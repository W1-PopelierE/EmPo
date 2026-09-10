import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
function startReview(root: string, id = "local"): string {
  const dir = sessionDir(root, id);
  mkdirSync(dir, { recursive: true });
  temps.push(dir);
  writeFileSync(join(dir, `pr-${id}.diff`), DIFF, "utf8");
  writeSession(dir, root, { id, diffPath: join(dir, `pr-${id}.diff`) });
  return dir;
}

/**
 * Makes a session look older than the one beside it. `sessionDirs` sorts on session.json's mtime,
 * and two sessions a test creates land in the same millisecond, so "newest" would otherwise be
 * whichever order readdir happened to return. Call it after the session has been written: rewriting
 * session.json afterwards stamps the mtime back to now.
 */
function backdate(dir: string, ms: number): void {
  utimesSync(join(dir, "session.json"), new Date(), new Date(Date.now() - ms));
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

/** `findings.json` as phase 1 leaves it, one finding per id, all citing the same changed line. */
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

// The activity log is one file per repository, so a second review running at the same time writes
// into it too. Filtering on time alone let those lines through: a PR review reading its worktree
// made the local review next to it look like it had opened files it never touched, and dragged its
// phase from "brief" to "reading". A line belongs to the session whose read root claims it deepest.
describe("with a second review live in the same repository", () => {
  /** A PR session, which reads out of its own detached worktree rather than the checkout. */
  function startPrReview(root: string, id: string): { dir: string; readRoot: string } {
    const dir = startReview(root, id);
    const readRoot = join(dir, "worktree");
    mkdirSync(readRoot, { recursive: true });
    writeSession(dir, root, {
      id,
      readRoot,
      worktree: readRoot,
      diffPath: join(dir, `pr-${id}.diff`),
    });
    return { dir, readRoot };
  }

  test("drops a read that happened inside the other session's read root", () => {
    const root = repo();
    const local = startReview(root);
    const { readRoot } = startPrReview(root, "1234");
    backdate(local, 60_000);
    log(root, [
      { tool: "Read", path: join(readRoot, "src/a.ts") },
      { tool: "Read", path: join(readRoot, "src/elsewhere.ts") },
    ]);

    const state = readReviewState(root, emptySnapshot(), basename(local));

    expect(state.session?.id).toBe("local");
    expect(state.activity).toEqual([]);
    expect(state.readOutsideDiff).toEqual([]);
    expect(state.files.every((one) => one.read)).toBe(false);
    expect(state.phase).toBe("brief");
  });

  test("keeps a read that happened inside its own read root", () => {
    const root = repo();
    const local = startReview(root);
    const { dir, readRoot } = startPrReview(root, "1234");
    backdate(local, 60_000);
    log(root, [{ tool: "Read", path: join(readRoot, "src/a.ts") }]);

    const state = readReviewState(root, emptySnapshot(), basename(dir));

    expect(state.session?.id).toBe("1234");
    expect(state.activity.map((one) => one.path)).toEqual(["src/a.ts"]);
    expect(state.files.find((one) => one.path === "src/a.ts")?.read).toBe(true);
  });

  test("keeps a path no read root claims rather than dropping it", () => {
    const root = repo();
    const local = startReview(root);
    startPrReview(root, "1234");
    backdate(local, 60_000);
    log(root, [{ tool: "Read", path: "/etc/hosts" }]);

    const state = readReviewState(root, emptySnapshot(), basename(local));

    expect(state.readOutsideDiff).toEqual(["/etc/hosts"]);
  });

  // Two local reviews of one checkout read literally the same files, so nothing on disk can say
  // which of them opened one. Showing the line to both is the documented behaviour, not a bug:
  // an undecidable attribution is more useful visible in two places than thrown away.
  test("shows a line to both sessions when they share a read root", () => {
    const root = repo();
    const first = startReview(root, "local");
    const second = startReview(root, "local-2");
    backdate(first, 60_000);
    log(root, [{ tool: "Read", path: join(root, "src/a.ts") }]);

    for (const key of [basename(first), basename(second)]) {
      const state = readReviewState(root, emptySnapshot(), key);
      expect(state.activity.map((one) => one.path)).toEqual(["src/a.ts"]);
      expect(state.files.find((one) => one.path === "src/a.ts")?.read).toBe(true);
    }
  });

  test("follows the selected session, and falls back to the newest for a key nobody has", () => {
    const root = repo();
    const local = startReview(root);
    startPrReview(root, "1234");
    backdate(local, 60_000);

    expect(readReviewState(root, emptySnapshot(), basename(local)).session?.id).toBe("local");
    expect(readReviewState(root, emptySnapshot(), "swept-away").session?.id).toBe("1234");
    expect(readReviewState(root, emptySnapshot(), null).session?.id).toBe("1234");
    expect(readReviewState(root, emptySnapshot()).session?.id).toBe("1234");
  });

  test("offers every live session newest first, with what the switcher has to name it", () => {
    const root = repo();
    const local = startReview(root);
    const { dir } = startPrReview(root, "1234");
    backdate(local, 60_000);

    const state = readReviewState(root, emptySnapshot());

    expect(state.sessions).toEqual([
      { key: basename(dir), id: "1234", branch: "feat/x", phase: "brief" },
      { key: basename(local), id: "local", branch: "feat/x", phase: "brief" },
    ]);
    expect(state.selected).toBe(basename(dir));
    // The switcher shows what is live now, so the note that used to count sessions is gone.
    expect(state.note).toBeNull();
  });

  // The switcher shows each review's phase, so every live session's phase is derived, not just the
  // selected one's — and derived from the same three sources, in the same order of precedence.
  test("derives a phase for every live session, not only the selected one", () => {
    const root = repo();
    const brief = startReview(root, "local");
    const { dir: reading, readRoot } = startPrReview(root, "1234");
    const findings = startReview(root, "1240");
    writeFindings(findings, ["f1"]);
    const gated = startReview(root, "1250");
    writeSession(gated, root, {
      id: "1250",
      sourceBranch: "fix/gate",
      diffPath: join(gated, "pr-1250.diff"),
    });
    recordRound(root, "fix/gate", "abc123", "def456", "1250", []);
    log(root, [{ tool: "Read", path: join(readRoot, "src/a.ts") }]);
    backdate(brief, 90_000);
    backdate(reading, 60_000);
    backdate(findings, 30_000);

    const state = readReviewState(root, emptySnapshot(), basename(brief));

    console.log(
      "DIAG " +
        JSON.stringify({
          mtimes: [brief, reading, findings, gated].map((d) => [
            basename(d),
            statSync(join(d, "session.json")).mtimeMs,
          ]),
          got: state.sessions.map((one) => one.id),
        }),
    );

    expect(state.phase).toBe("brief");
    expect(state.sessions.map((one) => [one.id, one.phase])).toEqual([
      ["1250", "gated"],
      ["1240", "findings"],
      ["1234", "reading"],
      ["local", "brief"],
    ]);
  });

  // The same attribution bug as in `activity`, one level up: a session that has read nothing must
  // not be shown as "reading" because the review beside it is busy in its own worktree.
  test("leaves a session at brief while the session beside it is the one reading", () => {
    const root = repo();
    const local = startReview(root);
    const { readRoot } = startPrReview(root, "1234");
    backdate(local, 60_000);
    log(root, [{ tool: "Read", path: join(readRoot, "src/a.ts") }]);

    const state = readReviewState(root, emptySnapshot(), basename(local));

    expect(state.sessions.map((one) => [one.id, one.phase])).toEqual([
      ["1234", "reading"],
      ["local", "brief"],
    ]);
  });

  // `roundsDir` keys on repository and branch alone, and a pull request reviewed from the branch
  // you are standing on carries the same `sourceBranch` as the local review beside it. Matched on
  // branch and time alone, both of them adopt whichever gated first: the one that never gated flips
  // to "gated", shows the other's round number, and has every one of its own findings marked
  // dropped by a gate that never read them. The round's id is what separates the two.
  test("keeps one session's round out of the other when they share a branch", () => {
    const root = repo();
    const local = startReview(root, "local");
    const pr = startReview(root, "1234");
    writeFindings(local, ["f1"]);
    writeSession(pr, root, { id: "1234", diffPath: join(pr, "pr-1234.diff") });
    backdate(local, 60_000);
    // The PR review gates; the local review beside it, on the same branch, has not.
    recordRound(root, "feat/x", "abc123", "def456", "1234", []);

    const state = readReviewState(root, emptySnapshot(), basename(local));

    expect(state.phase).toBe("findings");
    expect(state.round).toBeNull();
    expect(state.findings.map((one) => [one.id, one.survived])).toEqual([["f1", null]]);
    expect(state.sessions.map((one) => [one.id, one.phase])).toEqual([
      ["1234", "gated"],
      ["local", "findings"],
    ]);
  });

  // A review of a detached revision has no branch to name. The short sha is what a human recognises
  // it by; a session where git could answer neither is honestly named for what it is reviewing.
  test("falls back to the short sha, then to the working tree, when there is no branch", () => {
    const root = repo();
    const detached = startReview(root, "local");
    writeSession(detached, root, { sourceBranch: null, sha: "0123456789abcdef" });
    const unknown = startReview(root, "1234");
    writeSession(unknown, root, {
      id: "1234",
      sourceBranch: null,
      sha: null,
      diffPath: join(unknown, "pr-1234.diff"),
    });
    backdate(detached, 60_000);

    const state = readReviewState(root, emptySnapshot());

    expect(state.sessions.map((one) => [one.id, one.branch])).toEqual([
      ["1234", "working tree"],
      ["local", "0123456"],
    ]);
  });
});

describe("once the reviewer has written findings", () => {
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

// `src/commands/web.ts` stores whatever this returns and hands it back as `previous` on the next
// poll, so an empty snapshot here is not a blank frame — it is the finished review's frozen picture
// and its verdict gone for good.
describe("with a session directory whose session.json cannot be read", () => {
  test("keeps the frozen snapshot instead of discarding what the viewer holds", () => {
    const root = repo();
    const dir = startReview(root);
    writeFindings(dir, ["f1"]);
    const before = readReviewState(root, emptySnapshot());
    expect(before.session).not.toBeNull();

    // The directory survives — teardown mid-delete, or phase 1 mid-write — but nothing in it parses.
    writeFileSync(join(dir, "session.json"), "{ half-writ", "utf8");
    const after = readReviewState(root, before);

    expect(after.phase).toBe("findings");
    expect(after.findings.map((one) => one.id)).toEqual(["f1"]);
    expect(after.files.map((one) => one.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(after.note).toContain("session finished");
  });
});

// The findings sit beside the `session.json` that was actually read, and a directory named by an
// older slug scheme is not where `sessionDir` would recompute them from.
describe("with a session directory the current slug scheme would not name", () => {
  test("reads the findings out of the directory it found the session in", () => {
    const root = repo();
    const canonical = sessionDir(root, "local");
    const dir = join(dirname(canonical), `legacy-${basename(canonical)}`);
    mkdirSync(dir, { recursive: true });
    temps.push(dir);
    writeFileSync(join(dir, "pr-local.diff"), DIFF, "utf8");
    writeSession(dir, root, { diffPath: join(dir, "pr-local.diff") });
    writeFindings(dir, ["f1"]);

    const state = readReviewState(root, emptySnapshot());

    expect(state.phase).toBe("findings");
    expect(state.findings.map((one) => [one.id, one.claim])).toEqual([["f1", "f1 claim"]]);
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
