import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  branchesGatedUnder,
  canonicalRoot,
  lastRound,
  readRounds,
  recordRound,
  resetRounds,
  reviewsDir,
  roundsDir,
} from "../../src/engine/rounds";

/**
 * Everything here runs against a real directory rather than a stubbed filesystem, because the
 * contract is about what the filesystem does: `wx` refusing to overwrite, a mode a group can write,
 * a directory that is gone. A fake would be free to agree with us about all three.
 */

/**
 * How many of the next writes lose the `wx` race. The loser of two gates landing on one branch at
 * once cannot be produced by writing a file first — the number comes off the directory listing, so
 * a file that is there is a number already counted. The collision only exists in the window
 * between that listing and the write, which is why it is simulated here rather than staged on disk.
 */
const writes = vi.hoisted(() => ({ lose: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (path: string, data: string, options: object) => {
      if (writes.lose === 0) return actual.writeFileSync(path, data, options);
      writes.lose -= 1;
      // Exactly what the loser sees: the winner's file is there, and `wx` refuses it.
      actual.writeFileSync(path, "the other gate got here first\n");
      const error: NodeJS.ErrnoException = new Error("EEXIST: file already exists");
      error.code = "EEXIST";
      throw error;
    },
  };
});

let sandbox: string;
let repo: string;

/** A directory at a mode of our choosing. Set after the fact, because a umask edits `mkdir`'s. */
function dirAt(path: string, mode: number): string {
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
  return path;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "empo-rounds-"));
  repo = dirAt(join(sandbox, "repo"), 0o755);
  writes.lose = 0;
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("canonicalRoot", () => {
  test("resolves a symlinked path to the same key the real path gives", () => {
    // /var vs /private/var on macOS is the motivating case: phase 1 and phase 2 may be handed
    // different spellings of one checkout, and two spellings would be two round logs, which reads
    // as no rounds at all and costs a whole review.
    const link = join(sandbox, "link-to-repo");
    symlinkSync(repo, link);

    expect(canonicalRoot(link)).toBe(realpathSync(repo));
    expect(roundsDir(link, "feat/x")).toBe(roundsDir(repo, "feat/x"));
  });

  test("resolves a path that does not exist rather than throwing", () => {
    const missing = join(sandbox, "no-such-repo");

    expect(canonicalRoot(missing)).toBe(missing);
  });
});

describe("recordRound", () => {
  test("writes a round the log reads back, numbered from 001", () => {
    const finding = {
      id: "f1",
      kind: "bug",
      severity: "high",
      title: "off by one",
      file: "src/a.ts",
      line: 12,
    };

    const first = recordRound(repo, "feat/x", "sha-1", "tree-1", "local", [finding]);
    const second = recordRound(repo, "feat/x", "sha-2", "tree-2", "27", []);

    expect(first).toMatchObject({ round: 1, sha: "sha-1", tree: "tree-1", id: "local" });
    expect(second).toMatchObject({ round: 2, sha: "sha-2", tree: "tree-2", id: "27" });
    expect(readdirSync(roundsDir(repo, "feat/x")).sort()).toEqual(["001.json", "002.json"]);
    expect(readRounds(repo, "feat/x").map((round) => round.round)).toEqual([1, 2]);
    expect(readRounds(repo, "feat/x")[0]?.findings).toEqual([finding]);
    expect(lastRound(repo, "feat/x")?.sha).toBe("sha-2");
    // Written down and not only hashed into the path, so `--reset` can read the branch back.
    expect(lastRound(repo, "feat/x")?.branch).toBe("feat/x");
  });

  test("keeps the log inside the repository, ignored by git", () => {
    // In the checkout so it survives a reboot, and ignoring itself so a review never commits it or
    // reads it back as part of the diff it is reviewing.
    execFileSync("git", ["init", "-q"], { cwd: repo });
    recordRound(repo, "feat/x", "sha-1", null, "local", []);

    const round = join(roundsDir(repo, "feat/x"), "001.json");
    expect(round.startsWith(join(realpathSync(repo), ".empo", "reviews"))).toBe(true);
    expect(readFileSync(join(reviewsDir(repo), ".gitignore"), "utf8")).toBe("*\n");
    // Exits non-zero, and so throws, where the path is not ignored.
    expect(
      execFileSync("git", ["check-ignore", round], { cwd: repo, encoding: "utf8" }).trim(),
    ).toBe(round);
  });

  test("falls back to the sha where no tree was created", () => {
    // `git stash create` writes nothing when there is nothing uncommitted, so a clean round has no
    // tree, and a round whose tree were empty would diff against nothing on the next pass.
    expect(recordRound(repo, "feat/x", "sha-1", null, "local", [])?.tree).toBe("sha-1");
    expect(recordRound(repo, "feat/x", "sha-2", "", "local", [])?.tree).toBe("sha-2");
  });

  test("records nothing without a branch or a sha", () => {
    expect(recordRound(repo, null, "sha-1", null, "local", [])).toBeNull();
    expect(recordRound(repo, "", "sha-1", null, "local", [])).toBeNull();
    expect(recordRound(repo, "feat/x", null, null, "local", [])).toBeNull();
    expect(recordRound(repo, "feat/x", "", null, "local", [])).toBeNull();
  });

  test("takes the next free number when another gate wins the one it computed", () => {
    // The regression, and the reason the number is retried rather than insisted on: two gates can
    // land on one branch at once — the shipped discipline says as much — and both compute the same
    // number. The loser used to be dropped, which threw away findings that had already passed a
    // gate and cost the next review a re-read of everything that round had read.
    recordRound(repo, "feat/x", "sha-1", null, "local", []);
    writes.lose = 1;

    const next = recordRound(repo, "feat/x", "sha-2", null, "local", []);

    expect(next).toMatchObject({ round: 3, sha: "sha-2" });
    expect(readdirSync(roundsDir(repo, "feat/x")).sort()).toEqual([
      "001.json",
      "002.json",
      "003.json",
    ]);
    expect(readRounds(repo, "feat/x").map((round) => round.sha)).toEqual(["sha-1", "sha-2"]);
  });

  test("gives up rather than spinning when every number it tries is taken", () => {
    recordRound(repo, "feat/x", "sha-1", null, "local", []);
    writes.lose = 99;

    expect(recordRound(repo, "feat/x", "sha-2", null, "local", [])).toBeNull();
  });

  test("numbers past a file that will not parse", () => {
    // A file that will not parse still occupies its number permanently, so the next number comes
    // off the file names and never off the records: a round that recomputed the same number would
    // collide with it under `wx` on this run and on every run after it.
    recordRound(repo, "feat/x", "sha-1", null, "local", []);
    recordRound(repo, "feat/x", "sha-2", null, "local", []);
    writeFileSync(join(roundsDir(repo, "feat/x"), "003.json"), "not json at all\n");

    const next = recordRound(repo, "feat/x", "sha-4", null, "local", []);

    expect(next).toMatchObject({ round: 4, sha: "sha-4" });
    expect(existsSync(join(roundsDir(repo, "feat/x"), "004.json"))).toBe(true);
    // The unparseable file drops out of the log while keeping its number: three files, two rounds.
    expect(readRounds(repo, "feat/x").map((round) => round.round)).toEqual([1, 2, 4]);
  });

  test("orders the log numerically, so round 10 comes after round 9", () => {
    // A string sort puts 010.json before 009.json only past 999, but it puts 10 before 9 the moment
    // the padding is gone, and `lastRound` is what the next review narrows against.
    const dir = roundsDir(repo, "feat/x");
    mkdirSync(dir, { recursive: true });
    for (const round of [9, 10]) {
      writeFileSync(
        join(dir, `${String(round).padStart(3, "0")}.json`),
        JSON.stringify({ round, sha: `sha-${round}`, at: "", id: "local", branch: "feat/x" }),
      );
    }

    expect(lastRound(repo, "feat/x")?.round).toBe(10);
    expect(recordRound(repo, "feat/x", "sha-11", null, "local", [])?.round).toBe(11);
  });
});

describe("readRounds", () => {
  test("reads no rounds for a branch nothing was gated on, or for no branch at all", () => {
    expect(readRounds(repo, "feat/never-reviewed")).toEqual([]);
    expect(readRounds(repo, null)).toEqual([]);
    expect(readRounds(repo, "")).toEqual([]);
    expect(lastRound(repo, null)).toBeNull();
  });

  test("reads no rounds where the path is not a directory we own", () => {
    // A file standing where the branch's directory belongs is not a log to read out of.
    const dir = roundsDir(repo, "feat/x");
    mkdirSync(dirname(dir), { recursive: true });
    writeFileSync(dir, "planted\n");

    expect(readRounds(repo, "feat/x")).toEqual([]);
    expect(recordRound(repo, "feat/x", "sha-1", null, "local", [])).toBeNull();
  });
});

describe("branchesGatedUnder", () => {
  test("finds a branch whose pull request round is not the newest one it carries", () => {
    // The regression: one branch carries rounds under more than one id, because a pull request
    // review and a plain local review of the same branch both land in the same directory. A filter
    // that read only the last round reported the pull request's rounds as absent while they sat on
    // disk, and `--reset 27` then forgot nothing.
    recordRound(repo, "feat/x", "sha-1", null, "27", []);
    recordRound(repo, "feat/x", "sha-2", null, "local", []);

    expect(branchesGatedUnder(repo, "27")).toEqual(["feat/x"]);
    expect(branchesGatedUnder(repo, "local")).toEqual(["feat/x"]);
  });

  test("lists every branch gated under one id, sorted", () => {
    recordRound(repo, "feat/b", "sha-1", null, "27", []);
    recordRound(repo, "feat/a", "sha-2", null, "27", []);

    expect(branchesGatedUnder(repo, "27")).toEqual(["feat/a", "feat/b"]);
  });

  test("finds nothing for an id nobody gated, and nothing for a repository with no log", () => {
    recordRound(repo, "feat/x", "sha-1", null, "local", []);

    expect(branchesGatedUnder(repo, "27")).toEqual([]);
    expect(branchesGatedUnder(join(sandbox, "other-repo"), "27")).toEqual([]);
  });
});

describe("resetRounds", () => {
  test("hands back what it forgot and leaves the directory gone", () => {
    recordRound(repo, "feat/x", "sha-1", null, "local", []);
    recordRound(repo, "feat/x", "sha-2", null, "local", []);
    const dir = roundsDir(repo, "feat/x");

    const forgotten = resetRounds(repo, "feat/x");

    expect(forgotten.map((round) => round.sha)).toEqual(["sha-1", "sha-2"]);
    expect(existsSync(dir)).toBe(false);
    expect(readRounds(repo, "feat/x")).toEqual([]);
  });

  test("forgets nothing for a branch with no rounds, or for no branch at all", () => {
    expect(resetRounds(repo, "feat/never-reviewed")).toEqual([]);
    expect(resetRounds(repo, null)).toEqual([]);
    expect(resetRounds(repo, "")).toEqual([]);
  });
});
