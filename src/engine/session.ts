import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson } from "../errors";
import { canonicalRoot, pathKey } from "./rounds";

/**
 * Where phase 1 of a review leaves what phase 2 verifies against, and what a viewer reads while it
 * is happening. This lives in the engine rather than in `empo review` because three callers need
 * the same path — review itself, the `tool-use` hook, and `empo web` — and a second copy of the
 * formula is a drift waiting to happen. Nothing here writes; review owns creation and teardown.
 */

const ROOT = join(tmpdir(), "empo-review");

/** What phase 1 leaves behind so phase 2 can verify against the same code the review read. */
export interface ReviewSession {
  id: string;
  repoRoot: string;
  /** Where citations are resolved: a detached worktree for a PR, the checkout for a local diff. */
  readRoot: string;
  worktree: string | null;
  base: string;
  sourceBranch: string | null;
  /**
   * The revision phase 1 actually read, so the gate records that and not wherever HEAD has since
   * gone. A local review is the case that bites: commit or amend between the brief and the gate and
   * a round taken at gate time would name a commit nobody reviewed, and the next round would skip
   * past it unread. Null where git could not answer, which records nothing rather than a guess.
   */
  sha: string | null;
  /**
   * The tree phase 1 read, which is what the next round narrows against. Not the same thing as
   * `sha`: a local review is mostly uncommitted work, so a round that recorded only the commit
   * would tell the next round nothing about the lines it had actually read.
   */
  tree: string | null;
  diffPath: string;
}

/**
 * Scratch lives in the OS temp directory, never under .empo/. `generated/` is machine-owned by
 * empo index alone (docs/02-on-disk-layout.md), and a review must disturb nothing in the repository
 * it is reviewing.
 *
 * The repository is half the key because the id alone does not identify a review: a local one is
 * always "local", so every checkout on one machine would share one directory and each review would
 * tear down the one already running. That is not merely lost scratch. Phase 2 recovers its read root
 * from session.json, so a shared directory hands one repository's findings the other repository's
 * source to verify against, and a claim that stands on nothing comes back verified. The readable id
 * stays in the name so a human can still find the directory a brief just named.
 */
export function sessionDir(repoRoot: string, id: string): string {
  return join(ROOT, pathKey(id, canonicalRoot(repoRoot)));
}

export function readSession(repoRoot: string, id: string): ReviewSession | null {
  const file = join(sessionDir(repoRoot, id), "session.json");
  if (!existsSync(file)) return null;
  try {
    return readJson(file, file) as ReviewSession;
  } catch {
    return null;
  }
}

/**
 * Every live session directory for this repository, newest first. The repository is the hash half
 * of the key, identical across ids, so the suffix of an empty-id key is exactly the filter.
 */
export function sessionDirs(repoRoot: string): string[] {
  const suffix = pathKey("", canonicalRoot(repoRoot)).slice(1);
  try {
    return readdirSync(ROOT)
      .filter((name) => name.endsWith(suffix))
      .map((name) => join(ROOT, name))
      .filter((dir) => statSync(dir).isDirectory())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  } catch {
    return [];
  }
}

/** One log per repository, beside the sessions, so the hook needs no session id to write it. */
export function activityPath(repoRoot: string): string {
  return join(ROOT, `activity-${pathKey("", canonicalRoot(repoRoot))}.jsonl`);
}
