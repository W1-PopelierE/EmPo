import { realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { loadConfig } from "../engine/config";
import {
  GRAPH_PATH,
  installedPackVersion,
  type PackDrift,
  type SchemaDrift,
  schemaDriftClause,
} from "../engine/graph";
import { guardsPath } from "../engine/guard";
import { healthReport, quietProbes } from "../engine/health";
import { loadSpines } from "../engine/spines";
import { checkFacts, describeFailure, failedSpines, wantedPaths, wantedTerms } from "./check";

/**
 * `empo hook <event>`: the three Claude Code hooks (docs/10-distribution.md), which are the only
 * thing in this repository whose output is read by a host rather than by a human. An instruction in
 * AGENTS.md is advice; these are the same rules turned into something that fires while an agent
 * works, without anyone remembering to run a command.
 *
 * Four invariants, and they are all one idea: a hook that speaks on the happy path is a hook that
 * gets deleted.
 *
 * 1. **Silence is the answer.** Nothing to say means nothing printed and exit 0. Every event is
 *    wired to fire on every session or every edit, so anything printed routinely is noise the team
 *    learns to skip and then removes.
 * 2. **A repository EmPo has never touched is silent.** No config, no graph, an unreadable spine, no
 *    git: caught, and answered with nothing. A hook is not the place to teach someone `empo init`,
 *    and a hook that crashes on every tool call in an unrelated repository is uninstalled within an
 *    hour. That is why every branch here runs inside one catch that returns null.
 * 3. **Never a non-zero exit, not even to deny.** Exit 2 discards stdout and routes a bare string
 *    through stderr; a denial is structured JSON on stdout with exit 0, which carries the spine, the
 *    files and the repair. Nothing here calls process.exit and nothing here throws.
 * 4. **The gate is not reimplemented.** pre-commit calls `checkFacts` from commands/check.ts, the
 *    same computation `empo check` prints. Two implementations of one gate disagree eventually, and
 *    the day they disagree is the day somebody stops trusting it.
 *
 * The casing is asymmetric and it is the thing to get right: the payload arriving on stdin is
 * snake_case (`tool_input`, `file_path`, `hook_event_name`), and everything written back is
 * camelCase (`hookSpecificOutput`, `hookEventName`, `permissionDecision`). A typo on the way out is
 * a silent no-op in production, so every key below is pinned in test/commands/hook.test.ts.
 */

export interface HookOptions {
  /** The `--repo` flag, which the generated settings.json fills from `${CLAUDE_PROJECT_DIR}`. */
  repo?: string;
}

/** `.empo/generated`, derived from the graph's own path so the two cannot drift apart. */
const GENERATED_DIR = posix.dirname(GRAPH_PATH);

/**
 * Is this bash command a git commit? Deliberately dumb: a `git` word in command position, then any
 * number of whole words, then a `commit` word. That covers `git commit -m x`, `git -C sub commit`,
 * `git -c user.email=x commit`, `foo && git commit` and `git commit --amend`.
 *
 * Two boundaries do the real work, and both were chosen to fail towards missing a commit rather
 * than towards denying something that is not one. A false negative costs one ungated commit, which
 * `empo check` in CI still catches; a false positive denies an unrelated command and teaches the
 * team to rip the hook out.
 *
 * - **Command position.** `git` must open the string or follow one of `\n ; & | ( ) { }`, so
 *   `echo "git commit"` is not a commit and neither is any other quoted mention. The cost is that
 *   `VAR=1 git commit`, `sudo git commit` and `if git commit; then` are missed, because none of them
 *   puts `git` where this rule looks. Quoting is not tracked, so a delimiter inside a quoted string
 *   (`echo "a; git commit"`) can still create an apparent command position; that residual case is
 *   accepted because reaching a denial from there also requires a genuinely failing gate.
 * - **What may follow `commit`.** Anything but a word character, `.`, `/`, `\`, `:`, `=` or `-`, so
 *   `git commit-graph write` is not a commit, `git log --format=commit` is not one, and neither is
 *   `git add commit.php` or a path segment like `src/commit/Foo.php`. `git commit;`,
 *   `git commit && x` and a bare `git commit` all still match, which is why the boundary is a
 *   character class rather than `\s`.
 *
 * A word is only ever tried at a token start (every alternative consumes a whole `\S+` plus its
 * trailing whitespace), which is what keeps `commit` inside a longer path from ever being read as
 * the subcommand.
 */
const GIT_COMMIT = /(?:^|[\n;&|(){}])\s*git\s+(?:\S+\s+)*?commit(?![\w./\\:=-])/;

export function isGitCommit(command: string): boolean {
  return GIT_COMMIT.test(command);
}

/**
 * The tested core: an event, the hook payload (raw JSON text or already parsed), and the exact bytes
 * to write to stdout, or null for silence. Never throws, whatever the payload or the repository
 * holds, because the only failure mode a hook is allowed is saying nothing.
 */
export function hookAnswer(
  event: string,
  payload: unknown,
  options: HookOptions = {},
): string | null {
  try {
    const parsed = asRecord(typeof payload === "string" ? parseJson(payload) : payload);
    if (parsed === null) return null;

    const repoRoot = resolveRepoRoot(parsed, options);
    if (event === "session-start") return sessionStart(repoRoot);
    if (event === "pre-edit") return preEdit(repoRoot, parsed);
    if (event === "pre-commit") return preCommit(repoRoot, parsed);
    // An event name this build does not know, which is what an old binary sees after settings.json
    // has been regenerated by a newer one. Silence, not a usage error.
    return null;
  } catch {
    return null;
  }
}

/**
 * What the CLI wires. Reads the payload from stdin, prints the answer if there is one, and resolves
 * either way: it never throws and never rejects, so the caller has nothing to catch and no exit code
 * to set.
 */
export async function hookCommand(event: string, options: HookOptions = {}): Promise<void> {
  const answer = hookAnswer(event, await readStdin(), options);
  if (answer !== null) console.log(answer);
}

/**
 * SessionStart. The only event that speaks about the repository as a whole, so it says only what is
 * wrong and what to run. A healthy repository, and a repository EmPo has never indexed, both get
 * nothing: `empo doctor` is the command for the full picture, and restating good news every session
 * is how a warning stops being read.
 *
 * A graph that is on disk and cannot be read is neither of those, and it is the one state worth
 * opening a session with. `graphHealth` in engine/health.ts answers it with `state: "unreadable"`,
 * `stale: false`, no finding and `ok` left true, and every one of those is honest on its own: nothing
 * could be read, so nothing can be reported as out of date or as a specific fault. Together they read
 * exactly like a healthy repository, which is how this state used to pass the guard below in silence
 * over a repository where every graph-derived answer is unavailable. Staleness is an old answer;
 * this is no answer at all, and the agent has no way to find that out except by asking and failing.
 */
function sessionStart(repoRoot: string): string | null {
  // `quietProbes` and never the default ones, because this function is itself one of the hooks the
  // report would execute. With the system probes, `empo hook session-start` spawns
  // `empo hook session-start`, which is the one call in this file that can reach back into it. And
  // even if it could not, the budget forbids it: the host kills a SessionStart hook at 10 seconds
  // (docs/10-distribution.md) and there are three entries wired, so running them all would spend the
  // whole allowance on proving something the session cannot act on anyway.
  //
  // Nothing is lost by staying quiet here. A hook the host cannot run is a finding for `empo doctor`,
  // which is the command that has the time for it, and a session that opened by reporting its own
  // hook as broken would be reporting it from inside a run that just proved otherwise.
  const health = healthReport(repoRoot, installedPackVersion, quietProbes);
  // The guard that keeps a healthy session silent has to name every state the notes below are built
  // from, because a state it does not enumerate is a state the session can never mention however
  // loudly the code under it speaks. An unreadable graph was one such omission, and every warning
  // was another: the clause here used to be `health.ok`, which is false only for an error-level
  // finding, so the unmapped-directory warning in engine/health.ts could not reach a session at all.
  // A drifted spine escaped only because the guard separately counted `spines.soft + spines.hard`,
  // which was a second way of saying "there is a finding" that happened to be true for one kind of
  // finding. `findings.length` says it for all of them, and it is the same list the loop below
  // prints from, so the two cannot part again.
  //
  // A missing graph is deliberately not in here, so it stays silent. That is invariant 2 above: it
  // is what a repository that has never run `empo index` looks like, and a hook that opened every
  // session in an unrelated checkout to teach that command is a hook nobody keeps installed. An
  // unreadable graph cannot be mistaken for a repository EmPo never touched, because something wrote
  // that file.
  if (health.findings.length === 0 && health.graph.state !== "unreadable" && !health.graph.stale)
    return null;

  const notes: string[] = [];
  // Every reason the graph's own answers are wrong, collected before any of them is printed, because
  // they share one repair and it is said once at the end of them rather than after each.
  const graphNotes: string[] = [];
  // First of the graph notes, because it subsumes the others: with nothing readable on disk there is
  // no recorded commit to measure a distance against and no recorded pack version to compare, so
  // health reports null and empty for both and neither of the notes below can fire. The two failures
  // it covers, a file that is not valid JSON and valid JSON that is not a graph, are one state here
  // for the same reason engine/health.ts makes them one: the repair is the same file, rebuilt.
  if (health.graph.state === "unreadable") {
    graphNotes.push(
      `the graph at ${GRAPH_PATH} cannot be read, so every answer derived from it is unavailable rather than out of date. It is either not valid JSON or not a graph.`,
    );
  }
  // Strictly greater than zero, and it has to be, because `stale` is not only git distance any
  // more: a drifted pack sets it on a graph built at HEAD, where `commitsBehind` is 0. A non-null
  // check let that state through and opened the session with "the graph is 0 commits behind HEAD",
  // which is a sentence that is both false and unactionable, and it arrived instead of the reason
  // the graph was actually stale.
  if (health.graph.commitsBehind !== null && health.graph.commitsBehind > 0) {
    graphNotes.push(
      `the graph is ${plural(health.graph.commitsBehind, "commit")} behind HEAD, so every answer it gives is that far out of date.`,
    );
  }
  // Not an else: a graph can be behind its commit and built by a pack that has since moved, and
  // hearing only one of those sends someone to reindex for half a reason.
  for (const pack of health.graph.packDrift) graphNotes.push(packDriftNote(pack));
  // Last of the three, because it is the widest: a pack moving changes the answers one language
  // contributes, and a schema moving changes what a field means for every language at once.
  if (health.graph.schemaDrift !== null) {
    graphNotes.push(schemaDriftNote(health.graph.schemaDrift));
  }
  // One rebuild answers all of them at once, so the instruction is one note of its own. Ending each
  // reason with its own "Run empo index." reads as a list of separate jobs, and the two states above
  // arriving together is precisely when that misreads: the reader has two notes, two repairs and one
  // command.
  if (graphNotes.length > 0) notes.push(...graphNotes, "Run empo index.");
  // Every finding, warn and error alike, in the words engine/health.ts wrote it in. Some carry their
  // own repair and some cannot: a drifted spine ends "Run empo verify.", while a directory under no
  // root ends with its consequence, because the repair there is a decision about the config that no
  // hook can make on anyone's behalf. What none of them is repaired by is `empo index`, which is why
  // the graph notes above say that once for themselves instead of being folded in here.
  for (const finding of health.findings) notes.push(finding.message);
  if (notes.length === 0) return null;

  return json({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ["EmPo health:", ...notes.map((note) => `- ${note}`)].join("\n"),
    },
  });
}

/**
 * One pack whose version differs from the one the graph recorded, as a sentence.
 *
 * It has to be said out loud because git distance cannot see it and neither can `health.findings`:
 * a pack is data, so changing it changes every answer derived from it without moving a line of the
 * code that was indexed (engine/graph.ts). The graph can be current with HEAD and still be
 * answering out of a pack that is not the installed one, which is exactly the state that reads as
 * healthy and is not.
 *
 * What it deliberately does not say is which of the two versions is newer. `graphDrift` in
 * engine/graph.ts records a difference and not an ordering: it pushes a record whenever
 * `built !== loaded`, in either direction. A checkout moving from a branch whose pack is ahead back
 * to one whose pack is behind, and a repository that commits `generated/` (docs/02-on-disk-layout.md)
 * read by a teammate whose install is behind that commit, both leave the newer pack's answers in the
 * graph. This sentence used to end "is the older pack's answer", which is false in both of them.
 *
 * The opening clause, up to and including "is installed", is the same wording `driftLines` in
 * engine/graph.ts prints, including its refusal to guess a version a graph never recorded, so the
 * surfaces name one state the same way. That clause is all they share: doctor closes with
 * "(run empo index)" inside the fixed-width `drift` column its whole prose surface is aligned to,
 * while the hook leaves the repair to `sessionStart`, which says it once for however many reasons it
 * found. They are still held in step by hand, and the divergent tail is where the false claim above
 * got in. `schemaDriftNote` below shows the repair: lift the shared clause into engine/graph.ts
 * beside `schemaDriftClause` and have both printers read it, which is a change to doctor's printer
 * and is why it has not been made here.
 */
function packDriftNote(pack: PackDrift): string {
  // A graph that names a pack and records no version for it cannot name the one that built it, and
  // neither half of the sentence may pretend otherwise: with no version recorded there is nothing
  // to compare, so the honest consequence is that the graph cannot answer the question at all.
  // `empo index` never writes that state (engine/graph.ts on `PackDrift.built` says why), so this
  // branch is a graph.json some other hand produced, which is all the more reason not to guess for it.
  const built =
    pack.built === null
      ? `graph does not record which ${pack.lang} pack built it`
      : `graph built with ${pack.lang} pack ${pack.built}`;
  const consequence =
    pack.built === null
      ? "so nothing in the graph says whether its answers are the ones the installed pack gives"
      : `so every answer derived from that pack is the one ${pack.lang} pack ${pack.built} gives, not the one the installed pack gives`;
  return `${built}, ${pack.loaded} is installed, ${consequence}. Git distance cannot see a pack version.`;
}

/**
 * A graph written at a schema this binary does not write, as a sentence.
 *
 * It says what changed and refuses to say what it means, because it cannot know. A schema bump
 * records that a field the readers already knew kept its name and changed its meaning
 * (engine/graph.ts), and the file holds no list of which fields those were: only the two version
 * numbers. So the note names both and stops. Telling the agent which answers to distrust would be
 * inventing the very thing the number exists for, which is that nothing else on disk records it.
 *
 * The opening clause is `schemaDriftClause` in engine/graph.ts, which doctor's drift line opens with
 * too. Unlike the pack note above, these two cannot part: they read the shared half from one
 * function instead of keeping two copies of it in step by hand, and only the consequence and the
 * repair are the hook's own.
 */
function schemaDriftNote(schema: SchemaDrift): string {
  return `${schemaDriftClause(schema)}, so a field it records may not mean what this empo reads it to mean. Nothing in the file says which fields those are.`;
}

/**
 * PreToolUse on Edit and Write. Two rules, in order: the machine-owned directory is denied outright,
 * and a file on a spine's guarded chain is announced without touching the permission flow.
 */
function preEdit(repoRoot: string, payload: Record<string, unknown>): string | null {
  const filePath = toolInput(payload, "file_path");
  if (filePath === null) return null;

  const path = repoRelative(repoRoot, filePath);
  // Outside the repository, so nothing here has an opinion about it. Relativizing first is what
  // keeps a stray `/etc/.empo/generated/x` or a sibling checkout from matching by accident.
  if (path === null) return null;

  if (path === GENERATED_DIR || path.startsWith(`${GENERATED_DIR}/`)) {
    return json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: [
          `${path} is machine-owned: only empo index writes ${GENERATED_DIR}/ (docs/02-on-disk-layout.md).`,
          "An edited graph answers a blast radius that looks generated and is invented, which is the one failure the graph exists to prevent.",
          "If the answer in there is wrong, fix the config or the language pack that produced it and run empo index.",
        ].join(" "),
      },
    });
  }

  const { config } = loadConfig(repoRoot);
  const guarding = loadSpines(repoRoot, config).filter((loaded) => guardsPath(loaded.spine, path));
  if (guarding.length === 0) return null;

  const names = guarding.map((loaded) => `"${loaded.spine.name}"`).join(", ");

  // Both channels, and deliberately no permissionDecision. Whether additionalContext is honored on
  // PreToolUse without a permission decision is undocumented, so systemMessage (documented on every
  // event, shown to the human) is what keeps this warning from degrading to nothing. Neither is
  // redundant: one reaches the agent about to make the edit, the other reaches the person watching.
  // A permissionDecision here would prompt or block an ordinary edit, which is how a warning that
  // was only ever meant to inform gets the whole hook uninstalled.
  return json({
    systemMessage: `EmPo: ${path} is on the guarded chain of ${guarding.length === 1 ? "spine" : "spines"} ${names}, so empo check will want an added test line that asserts the value.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: [
        `${path} is a guarded file on ${plural(guarding.length, "spine")}. Read the spine before changing a value here, and expect empo check to ask this change for an assertion.`,
        ...guarding.map(
          (loaded) =>
            `- ${loaded.spine.name} (${loaded.path}) counts an added test line using ${wantedTerms(loaded.spine.assertionTerms)}${wantedPaths(loaded.spine.assertionPaths)}.`,
        ),
      ].join("\n"),
    },
  });
}

/**
 * PreToolUse on Bash. Runs the commit gate on the staged diff, exactly as `empo check` does, and
 * denies a commit no spine's chain was asserted for. Silent on a pass, silent on anything that is
 * not a commit, and silent when the gate cannot run at all (no config, no spines, no git).
 */
function preCommit(repoRoot: string, payload: Record<string, unknown>): string | null {
  const command = toolInput(payload, "command");
  if (command === null || !isGitCommit(command)) return null;

  const failed = failedSpines(checkFacts(repoRoot));
  if (failed.length === 0) return null;

  return json({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: [
        `empo check gates this commit: ${failed.length === 1 ? "1 spine guards files" : `${failed.length} spines guard files`} this change touches and no added test line asserts a value.`,
        ...failed.flatMap(describeFailure),
        'Add a test that asserts the value in the smallest exact unit and stage it, then commit again. If this change genuinely cannot move a value, empo check --bypass "<reason>" is the way through and puts the reason on the record.',
      ].join("\n"),
    },
  });
}

/**
 * The `--repo` flag first, because the generated settings.json fills it from `${CLAUDE_PROJECT_DIR}`
 * and that is the project root even when the tool ran somewhere below it. The payload's `cwd` next,
 * then this process's, so the command still answers when it is run by hand.
 */
function resolveRepoRoot(payload: Record<string, unknown>, options: HookOptions): string {
  const flag = (options.repo ?? "").trim();
  if (flag !== "") return flag;
  const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
  return cwd === "" ? process.cwd() : cwd;
}

/**
 * An absolute `tool_input.file_path` as a repo-relative posix path, or null when it falls outside
 * the repository. Separators are forced to `/` for the reason engine/spines.ts does it: every
 * pattern a spine guards is written in posix, so matching a `\` path against them silently guards
 * nothing.
 *
 * The realpath pass is for the case where the root arrives as a symlink and the file does not, which
 * is the default on macOS for anything under /tmp. Failing that comparison would let an edit through
 * a gate that should have caught it, so it is worth the extra call.
 */
function repoRelative(repoRoot: string, filePath: string): string | null {
  for (const root of [repoRoot, realRoot(repoRoot)]) {
    if (root === null) continue;
    const rel = relative(root, resolve(root, filePath));
    // Empty is the root directory itself, and either form of `..` is outside it. isAbsolute catches
    // the Windows case where the two paths are on different drives and there is no relative form.
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    return rel.split(sep).join("/");
  }
  return null;
}

function realRoot(repoRoot: string): string | null {
  try {
    const real = realpathSync(repoRoot);
    return real === repoRoot ? null : real;
  } catch {
    return null;
  }
}

/** A non-empty string field of `tool_input`, or null. An absent `tool_input` is not an error. */
function toolInput(payload: Record<string, unknown>, key: string): string | null {
  const input = asRecord(payload.tool_input);
  if (input === null) return null;
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One line, because this is parsed and never read. */
function json(document: unknown): string {
  return JSON.stringify(document);
}

/**
 * Everything on stdin, or the empty string. A TTY is checked first: run by hand with no pipe, the
 * read would otherwise block forever, and a hook that hangs is worse than one that says nothing.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return "";
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
