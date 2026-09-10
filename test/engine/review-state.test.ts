import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { emptySnapshot, readReviewState } from "../../src/engine/review-state";
import { activityPath, sessionDir } from "../../src/engine/session";

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
  const diffPath = join(dir, "pr-local.diff");
  writeFileSync(diffPath, DIFF, "utf8");
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
      diffPath,
    }),
    "utf8",
  );
  return dir;
}

function log(root: string, lines: { tool: string; path: string }[]): void {
  writeFileSync(
    activityPath(root),
    `${lines.map((one) => JSON.stringify({ at: new Date().toISOString(), ...one })).join("\n")}\n`,
    "utf8",
  );
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
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
});
