import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ReviewFinding } from "../discipline/findings";
import { parseFindingsFile } from "../schema/findings.schema";
import { type ChangedFile, type ChangeStatus, parseDiff } from "./diff";
import { type RoundRecord, readRounds } from "./rounds";
import { activityPath, type ReviewSession, sessionDir, sessionDirs } from "./session";

/**
 * The review as a viewer can see it, derived and never reported. Every phase here is inferred from
 * a file that `empo review` writes for its own reasons, so nothing in this display depends on an
 * agent being honest about its own progress.
 *
 * The `previous` argument carries what the gate's teardown deletes. Phase 2 removes the session
 * directory (docs/07-review-discipline.md invariant 2), so the diff and the suspected findings only
 * exist while the review runs. A viewer that read them once keeps them; one started afterwards
 * cannot show them, and says so rather than showing an empty review.
 */

const ACTIVITY_TAIL = 200;

export type Phase = "idle" | "brief" | "reading" | "findings" | "gated";

export interface ActivityLine {
  at: string;
  tool: string;
  path: string;
}

export interface SnapshotFile {
  path: string;
  status: ChangeStatus;
  addedCount: number;
  removedCount: number;
  findingCount: number;
  /** The reviewer opened it. False on a changed file it never looked at. */
  read: boolean;
}

export interface SnapshotFinding {
  id: string;
  kind: string;
  severity: string;
  title: string;
  claim: string;
  file: string;
  line: number;
  anchor: string;
  suggestion: string | null;
  /** null until the gate has run. */
  survived: boolean | null;
}

export interface Snapshot {
  phase: Phase;
  session: ReviewSession | null;
  round: number | null;
  files: SnapshotFile[];
  hunks: Record<string, ChangedFile>;
  readOutsideDiff: string[];
  findings: SnapshotFinding[];
  activity: ActivityLine[];
  liveSessions: number;
  note: string | null;
}

export function emptySnapshot(): Snapshot {
  return {
    phase: "idle",
    session: null,
    round: null,
    files: [],
    hunks: {},
    readOutsideDiff: [],
    findings: [],
    activity: [],
    liveSessions: 0,
    note: null,
  };
}

export function readReviewState(repoRoot: string, previous: Snapshot): Snapshot {
  const dirs = sessionDirs(repoRoot);
  if (dirs.length === 0) return afterTeardown(repoRoot, previous);

  const found = newestSession(dirs);
  if (found === null) return { ...emptySnapshot(), liveSessions: dirs.length };
  const { session, startedAt } = found;

  const changed = readDiff(session);
  const activity = readActivity(repoRoot, startedAt).map((one) => ({
    ...one,
    path: repoRelative(one.path, session.readRoot, repoRoot),
  }));
  const opened = new Set(activity.map((one) => one.path));
  const inDiff = new Set(changed.map((one) => one.path));

  const { findings, round } = readFindings(repoRoot, session, startedAt);
  const findingCounts = new Map<string, number>();
  for (const finding of findings) {
    findingCounts.set(finding.file, (findingCounts.get(finding.file) ?? 0) + 1);
  }

  let phase: Phase = activity.length === 0 ? "brief" : "reading";
  if (findings.length > 0) phase = "findings";
  if (round !== null) phase = "gated";

  return {
    phase,
    session,
    round: round?.round ?? null,
    files: changed.map((file) => ({
      path: file.path,
      status: file.status,
      addedCount: file.addedCount,
      removedCount: file.removedCount,
      findingCount: findingCounts.get(file.path) ?? 0,
      read: opened.has(file.path),
    })),
    hunks: Object.fromEntries(changed.map((file) => [file.path, file])),
    readOutsideDiff: [...opened].filter((path) => !inDiff.has(path)).sort(),
    findings,
    activity,
    liveSessions: dirs.length,
    note: dirs.length > 1 ? `${dirs.length} sessions active; showing the newest` : null,
  };
}

/**
 * The suspected findings crossed with the gate's verdict on them. `findings.json` (docs/07-review-
 * discipline.md step 5) has the full text of every finding the reviewer suspected, but the gate
 * deletes the session directory and its round record (`src/engine/rounds.ts`) keeps only the
 * survivors, each stripped to `{id, kind, severity, title, file, line}`. Crossing the two is what
 * lets a dropped finding show its actual claim rather than nothing at all.
 *
 * Findings named only by the round record — the session is gone, so `findings.json` cannot be read
 * — are added with empty text: the record only ever holds survivors, so they show as such.
 */
function readFindings(
  repoRoot: string,
  session: ReviewSession,
  startedAt: number,
): { findings: SnapshotFinding[]; round: RoundRecord | null } {
  const suspected = readFindingsFile(repoRoot, session);
  const round = newestRound(repoRoot, session.sourceBranch, startedAt);
  if (round === null) {
    return {
      findings: suspected.map((one) => toSnapshotFinding(one, null)),
      round: null,
    };
  }

  const survivors = new Map(round.findings.map((one) => [one.id, one]));
  const findings = suspected.map((one) => toSnapshotFinding(one, survivors.has(one.id)));
  for (const survivor of round.findings) {
    if (!suspected.some((one) => one.id === survivor.id)) {
      findings.push({
        id: survivor.id,
        kind: survivor.kind,
        severity: survivor.severity,
        title: survivor.title,
        claim: "",
        file: survivor.file,
        line: survivor.line,
        anchor: "",
        suggestion: null,
        survived: true,
      });
    }
  }
  return { findings, round };
}

function toSnapshotFinding(finding: ReviewFinding, survived: boolean | null): SnapshotFinding {
  return {
    id: finding.id,
    kind: finding.kind,
    severity: finding.severity,
    title: finding.title,
    claim: finding.claim,
    file: finding.citation.file,
    line: finding.citation.line,
    anchor: finding.citation.anchor,
    suggestion: finding.suggestion ?? null,
    survived,
  };
}

/** `findings.json` as phase 1 leaves it, or nothing at all before it exists or once it is gone. */
function readFindingsFile(repoRoot: string, session: ReviewSession): ReviewFinding[] {
  try {
    const path = join(sessionDir(repoRoot, session.id), "findings.json");
    if (!existsSync(path)) return [];
    return parseFindingsFile(JSON.parse(readFileSync(path, "utf8")), path);
  } catch {
    return [];
  }
}

/**
 * The newest round for this session's branch, but only when it is newer than the session itself:
 * an old round left over from a previous review of this branch is not this review's verdict, and
 * showing it would mark this round's findings survived or dropped by a gate that never saw them.
 */
function newestRound(
  repoRoot: string,
  branch: string | null,
  startedAt: number,
): RoundRecord | null {
  const rounds = readRounds(repoRoot, branch);
  const newest = rounds.at(-1) ?? null;
  if (newest === null) return null;
  return Date.parse(newest.at) >= startedAt ? newest : null;
}

/**
 * The session the viewer follows when more than one is live, paired with when it started.
 * `sessionDirs` already sorts newest first by mtime, so this only has to skip a directory whose
 * `session.json` lost a race with teardown or was never finished — reading is best-effort here, the
 * way every source in this module is, rather than a reason to show nothing while a second review is
 * mid-write.
 *
 * Read directly off each directory rather than through `readSession` (which takes an id and
 * recomputes the same path) — `sessionDirs` already did the lookup, and the id on disk inside
 * `session.json` is not reliably recoverable from the directory name, which is a sanitized,
 * truncated slug plus a hash.
 *
 * `session.json`'s own mtime is this round's start: phase 1 writes it once, when it creates the
 * session, and a later round gets a fresh file after teardown deletes the old one. That is what
 * `readActivity` filters against, so the repo-wide activity log — one file shared by every review
 * this repository ever runs — does not leak a previous, unrelated review's reads into this one.
 */
function newestSession(dirs: string[]): { session: ReviewSession; startedAt: number } | null {
  for (const dir of dirs) {
    try {
      const file = join(dir, "session.json");
      if (!existsSync(file)) continue;
      const session = JSON.parse(readFileSync(file, "utf8")) as ReviewSession;
      // Floored: the filesystem's mtime can carry sub-millisecond precision `Date.parse` never
      // does (nanoseconds rounded to a fraction of a millisecond), so an activity line logged in
      // the same millisecond session.json was written can otherwise compare as slightly earlier.
      return { session, startedAt: Math.floor(statSync(file).mtimeMs) };
    } catch {
      // Try the next directory; a half-written session.json is normal mid-write, not a failure.
    }
  }
  return null;
}

/** The session's diff, or no files at all when phase 1 has not finished writing it yet. */
function readDiff(session: ReviewSession): ChangedFile[] {
  try {
    if (!existsSync(session.diffPath)) return [];
    return parseDiff(readFileSync(session.diffPath, "utf8"));
  } catch {
    return [];
  }
}

/**
 * The activity log the `tool-use` hook appends to, filtered to this session and tailed to the most
 * recent lines a viewer can usefully show. A line the hook half-wrote (a crash mid-append) is
 * dropped rather than failing the whole read, since one bad line should cost one line of history,
 * not the display.
 *
 * `activityPath` is one file per repository, not per review, so without the `startedAt` filter a
 * second review would inherit the first one's history: it would start in "reading" instead of
 * "brief", and files the previous review opened would show as already read by this one. Filtering
 * first and tailing after means the 200 lines kept are this session's, not 200 lines of whichever
 * review happened to write last.
 */
function readActivity(repoRoot: string, startedAt: number): ActivityLine[] {
  try {
    const path = activityPath(repoRoot);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const parsed: ActivityLine[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ActivityLine;
        if (Date.parse(entry.at) >= startedAt) parsed.push(entry);
      } catch {
        // One malformed line costs one line of history, not the read.
      }
    }
    return parsed.slice(-ACTIVITY_TAIL);
  } catch {
    return [];
  }
}

/**
 * An activity path as the diff spells it. The hook writes `repoRelative(repoRoot, …) ?? filePath`
 * and knows nothing about the session, so a PR review — whose read root is a worktree under the OS
 * temp directory, entirely outside the repository — logs absolute paths that match no diff entry at
 * all. Relativizing against `readRoot` here is what lands a worktree read on the same repo-relative
 * path the diff uses; on a local review the two roots are the same and nothing changes.
 *
 * The realpath pass is the one `src/commands/hook.ts` makes for the same reason: on macOS the temp
 * root arrives as a symlink and the file below it does not, so the raw comparison misses.
 */
function repoRelative(path: string, readRoot: string, repoRoot: string): string {
  if (!isAbsolute(path)) return path;
  for (const root of [readRoot, realRoot(readRoot), repoRoot, realRoot(repoRoot)]) {
    if (root === null) continue;
    const rel = relative(root, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    return rel.split(sep).join("/");
  }
  return path;
}

function realRoot(root: string): string | null {
  try {
    const real = realpathSync(root);
    return real === root ? null : real;
  } catch {
    return null;
  }
}

/**
 * What to show once no session directory survives. A review that ran in this process's lifetime
 * left its last snapshot behind, so that carries forward with a note explaining why it is frozen; a
 * viewer that never saw a session has nothing to carry and stays idle.
 *
 * The session directory vanishing is not by itself a gate: `empo review --reset` deletes it, and so
 * does an aborted run. Only a round record actually crossed here turns the phase to "gated"; without
 * one the last live phase carries forward, so a review that was killed mid-read is not reported as
 * judged with every finding tagged "suspected".
 *
 * The gate's verdict is read here rather than only in `readReviewState`, because the two things it
 * needs never coexist for long: `recordRound` and the teardown that deletes the session directory
 * are twenty lines apart (`src/commands/review.ts`), so a poll at any sane interval sees the
 * findings before and the round after, and practically never both at once. Crossing the carried
 * findings with the round on the way past is what makes survivors and dropped findings show at all.
 */
function afterTeardown(repoRoot: string, previous: Snapshot): Snapshot {
  if (previous.session === null) return emptySnapshot();
  const frozen: Snapshot = { ...previous, note: "session finished; showing its last state" };
  if (previous.round !== null) return { ...frozen, phase: "gated" };

  // Matched on the tree phase 1 read, not on time: that is exactly what the gate writes down about
  // the review it gated, so an older round on the same branch cannot be mistaken for this verdict.
  // Falling back to the sha the way `recordRound` does, since a record whose tree could not be read
  // carries the sha in that field and would otherwise match nothing at all.
  const tree = previous.session.tree ?? previous.session.sha;
  if (tree === null || tree === "") return frozen;
  const round = readRounds(repoRoot, previous.session.sourceBranch)
    .filter((one) => one.tree === tree)
    .at(-1);
  if (round === undefined) return frozen;

  const survivors = new Set(round.findings.map((one) => one.id));
  const findings = previous.findings.map((one) => ({ ...one, survived: survivors.has(one.id) }));
  // Survivors the carried findings do not name, for the same reason `readFindings` adds them: a
  // gate run with `--findings` pointing outside the session directory leaves the viewer holding no
  // suspected findings at all, and a round shown with none of them reads as a review that found
  // nothing rather than one whose text the viewer never saw.
  for (const survivor of round.findings) {
    if (findings.some((one) => one.id === survivor.id)) continue;
    findings.push({
      id: survivor.id,
      kind: survivor.kind,
      severity: survivor.severity,
      title: survivor.title,
      claim: "",
      file: survivor.file,
      line: survivor.line,
      anchor: "",
      suggestion: null,
      survived: true,
    });
  }
  return { ...frozen, phase: "gated", round: round.round, findings };
}
