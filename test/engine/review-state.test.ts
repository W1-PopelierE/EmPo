import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { emptySnapshot, readReviewState } from "../../src/engine/review-state";
import { recordRound } from "../../src/engine/rounds";
import { activityPath, sessionDir } from "../../src/engine/session";

/**
 * `recordRound` falls back to `homedir()` when the OS temp root is not private
 * (test/engine/rounds.test.ts explains why). Redirected to a sandbox so a run on a machine where
 * that fallback fires never writes rounds under the real `~/.empo`. `tmpdir()` itself is left alone:
 * `session.ts` fixes its `ROOT` from `tmpdir()` at module load, before any per-test mock value could
 * apply, so `sessionDir` always resolves against the real temp root regardless — redirecting it here
 * would only desync the two.
 */
const roots = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => (roots.home === "" ? actual.homedir() : roots.home) };
});

const temps: string[] = [];

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 export { x };
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,2 @@
 const z = 3;
+const w = 4;
`;

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-state-"));
  temps.push(dir);
  return dir;
}

/** A session on disk exactly as phase 1 leaves it. */
function startReview(root: string): string {
  const dir = sessionDir(root, "local");
  mkdirSync(dir, { recursive: true });
  temps.push(dir);
  writeFileSync(join(dir, "pr-local.diff"), DIFF, "utf8");
  writeSession(dir, root);
  return dir;
}

/** The session file phase 1 leaves, with whichever field a test needs to say differently. */
function writeSession(dir: string, root: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, "session.json"),
    JSON.stringify({
      id: "local",
      repoRoot: root,
      readRoot: root,
      worktree: null,
      base: "main",
      sourceBranch: "feat/x",
      sha: "abc123",
      tree: "def456",
      diffPath: join(dir, "pr-local.diff"),
      ...overrides,
    }),
    "utf8",
  );
}

function log(root: string, lines: { tool: string; path: string }[]): void {
  writeFileSync(
    activityPath(root),
    `${lines.map((one) => JSON.stringify({ at: new Date().toISOString(), ...one })).join("\n")}\n`,
    "utf8",
  );
}

/** Like `log`, but the caller picks each line's `at` instead of stamping it with "now". */
function logAt(root: string, lines: { at: string; tool: string; path: string }[]): void {
  writeFileSync(
    activityPath(root),
    `${lines.map((one) => JSON.stringify(one)).join("\n")}\n`,
    "utf8",
  );
}

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "empo-state-home-"));
  temps.push(home);
  roots.home = home;
});

afterEach(() => {
  roots.home = "";
  for (const dir of temps.splice(0)) {
    // The activity log lives beside the sessions in the OS temp root, keyed on the repository path
    // and never deleted by anything in `src`, so a test repo that is not swept here leaks one file
    // per run into a directory `sessionDirs` enumerates on every Read the hook sees. Computed while
    // the directory still exists, since the key runs through `realpathSync`.
    rmSync(activityPath(dir), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("with no review running", () => {
  test("is idle and says nothing else", () => {
    const state = readReviewState(repo(), emptySnapshot());

    expect(state.phase).toBe("idle");
    expect(state.session).toBeNull();
    expect(state.files).toEqual([]);
  });
});

describe("once phase 1 has written the brief", () => {
  test("reads the diff and reports the changed files", () => {
    const root = repo();
    startReview(root);

    const state = readReviewState(root, emptySnapshot());

    expect(state.phase).toBe("brief");
    expect(state.session?.base).toBe("main");
    expect(state.files.map((one) => one.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(state.files[0]?.addedCount).toBe(1);
    expect(state.files.every((one) => one.read)).toBe(false);
  });

  test("turns to reading once the reviewer opens something, and marks which files it opened", () => {
    const root = repo();
    startReview(root);
    log(root, [
      { tool: "Read", path: "src/a.ts" },
      { tool: "Read", path: "src/engine/git.ts" },
    ]);

    const state = readReviewState(root, emptySnapshot());

    expect(state.phase).toBe("reading");
    expect(state.files.find((one) => one.path === "src/a.ts")?.read).toBe(true);
    expect(state.files.find((one) => one.path === "src/b.ts")?.read).toBe(false);
    expect(state.readOutsideDiff).toEqual(["src/engine/git.ts"]);
    expect(state.activity).toHaveLength(2);
  });

  test("ignores activity left over from a review that finished before this one started", () => {
    const root = repo();
    const dir = startReview(root);
    // Written after the session directory, but stamped as if it happened long before this
    // session existed — exactly what a previous review's unpruned log line looks like.
    logAt(root, [{ at: new Date(0).toISOString(), tool: "Read", path: "src/a.ts" }]);
    // Confirm the fixture actually is older than session.json's mtime, not just older in string form.
    expect(new Date(0).getTime()).toBeLessThan(statSync(join(dir, "session.json")).mtimeMs);

    const state = readReviewState(root, emptySnapshot());

    expect(state.phase).toBe("brief");
    expect(state.activity).toEqual([]);
    expect(state.files.every((one) => one.read)).toBe(false);
  });

  test("keeps only the most recent 200 activity lines", () => {
    const root = repo();
    startReview(root);
    const base = Date.now() + 60_000; // comfortably after session.json's mtime
    const lines = Array.from({ length: 250 }, (_, index) => ({
      at: new Date(base + index).toISOString(),
      tool: "Read",
      path: `src/file-${index}.ts`,
    }));
    logAt(root, lines);

    const state = readReviewState(root, emptySnapshot());

    expect(state.activity).toHaveLength(200);
    expect(state.activity[0]?.path).toBe("src/file-50.ts");
    expect(state.activity.at(-1)?.path).toBe("src/file-249.ts");
  });
});

// A pull request is reviewed out of a detached worktree under the OS temp directory, so the hook —
// which knows the repository and not the session — cannot make those reads repo-relative and logs
// them absolute. Without resolving them against the session's read root, `opened` and the diff's
// repo-relative paths never intersect: every changed file reads as unread forever and every one of
// them also shows up under "read outside the diff".
describe("on a pull request, whose read root is a worktree outside the repository", () => {
  test("counts a worktree read as the changed file the diff names", () => {
    const root = repo();
    const dir = startReview(root);
    const readRoot = join(dir, "worktree");
    mkdirSync(readRoot, { recursive: true });
    writeSession(dir, root, { readRoot, worktree: readRoot });
    log(root, [
      { tool: "Read", path: join(readRoot, "src/a.ts") },
      { tool: "Read", path: join(readRoot, "src/elsewhere.ts") },
    ]);

    const state = readReviewState(root, emptySnapshot());

    expect(state.files.find((one) => one.path === "src/a.ts")?.read).toBe(true);
    expect(state.files.find((one) => one.path === "src/b.ts")?.read).toBe(false);
    expect(state.readOutsideDiff).toEqual(["src/elsewhere.ts"]);
    expect(state.activity.map((one) => one.path)).toEqual(["src/a.ts", "src/elsewhere.ts"]);
  });

  test("leaves a path under neither root alone rather than mangling it", () => {
    const root = repo();
    const dir = startReview(root);
    const readRoot = join(dir, "worktree");
    mkdirSync(readRoot, { recursive: true });
    writeSession(dir, root, { readRoot, worktree: readRoot });
    log(root, [{ tool: "Read", path: "/etc/hosts" }]);

    const state = readReviewState(root, emptySnapshot());

    expect(state.readOutsideDiff).toEqual(["/etc/hosts"]);
  });
});

describe("once the reviewer has written findings", () => {
  function writeFindings(dir: string, ids: string[]): void {
    writeFileSync(
      join(dir, "findings.json"),
      JSON.stringify({
        findings: ids.map((id) => ({
          id,
          kind: "diff",
          severity: "major",
          title: `${id} title`,
          claim: `${id} claim`,
          citation: { file: "src/a.ts", line: 2, anchor: "const y = 2;" },
          introducedBy: { file: "src/a.ts", line: 2, anchor: "const y = 2;" },
          suggestion: `${id} suggestion`,
        })),
      }),
      "utf8",
    );
  }

  test("shows them all as unjudged before the gate has run", () => {
    const root = repo();
    const dir = startReview(root);
    log(root, [{ tool: "Read", path: "src/a.ts" }]);
    writeFindings(dir, ["f1", "f2"]);

    const state = readReviewState(root, emptySnapshot());

    expect(state.phase).toBe("findings");
    expect(state.findings.map((one) => one.survived)).toEqual([null, null]);
    expect(state.findings[0]?.claim).toBe("f1 claim");
    expect(state.files.find((one) => one.path === "src/a.ts")?.findingCount).toBe(2);
  });

  test("marks survivors and dropped once a round record exists, keeping the full text of both", () => {
    const root = repo();
    const dir = startReview(root);
    writeFindings(dir, ["f1", "f2"]);
    recordRound(root, "feat/x", "abc123", "def456", "local", [
      { id: "f1", kind: "diff", severity: "major", title: "f1 title", file: "src/a.ts", line: 2 },
    ]);

    const state = readReviewState(root, emptySnapshot());

    expect(state.phase).toBe("gated");
    expect(state.round).toBe(1);
    expect(state.findings.find((one) => one.id === "f1")?.survived).toBe(true);
    expect(state.findings.find((one) => one.id === "f2")?.survived).toBe(false);
    // The point of the crossing: the dropped one still has the text the round record does not keep.
    expect(state.findings.find((one) => one.id === "f2")?.claim).toBe("f2 claim");
  });

  test("keeps showing the last review after the session directory went away", () => {
    const root = repo();
    const dir = startReview(root);
    writeFindings(dir, ["f1"]);
    const before = readReviewState(root, emptySnapshot());

    rmSync(dir, { recursive: true, force: true });
    const after = readReviewState(root, before);

    // No round was recorded, so this is a review that stopped, not one that was judged.
    expect(after.phase).toBe("findings");
    expect(after.files.map((one) => one.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(after.note).toContain("session finished");
  });

  // The gate records the round and deletes the session twenty lines later, so a poll at any sane
  // interval sees the findings before it and the round after, and practically never both at once.
  // Without the crossing on the way past, the verdict the whole viewer exists to show never renders.
  test("crosses the round into the carried findings when the gate deleted the session first", () => {
    const root = repo();
    const dir = startReview(root);
    writeFindings(dir, ["f1", "f2"]);
    const before = readReviewState(root, emptySnapshot());
    expect(before.findings.every((one) => one.survived === null)).toBe(true);

    recordRound(root, "feat/x", "abc123", "def456", "local", [
      { id: "f1", kind: "diff", severity: "major", title: "f1 title", file: "src/a.ts", line: 2 },
    ]);
    rmSync(dir, { recursive: true, force: true });
    const after = readReviewState(root, before);

    expect(after.phase).toBe("gated");
    expect(after.round).toBe(1);
    expect(after.findings.find((one) => one.id === "f1")?.survived).toBe(true);
    expect(after.findings.find((one) => one.id === "f2")?.survived).toBe(false);
    expect(after.findings.find((one) => one.id === "f2")?.claim).toBe("f2 claim");
  });

  // `recordRound` writes `tree ?? sha`, so a session whose tree git could not answer for is found
  // again by its sha. Reading only `tree` here matched nothing and left the verdict unshown.
  test("crosses a round recorded under the sha when the session has no tree", () => {
    const root = repo();
    const dir = startReview(root);
    writeSession(dir, root, { tree: null });
    writeFindings(dir, ["f1"]);
    const before = readReviewState(root, emptySnapshot());

    recordRound(root, "feat/x", "abc123", null, "local", [
      { id: "f1", kind: "diff", severity: "major", title: "f1 title", file: "src/a.ts", line: 2 },
    ]);
    rmSync(dir, { recursive: true, force: true });
    const after = readReviewState(root, before);

    expect(after.round).toBe(1);
    expect(after.findings[0]?.survived).toBe(true);
  });

  // Phase 2 can be handed a findings file outside the session directory, in which case the viewer
  // never read one. Showing the round with no findings at all would report a review that found
  // nothing, which is the opposite of what the gate just recorded.
  test("shows a survivor the carried snapshot never held", () => {
    const root = repo();
    const dir = startReview(root);
    const before = readReviewState(root, emptySnapshot());
    expect(before.findings).toEqual([]);

    recordRound(root, "feat/x", "abc123", "def456", "local", [
      { id: "f1", kind: "diff", severity: "major", title: "f1 title", file: "src/a.ts", line: 2 },
    ]);
    rmSync(dir, { recursive: true, force: true });
    const after = readReviewState(root, before);

    expect(after.round).toBe(1);
    expect(after.findings.map((one) => [one.id, one.survived, one.title])).toEqual([
      ["f1", true, "f1 title"],
    ]);
  });

  // Matched on the tree phase 1 read, so a round from an earlier review of the same branch cannot
  // be read as this one's verdict and mark findings a gate never saw.
  test("leaves the carried findings ungraded when the only round is from another tree", () => {
    const root = repo();
    const dir = startReview(root);
    writeFindings(dir, ["f1"]);
    const before = readReviewState(root, emptySnapshot());

    recordRound(root, "feat/x", "abc123", "other-tree", "local", [
      { id: "f1", kind: "diff", severity: "major", title: "f1 title", file: "src/a.ts", line: 2 },
    ]);
    rmSync(dir, { recursive: true, force: true });
    const after = readReviewState(root, before);

    expect(after.round).toBeNull();
    expect(after.findings[0]?.survived).toBeNull();
  });

  // A round record with no session and no previous snapshot cannot be crossed with anything: with
  // no session directory there is no sourceBranch to read the record with, so the viewer stays idle
  // rather than showing a review it arrived too late to have witnessed.
  test("stays idle for a round record left with no session and no previous snapshot", () => {
    const root = repo();
    recordRound(root, "feat/x", "abc123", "def456", "local", [
      { id: "f1", kind: "diff", severity: "minor", title: "f1 title", file: "src/a.ts", line: 2 },
    ]);

    const state = readReviewState(root, emptySnapshot());

    expect(state.phase).toBe("idle");
    expect(state.findings).toEqual([]);
  });
});

// The session directory disappearing is not a verdict. `empo review --reset` deletes it, and so
// does an abort, and calling that "gated" tells the reader a gate judged findings it never saw.
describe("when the session went away without a gate", () => {
  test("carries the last live phase forward instead of claiming a gate ran", () => {
    const root = repo();
    const dir = startReview(root);
    log(root, [{ tool: "Read", path: "src/a.ts" }]);
    const before = readReviewState(root, emptySnapshot());
    expect(before.phase).toBe("reading");

    rmSync(dir, { recursive: true, force: true });
    const after = readReviewState(root, before);

    expect(after.phase).toBe("reading");
    expect(after.round).toBeNull();
    expect(after.note).toContain("session finished");
  });

  // The sibling case, and the one that must keep saying "gated": a gate that dropped everything
  // records a round with no findings, which is a verdict and not an absence of one.
  test("still reads as gated when the round it crossed found nothing", () => {
    const root = repo();
    const dir = startReview(root);
    const before = readReviewState(root, emptySnapshot());

    recordRound(root, "feat/x", "abc123", "def456", "local", []);
    rmSync(dir, { recursive: true, force: true });
    const after = readReviewState(root, before);

    expect(after.phase).toBe("gated");
    expect(after.round).toBe(1);
    expect(after.findings).toEqual([]);
  });
});
