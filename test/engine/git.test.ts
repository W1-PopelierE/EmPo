import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isAncestor, reviewedTree, runShell } from "../../src/engine/git";

/**
 * These run a real shell rather than a stub, because the whole contract is about what a shell does
 * with a command string: the 127 case only exists because a shell reports a missing command as an
 * exit code instead of a spawn failure, and a stub would be free to agree with us about that.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "empo-shell-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("runShell", () => {
  test("reports success for a command that exits 0", () => {
    const result = runShell(cwd, "exit 0", {}, 5_000);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("reports the exit code of a command that fails", () => {
    const result = runShell(cwd, "exit 3", {}, 5_000);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  test("reports a missing command as exit 127 rather than as no process", () => {
    const result = runShell(cwd, "empo-no-such-command-here --version", {}, 5_000);

    expect(result.ok).toBe(false);
    // A number, not null: the shell started and answered, the thing it was asked to run did not
    // exist. The caller distinguishes those two, so this must not collapse into the null case.
    expect(result.exitCode).toBe(127);
  });

  test("passes the given environment through to the command", () => {
    const result = runShell(cwd, 'printf "%s" "$EMPO_PROBE"', { EMPO_PROBE: "wired" }, 5_000);

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("wired");
  });

  test("keeps the inherited environment alongside the given entries", () => {
    const result = runShell(cwd, 'printf "%s" "$PATH"', { EMPO_PROBE: "wired" }, 5_000);

    expect(result.ok).toBe(true);
    expect(result.stdout).not.toBe("");
  });

  test("cuts off a command that would hang", () => {
    const result = runShell(cwd, "sleep 30", {}, 200);

    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });

  test("captures and trims stdout and stderr", () => {
    const result = runShell(cwd, 'echo "  out  "; echo "  err  " >&2', {}, 5_000);

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });
});

/**
 * A real repository rather than a stub, for the same reason `runShell` uses a real shell: what is
 * under test is what git does, and a stub would be free to agree with us about it.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-git-"));
  runShell(dir, "git init -q .", {}, 10_000);
  runShell(dir, "git config user.email empo@example.com && git config user.name EmPo", {}, 10_000);
  runShell(dir, 'printf "one\\n" > file.txt && git add -A', {}, 10_000);
  runShell(dir, 'git -c commit.gpgsign=false commit -q -m "one"', {}, 10_000);
  return dir;
}

function sha(dir: string, ref: string): string {
  return runShell(dir, `git rev-parse ${ref}`, {}, 10_000).stdout;
}

describe("isAncestor", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("a commit behind HEAD is an ancestor of it", () => {
    const first = sha(repo, "HEAD");
    runShell(repo, 'printf "two\\n" >> file.txt && git add -A', {}, 10_000);
    runShell(repo, 'git -c commit.gpgsign=false commit -q -m "two"', {}, 10_000);

    expect(isAncestor(repo, first, "HEAD")).toBe(true);
  });

  test("HEAD is an ancestor of itself, so an unmoved branch is never reported as diverged", () => {
    expect(isAncestor(repo, sha(repo, "HEAD"), "HEAD")).toBe(true);
  });

  test("a commit that HEAD has been amended away from is not an ancestor", () => {
    const before = sha(repo, "HEAD");
    runShell(repo, 'git -c commit.gpgsign=false commit -q --amend -m "one, amended"', {}, 10_000);

    // The object is still there until a garbage collect, which is what makes this the interesting
    // case: the sha resolves, and it is still not behind HEAD.
    expect(sha(repo, before)).toBe(before);
    expect(isAncestor(repo, before, "HEAD")).toBe(false);
  });

  test("a sha that is not in the repository at all is not an ancestor", () => {
    expect(isAncestor(repo, "0".repeat(40), "HEAD")).toBe(false);
  });
});

describe("reviewedTree", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("names a dirty tree as a commit HEAD is not", () => {
    runShell(repo, 'printf "uncommitted\\n" >> file.txt', {}, 10_000);

    const tree = reviewedTree(repo);

    // The whole point: the uncommitted work has a coordinate of its own, so a later round can diff
    // against what was read instead of against a commit that predates all of it.
    expect(tree).not.toBeNull();
    expect(tree).not.toBe(sha(repo, "HEAD"));
    expect(runShell(repo, `git diff --name-only ${tree}`, {}, 10_000).stdout).toBe("");
  });

  test("falls back to HEAD where the tree is clean", () => {
    expect(reviewedTree(repo)).toBe(sha(repo, "HEAD"));
  });

  test("leaves the checkout it read alone: no ref moves, no file changes", () => {
    runShell(repo, 'printf "uncommitted\\n" >> file.txt', {}, 10_000);
    const head = sha(repo, "HEAD");
    const status = runShell(repo, "git status --porcelain", {}, 10_000).stdout;

    reviewedTree(repo);

    expect(sha(repo, "HEAD")).toBe(head);
    expect(runShell(repo, "git status --porcelain", {}, 10_000).stdout).toBe(status);
    expect(runShell(repo, "git stash list", {}, 10_000).stdout).toBe("");
  });

  test("answers null outside a repository rather than throwing", () => {
    const bare = mkdtempSync(join(tmpdir(), "empo-nogit-"));
    try {
      expect(reviewedTree(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
