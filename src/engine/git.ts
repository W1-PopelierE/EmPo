import { execaSync } from "execa";

/**
 * The only place EmPo runs a subprocess. Adapters shell out through `run` rather than importing
 * execa themselves, so there is exactly one module to audit for what this tool executes.
 *
 * Every git call is best-effort: a repository that is not a git checkout still indexes, it just
 * cannot report staleness (docs/02-on-disk-layout.md). Nothing here throws, because a missing git
 * is not a reason to refuse to build a graph. The worktree calls are the one place a failure
 * matters to the caller, so they return the message instead of swallowing it.
 */

export interface GitInfo {
  /** Full 40-character sha of HEAD. */
  sha: string;
  subject: string;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function gitInfo(repoRoot: string): GitInfo | null {
  const sha = git(repoRoot, ["rev-parse", "HEAD"]);
  if (sha === null) return null;
  return { sha, subject: git(repoRoot, ["log", "-1", "--format=%s"]) ?? "" };
}

/**
 * How many commits HEAD is ahead of the sha a graph was built against. `null` when it cannot be
 * answered (no git, or a sha that no longer exists after a rebase), which is reported as unknown
 * rather than as zero: a silent zero would claim the graph is current.
 */
export function commitsAhead(repoRoot: string, sha: string): number | null {
  if (sha === "") return null;
  const count = git(repoRoot, ["rev-list", "--count", `${sha}..HEAD`]);
  if (count === null) return null;
  const parsed = Number.parseInt(count, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function shortSha(sha: string): string {
  return sha === "" ? "unknown" : sha.slice(0, 7);
}

/** The branch HEAD points at, or null in a detached checkout (which a review worktree is). */
export function currentBranch(repoRoot: string): string | null {
  const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null || branch === "" || branch === "HEAD") return null;
  return branch;
}

/** Resolves any ref to a sha, so a caller can tell "no such base" from "no changes". */
export function resolveRef(repoRoot: string, ref: string): string | null {
  return git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

/**
 * The local working diff against a base ref: two dots, no second ref, so uncommitted work is in it.
 * This is what `empo review` with no PR argument reviews (docs/06-cli.md).
 */
export function diffAgainstBase(repoRoot: string, base: string): string | null {
  return git(repoRoot, ["diff", "--no-color", base]);
}

/**
 * What is staged for the next commit, which is what the commit gate judges (docs/06-cli.md
 * `empo check`). Staged rather than working-tree on purpose: the gate answers "may this commit go",
 * and a change the author has not staged is not part of it.
 */
export function stagedDiff(repoRoot: string): string | null {
  return git(repoRoot, ["diff", "--no-color", "--cached"]);
}

/** The diff of one ref range, for a PR branch fetched into the review's worktree. */
export function diffRange(repoRoot: string, base: string, head: string): string | null {
  return git(repoRoot, ["diff", "--no-color", `${base}...${head}`]);
}

export function fetchRef(repoRoot: string, remote: string, ref: string): boolean {
  return git(repoRoot, ["fetch", "--no-tags", remote, ref]) !== null;
}

export type WorktreeResult = { ok: true; path: string } | { ok: false; message: string };

/**
 * A detached worktree at `ref`, which is how a review reads a branch's files without touching the
 * human's checkout and without an environment setup (docs/07-review-discipline.md invariant 2).
 * Detached on purpose: two reviews of the same branch must be able to run at once, and a checked
 * out branch can only live in one worktree.
 */
export function addWorktree(repoRoot: string, ref: string, path: string): WorktreeResult {
  const result = run(repoRoot, "git", ["worktree", "add", "--detach", path, ref]);
  if (!result.ok) return { ok: false, message: firstLine(result.stderr) };
  return { ok: true, path };
}

/** Teardown, step 8. Best-effort: a leftover worktree is a nuisance, not a failed review. */
export function removeWorktree(repoRoot: string, path: string): boolean {
  return run(repoRoot, "git", ["worktree", "remove", "--force", path]).ok;
}

/**
 * Whether git ignores `path`, or null where the question has no answer: no checkout here, or git
 * itself failed. Two calls and not one, because `check-ignore` exits 1 for "not ignored" and 128 for
 * "not a repository" and `run` reports both as a failure; without the first call a directory git has
 * never heard of would read as one that ignores nothing, which is a different claim entirely.
 *
 * The index counts, so no `--no-index`: `check-ignore` calls a tracked path not ignored however the
 * rules read, and that is the honest answer to "is git ignoring this" once someone has force-added
 * it. Note that a directory rule cannot match a path that does not exist, so a caller asking about
 * `foo/` must know whether it is there before reading a false out of the answer.
 */
export function ignoresPath(repoRoot: string, path: string): boolean | null {
  if (!run(repoRoot, "git", ["rev-parse", "--is-inside-work-tree"]).ok) return null;
  return run(repoRoot, "git", ["check-ignore", "-q", "--", path]).ok;
}

/** Whether a CLI an adapter needs is on PATH. An absent one degrades, it does not crash. */
export function commandExists(command: string): boolean {
  return run(process.cwd(), command, ["--version"]).ok;
}

/**
 * One subprocess call, never throwing. `stdin: "ignore"` so a command that wants a password or a
 * confirmation fails instead of hanging a review that no human is watching.
 */
export function run(cwd: string, command: string, args: string[]): CommandResult {
  try {
    const result = execaSync(command, args, { cwd, stdin: "ignore" });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (failure.stdout ?? "").trim(),
      stderr: (failure.stderr ?? failure.message ?? "").trim(),
    };
  }
}

export interface ShellResult {
  /** True only on exit code 0. */
  ok: boolean;
  /** The process exit code, or null when no process could be started at all. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * One shell command, never throwing. Used to run a host hook command string the way the host
 * itself does: through a shell, because the string contains shell syntax the host expands.
 *
 * `stdin: "ignore"` is what makes this safe to run unattended, and it is also what makes the probe
 * meaningful. A hook binary reads its payload from stdin, so an ignored stdin hands it EOF: it
 * exits immediately having done nothing, which is exactly what `empo doctor` wants. The run proves
 * the command resolves and starts without letting it act on the repository.
 *
 * The distinction this returns is the whole reason the caller exists. Under `shell: true` there is
 * always a shell to start, so a command that is not on PATH is not a spawn failure: the shell runs,
 * says "command not found" and exits **127**, a number. 127 must survive as a number here, because
 * that is how the caller tells "the hook is wired to something that is not installed" from "no
 * process could be started at all", which is the only case that reports null.
 *
 * **The command line comes out of the repository under report, and it reaches a shell whole.** A
 * wired hook is a `command` string somebody wrote into `.claude/settings.json`, and shell syntax in
 * it is honoured here exactly as the host would honour it, which is the point of the probe and also
 * its whole cost: nothing on this path validates, escapes or narrows that string, and the ownership
 * test that selected it reads its shape rather than a signature (src/host/claude.ts). So the one
 * decision this function cannot make is the caller's, and it is not a detail: whether the checkout
 * the string was read from is a checkout whose commands may run at all. `empo doctor` states that
 * boundary out loud and offers `--skip-hooks` for the answer "not yet" (docs/06-cli.md).
 */
export function runShell(
  cwd: string,
  commandLine: string,
  env: Record<string, string>,
  timeoutMs: number,
): ShellResult {
  try {
    // No extendEnv: false. The hook must see the environment the host would have given it, with
    // these entries laid on top, not a bare environment that fails for a reason the host never has.
    const result = execaSync(commandLine, {
      cwd,
      env,
      shell: true,
      stdin: "ignore",
      timeout: timeoutMs,
    });
    return {
      ok: true,
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      timedOut: false,
    };
  } catch (error) {
    const failure = error as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
      timedOut?: boolean;
    };
    return {
      ok: false,
      // Killed on timeout leaves no exit code, and neither does a shell that never started; both
      // are the honest "no number to report" that null stands for.
      exitCode: typeof failure.exitCode === "number" ? failure.exitCode : null,
      stdout: (failure.stdout ?? "").trim(),
      stderr: (failure.stderr ?? failure.message ?? "").trim(),
      timedOut: failure.timedOut === true,
    };
  }
}

function git(cwd: string, args: string[]): string | null {
  const result = run(cwd, "git", args);
  return result.ok ? result.stdout : null;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return line === undefined ? "git reported no reason" : line.trim();
}
