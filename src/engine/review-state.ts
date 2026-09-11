import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { ReviewFinding } from "../discipline/findings";
import { parseFindingsFile } from "../schema/findings.schema";
import { type ChangedFile, type ChangeStatus, parseDiff } from "./diff";
import {
  archivePath,
  pruneArchives,
  type RoundRecord,
  readRounds,
  type SavedRound,
  savedRounds,
} from "./rounds";
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
}

/** One live review a viewer can switch to. The page composes the line; the shape is what it needs. */
export interface SessionChoice {
  /** The session directory's basename. Stable while the review lives; this is what `?session=` names. */
  key: string;
  /** "local", or the pull request id. */
  id: string;
  /** The branch under review, falling back to the short sha, then to "working tree". */
  branch: string;
  phase: Phase;
  /** The round this is a saved picture of, or null while the review is still live. */
  round: number | null;
  /** When the gate that saved it ran, or null for a live review. */
  at: string | null;
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
  /** Every live session, newest first. */
  sessions: SessionChoice[];
  /** The key this snapshot is about, which is not always the key that was asked for. */
  selected: string | null;
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
    sessions: [],
    selected: null,
    note: null,
  };
}

/**
 * `selected` is a key out of `sessions`. When it names a live session directory that one is shown;
 * anything else — a key that was never valid, or one whose review was torn down between the click
 * and the poll — falls back to the newest, which is what a viewer with no choice at all gets.
 */
export function readReviewState(
  repoRoot: string,
  previous: Snapshot,
  selected?: string | null,
): Snapshot {
  // Every gate this repository ran that still has a picture, whether or not anything is live now:
  // they are rows in the switcher either way, and the one thing a reader cannot get back by waiting
  // is the review that already finished.
  const saved = savedRounds(repoRoot);
  const savedChoices: SessionChoice[] = saved.map((one) => ({
    key: SAVED_PREFIX + one.key,
    id: one.record.id,
    branch: one.record.branch === "" ? "working tree" : one.record.branch,
    phase: "gated",
    round: one.record.round,
    at: one.record.at,
  }));

  const dirs = sessionDirs(repoRoot);
  if (dirs.length === 0) {
    return withoutLive(repoRoot, previous, selected ?? "", saved, savedChoices);
  }

  // Read once for every session rather than once per session: the log is one file per repository
  // and this whole function runs on a poll, so parsing it four times over would be three times the
  // work for the same lines. The diff is the other half of that: it is the only large file here and
  // no session's phase depends on it, so only the session actually on screen has its diff parsed.
  const log = readActivityLog(repoRoot);
  const onDisk = liveSessions(dirs);
  const live = onDisk.map((one) => ({ ...one, ...derive(repoRoot, one, log, onDisk) }));
  const sessions: SessionChoice[] = [
    ...live.map((one) => ({
      key: one.key,
      id: one.session.id,
      branch: branchOf(one.session),
      phase: one.phase,
      round: null,
      at: null,
    })),
    ...savedChoices,
  ];

  // A saved round is picked explicitly and never fallen back to: the newest live review is what a
  // viewer with no choice should see, and a key naming a snapshot that has since been pruned means
  // the same as any other unknown key.
  const archived = pickArchive(saved, sessions, selected ?? "");
  if (archived !== null) return archived;

  const found = live.find((one) => one.key === selected) ?? live[0];
  // A session directory with no readable `session.json` is a teardown mid-delete or a session
  // mid-write, and neither is a reason to throw away what the viewer already holds: `src/commands/
  // web.ts` stores this result, so returning an empty snapshot here would make the next poll see
  // `previous.session === null` and lose the finished review's frozen picture and its verdict.
  if (found === undefined) return { ...afterTeardown(repoRoot, previous), sessions };
  const { session, round } = found;

  const changed = readDiff(session);
  const activity = found.activity.map((one) => ({
    ...one,
    path: repoRelative(one.path, session.readRoot, repoRoot),
  }));
  const opened = new Set(activity.map((one) => one.path));
  const inDiff = new Set(changed.map((one) => one.path));

  const findings = crossFindings(found.suspected, round);
  const findingCounts = new Map<string, number>();
  for (const finding of findings) {
    findingCounts.set(finding.file, (findingCounts.get(finding.file) ?? 0) + 1);
  }

  return {
    phase: found.phase,
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
    sessions,
    selected: found.key,
    note: null,
  };
}

/**
 * What `?session=` names a saved round by, kept apart from a live key by a prefix a session
 * directory basename cannot contain: `sessionDir` sanitises its slug and hashes the rest, so no
 * live key ever carries a colon.
 */
const SAVED_PREFIX = "saved:";

/**
 * The snapshot a gated round saved, when that is what was asked for. Null for any other key,
 * including one naming a round whose snapshot has since been pruned — which is an unknown key and
 * falls back the way every unknown key does.
 */
function pickArchive(
  saved: SavedRound[],
  sessions: SessionChoice[],
  selected: string,
): Snapshot | null {
  if (!selected.startsWith(SAVED_PREFIX)) return null;
  const one = saved.find((round) => SAVED_PREFIX + round.key === selected);
  if (one === undefined) return null;
  const snapshot = readArchive(one.path);
  if (snapshot === null) return null;
  return {
    ...snapshot,
    phase: "gated",
    round: one.record.round,
    sessions,
    selected,
    note: `finished review, round ${one.record.round}${when(one.record.at)}`,
  };
}

/**
 * What to show with no session directory left. The order is what the reader means by "the review I
 * was looking at": the one this viewer watched finish, then anything saved, then nothing.
 *
 * The frozen copy wins over its own saved snapshot because they are the same review and the frozen
 * one is the one already on screen — swapping it for a file would redraw the diff and drop the
 * reader's scroll at the exact moment the gate landed.
 */
function withoutLive(
  repoRoot: string,
  previous: Snapshot,
  selected: string,
  saved: SavedRound[],
  sessions: SessionChoice[],
): Snapshot {
  const archived = pickArchive(saved, sessions, selected);
  if (archived !== null) return archived;

  // The picture already on screen is a saved round, so it stays that: `afterTeardown` below would
  // carry the same content forward under a note about a session that finished, which is not what a
  // reader looking at round three from yesterday is being told.
  const again = pickArchive(saved, sessions, previous.selected ?? "");
  if (again !== null) return again;

  const frozen = afterTeardown(repoRoot, previous);
  if (frozen.session !== null) return { ...frozen, sessions };

  const newest = saved[0];
  if (newest === undefined) return { ...emptySnapshot(), sessions };
  return (
    pickArchive(saved, sessions, SAVED_PREFIX + newest.key) ?? { ...emptySnapshot(), sessions }
  );
}

/** A gate time a header can hold, or nothing at all where the record carries none. */
function when(at: string): string {
  return at === "" ? "" : `, gated ${at.slice(0, 16).replace("T", " ")}`;
}

/**
 * Keep this round's picture where the gate's own record lives, so the viewer can still draw it once
 * teardown has taken the session directory. Best-effort by design: a snapshot nobody could write
 * costs a reader some history, and failing the gate over it would cost them the review.
 *
 * The three view fields are dropped rather than saved. `sessions` and `selected` are about the
 * window that happens to be open, and a note saved here would outlive the reason for it.
 */
export function writeArchive(
  repoRoot: string,
  branch: string | null,
  round: number,
  snapshot: Snapshot,
): void {
  if (branch === null || branch === "") return;
  try {
    writeFileSync(
      archivePath(repoRoot, branch, round),
      JSON.stringify({ ...snapshot, sessions: [], selected: null, note: null }),
      { encoding: "utf8", mode: 0o600 },
    );
    pruneArchives(repoRoot);
  } catch {
    // A picture we cannot save is a viewer that shows less, never a gate that fails.
  }
}

/**
 * A saved snapshot, or null where the file is gone or unreadable. Spread onto an empty snapshot so
 * a file written by an older version, missing a field this one draws, renders as that field empty
 * rather than as a page that throws on it.
 */
function readArchive(path: string): Snapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Snapshot>;
    if (parsed.session === undefined) return null;
    return { ...emptySnapshot(), ...parsed };
  } catch {
    return null;
  }
}

/** What every live session needs derived, whether it is on screen or only a line in the switcher. */
interface SessionState {
  /** This session's own reads, paths still absolute as the hook logged them. */
  activity: ActivityLine[];
  suspected: ReviewFinding[];
  round: RoundRecord | null;
  phase: Phase;
}

/**
 * Everything a session's phase is inferred from, and nothing else. Deliberately without the diff:
 * it is hundreds of kilobytes, the phase does not depend on it, and this runs for every live session
 * on every poll — parsing four diffs to draw one is the difference between a viewer you can leave
 * open and one you notice.
 *
 * `belongsHere` applies to the switcher for the same reason it applies to the activity list: a
 * session that has read nothing must not be dragged from "brief" to "reading" by the review running
 * beside it.
 */
function derive(
  repoRoot: string,
  here: LiveSession,
  log: ActivityLine[],
  live: LiveSession[],
): SessionState {
  const activity = log
    .filter((one) => Date.parse(one.at) >= here.startedAt && belongsHere(one.path, here, live))
    .slice(-ACTIVITY_TAIL);
  const suspected = readFindingsFile(here.dir);
  const round = newestRound(repoRoot, here.session, here.startedAt);
  let phase: Phase = activity.length === 0 ? "brief" : "reading";
  if (suspected.length > 0) phase = "findings";
  if (round !== null) phase = "gated";
  return { activity, suspected, round, phase };
}

/** What a human recognises the review by. A detached revision has no branch, so the sha stands in. */
function branchOf(session: ReviewSession): string {
  if (session.sourceBranch !== null && session.sourceBranch !== "") return session.sourceBranch;
  if (session.sha !== null && session.sha !== "") return session.sha.slice(0, 7);
  return "working tree";
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
function crossFindings(suspected: ReviewFinding[], round: RoundRecord | null): SnapshotFinding[] {
  if (round === null) return suspected.map((one) => toSnapshotFinding(one, null));

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
  return findings;
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

/**
 * `findings.json` as phase 1 leaves it, or nothing at all before it exists or once it is gone.
 * Joined onto the directory `liveSessions` actually read `session.json` out of, rather than
 * recomputed from the id: a directory named by an older slug scheme still holds a session whose id
 * `sessionDir` would map somewhere else entirely, and then the findings beside it are missed.
 */
function readFindingsFile(dir: string): ReviewFinding[] {
  try {
    const path = join(dir, "findings.json");
    if (!existsSync(path)) return [];
    return parseFindingsFile(JSON.parse(readFileSync(path, "utf8")), path);
  } catch {
    return [];
  }
}

/**
 * The newest round for this session's branch, but only this session's own and only newer than the
 * session itself: an old round left over from a previous review of this branch is not this review's
 * verdict, and showing it would mark this round's findings survived or dropped by a gate that never
 * saw them.
 *
 * The id is what separates two live reviews of one branch. `roundsDir` (`src/engine/rounds.ts`)
 * keys on repository and branch alone, and `isolate` (`src/commands/review.ts`) gives a pull request
 * reviewed from the branch you are standing on the same `sourceBranch` as the local review beside
 * it — so on branch and time alone both sessions adopt whichever of them gated first, and the other
 * one shows a round number, a phase and a set of verdicts belonging to a gate that never read it.
 *
 * `afterTeardown` needs the same id for the same reason, and has it: the carried snapshot holds the
 * whole session phase 1 wrote, id included, and phase 2 hands `recordRound` that session's id and
 * that session's tree (`src/commands/review.ts`), so the round belonging to a frozen review carries
 * both. It narrows on the tree as well, because there the session is gone and time is no longer a
 * usable bound: an older round of this same review would otherwise be read as its verdict.
 */
function newestRound(
  repoRoot: string,
  session: ReviewSession,
  startedAt: number,
): RoundRecord | null {
  const rounds = readRounds(repoRoot, session.sourceBranch);
  const newest = rounds.filter((one) => one.id === session.id).at(-1) ?? null;
  if (newest === null) return null;
  return Date.parse(newest.at) >= startedAt ? newest : null;
}

interface LiveSession {
  key: string;
  /** The directory `session.json` was read out of, so nothing beside it has to be recomputed. */
  dir: string;
  session: ReviewSession;
  startedAt: number;
}

/**
 * Every session a viewer can switch to, paired with when each started. `sessionDirs` already sorts
 * newest first by mtime, so this only has to skip a directory whose `session.json` lost a race with
 * teardown or was never finished — reading is best-effort here, the way every source in this module
 * is, rather than a reason to show nothing while a second review is mid-write.
 *
 * The key is the directory's basename and not the session id: two reviews of the same repository can
 * both be "local", while the directory name carries the repository hash and stays unique.
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
function liveSessions(dirs: string[]): LiveSession[] {
  const live: LiveSession[] = [];
  for (const dir of dirs) {
    try {
      const file = join(dir, "session.json");
      if (!existsSync(file)) continue;
      const session = JSON.parse(readFileSync(file, "utf8")) as ReviewSession;
      // Floored: the filesystem's mtime can carry sub-millisecond precision `Date.parse` never
      // does (nanoseconds rounded to a fraction of a millisecond), so an activity line logged in
      // the same millisecond session.json was written can otherwise compare as slightly earlier.
      live.push({
        key: basename(dir),
        dir,
        session,
        startedAt: Math.floor(statSync(file).mtimeMs),
      });
    } catch {
      // Try the next directory; a half-written session.json is normal mid-write, not a failure.
    }
  }
  return live;
}

/**
 * Whether an activity line was this session's read. The log is one file per repository and the hook
 * that appends to it knows nothing about sessions, so time alone cannot separate two reviews running
 * at once: a PR review reading its worktree would mark the local review's files as opened and drag
 * its phase from "brief" to "reading".
 *
 * A line belongs to the session whose read root claims it deepest. That separates a PR review (a
 * detached worktree under the temp directory) from a local one (the checkout), and two PR reviews
 * from each other. Two LOCAL reviews of one checkout it cannot separate — they read literally the
 * same files — so both claim equally deep and both keep the line. Unclaimed and relative paths stay
 * too: an attribution nobody can make is more use visible than discarded.
 */
function belongsHere(path: string, here: LiveSession, live: LiveSession[]): boolean {
  if (!isAbsolute(path)) return true;
  const mine = claimDepth(path, here.session.readRoot);
  const deepest = Math.max(...live.map((one) => claimDepth(path, one.session.readRoot)));
  return deepest < 0 || mine === deepest;
}

/**
 * How deep a read root contains a path, as the length of the root that matched, or -1 for none.
 * The realpath pass is `repoRelative`'s, for the same reason: on macOS the temp root arrives as a
 * symlink and the file below it does not, so a raw comparison misses the worktree entirely.
 */
function claimDepth(path: string, readRoot: string): number {
  let deepest = -1;
  for (const root of [readRoot, realRoot(readRoot)]) {
    if (root === null) continue;
    const rel = relative(root, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    deepest = Math.max(deepest, root.length);
  }
  return deepest;
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
 * The whole activity log the `tool-use` hook appends to, every session's lines together, since one
 * file holds them all and `derive` splits them per session afterwards. A line the hook half-wrote
 * (a crash mid-append) is dropped rather than failing the whole read, since one bad line should cost
 * one line of history, not the display.
 *
 * The `startedAt` filter `derive` applies is what keeps a review out of its predecessor's history:
 * `activityPath` is one file per repository, not per review, so without it a second review would
 * start in "reading" instead of "brief" and show the previous review's files as already read.
 * Filtering first and tailing after means the 200 lines kept are that session's, not 200 lines of
 * whichever review happened to write last.
 */
function readActivityLog(repoRoot: string): ActivityLine[] {
  try {
    const path = activityPath(repoRoot);
    if (!existsSync(path)) return [];
    const parsed: ActivityLine[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        parsed.push(JSON.parse(line) as ActivityLine);
      } catch {
        // One malformed line costs one line of history, not the read.
      }
    }
    return parsed;
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
  // No directory survives, so nothing is live to switch to; `selected` stays, since it still says
  // which review this frozen picture is of.
  const frozen: Snapshot = {
    ...previous,
    sessions: [],
    note: "session finished; showing its last state",
  };
  if (previous.round !== null) return { ...frozen, phase: "gated" };

  // Matched on the review that wrote it and on the tree phase 1 read, not on time: together those
  // are exactly what the gate writes down about the review it gated, so neither an older round on
  // the same branch nor a round of the other review sharing it can be mistaken for this verdict.
  // The id alone is not enough — this review's own earlier rounds carry it too — and the tree alone
  // is not either, because `isolate` gives a pull request reviewed from the branch you are standing
  // on the same `sourceBranch` as the local review beside it, and with nothing uncommitted between
  // them the same tree as well. Falling back to the sha the way `recordRound` does, since a record
  // whose tree could not be read carries the sha in that field and would otherwise match nothing.
  const { id, tree: read, sha, sourceBranch } = previous.session;
  const tree = read ?? sha;
  if (tree === null || tree === "") return frozen;
  const round = readRounds(repoRoot, sourceBranch)
    .filter((one) => one.id === id && one.tree === tree)
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
