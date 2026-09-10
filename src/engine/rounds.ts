import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * What every gated round on a branch read, so the next review of that branch can be about what
 * changed since the last one (docs/06-cli.md, `empo review`).
 *
 * The problem it exists for: nothing recorded that a review had happened, so every round diffed
 * against the base again. Eleven rounds over one branch re-read the same seven hundred lines
 * eleven times while each round had changed a few dozen.
 *
 * A log and not a counter. One file per round holding the commit that round read, when it was
 * gated and what came through the gate, which is the difference between knowing you are on round
 * four and being able to read what round two found. Rounds are only ever appended, never edited,
 * so each file is written once and with `wx`.
 *
 * Where it lives, and why not the two obvious places. Not in the repository: `.empo/generated/` is
 * machine-owned by `empo index` alone (docs/02-on-disk-layout.md) and a review disturbs nothing in
 * the checkout it reads (docs/07-review-discipline.md invariant 2). Not in a bare `/tmp` either,
 * because the path here is derived rather than random, and a predictable path in a world-writable
 * directory is one somebody else can plant a symlink at ahead of time: the write would land in a
 * file of their choosing, or a forged round would tell `empo review` it may skip code nobody read.
 * `XDG_RUNTIME_DIR` is the temp directory that is already the user's own, mode 0700 and emptied at
 * logout, and where it is unset `os.tmpdir()` is per-user anyway on macOS. Sweeping is the point
 * rather than the cost: a lost log reads as no rounds, which is a whole review, said out loud.
 *
 * Both the repository and the branch are in the path. Per branch because two branches under review
 * at once are two loops and a shared entry would tell the second it had already read the first
 * one's work; per repository because branch names are not unique across checkouts, and two clones
 * of one repository are two different working trees at two different commits.
 */
export interface RoundRecord {
  /** 1 for the first gated round on this branch. The next review is this + 1. */
  round: number;
  /** The commit phase 1 read. The next round diffs the working tree against this. */
  sha: string;
  /** ISO timestamp of the gate that wrote it, so a stale round can be read as stale. */
  at: string;
  /** What came through the gate, so a later round can read what an earlier one already said. */
  findings: RoundFinding[];
}

/** A survivor as the log keeps it: enough to recognise the claim, not the whole case for it. */
export interface RoundFinding {
  id: string;
  kind: string;
  severity: string;
  title: string;
  file: string;
  line: number;
}

/**
 * Both phases and every future run have to land on the same directory, so the repository key is the
 * one the root git and the OS agree on: /var and /private/var are one checkout on macOS, and a
 * relative path is one too.
 */
export function canonicalRoot(repoRoot: string): string {
  try {
    return realpathSync(repoRoot);
  } catch {
    return resolve(repoRoot);
  }
}

/** Where this branch's rounds are kept. Named readably, keyed by digest: see the type above. */
export function roundsDir(repoRoot: string, branch: string): string {
  const root = canonicalRoot(repoRoot);
  return join(
    runtimeRoot(),
    "empo-review",
    "rounds",
    key(basename(root), root),
    key(branch, branch),
  );
}

/** Every gated round on this branch, oldest first. Empty where none has been gated, or none read. */
export function readRounds(repoRoot: string, branch: string | null): RoundRecord[] {
  if (branch === null || branch === "") return [];
  const dir = roundsDir(repoRoot, branch);
  if (!ours(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d+\.json$/.test(name))
    .sort(compare)
    .map((name) => parseRound(join(dir, name)))
    .filter((round): round is RoundRecord => round !== null);
}

/** What this branch was last reviewed at, or null where no round has been gated against it. */
export function lastRound(repoRoot: string, branch: string | null): RoundRecord | null {
  return readRounds(repoRoot, branch).at(-1) ?? null;
}

/**
 * Record that `sha` on `branch` has been reviewed. Called by the gate and nowhere else: the brief
 * is not a review, it is the facts a review reads, and a round that never reached the gate produced
 * nothing anyone should be told they can skip re-reading.
 *
 * Null where the round could not be written, which the gate says out loud rather than swallowing:
 * an unrecorded round and a recorded one differ only in what the next review will read.
 */
export function recordRound(
  repoRoot: string,
  branch: string | null,
  sha: string | null,
  findings: RoundFinding[],
): RoundRecord | null {
  if (branch === null || branch === "" || sha === null || sha === "") return null;
  const dir = roundsDir(repoRoot, branch);
  const round = (lastRound(repoRoot, branch)?.round ?? 0) + 1;
  const record: RoundRecord = { round, sha, at: new Date().toISOString(), findings };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!ours(dir)) return null;
    // `wx` is O_CREAT|O_EXCL, which refuses to follow a symlink and refuses to overwrite. A log
    // that only ever appends needs nothing else, and it is what makes a shared temp root survivable.
    writeFileSync(
      join(dir, `${String(round).padStart(3, "0")}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    return record;
  } catch {
    return null;
  }
}

/** Forget every round on this branch, and hand back what was forgotten. `empo review --reset`. */
export function resetRounds(repoRoot: string, branch: string | null): RoundRecord[] {
  if (branch === null || branch === "") return [];
  const forgotten = readRounds(repoRoot, branch);
  rmSync(roundsDir(repoRoot, branch), { recursive: true, force: true });
  return forgotten;
}

/** The temp root that is already the user's own, where the platform offers one. */
function runtimeRoot(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime !== undefined && runtime !== "" ? runtime : tmpdir();
}

/**
 * A readable name a human can find in a directory listing, and a digest that makes it a key: two
 * branches slug to `feat-x` and only one of them is `feat/x`.
 */
function key(readable: string, material: string): string {
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 8);
  const slug = readable.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
  return `${slug === "" ? "x" : slug}-${digest}`;
}

/**
 * A directory we made and still own. Cheap insurance for the case where the runtime root falls back
 * to a shared `/tmp`: somebody else's directory at our path is not one we read rounds out of.
 */
function ours(dir: string): boolean {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && stat.uid === (process.getuid?.() ?? stat.uid);
  } catch {
    return false;
  }
}

/** A round file we cannot read is scratch, not state: it drops out and the log reads shorter. */
function parseRound(path: string): RoundRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RoundRecord;
    return typeof parsed.sha === "string" && typeof parsed.round === "number"
      ? { ...parsed, findings: Array.isArray(parsed.findings) ? parsed.findings : [] }
      : null;
  } catch {
    return null;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
