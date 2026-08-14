import picomatch from "picomatch";
import type { EmpoConfig } from "../schema/config.schema";
import type { Pack } from "../schema/pack.schema";
import type { SpineFile } from "../schema/spine.schema";
import type { ChangedFile } from "./diff";
import { compileTestPath } from "./extractor";
import { compareStrings } from "./order";
import { loadPack } from "./pack-loader";
import type { LoadedSpine } from "./spines";

/**
 * The commit gate (docs/06-cli.md `empo check`, docs/08-spines.md `guarded`). One question, asked
 * mechanically: this change edits a file on a spine's critical chain, so does it also add a line
 * that asserts a value?
 *
 * Everything here is deliberately dumb. It does not run tests, it does not read the graph, and it
 * does not judge whether the assertion covers the change: it reads the diff and the spine, both of
 * which are on disk. That keeps the gate fast enough for a pre-commit hook and keeps it honest,
 * because a gate that guesses is a gate people learn to route around.
 *
 * Two properties are load-bearing. The spines are read from disk, never from the diff, so unstaging
 * the spine file cannot dodge the gate (docs/06). And only *added* lines count as assertions: an
 * assertion that was already there is evidence about the change that added it, not about this one.
 */

export interface AssertionHit {
  /** Repo-relative path of the test file the added line is in. */
  file: string;
  /** Line number in the new file, which is the line an author opens. */
  line: number;
  term: string;
  text: string;
}

/**
 * One guarded file a change touches, named by the spelling the spine's own patterns claim.
 *
 * `movedTo` is the whole reason this is a record and not a string. A rename has two paths and only
 * one of them can be the guarded one, so a gate that reads the new path alone lets `git mv` carry a
 * guarded file out of its guard with a logic change riding along, which was measured and not feared.
 * Where that happens the guarded spelling is the old path, which no longer exists, and printing it
 * without saying where the file went would send an author to look for it.
 */
export interface GuardedTouch {
  /** The spelling `guarded` matched: the new path where that is guarded, else the pre-rename one. */
  path: string;
  /** Where a rename took this file, when the new path is not itself guarded. Null otherwise. */
  movedTo: string | null;
}

export interface GuardVerdict {
  name: string;
  /** Repo-relative path of the spine file, so a failure names the artifact to read. */
  path: string;
  /** Whether this spine guards anything at all. A spine with no globs gates nothing. */
  guards: boolean;
  /** What this spine counts as a value assertion, carried so a failure can name it. */
  termsWanted: string[];
  /** Where this spine counts one, carried for the same reason. Empty is "any test file". */
  pathsWanted: string[];
  /** The guarded files this change touches, sorted by the guarded spelling. */
  touched: GuardedTouch[];
  assertions: AssertionHit[];
  passed: boolean;
}

/**
 * `isTestFile` is null when no installed pack declares a single test path. The gate then counts an
 * assertion term added anywhere in the diff, which is weaker, and the command says so out loud
 * rather than reporting a pass it cannot stand behind.
 */
export function guardSpines(
  spines: LoadedSpine[],
  files: ChangedFile[],
  isTestFile: ((path: string) => boolean) | null,
): GuardVerdict[] {
  return spines.map((loaded) => {
    const { spine } = loaded;
    const touched = guardedTouches(spine, files);

    const assertions =
      touched.length === 0
        ? []
        : addedAssertions(spine.assertionTerms, files, isTestFile, spine.assertionPaths);

    return {
      name: spine.name,
      path: loaded.path,
      guards: spine.guarded.length > 0,
      termsWanted: spine.assertionTerms,
      pathsWanted: spine.assertionPaths,
      touched,
      assertions,
      passed: touched.length === 0 || assertions.length > 0,
    };
  });
}

/**
 * Whether one spine's `guarded` list claims this path. One line, and it earns a name because three
 * surfaces ask it and all three have to answer the same: `guardedTouches` below computes the gate's
 * and the review's subject with it, and `commands/hook.ts` warns before an edit lands on a guarded
 * file. A second copy of the rule is how a brief comes to name a spine the gate will not fire on, or
 * stays silent about one it will.
 *
 * A path, not a file, because the hook has only a path: it fires before an edit exists. Anything
 * holding a `ChangedFile` asks `guardedTouches` instead, which consults both spellings of a rename.
 */
export function guardsPath(spine: SpineFile, path: string): boolean {
  return spine.guarded.some((pattern) => matchesPattern(path, pattern));
}

/**
 * Which of a change's files one spine guards, asked of a `ChangedFile` rather than of a path,
 * because a rename carries two paths and the guarded one is not always the one the file now has.
 *
 * Both spellings are consulted, new first. That order is what makes each case answer once: a rename
 * within the guarded tree, and a rename *into* it, both match on the new path and are reported under
 * the name the author now opens, while a rename *out* of the tree matches only on the old path and
 * is reported under the guarded spelling with `movedTo` carrying where it went.
 *
 * The last of those is why this function exists, and it was measured rather than imagined. Matching
 * `file.path` alone let `git mv` walk a guarded file out from under its own guard: git recorded the
 * move as a rename, the gate saw only the new path, printed "touched none of its guarded files" and
 * exited 0, with a changed rounding rule riding along in the same commit. The verdict even inverted
 * with the size of the edit, because a move rewritten past git's similarity threshold is recorded as
 * a delete plus an add and the delete half carries the old path, so the small edit escaped and the
 * large one was caught. `ChangedFile.oldPath` was already populated and simply not consulted.
 *
 * Both `empo check` and `empo review`'s spine section ask through here, for the same reason
 * `guardsPath` has one owner: a brief that named a different set from the gate's would announce a
 * spine that will not fire, or stay silent about one that will.
 */
export function guardedTouches(spine: SpineFile, files: ChangedFile[]): GuardedTouch[] {
  const touches: GuardedTouch[] = [];

  for (const file of files) {
    if (guardsPath(spine, file.path)) {
      touches.push({ path: file.path, movedTo: null });
      continue;
    }
    // A delete has no `oldPath` (its one path is on `path` already), so this is renames only.
    if (file.oldPath !== null && guardsPath(spine, file.oldPath)) {
      touches.push({ path: file.oldPath, movedTo: file.path });
    }
  }

  return touches.sort((a, b) => compareStrings(a.path, b.path));
}

/**
 * A guarded entry is a glob (`apps/api/app/Libraries/Price/**`), an exact file, or a directory whose
 * whole subtree is guarded. All three are written by hand in the same field, so all three are
 * matched: requiring `/**` on every directory would make a spine that names one file guard nothing
 * at all, silently, which is the failure mode a gate can least afford.
 *
 * `dot: true` because the three forms have to agree. picomatch defaults to skipping anything whose
 * name begins with a dot, so `apps/api/config/**` would have guarded `config/app.php` and not
 * `config/.env`, while the bare directory `apps/api/config` guarded both. Two spellings of one
 * intent giving two answers is bad on its own; here it also failed in the one direction a gate may
 * never fail, letting a change through. Nobody writing `Price/**` means "except the dotfiles", and
 * `.env` is exactly the kind of file whose change moves a number.
 *
 * This is deliberately the opposite of the scanner's `dot: false` (engine/scanner.ts) and of the
 * test paths compiled beside it. Those walk the source tree to decide what the graph holds, and a
 * file the graph never holds cannot be a node. A guarded pattern is matched against a diff, which
 * carries every path git staged, dot-directories included.
 */
export function matchesPattern(path: string, pattern: string): boolean {
  const cleaned = pattern.replace(/\/+$/, "");
  if (cleaned === "") return false;
  if (/[*?[\]{}!]/.test(cleaned)) return picomatch(cleaned, { dot: true })(path);
  return path === cleaned || path.startsWith(`${cleaned}/`);
}

/**
 * Every added line that uses one of this spine's assertion terms. A term is a token
 * (`assertSame`, `->assertMoney(`, `cents`), so this is a plain substring match on the added text,
 * with nothing subtracted from it first.
 *
 * That last part is where this parts company with the pack-level `assertionTerms`, and the
 * difference is deliberate rather than an oversight. engine/extractor.ts removes the pack's
 * `assertionExcludes` from a file before it looks for a term, because a pack's list is generic and
 * runs unattended over every test file in a repository: there, `assertTrue` has to cover both
 * `assertTrue($order->isPaid())` and `assertTrue(method_exists($c, 'confirm'))`. Left unqualified,
 * one such term scored 14 of 15 test files as asserting on a value, which is
 * the measurement engine/extractor.ts records beside that field. A
 * spine's terms are the opposite kind of list. They are hand-written, per spine, by whoever owns
 * that chain, they name what proof looks like for that chain and nothing else, and the verdict
 * carries them back on `termsWanted` so a failing author reads the exact tokens they are held to. A
 * term that admits liveness there is one the author chose and can edit, in a file they already have
 * open. Subtracting a second hand-written list from it would mean a second field on
 * schema/spine.schema.ts to keep in step with the first, and a gate that refuses a line the spine's
 * own author declared as proof.
 *
 * The cost is real and worth stating: where a spine lists a term whose liveness spelling the pack
 * excludes, this gate accepts as proof an assertion engine/coverage.ts will not count, so a change
 * can pass `empo check` and the flow still read blind in the graph. The two are asking different
 * questions. The gate asks whether this change added the proof this spine asked for. The graph asks
 * whether any test asserts a value at all. A spine whose terms make those answers disagree is
 * telling its author something, and `empo index` prints that flow as blind on every run, which is
 * a louder place for it than a gate that silently held a change to a rule nobody wrote down.
 *
 * `paths` is where such a line has to be added, and it is the answer to the measured defect: with
 * no scope beyond "is a test file", the same commit that
 * changed `Math.trunc` to `Math.round` inside a guarded money function passed the gate on the
 * strength of an added `expect(nextTheme("dark")).toBe("light")` in a theme test that imports
 * nothing from pricing. A spine that names its own test files is held to those files instead.
 *
 * The two scopes **intersect**, and that direction is the whole safety of the field. A spine's paths
 * can only ever narrow what counts, never widen it, so a wide or misspelled glob costs its author a
 * gate that is hard to satisfy rather than one that waves a change through: the failure mode is a
 * commit that stops, which is visible in the second it happens, and not a commit that passes, which
 * is visible to nobody. That is why this does not follow `assertionTerms`, where the spine's
 * hand-written list replaces the pack's outright. A term list only ever decides what proof looks
 * like; a path list decides how much of the diff the gate is willing to read.
 */
function addedAssertions(
  terms: string[],
  files: ChangedFile[],
  isTestFile: ((path: string) => boolean) | null,
  paths: string[],
): AssertionHit[] {
  const hits: AssertionHit[] = [];

  for (const file of files) {
    if (isTestFile !== null && !isTestFile(file.path)) continue;
    // Empty is every spine that curates no test scope, which is what this field defaulted to for
    // every spine written before it existed. It must not narrow to nothing, so it is asked first.
    if (paths.length > 0 && !paths.some((pattern) => matchesPattern(file.path, pattern))) continue;
    for (const hunk of file.hunks) {
      for (const added of hunk.added) {
        // First matching term in declared order, so a line using two of them is reported once and
        // always as the same one, whatever order the diff was parsed in.
        const term = terms.find((candidate) => added.text.includes(candidate));
        if (term === undefined) continue;
        hits.push({ file: file.path, line: added.line, term, text: added.text.trim() });
      }
    }
  }

  return hits.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line);
}

/**
 * "Is this a test file" answered by the packs rather than by a heuristic here, so the gate's idea of
 * a test is the same one the graph's `isTest` and the blind-flow computation use. Null when no root's
 * pack declares any test path, which is a real configuration (a pack can leave `tests.paths` empty)
 * and must not silently mean "nothing is a test", because that would fail every guarded change.
 */
export function testFileMatcher(
  config: EmpoConfig,
  load: (lang: string) => Pack = loadPack,
): ((path: string) => boolean) | null {
  const matchers: { prefix: string; matches: ((relPath: string) => boolean)[] }[] = [];
  let declared = 0;

  for (const root of config.roots) {
    const paths = load(root.lang).tests.paths;
    declared += paths.length;
    if (paths.length === 0) continue;
    matchers.push({
      prefix: root.path === "." || root.path === "" ? "" : `${root.path.replace(/\/+$/, "")}/`,
      matches: paths.map(compileTestPath),
    });
  }

  if (declared === 0) return null;

  return (path: string) =>
    matchers.some(({ prefix, matches }) => {
      if (prefix !== "" && !path.startsWith(prefix)) return false;
      const relPath = path.slice(prefix.length);
      return matches.some((match) => match(relPath));
    });
}
