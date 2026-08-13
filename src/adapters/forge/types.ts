/**
 * The forge adapter contract (docs/09-adapters.md). A forge is the pull-request host. The review
 * discipline calls this interface and never the host's CLI, so adding a host is implementing this
 * file, not editing docs/07-review-discipline.md.
 *
 * Two rules the shape encodes:
 *
 * - Capabilities differ per host and the review has to be able to say what it could not check.
 *   A capability a host lacks is declared absent, so the report reads "CI result unavailable"
 *   rather than inventing a passing pipeline.
 * - Mutating calls (comment, approve, requestChanges) are opt-in at the command layer. An adapter
 *   with nowhere to post throws rather than silently doing nothing.
 */

import type { EmpoForge } from "../../schema/config.schema";

/**
 * `mcp` is one kind for every host empo cannot reach itself (Bitbucket, GitLab, and whatever comes
 * next): empo makes no network call, so the agent running it fetches the pull request with its own
 * connector and empo validates the payload against this repository. Which host it was is
 * `adapters.forge.host`, a free string nothing here branches on.
 *
 * Derived from `forgeSchema` rather than spelled a second time. The factory in `create.ts` switches
 * on the schema's enum and proves exhaustiveness against that, so a kind written only here used to
 * compile everywhere and reach no branch. One declaration cannot diverge from itself.
 */
export type ForgeKind = EmpoForge["kind"];

/**
 * `OWNER/REPO`, the only form a github tool accepts, from the two fields config keeps apart.
 *
 * Detection splits an origin remote into a workspace and a repo because every Bitbucket call wants
 * them separate (docs/09-adapters.md), and `gh --repo` wants them joined. Nothing joined them for
 * the adapter, so `empo review <pr>` against any github repository died on
 * `expected the "[HOST/]OWNER/REPO" format` before it fetched anything, while `empo init` printed
 * the right slug from its own copy of this expression and looked correct.
 *
 * Undefined when there is no repo to name, which is the one case where the flag must be left off
 * entirely rather than passed empty: gh then infers the repository from the working directory,
 * which is the right answer, and `--repo ""` is not.
 */
export function forgeSlug(forge: { repo?: string; workspace?: string }): string | undefined {
  if (forge.repo === undefined) return undefined;
  return forge.workspace === undefined ? forge.repo : `${forge.workspace}/${forge.repo}`;
}

/**
 * What a host can answer. `pr`, `comments` and `ci` are absent on `local`, which has no host,
 * and `post` is absent wherever the review cannot write back.
 */
export type ForgeCapability = "pr" | "diff" | "comments" | "ci" | "post";

export interface PullRequest {
  id: string;
  title: string;
  author: string;
  /** The branch under review, checked out verbatim into the review's worktree. */
  sourceBranch: string;
  /**
   * Load-bearing for stacked PRs: comparing against the wrong base floods the review with findings
   * that belong to the parent PR (docs/07-review-discipline.md step 1).
   */
  baseBranch: string;
  description: string;
  url: string;
}

export interface ForgeComment {
  author: string;
  body: string;
  /** Repo-relative path for an inline comment, null for a top-level one. */
  file: string | null;
  line: number | null;
}

export type CiState = "passed" | "failed" | "pending" | "unknown";

/** The review reads this instead of running the target project's tests (invariant 1 of doc 07). */
export interface CiResult {
  state: CiState;
  detail: string;
}

/** Where an inline comment attaches. Repo-relative, like every citation EmPo prints. */
export interface InlineAnchor {
  file: string;
  line: number;
}

export interface ForgeAdapter {
  readonly kind: ForgeKind;
  /** Declared, not guessed. The review names every capability it did not have. */
  readonly capabilities: ReadonlySet<ForgeCapability>;
  /** One call for all PR metadata. `null` when this host has no `pr` capability. */
  getPr(id: string): PullRequest | null;
  /** The unified diff as text. Every adapter can do this one; it is what makes `local` viable. */
  getDiff(id: string): string;
  listComments(id: string): ForgeComment[];
  getCiResult(id: string): CiResult;
  comment(id: string, body: string, inline?: InlineAnchor): void;
  approve(id: string): void;
  requestChanges(id: string, body: string): void;
}

export function hasCapability(adapter: ForgeAdapter, capability: ForgeCapability): boolean {
  return adapter.capabilities.has(capability);
}
