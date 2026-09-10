import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { activityPath, readSession, sessionDir, sessionDirs } from "../../src/engine/session";

const temps: string[] = [];

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-session-"));
  temps.push(dir);
  return dir;
}

/** A session directory as phase 1 leaves it, optionally aged so the ttl can be exercised. */
function session(dir: string, at?: number): string {
  mkdirSync(dir, { recursive: true });
  temps.push(dir);
  const file = join(dir, "session.json");
  writeFileSync(file, "{}");
  if (at !== undefined) utimesSync(file, at / 1000, at / 1000);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    // The activity log lives beside the sessions in the OS temp root, keyed on the repository path
    // and never deleted by anything in `src`, so a test repo that is not swept here leaks one file
    // per run into a directory `sessionDirs` enumerates on every Read the hook sees. Computed while
    // the directory still exists, since the key runs through `realpathSync`.
    rmSync(activityPath(dir), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("where a review session lives", () => {
  test("keys the directory on the review id and the canonical repository root", () => {
    const root = repo();
    const dir = sessionDir(root, "local");

    expect(dir.startsWith(join(tmpdir(), "empo-review"))).toBe(true);
    expect(basename(dir).startsWith("local-")).toBe(true);
    expect(sessionDir(root, "local")).toBe(dir);
    expect(sessionDir(root, "42")).not.toBe(dir);
    expect(sessionDir(repo(), "local")).not.toBe(dir);
  });

  test("reads a session back, and answers null for one that is not there", () => {
    const root = repo();
    expect(readSession(root, "local")).toBeNull();

    const dir = sessionDir(root, "local");
    mkdirSync(dir, { recursive: true });
    temps.push(dir);
    writeFileSync(join(dir, "session.json"), JSON.stringify({ id: "local", readRoot: root }));

    expect(readSession(root, "local")?.readRoot).toBe(root);
  });

  test("lists every live session for this repository and no other repository's", () => {
    const mine = repo();
    const theirs = repo();
    for (const dir of [
      sessionDir(mine, "local"),
      sessionDir(mine, "42"),
      sessionDir(theirs, "local"),
    ]) {
      session(dir);
    }

    expect(sessionDirs(mine)).toHaveLength(2);
    expect(sessionDirs(theirs)).toHaveLength(1);
  });

  test("skips a directory that has no session.json", () => {
    const root = repo();
    const written = session(sessionDir(root, "local"));
    const bare = sessionDir(root, "42");
    mkdirSync(bare, { recursive: true });
    temps.push(bare);

    expect(sessionDirs(root)).toEqual([written]);
  });

  test("drops a session older than the twelve-hour ttl", () => {
    const root = repo();
    const fresh = session(sessionDir(root, "local"));
    const stale = session(sessionDir(root, "42"), Date.now() - 13 * 60 * 60 * 1000);

    expect(sessionDirs(root)).toEqual([fresh]);
    expect(sessionDirs(root)).not.toContain(stale);
  });

  test("orders on session.json's mtime and not the directory's", () => {
    const root = repo();
    // The older session is the one written to last: `empo review` has the reviewing agent drop
    // findings.json inside the directory, which bumps the directory mtime. Sorting on that key puts
    // the older review first and swaps the review under a viewer that asked for the newest one.
    const older = session(sessionDir(root, "42"), Date.now() - 60 * 60 * 1000);
    const newer = session(sessionDir(root, "local"));
    writeFileSync(join(older, "findings.json"), "[]");

    expect(sessionDirs(root)).toEqual([newer, older]);
  });

  test("puts the activity log beside the sessions, one per repository", () => {
    const root = repo();
    expect(activityPath(root)).toBe(
      join(tmpdir(), "empo-review", `activity-${basename(sessionDir(root, ""))}.jsonl`),
    );
  });
});
