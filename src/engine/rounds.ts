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
import { homedir, tmpdir } from "node:os";
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
 * the checkout it reads (docs/07-review-discipline.md invariant 2). And a temp directory only where
 * that temp directory is the user's own, which `roundsRoot` decides and never assumes.
 *
 * The reason is worth stating in full, because the obvious hardening does not work. This path is
 * derived rather than random, so in a world-writable directory somebody can plant a symlink at it
 * ahead of time. Checking for that is not enough: `mkdirSync` with `recursive` follows a symlink
 * standing in for any parent component, and an `lstat` of the leaf passes because the leaf is the
 * directory we just created ourselves, under their parent. Even a per-component check loses the
 * race, since Node exposes no `openat` to pin a directory and work relative to the handle. What
 * `O_EXCL` on each round file buys is real but partial: nobody replaces a round through a symlink
 * on the file itself. So the decision is made one level up. A world-writable root is not used.
 *
 * Sweeping is the point rather than the cost: a lost log reads as no rounds, which is a whole
 * review, said out loud.
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
  /**
   * The review this round belonged to: a pull request id, or "local". Kept so `--reset` can find
   * the branch a pull request was reviewed on without asking the forge which branch that was,
   * which is a network call to answer a question the log already holds the answer to.
   */
  id: string;
  /** The branch, written down rather than only hashed into the path, so it can be read back. */
  branch: string;
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
  return join(roundsRoot(), key(basename(root), root), key(branch, branch));
}

/**
 * The temp directory where it is the user's own, and the user's own directory otherwise.
 *
 * `XDG_RUNTIME_DIR` is exactly this by definition on Linux, and `os.tmpdir()` is the private
 * `/var/folders/...` on macOS, so on both the common case is a swept temp directory, which is what
 * a round log wants: history that expires on its own. Where neither is private — a Linux box with
 * no `XDG_RUNTIME_DIR`, where `os.tmpdir()` is the shared `/tmp` — the log goes under the home
 * directory instead, which nobody else can write and so nobody else can plant a path in. That
 * costs the automatic sweep, and `--reset` is the broom.
 */
export function roundsRoot(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && runtime !== "" && isPrivate(runtime)) {
    return join(runtime, "empo-review", "rounds");
  }
  const temp = tmpdir();
  if (isPrivate(temp)) return join(temp, "empo-review", "rounds");
  return join(homedir(), ".empo", "rounds");
}

/** A directory that is ours and that no one else may write, which is the whole test that matters. */
function isPrivate(dir: string): boolean {
  try {
    const stat = lstatSync(dir);
    return (
      stat.isDirectory() &&
      (stat.mode & 0o077) === 0 &&
      stat.uid === (process.getuid?.() ?? stat.uid)
    );
  } catch {
    return false;
  }
}

/** Every gated round on this branch, oldest first. Empty where none has been gated, or none read. */
export function readRounds(repoRoot: string, branch: string | null): RoundRecord[] {
  return roundFiles(repoRoot, branch)
    .map(([, path]) => parseRound(path))
    .filter((round): round is RoundRecord => round !== null);
}

/**
 * Every round file that is there, as `[number, path]`, oldest first. Kept apart from the parsing
 * because the next round's number comes off the file names and never off the records: a file that
 * will not parse still occupies its number, and a round that recomputed the same number would
 * collide with it under `wx` on this run and on every run after it.
 *
 * Sorted numerically, so round 1000 does not land before round 999 the way a string sort puts it.
 */
function roundFiles(repoRoot: string, branch: string | null): [number, string][] {
  return branch === null || branch === "" ? [] : roundFilesIn(roundsDir(repoRoot, branch));
}

function roundFilesIn(dir: string): [number, string][] {
  try {
    if (!ours(dir)) return [];
    return readdirSync(dir)
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name): [number, string] => [Number.parseInt(name, 10), join(dir, name)])
      .sort(([a], [b]) => a - b);
  } catch {
    // The directory can go while we are reading it: a temp sweep, a logout, another `--reset`.
    // That is no rounds, which is a whole review, and never a review that fails to start.
    return [];
  }
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
  id: string,
  findings: RoundFinding[],
): RoundRecord | null {
  if (branch === null || branch === "" || sha === null || sha === "") return null;
  const dir = roundsDir(repoRoot, branch);
  const round = (roundFiles(repoRoot, branch).at(-1)?.[0] ?? 0) + 1;
  const record: RoundRecord = { round, sha, at: new Date().toISOString(), id, branch, findings };
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

/**
 * Which branches of this repository carry rounds gated under `id`. What `--reset` needs when it is
 * given a pull request: the rounds are keyed by the branch the pull request came from, and that
 * branch is usually not the one checked out, because reviewing a pull request never checks it out.
 */
export function branchesGatedUnder(repoRoot: string, id: string): string[] {
  const root = canonicalRoot(repoRoot);
  const dir = join(roundsRoot(), key(basename(root), root));
  try {
    return readdirSync(dir)
      .map((name) => roundFilesIn(join(dir, name)).at(-1))
      .map((file) => (file === undefined ? null : parseRound(file[1])))
      .filter((round): round is RoundRecord => round !== null && round.id === id)
      .map((round) => round.branch)
      .filter((branch) => branch !== "")
      .sort(compare);
  } catch {
    return [];
  }
}

/** Forget every round on this branch, and hand back what was forgotten. `empo review --reset`. */
export function resetRounds(repoRoot: string, branch: string | null): RoundRecord[] {
  if (branch === null || branch === "") return [];
  const forgotten = readRounds(repoRoot, branch);
  rmSync(roundsDir(repoRoot, branch), { recursive: true, force: true });
  return forgotten;
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
    if (typeof parsed.sha !== "string" || typeof parsed.round !== "number") return null;
    // Field by field rather than spread: whatever else is in that file is not part of a round, and
    // a record carrying it would hand the rest of the command fields nobody here decided on.
    return {
      round: parsed.round,
      sha: parsed.sha,
      at: typeof parsed.at === "string" ? parsed.at : "",
      id: typeof parsed.id === "string" ? parsed.id : "local",
      branch: typeof parsed.branch === "string" ? parsed.branch : "",
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    };
  } catch {
    return null;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
