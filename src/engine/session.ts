import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "../errors";
import { canonicalRoot, pathKey, reviewsDir } from "./rounds";

/**
 * Where phase 1 of a review leaves what phase 2 verifies against. This lives in the engine rather
 * than in `empo review` because the path is engine knowledge, not command
 * knowledge. Nothing here
 * writes; review owns creation and teardown.
 */

/** Session scratch, per repository, beside the round log. */
function sessionsRoot(repoRoot: string): string {
  return join(reviewsDir(repoRoot), "sessions");
}

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
 * Scratch lives in `.empo/reviews/sessions/`, which ignores itself, so a review survives a reboot and
 * still commits nothing into the repository it is reviewing.
 *
 * The repository is half the key because the id alone does not identify a review: a local one is
 * always "local", so every checkout on one machine would share one directory and each review would
 * tear down the one already running. That is not merely lost scratch. Phase 2 recovers its read root
 * from session.json, so a shared directory hands one repository's findings the other repository's
 * source to verify against, and a claim that stands on nothing comes back verified. The readable id
 * stays in the name so a human can still find the directory a brief just named.
 */
export function sessionDir(repoRoot: string, id: string): string {
  return join(sessionsRoot(repoRoot), pathKey(id, canonicalRoot(repoRoot)));
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
