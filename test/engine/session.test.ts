import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readSession, sessionDir } from "../../src/engine/session";

const temps: string[] = [];

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-session-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  // Sessions live inside the repository, so removing it removes them.
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("where a review session lives", () => {
  test("keys the directory on the review id and the canonical repository root", () => {
    const root = repo();
    const dir = sessionDir(root, "local");

    expect(dir.startsWith(join(realpathSync(root), ".empo", "reviews", "sessions"))).toBe(true);
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
});
