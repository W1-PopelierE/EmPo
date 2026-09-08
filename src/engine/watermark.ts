import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * What a branch was last reviewed against, so a second review of the same branch can be about what
 * changed since the first one (docs/06-cli.md, `empo review --since`).
 *
 * The problem it exists for: nothing recorded that a review had happened, so every round diffed
 * against the base again. Eleven rounds over one branch re-read the same seven hundred lines
 * eleven times while each round had changed a few dozen.
 *
 * It lives beside the review scratch in the OS temp directory and never inside the repository.
 * `.empo/generated/` is machine-owned by `empo index` alone (docs/02-on-disk-layout.md) and a
 * review disturbs nothing in the checkout it reads (docs/07-review-discipline.md invariant 2), so a
 * file this command writes belongs on neither. The cost is honest and worth naming: a temp sweep
 * loses the watermark, and `--since` then reports a full review rather than pretending otherwise.
 *
 * Per branch and not per repository, because two branches under review at once are two loops, and a
 * shared entry would tell the second one it had already read the first one's work.
 */
export interface ReviewMark {
  /** The commit whose review was gated. `--since` diffs the working tree against this. */
  sha: string;
  /** ISO timestamp of the gate that wrote it, so a stale watermark can be read as stale. */
  at: string;
  /** How many rounds have been gated against this branch. The next review is round + 1. */
  round: number;
}

interface WatermarkFile {
  version: 1;
  branches: Record<string, ReviewMark>;
}

/**
 * Both phases and every future run have to land on the same file, so the key is the root git and
 * the OS agree on: /var and /private/var are one checkout on macOS, and a relative path is one too.
 */
export function canonicalRoot(repoRoot: string): string {
  try {
    return realpathSync(repoRoot);
  } catch {
    return resolve(repoRoot);
  }
}

export function watermarkPath(repoRoot: string): string {
  const digest = createHash("sha256").update(canonicalRoot(repoRoot)).digest("hex").slice(0, 8);
  return join(tmpdir(), "empo-review", `watermark-${digest}.json`);
}

/** What this branch was last reviewed at, or null where no round has been gated against it. */
export function readMark(repoRoot: string, branch: string | null): ReviewMark | null {
  if (branch === null) return null;
  return readFile(repoRoot).branches[branch] ?? null;
}

/**
 * Record that `sha` on `branch` has been reviewed. Called by the gate and nowhere else: the brief
 * is not a review, it is the facts a review reads, and a round that never reached the gate produced
 * nothing anyone should be told they can skip re-reading.
 */
export function recordReview(repoRoot: string, branch: string | null, sha: string | null): void {
  if (branch === null || sha === null || sha === "") return;
  const file = readFile(repoRoot);
  const round = (file.branches[branch]?.round ?? 0) + 1;
  file.branches[branch] = { sha, at: new Date().toISOString(), round };
  const path = watermarkPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** A watermark we cannot read is scratch, not state: it reads as no rounds, which is a full review. */
function readFile(repoRoot: string): WatermarkFile {
  const path = watermarkPath(repoRoot);
  if (!existsSync(path)) return { version: 1, branches: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as WatermarkFile;
    return typeof parsed.branches === "object" && parsed.branches !== null
      ? { version: 1, branches: parsed.branches }
      : { version: 1, branches: {} };
  } catch {
    return { version: 1, branches: {} };
  }
}
