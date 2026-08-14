import { loadConfig } from "../engine/config";
import { parseDiff } from "../engine/diff";
import { diffAgainstBase, resolveRef, stagedDiff } from "../engine/git";
import {
  type GuardedTouch,
  type GuardVerdict,
  guardSpines,
  testFileMatcher,
} from "../engine/guard";
import { loadSpines } from "../engine/spines";
import { configError, environmentError, gateFailure } from "../errors";
import { plural } from "../term";

/**
 * `empo check`: the commit gate (docs/06-cli.md). A staged change that edits a spine's guarded files
 * and adds no value-asserting test line fails, naming the spine and the terms it was looking for.
 * Intended for a pre-commit hook and for CI (`empo check --base $BASE`, docs/10-distribution.md).
 *
 * The gate is mechanical on purpose: it reads the diff and the spines and nothing else, so it is
 * fast, it needs no graph, and it can be argued with. It can be bypassed only explicitly, by a human
 * stating a reason, never by unstaging the spine file, because the spines are read from disk and the
 * diff is only ever the subject.
 *
 * The computation is `checkFacts` and the printing is `checkCommand`, split because the pre-commit
 * hook (src/commands/hook.ts) has to ask the same question and answer it in JSON on stdout instead
 * of in prose. Two implementations of one gate disagree eventually, and the day they disagree is the
 * day somebody stops trusting it, so the hook renders these facts rather than recomputing them.
 */

/** Printed with every answer, pass or fail. The gate can see that a line was added, nothing more. */
export const GATE_IS_MECHANICAL =
  "This gate sees that a value-asserting line was added, not that it asserts the right value. Reading the test is still the reviewer's job.";

/**
 * The second half of the same honesty, printed only for an answer some spine in it earned. A spine
 * that declares no `assertionPaths` is satisfied by an added assertion in any test file the diff
 * carries, related to the guarded change or not, which is the measured defect and the reason that
 * field exists.
 *
 * It is conditional rather than constant because the caveat a reader is owed is the one that is true
 * of the answer in front of them. Printed on every answer it would be false of every scoped spine,
 * and a caveat that is routinely false is read as boilerplate and then not read at all, which costs
 * the sentence above it too.
 */
export const GATE_IS_UNSCOPED =
  "Where a spine declares no assertionPaths, that line may be in any test file the change touches, including one with nothing to do with the guarded file.";

/** The caveats true of this answer, in one string, so both surfaces carry the same sentence. */
export function caveatFor(verdicts: GuardVerdict[]): string {
  // `guards`, not `touched`, because the reader is being told what this gate's rule is over the
  // spines it is holding, and a spine that gates nothing today gates on the same rule tomorrow. A
  // spine that guards nothing is excluded outright: it has no gate for the sentence to be about.
  const unscoped = verdicts.some((verdict) => verdict.guards && verdict.pathsWanted.length === 0);
  return unscoped ? `${GATE_IS_MECHANICAL} ${GATE_IS_UNSCOPED}` : GATE_IS_MECHANICAL;
}

export interface CheckOptions {
  /** Compare against this ref instead of judging the staged change. For CI. */
  base?: string;
  /** An explicit human decision that this change cannot affect a value. Requires a reason. */
  bypass?: string;
  json?: boolean;
}

/**
 * The gate itself: everything `empo check` knows, computed and returned, nothing printed. Throws
 * exactly what the command throws for a bad flag, an unreadable spine or a missing git, because a
 * caller that wants silence (the hook) catches, and one that wants an exit code (the CLI) does not.
 */
export function checkFacts(repoRoot: string, options: CheckOptions = {}): CheckFacts {
  const { config } = loadConfig(repoRoot);
  const spines = loadSpines(repoRoot, config);

  const bypass = options.bypass === undefined ? null : options.bypass.trim();
  if (bypass !== null && bypass === "") {
    throw configError("empo check --bypass needs a reason", [
      "The bypass is a human decision on the record, so it is not a bare flag.",
      'Example: empo check --bypass "config only, no value on any path".',
    ]);
  }

  // No spines, no gate, and no reason to shell out to git: a repository with nothing curated must
  // not pay for the gate, or the hook that runs it gets removed from repositories it never gates.
  if (spines.length === 0) {
    return { subject: subjectLabel(options), verdicts: [], scoped: true, files: null, bypass };
  }

  const diff = readDiff(repoRoot, options.base);
  const files = parseDiff(diff);
  const isTestFile = testFileMatcher(config);
  const verdicts = guardSpines(spines, files, isTestFile);

  return {
    subject: subjectLabel(options),
    verdicts,
    scoped: isTestFile !== null,
    files: files.length,
    bypass,
  };
}

/** The spines this change failed, in load order. Empty is a pass. */
export function failedSpines(facts: CheckFacts): GuardVerdict[] {
  return facts.verdicts.filter((verdict) => !verdict.passed);
}

/**
 * Assertion terms quoted and joined, e.g. `"assertSame(" or "assertEqualsWithDelta("`. Shared with
 * the hook so the two surfaces name the terms the same way.
 */
export function wantedTerms(terms: string[]): string {
  return terms.map((term) => `"${term}"`).join(" or ");
}

/**
 * Where such a line has to be added, as a clause that reads on the end of `wantedTerms`, or the
 * empty string where the spine names no scope. Shared with the hook and with `empo review`'s brief
 * for the reason every other sentence about a spine is: three surfaces tell an author what this gate
 * wants, and one of them wording the scope differently is one of them being wrong.
 *
 * A spine with no scope gets no clause rather than "anywhere", because the sentence it appends to is
 * already about what to add and the wider rule is the conditional caveat's job.
 */
export function wantedPaths(paths: string[]): string {
  return paths.length === 0 ? "" : ` in ${paths.join(" or ")}`;
}

/**
 * One failed spine, as the lines the command's failure and the hook's denial both carry: what
 * gated, where its file is, which guarded paths changed, and what would have satisfied it. The two
 * surfaces differ in what they say afterwards, never in what they say about the spine.
 */
export function describeFailure(verdict: GuardVerdict): string[] {
  return [
    `${verdict.name} (${verdict.path}): ${verdict.touched.length === 1 ? "1 guarded file" : `${verdict.touched.length} guarded files`} changed, no added line uses ${wantedTerms(verdict.termsWanted)}${wantedPaths(verdict.pathsWanted)}.`,
    ...verdict.touched.map((touch) => `  ${describeTouch(touch)}`),
  ];
}

/**
 * One touched file as both surfaces print it. A rename that carried a guarded file out of its guard
 * is named by the spelling the spine claims, which is the old one, so the destination has to be
 * printed with it: the file is not at the path this line opens with any more, and an author reading
 * the guarded name alone would go looking for a file that moved.
 */
export function describeTouch(touch: GuardedTouch): string {
  return touch.movedTo === null
    ? touch.path
    : `${touch.path} -> ${touch.movedTo}  (moved out of the guarded tree)`;
}

export function checkCommand(repoRoot: string, options: CheckOptions = {}): void {
  const facts = checkFacts(repoRoot, options);
  const { bypass } = facts;

  report(options, facts);

  const failed = failedSpines(facts);
  if (failed.length === 0) return;

  if (bypass !== null) {
    // The reason rides inside the document under --json, never beside it. An override is exactly
    // when a machine reader most needs to be told what happened, and printing these three lines
    // after the JSON left it unparseable at that one moment.
    if (options.json !== true) {
      console.log("");
      console.log(`BYPASSED  ${bypass}`);
      console.log(
        `  ${failed.map((verdict) => verdict.name).join(", ")} gated this change and a human overrode it.`,
      );
    }
    return;
  }

  throw gateFailure(
    `${failed.length === 1 ? "1 spine gates" : `${failed.length} spines gate`} this change`,
    failed.flatMap((verdict) => [
      ...describeFailure(verdict),
      'Add a test that asserts the value in the smallest exact unit, or rerun with --bypass "<reason>".',
    ]),
  );
}

function readDiff(repoRoot: string, base: string | undefined): string {
  if (base === undefined) {
    const staged = stagedDiff(repoRoot);
    if (staged === null) {
      throw environmentError("empo check could not read the staged diff", [
        "It runs git diff --cached, so it needs a git repository and git on PATH.",
      ]);
    }
    return staged;
  }

  if (resolveRef(repoRoot, base) === null) {
    throw configError(`"${base}" is not a ref this repository knows`, [
      "empo check --base takes a branch, a tag or a sha to compare against.",
    ]);
  }

  const diff = diffAgainstBase(repoRoot, base);
  if (diff === null) {
    throw environmentError(`empo check could not diff against "${base}"`, [
      "git diff failed. Run it by hand to see why.",
    ]);
  }
  return diff;
}

export interface CheckFacts {
  subject: string;
  verdicts: GuardVerdict[];
  /** Whether "is a test file" was answered by a pack, or every changed file had to count. */
  scoped: boolean;
  /** Null when no diff was read at all, which is what happens when there is no spine to gate. */
  files: number | null;
  /** The stated reason when a human overrode the gate, null when nobody did. */
  bypass: string | null;
}

function subjectLabel(options: CheckOptions): string {
  return options.base === undefined ? "staged changes" : `changes against ${options.base}`;
}

function report(options: CheckOptions, view: CheckFacts): void {
  if (options.json === true) {
    console.log(
      JSON.stringify(
        {
          subject: view.subject,
          files: view.files,
          spines: view.verdicts,
          // The mechanical verdict, which stays false under an override: a reader asking whether
          // the commit proceeds wants `passed || bypass !== null`, and a reader asking whether the
          // chain was asserted wants this field alone. Collapsing the two would hide the override.
          passed: view.verdicts.every((verdict) => verdict.passed),
          bypass: view.bypass,
          caveat: caveatFor(view.verdicts),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log(
    view.files === null
      ? `subject    ${view.subject}`
      : `subject    ${view.subject}, ${plural(view.files, "file")}`,
  );

  if (view.verdicts.length === 0) {
    console.log("spines     none: there is nothing to gate");
    console.log("");
    console.log("A spine is expensive to curate and only worth it where a wrong value is silent.");
    return;
  }

  console.log(`spines     ${plural(view.verdicts.length, "spine")}`);
  console.log("");

  for (const verdict of view.verdicts) {
    console.log(`${verdict.name}  ${verdict.path}`);
    if (!verdict.guards) {
      console.log("  guards nothing: this spine declares no guarded globs");
      console.log("");
      continue;
    }
    if (verdict.touched.length === 0) {
      console.log("  touched  none of its guarded files");
      console.log("");
      continue;
    }

    for (const touch of verdict.touched) console.log(`  touched  ${describeTouch(touch)}`);
    if (verdict.assertions.length === 0) {
      console.log(
        `  asserts  NOTHING: no added line uses ${wantedTerms(verdict.termsWanted)}${wantedPaths(verdict.pathsWanted)}`,
      );
    }
    for (const hit of verdict.assertions.slice(0, 5)) {
      console.log(`  asserts  ${hit.file}:${hit.line}  "${hit.term}"  ${excerpt(hit.text)}`);
    }
    if (verdict.assertions.length > 5) {
      console.log(`           ... and ${verdict.assertions.length - 5} more`);
    }
    console.log("");
  }

  // Only where some spine in this answer is actually left counting the whole diff. A spine that
  // names its own `assertionPaths` is scoped whatever the packs declare, so printing this beside one
  // would report a degradation that did not happen to that spine.
  if (!view.scoped && view.verdicts.some((verdict) => verdict.pathsWanted.length === 0)) {
    console.log(
      "note: no installed pack declares a test path, so an assertion term counts anywhere in the diff.",
    );
    console.log("");
  }

  const failed = view.verdicts.filter((verdict) => !verdict.passed);
  console.log(
    failed.length === 0
      ? "OK  nothing on a spine changed unasserted"
      : `FAIL  ${failed.map((verdict) => verdict.name).join(", ")}`,
  );
  console.log("");
  console.log(caveatFor(view.verdicts));
}

function excerpt(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}
