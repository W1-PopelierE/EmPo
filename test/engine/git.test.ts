import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runShell } from "../../src/engine/git";

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
