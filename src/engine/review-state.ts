import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ChangedFile, type ChangeStatus, parseDiff } from "./diff";
import { activityPath, type ReviewSession, sessionDirs } from "./session";

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
  /** The gate's reason, when it dropped this one. */
  dropped: string | null;
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
  const activity = readActivity(repoRoot, startedAt);
  const opened = new Set(activity.map((one) => one.path));
  const inDiff = new Set(changed.map((one) => one.path));

  return {
    phase: activity.length === 0 ? "brief" : "reading",
    session,
    round: null,
    files: changed.map((file) => ({
      path: file.path,
      status: file.status,
      addedCount: file.addedCount,
      removedCount: file.removedCount,
      findingCount: 0,
      read: opened.has(file.path),
    })),
    hunks: Object.fromEntries(changed.map((file) => [file.path, file])),
    readOutsideDiff: [...opened].filter((path) => !inDiff.has(path)).sort(),
    findings: [],
    activity,
    liveSessions: dirs.length,
    note: dirs.length > 1 ? `${dirs.length} sessions active; showing the newest` : null,
  };
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
 * What to show once no session directory survives. A review that ran in this process's lifetime
 * left its last snapshot behind, so that carries forward with a note explaining why it is frozen; a
 * viewer that never saw a session has nothing to carry and stays idle.
 */
function afterTeardown(_repoRoot: string, previous: Snapshot): Snapshot {
  if (previous.session === null) return emptySnapshot();
  return { ...previous, phase: "gated", note: "session finished; showing its last state" };
}
