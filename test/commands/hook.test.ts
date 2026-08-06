import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type HookOptions, hookAnswer, hookCommand, isGitCommit } from "../../src/commands/hook";
import { run } from "../../src/engine/git";
import { GRAPH_SCHEMA } from "../../src/engine/graph";

/**
 * `empo hook`, the first output in this repository a host parses instead of a human reading.
 *
 * Two things are pinned harder here than anywhere else. The output keys, spelled out one at a time,
 * because `permissionDecision` misspelled is a hook that silently never denies and no assertion of
 * the form "something was printed" would notice. And silence, in every failure mode there is, because
 * a hook that throws in an unrelated repository fires on every tool call the person makes that day.
 *
 * The commit detection is tested as a table in both directions for the same reason it is written as
 * one regex: a false positive there denies a command that has nothing to do with EmPo, and the team
 * removes the hook rather than argues with it.
 */

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

const SPINE_PATH = ".empo/spines/pricing.json";
const CALCULATOR_FILE = "apps/api/app/Libraries/Price/PriceCalculator.php";
const ORDER_TEST_FILE = "apps/api/tests/Feature/OrderTest.php";
const ADMIN_CONTROLLER_FILE = "apps/api/app/Http/Controllers/AdminController.php";

const TAX_RATE = "private const TAX_RATE_BASIS_POINTS = 2100;";

/** What the fixture spine counts as a value assertion. Both have to reach the agent. */
const TERMS = ['"assertSame("', '"assertEqualsWithDelta("'];

/** Enough config to load, with no spines directory and no graph: a repository that curated nothing. */
const MINIMAL_CONFIG = {
  version: 1,
  roots: [{ path: ".", lang: "php" }],
  packs: { php: { version: "^1" } },
};

let repo: string;
const temps: string[] = [];

interface HookOutput {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

/** The answer parsed, with a readable failure when the hook said nothing and a test expected words. */
function spoke(answer: string | null): HookOutput {
  expect(answer, "expected the hook to answer, it was silent").not.toBeNull();
  return JSON.parse(answer as string) as HookOutput;
}

function git(args: string[]): string {
  const result = run(repo, "git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** -c on the commit so this passes with no git identity and no signing key configured. */
function commit(message: string): string {
  git([
    "-c",
    "user.email=empo@example.com",
    "-c",
    "user.name=EmPo Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
  return git(["rev-parse", "HEAD"]);
}

function stage(...paths: string[]): void {
  git(["add", "-f", ...paths]);
}

function linesOf(path: string): string[] {
  return readFileSync(join(repo, path), "utf8").split("\n");
}

function indexOfAnchor(lines: string[], path: string, anchor: string): number {
  const index = lines.findIndex((line) => line.includes(anchor));
  if (index === -1) throw new Error(`no line of ${path} contains "${anchor}"`);
  return index;
}

function insertAfter(path: string, anchor: string, added: string): void {
  const lines = linesOf(path);
  lines.splice(indexOfAnchor(lines, path, anchor) + 1, 0, added);
  writeFileSync(join(repo, path), lines.join("\n"));
}

/** The change the gate exists for: a money value moves and nothing asserts what it is now. */
function changeTaxRate(): void {
  const lines = linesOf(CALCULATOR_FILE);
  lines[indexOfAnchor(lines, CALCULATOR_FILE, TAX_RATE)] =
    "    private const TAX_RATE_BASIS_POINTS = 2000;";
  writeFileSync(join(repo, CALCULATOR_FILE), lines.join("\n"));
}

/**
 * The version of the php pack this build would load, read rather than written down, so a pack bump
 * does not have to remember to come back here. The old version the graph is rewritten to claim is
 * hardcoded on purpose: it is a version that used to exist, not one anybody will bump.
 */
const PHP_PACK_VERSION = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../src/packs/php/pack.json", import.meta.url)), "utf8"),
  ) as { version: string }
).version;

const GRAPH_PATH = ".empo/generated/graph.json";

/** A version that used to exist, which no bump will ever reach again: the graph is behind. */
const PACK_BEHIND = "1.0.0";

/**
 * A version no pack will ever carry, which is the state a checkout back to an older branch leaves,
 * and the state a teammate whose install is behind a committed `generated/` reads. The graph is
 * ahead of the installed pack here, and the note must not call it the older one.
 */
const PACK_AHEAD = "9999.0.0";

/**
 * The graph as if a different php pack had built it, at whatever commit the caller names.
 *
 * The two are set together because pack drift is only interesting where git distance is not: a
 * pack is data, so it moves without a line of the indexed code moving, and the graph it built stays
 * current with HEAD while every answer derived from that pack is the recorded pack's answer.
 *
 * `packs.php` takes null as well, for the graph old enough to predate the recorded versions, which
 * is drift the same way: `built !== loaded` with nothing on the left to name.
 */
function driftThePack(builtAgainst: string, built: string | null = PACK_BEHIND): void {
  const graph = JSON.parse(readFileSync(join(repo, GRAPH_PATH), "utf8")) as {
    builtAgainst: string;
    packs: Record<string, string | null>;
  };
  graph.builtAgainst = builtAgainst;
  graph.packs.php = built;
  writeFileSync(join(repo, GRAPH_PATH), JSON.stringify(graph, null, 2));
}

/** The graph as if an older empo had written it, which is drift no pack version and no sha records. */
function rewriteSchema(schema: number): void {
  const graph = JSON.parse(readFileSync(join(repo, GRAPH_PATH), "utf8")) as { schema: number };
  graph.schema = schema;
  writeFileSync(join(repo, GRAPH_PATH), JSON.stringify(graph, null, 2));
}

/** The bullets of a SessionStart answer, which is the unit every assertion below is written in. */
function bulletsOf(answer: string | null): string[] {
  return (spoke(answer).hookSpecificOutput?.additionalContext ?? "").split("\n");
}

/** An added line in the real test file that asserts an exact value, which is what the gate wants. */
function assertInTest(): void {
  insertAfter(
    ORDER_TEST_FILE,
    "assertSame(1210,",
    "        $this->assertSame(1000, $order->subtotal);",
  );
}

/** A directory with nothing in it at all: no config, no .empo, not a git checkout. */
function emptyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-hook-empty-"));
  temps.push(dir);
  return dir;
}

/** A config and nothing else, which is what a repository looks like before the first empo index. */
function repoWithConfigOnly(): string {
  const dir = emptyRepo();
  mkdirSync(join(dir, ".empo"), { recursive: true });
  writeFileSync(join(dir, ".empo/config.json"), `${JSON.stringify(MINIMAL_CONFIG, null, 2)}\n`);
  return dir;
}

/** A payload as the host sends it: snake_case in, whatever the repo root is on the side. */
function edit(root: string, relPath: string): Record<string, unknown> {
  return { cwd: root, tool_input: { file_path: join(root, relPath) } };
}

function bash(root: string, command: string): Record<string, unknown> {
  return { cwd: root, tool_input: { command } };
}

/**
 * The fixture in a throwaway git repository, committed, ready for an edit to be staged into it.
 *
 * Called per describe rather than once at the top of the file, because the commit-detection table
 * below is 26 cases that touch no repository at all, and paying a fixture copy plus a git init for
 * each of them roughly doubled this file's runtime. That matters beyond this file: the specs share
 * a 5 second default timeout and the slow ones are already close to it.
 */
function useRepo(): void {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "empo-hook-"));
    cpSync(fixture, repo, { recursive: true });
    temps.push(repo);

    git(["init", "-b", "main"]);
    // -f so a global gitignore a EmPo developer plausibly has cannot decide what the diff can show.
    git(["add", "-A", "-f"]);
    commit("the fixture as it stands");
  });
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("detecting a git commit", () => {
  /**
   * Every shape a real commit takes in an agent's Bash call. A miss here is one ungated commit,
   * which is the direction this regex is deliberately biased towards, so each of these is a shape
   * common enough that missing it would leave the gate mostly decorative.
   */
  const COMMITS = [
    "git commit",
    'git commit -m "raise the tax rate"',
    "git commit --amend --no-edit",
    "git -C apps/api commit -m x",
    "git -c user.email=empo@example.com commit -m x",
    'git add -A && git commit -m "x"',
    "git add -A; git commit",
    "cd apps/api && git commit -m x",
    "(git commit)",
    "  git commit",
    "git add -A\ngit commit -m x",
    'git commit -m "fix" || echo failed',
  ];

  /**
   * The half that matters more. Each of these mentions a commit and is not one, and denying any of
   * them would deny work that has nothing to do with EmPo.
   */
  const NOT_COMMITS = [
    "git commit-graph write",
    'echo "git commit"',
    "echo git commit",
    "git log --format=commit",
    "git log --oneline -5",
    "git add src/commit/Order.php",
    "git add commit.php",
    "gitk commit",
    "git status",
    "git push origin main",
    "npm run commit",
    "cat docs/commit-conventions.md",
    "git-commit-helper --dry-run",
    "grep -rn commit src/",
  ];

  test.each(COMMITS)("matches %j", (command) => {
    expect(isGitCommit(command)).toBe(true);
  });

  test.each(NOT_COMMITS)("does not match %j", (command) => {
    expect(isGitCommit(command)).toBe(false);
  });
});

describe("every failure mode is silence", () => {
  useRepo();

  const EVENTS = ["session-start", "pre-edit", "pre-commit"];

  test.each(EVENTS)("%s says nothing when stdin is not JSON", (event) => {
    expect(hookAnswer(event, "not json at all", { repo })).toBeNull();
    expect(hookAnswer(event, "", { repo })).toBeNull();
    // Valid JSON that is not an object is just as unusable, and just as silent.
    expect(hookAnswer(event, "[1,2,3]", { repo })).toBeNull();
    expect(hookAnswer(event, undefined, { repo })).toBeNull();
  });

  test.each(EVENTS)("%s says nothing in a repository with no empo config", (event) => {
    const bare = emptyRepo();
    expect(hookAnswer(event, edit(bare, "src/app.php"), { repo: bare })).toBeNull();
    expect(hookAnswer(event, bash(bare, "git commit -m x"), { repo: bare })).toBeNull();
  });

  test("an event this build does not know is silent, not a usage error", () => {
    // What an old binary sees once a newer one has regenerated settings.json. A usage error there
    // would break every session until the two versions matched again.
    expect(hookAnswer("post-tool-use", { cwd: repo }, { repo })).toBeNull();
    expect(hookAnswer("", { cwd: repo }, { repo })).toBeNull();
  });

  test("an absent tool_input is silent on both PreToolUse events", () => {
    expect(hookAnswer("pre-edit", { cwd: repo }, { repo })).toBeNull();
    expect(hookAnswer("pre-commit", { cwd: repo }, { repo })).toBeNull();
    expect(hookAnswer("pre-edit", { cwd: repo, tool_input: {} }, { repo })).toBeNull();
    expect(hookAnswer("pre-commit", { cwd: repo, tool_input: {} }, { repo })).toBeNull();
    // The wrong shape entirely, which is what a host that renamed a field would send.
    expect(hookAnswer("pre-edit", { cwd: repo, tool_input: "graph.json" }, { repo })).toBeNull();
    expect(
      hookAnswer("pre-edit", { cwd: repo, tool_input: { file_path: 42 } }, { repo }),
    ).toBeNull();
  });

  test("pre-commit is silent when the gate cannot run because there is no git", () => {
    // A spine to gate with and no index to read: empo check raises an environment error here, and
    // the hook has to answer that with nothing rather than with a denial nobody can act on.
    const noGit = mkdtempSync(join(tmpdir(), "empo-hook-nogit-"));
    cpSync(fixture, noGit, { recursive: true });
    temps.push(noGit);
    // Stated rather than assumed: git walks *up*, so a $TMPDIR inside a checkout would give this
    // copy a work tree, the gate would run against that repository's staged diff, and a silence
    // that means "there is nothing staged over there" would be read here as "there is no git".
    expect(run(noGit, "git", ["rev-parse", "--show-toplevel"]).ok).toBe(false);

    expect(hookAnswer("pre-commit", bash(noGit, "git commit -m x"), { repo: noGit })).toBeNull();
  });

  test("pre-edit is silent when the spines cannot be read", () => {
    // A malformed spine is a real state (someone is halfway through editing one) and it must not
    // turn every Edit in the repository into a crash.
    writeFileSync(join(repo, SPINE_PATH), "{ not json");

    expect(hookAnswer("pre-edit", edit(repo, CALCULATOR_FILE), { repo })).toBeNull();
  });
});

describe("empo hook session-start", () => {
  useRepo();

  test("says nothing about a healthy repository", () => {
    // The whole point of the event. A hook that reports good news every session is a hook the team
    // stops reading and then removes.
    expect(hookAnswer("session-start", { cwd: repo }, { repo })).toBeNull();
  });

  test("says nothing in a repository that was never indexed", () => {
    const fresh = repoWithConfigOnly();

    expect(hookAnswer("session-start", { cwd: fresh }, { repo: fresh })).toBeNull();
  });

  test("says nothing when the graph is absent from a repository that is otherwise curated", () => {
    // Config, spines and git all present, and no graph: still the state of a repository that has
    // not run empo index, so it is still not the hook's business. This is the boundary of the note
    // below and it is asserted from the other side, because an unreadable graph and an absent one
    // are one branch apart in engine/health.ts and the easy mistake is to answer both the same way.
    rmSync(join(repo, ".empo/generated"), { recursive: true, force: true });

    expect(hookAnswer("session-start", { cwd: repo }, { repo })).toBeNull();
  });

  test("names an unreadable graph and sends the reader to empo index", () => {
    // The file is there and does not parse, which is what a half-written index, an interrupted
    // write or a bad merge of a committed generated/ leaves behind. health reports state
    // "unreadable" with stale false, no finding and ok true, and that combination used to be
    // indistinguishable from health here: the session opened in silence over a repository where
    // every graph-derived answer is unavailable.
    writeFileSync(join(repo, GRAPH_PATH), "{ this is not a graph\n");

    expect(bulletsOf(hookAnswer("session-start", { cwd: repo }, { repo }))).toEqual([
      "EmPo health:",
      `- the graph at ${GRAPH_PATH} cannot be read, so every answer derived from it is unavailable rather than out of date. It is either not valid JSON or not a graph.`,
      "- Run empo index.",
    ]);
  });

  test("names an unreadable graph when the file is valid JSON and is not a graph", () => {
    // The other half of what engine/health.ts calls unreadable, and the one a parse-only check
    // misses: `[]` is JSON, so nothing throws until the first field is read. The sentence must not
    // claim which of the two it was, because the hook is not the thing that looked.
    writeFileSync(join(repo, GRAPH_PATH), "[]\n");

    expect(bulletsOf(hookAnswer("session-start", { cwd: repo }, { repo }))).toEqual([
      "EmPo health:",
      `- the graph at ${GRAPH_PATH} cannot be read, so every answer derived from it is unavailable rather than out of date. It is either not valid JSON or not a graph.`,
      "- Run empo index.",
    ]);
  });

  test("names the staleness and the command that fixes it when the graph is behind HEAD", () => {
    const graph = JSON.parse(readFileSync(join(repo, ".empo/generated/graph.json"), "utf8")) as {
      builtAgainst: string;
    };
    graph.builtAgainst = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, ".empo/generated/graph.json"), JSON.stringify(graph, null, 2));
    insertAfter(ADMIN_CONTROLLER_FILE, "$pending = new Order();", "        // one more line");
    stage(ADMIN_CONTROLLER_FILE);
    commit("a commit the graph has not seen");

    const answer = spoke(hookAnswer("session-start", { cwd: repo }, { repo }));

    expect(answer.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(answer.hookSpecificOutput?.additionalContext).toContain("1 commit behind HEAD");
    expect(answer.hookSpecificOutput?.additionalContext).toContain("Run empo index.");
    // SessionStart has no permission flow at all, so neither key belongs in the answer.
    expect(answer.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(Object.keys(answer.hookSpecificOutput ?? {})).toEqual([
      "hookEventName",
      "additionalContext",
    ]);
  });

  test("names the pack and both versions when only the pack moved, and claims no git distance", () => {
    // The state this PR creates for every already-indexed repository: the php pack version moved,
    // so the graph is stale on a commit it is exactly current with. commitsBehind is 0 here, and 0
    // is not null, which is how the distance sentence used to open the session with "the graph is
    // 0 commits behind HEAD" and never say a word about the pack.
    driftThePack(git(["rev-parse", "HEAD"]).trim());

    // The whole answer, sentence for sentence. This is the one surface an agent reads without a
    // human in the loop, so a reworded clause has to fail here rather than pass on a fragment.
    expect(bulletsOf(hookAnswer("session-start", { cwd: repo }, { repo }))).toEqual([
      "EmPo health:",
      `- graph built with php pack ${PACK_BEHIND}, ${PHP_PACK_VERSION} is installed, so every answer derived from that pack is the one php pack ${PACK_BEHIND} gives, not the one the installed pack gives. Git distance cannot see a pack version.`,
      "- Run empo index.",
    ]);
  });

  test("does not call the graph's pack the older one when the installed pack is the older one", () => {
    // Drift has no direction: health.ts reports `built !== loaded` either way round. A checkout back
    // to a branch whose pack is behind, and a teammate reading a committed generated/ with an older
    // install, both leave the graph holding the NEWER pack's answers. The note that used to end "is
    // the older pack's answer" was flatly false in both, and it was false in the direction that
    // matters: it tells the reader to distrust the newer answers they already have.
    driftThePack(git(["rev-parse", "HEAD"]).trim(), PACK_AHEAD);

    const bullets = bulletsOf(hookAnswer("session-start", { cwd: repo }, { repo }));

    expect(bullets).toEqual([
      "EmPo health:",
      `- graph built with php pack ${PACK_AHEAD}, ${PHP_PACK_VERSION} is installed, so every answer derived from that pack is the one php pack ${PACK_AHEAD} gives, not the one the installed pack gives. Git distance cannot see a pack version.`,
      "- Run empo index.",
    ]);
    // No age is claimed for either version, in any wording a rewrite might reach for.
    for (const word of ["older", "newer", "out of date", "stale"]) {
      expect(bullets.join("\n")).not.toContain(word);
    }
  });

  test("a graph that never recorded a pack version is not given one, or given an age", () => {
    // A graph old enough to predate the recorded versions. doctor refuses to guess a version here
    // and so does the hook, but the refusal has to reach the consequence too: the clause that once
    // followed spoke of "that pack" and "the older pack" right after saying the graph names neither.
    driftThePack(git(["rev-parse", "HEAD"]).trim(), null);

    const bullets = bulletsOf(hookAnswer("session-start", { cwd: repo }, { repo }));

    expect(bullets).toEqual([
      "EmPo health:",
      `- graph does not record which php pack built it, ${PHP_PACK_VERSION} is installed, so nothing in the graph says whether its answers are the ones the installed pack gives. Git distance cannot see a pack version.`,
      "- Run empo index.",
    ]);
    expect(bullets.join("\n")).not.toContain("older");
  });

  test("names a graph an older empo wrote, and refuses to say which fields moved under it", () => {
    // The staleness neither git nor a pack version can hold. A schema bump records that a field the
    // readers already knew kept its name and changed its meaning (src/engine/graph.ts), and the file
    // carries no list of which fields those were, only the two numbers. So the note names both and
    // stops: naming the answers to distrust would be inventing the one thing nothing on disk records.
    rewriteSchema(1);

    expect(bulletsOf(hookAnswer("session-start", { cwd: repo }, { repo }))).toEqual([
      "EmPo health:",
      `- graph was written at schema 1, this empo writes schema ${GRAPH_SCHEMA}, so a field it records may not mean what this empo reads it to mean. Nothing in the file says which fields those are.`,
      "- Run empo index.",
    ]);
  });

  test("says both when the graph is behind HEAD and the pack has moved as well", () => {
    // Two independent reasons the answers on disk are wrong, and hearing only one of them sends
    // someone to reindex for half a reason and to distrust the other half when it survives.
    insertAfter(ADMIN_CONTROLLER_FILE, "$pending = new Order();", "        // one more line");
    stage(ADMIN_CONTROLLER_FILE);
    const before = git(["rev-parse", "HEAD"]).trim();
    commit("a commit the graph has not seen");
    driftThePack(before);

    const bullets = bulletsOf(hookAnswer("session-start", { cwd: repo }, { repo }));

    // One rebuild repairs both, so the instruction is one bullet and the two reasons are the two
    // above it. The pack note also has to stop claiming the graph is current with HEAD, because
    // here it is not, and the two notes were contradicting each other one line apart.
    expect(bullets).toEqual([
      "EmPo health:",
      "- the graph is 1 commit behind HEAD, so every answer it gives is that far out of date.",
      `- graph built with php pack ${PACK_BEHIND}, ${PHP_PACK_VERSION} is installed, so every answer derived from that pack is the one php pack ${PACK_BEHIND} gives, not the one the installed pack gives. Git distance cannot see a pack version.`,
      "- Run empo index.",
    ]);
    expect(bullets.filter((bullet) => bullet.includes("empo index"))).toHaveLength(1);
    expect(bullets.join("\n")).not.toContain("current with HEAD");
  });

  test("a warn-level finding reaches the session the way a drifted spine does", () => {
    // The guard used to open with `health.ok`, which is false only for an error-level finding, so
    // every warning in engine/health.ts was unreachable from here: the notes below are built from
    // `health.findings` and the guard returned before any of them was read. A drifted spine escaped
    // only because the guard separately counted `spines.soft + spines.hard`, which happened to be a
    // second way of saying "there is a finding" for that one kind of finding.
    //
    // An unmapped directory is the warning that had no such second route. It means a whole directory
    // is under no root, so nothing in it is in the graph at all, and every blast radius the agent is
    // about to ask for silently excludes it. That is precisely a thing to open a session with.
    mkdirSync(join(repo, "tools"), { recursive: true });
    writeFileSync(join(repo, "tools/release.sh"), "#!/bin/sh\n");

    // The whole answer, so the note arrives on its own rather than beside a graph the copy happens
    // to have made stale as well.
    expect(bulletsOf(hookAnswer("session-start", { cwd: repo }, { repo }))).toEqual([
      "EmPo health:",
      '- directory "tools" is under no root, nothing in it is indexed',
    ]);
  });

  test("names a drifted spine and sends the reader to empo verify", () => {
    const spine = JSON.parse(readFileSync(join(repo, SPINE_PATH), "utf8")) as {
      hops: { line: number }[];
    };
    // The anchor is still in the file, five lines from where the spine claims it: soft drift, which
    // is the one that misleads quietly and so is exactly what a session should open by saying.
    (spine.hops[0] as { line: number }).line = 1;
    writeFileSync(join(repo, SPINE_PATH), JSON.stringify(spine, null, 2));

    const answer = spoke(hookAnswer("session-start", { cwd: repo }, { repo }));

    expect(answer.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(answer.hookSpecificOutput?.additionalContext).toContain('spine "pricing" has drifted');
    expect(answer.hookSpecificOutput?.additionalContext).toContain("Run empo verify.");
    // Only what is wrong: the graph is fine here, so the graph is not mentioned.
    expect(answer.hookSpecificOutput?.additionalContext).not.toContain("empo index");
  });

  test("reads the payload as raw stdin text, which is how the host really sends it", () => {
    expect(hookAnswer("session-start", JSON.stringify({ cwd: repo }), {})).toBeNull();
  });
});

describe("empo hook pre-edit", () => {
  useRepo();

  test("denies a write under .empo/generated and says who owns it", () => {
    const answer = spoke(
      hookAnswer("pre-edit", edit(repo, ".empo/generated/graph.json"), { repo }),
    );

    expect(Object.keys(answer)).toEqual(["hookSpecificOutput"]);
    expect(answer.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");

    const reason = answer.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(reason).toContain(".empo/generated/graph.json is machine-owned");
    expect(reason).toContain("only empo index writes");
    // The repair, or the agent denies once and then tries again with a different tool.
    expect(reason).toContain("fix the config or the language pack that produced it");
  });

  test("denies the directory itself and anything deeper in it", () => {
    for (const path of [".empo/generated", ".empo/generated/packs.lock.json"]) {
      const answer = spoke(hookAnswer("pre-edit", edit(repo, path), { repo }));
      expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
    }
  });

  test("denies it in a repository with no config at all, because ownership does not depend on one", () => {
    const bare = emptyRepo();

    const answer = spoke(
      hookAnswer("pre-edit", edit(bare, ".empo/generated/graph.json"), { repo: bare }),
    );

    expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("warns on a guarded file through both channels and never decides a permission", () => {
    const answer = spoke(hookAnswer("pre-edit", edit(repo, CALCULATOR_FILE), { repo }));

    // Both channels, and this is the assertion that catches somebody deleting one as redundant:
    // additionalContext on PreToolUse without a permission decision is undocumented, so the human
    // facing systemMessage is what keeps the warning from degrading to nothing.
    expect(answer.systemMessage).toContain(CALCULATOR_FILE);
    expect(answer.systemMessage).toContain('"pricing"');
    expect(answer.hookSpecificOutput?.hookEventName).toBe("PreToolUse");

    const context = answer.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain(CALCULATOR_FILE);
    expect(context).toContain("pricing");
    // The spine's own path, so the agent can open the map rather than guess at it.
    expect(context).toContain(SPINE_PATH);
    // And what the next gate will want, because that is the next thing that happens to this change.
    for (const term of TERMS) expect(context).toContain(term);

    // The permission flow stays untouched: a decision here would prompt or block an ordinary edit.
    expect(answer.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toBeUndefined();
    expect(Object.keys(answer.hookSpecificOutput ?? {})).toEqual([
      "hookEventName",
      "additionalContext",
    ]);
  });

  test("names the test files a spine scopes itself to, so the warning matches the gate", () => {
    // The pre-edit warning tells an agent what `empo check` is about to want, and a spine that
    // curates `assertionPaths` wants a line in one named file rather than in any test at all. Left
    // out here, the hook would send an agent to write a test the gate then refuses, which is worse
    // than saying nothing: three surfaces print this sentence and they have to print one rule.
    const spine = JSON.parse(readFileSync(join(repo, SPINE_PATH), "utf8")) as Record<
      string,
      unknown
    >;
    spine.assertionPaths = [ORDER_TEST_FILE];
    writeFileSync(join(repo, SPINE_PATH), `${JSON.stringify(spine, null, 2)}\n`);

    const answer = spoke(hookAnswer("pre-edit", edit(repo, CALCULATOR_FILE), { repo }));
    const context = answer.hookSpecificOutput?.additionalContext ?? "";

    for (const term of TERMS) expect(context).toContain(term);
    expect(context).toContain(`in ${ORDER_TEST_FILE}`);
  });

  test("still matches when the root arrives as a symlink and the file path does not", () => {
    // The default on macOS for anything under /tmp, and a mismatch fails in the one direction a
    // gate may never fail: the deny and the warning both silently stop firing.
    const link = join(mkdtempSync(join(tmpdir(), "empo-hook-link-")), "project");
    temps.push(link);
    symlinkSync(repo, link, "dir");
    const realPath = join(realpathSync(repo), CALCULATOR_FILE);

    const answer = spoke(
      hookAnswer("pre-edit", { cwd: link, tool_input: { file_path: realPath } }, { repo: link }),
    );

    expect(answer.hookSpecificOutput?.additionalContext).toContain(CALCULATOR_FILE);
  });

  test("says nothing about an ordinary source file", () => {
    expect(hookAnswer("pre-edit", edit(repo, ADMIN_CONTROLLER_FILE), { repo })).toBeNull();
    expect(hookAnswer("pre-edit", edit(repo, "apps/api/routes/api.php"), { repo })).toBeNull();
  });

  test("says nothing about a path outside the repository", () => {
    // Relativizing first is what stops a sibling checkout's generated directory, or a home directory
    // file that happens to sit under a path with the same tail, from matching a repo-relative rule.
    const outside = emptyRepo();
    mkdirSync(join(outside, ".empo/generated"), { recursive: true });

    const payload = {
      cwd: repo,
      tool_input: { file_path: join(outside, ".empo/generated/graph.json") },
    };
    expect(hookAnswer("pre-edit", payload, { repo })).toBeNull();

    expect(
      hookAnswer("pre-edit", { cwd: repo, tool_input: { file_path: "/etc/hosts" } }, { repo }),
    ).toBeNull();
    // The repository root itself is not a file anybody edits, and it is not inside itself.
    expect(
      hookAnswer("pre-edit", { cwd: repo, tool_input: { file_path: repo } }, { repo }),
    ).toBeNull();
  });
});

describe("empo hook pre-commit", () => {
  useRepo();

  test("says nothing about a command that is not a commit", () => {
    changeTaxRate();
    stage(CALCULATOR_FILE);

    // The gate would fail right now, so anything printed here would be printed for the wrong reason.
    expect(hookAnswer("pre-commit", bash(repo, "git status"), { repo })).toBeNull();
    expect(hookAnswer("pre-commit", bash(repo, 'echo "git commit"'), { repo })).toBeNull();
  });

  test("denies a commit that moves a guarded value with nothing asserting it", () => {
    changeTaxRate();
    stage(CALCULATOR_FILE);

    const answer = spoke(
      hookAnswer("pre-commit", bash(repo, 'git commit -m "raise the tax rate"'), { repo }),
    );

    expect(Object.keys(answer)).toEqual(["hookSpecificOutput"]);
    expect(answer.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");

    const reason = answer.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(reason).toContain("empo check gates this commit");
    expect(reason).toContain("pricing");
    expect(reason).toContain(SPINE_PATH);
    expect(reason).toContain(CALCULATOR_FILE);
    for (const term of TERMS) expect(reason).toContain(term);
    // The way through, stated, or the agent's next move is to work around the gate instead of
    // through it.
    expect(reason).toContain('empo check --bypass "<reason>"');
  });

  test("says nothing when the same change adds an asserting line to a test", () => {
    changeTaxRate();
    assertInTest();
    stage(CALCULATOR_FILE, ORDER_TEST_FILE);

    expect(hookAnswer("pre-commit", bash(repo, "git commit -m x"), { repo })).toBeNull();
  });

  test("says nothing when nothing guarded is staged", () => {
    insertAfter(ADMIN_CONTROLLER_FILE, "$pending = new Order();", "        // an admin note");
    stage(ADMIN_CONTROLLER_FILE);

    expect(hookAnswer("pre-commit", bash(repo, "git commit -m x"), { repo })).toBeNull();
  });

  test("reads the spines from disk, so unstaging the spine file cannot dodge it", () => {
    // The gate's load-bearing property (docs/06-cli.md), asserted through the hook because the hook
    // is where an agent would most plausibly try it: the spine leaves the index and stays on disk,
    // which is what "unstage the spine" means, and the gate reads the disk.
    changeTaxRate();
    stage(CALCULATOR_FILE);
    git(["rm", "--cached", SPINE_PATH]);

    const answer = spoke(hookAnswer("pre-commit", bash(repo, "git commit -m x"), { repo }));

    expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("which repository the hook is answering about", () => {
  useRepo();

  test("prefers --repo, which the generated settings.json fills from CLAUDE_PROJECT_DIR", () => {
    // The payload points at a directory with no config, so if cwd won this would be silent. The
    // flag is what the host fills from the project root, and a tool run from a subdirectory would
    // otherwise answer about the wrong tree.
    const elsewhere = emptyRepo();
    const payload = { cwd: elsewhere, tool_input: { file_path: join(repo, CALCULATOR_FILE) } };

    const answer = spoke(hookAnswer("pre-edit", payload, { repo }));

    expect(answer.hookSpecificOutput?.additionalContext).toContain("pricing");
  });

  test("falls back to the payload's cwd when --repo is absent or empty", () => {
    const byCwd = hookAnswer("pre-edit", edit(repo, CALCULATOR_FILE), {});
    expect(spoke(byCwd).hookSpecificOutput?.additionalContext).toContain("pricing");

    const blankFlag = hookAnswer("pre-edit", edit(repo, CALCULATOR_FILE), { repo: "   " });
    expect(spoke(blankFlag).hookSpecificOutput?.additionalContext).toContain("pricing");
  });
});

describe("the payload really arriving on stdin", () => {
  useRepo();

  /**
   * The seam every other test in this file skips past, and the one that runs in production: the host
   * pipes JSON in and reads whatever comes back on stdout. Everything above proves what the answer
   * is; this proves it is written, once, and that silence really is nothing printed rather than an
   * empty line a parser would choke on.
   */
  async function pipe(event: string, payload: unknown, options: HookOptions): Promise<string[]> {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from(JSON.stringify(payload), "utf8")]),
      configurable: true,
    });

    try {
      await hookCommand(event, options);
    } finally {
      if (stdin !== undefined) Object.defineProperty(process, "stdin", stdin);
      log.mockRestore();
    }
    return lines;
  }

  test("writes exactly one line of JSON when there is something to say", async () => {
    const lines = await pipe("pre-edit", edit(repo, ".empo/generated/graph.json"), { repo });

    expect(lines).toHaveLength(1);
    const answer = JSON.parse(lines[0] as string) as HookOutput;
    expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("writes nothing at all on the happy path", async () => {
    expect(await pipe("pre-edit", edit(repo, ADMIN_CONTROLLER_FILE), { repo })).toEqual([]);
  });
});
