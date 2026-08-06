import { diffRange } from "../../engine/git";
import { type EmpoError, environmentError } from "../../errors";
import type { HostPullRequest } from "../../schema/host-payload.schema";
import type { VerifiedPullRequest } from "../host-input";
import type { CiResult, ForgeAdapter, ForgeCapability, ForgeComment, PullRequest } from "./types";

/**
 * The forge for every host EmPo cannot speak to itself (docs/09-adapters.md). Bitbucket, GitLab and
 * anything else behind an MCP connector arrive through this one adapter, because the agent running
 * the review is what holds the connector: it fetches the pull request, writes it to a file, and
 * re-runs the CLI pointing at that file. Six hosts, six token stories and six APIs to version
 * become zero, and src/engine/git.ts stays the only module in the tool that runs a subprocess.
 *
 * Two things make that acceptable rather than credulous.
 *
 * The payload is checked against git before this adapter is ever built (adapters/host-input.ts), so
 * a pull request a model invented has already failed on its branch names. And the diff is never
 * taken from the payload: `getDiff` computes it locally, which is why the round trip through the
 * host only ever carries metadata. The one artefact the review reasons over line by line is the one
 * artefact no model touched.
 *
 * `verified` carries the refs that check produced. They are taken rather than re-derived from the
 * payload's branch names on purpose: a pull request's source branch is usually only
 * `origin/<branch>` on the machine reviewing it, and a second copy of the local-then-origin rule
 * living here is how this file and the gate would come to disagree.
 *
 * `host` is the human-facing name of the host ("bitbucket", "jira"), used only in text this module
 * prints. Nothing here branches on it, which is what keeps a seventh host from being a code change.
 */

export function createMcpForge(
  repoRoot: string,
  options: {
    payload: HostPullRequest | null;
    verified: VerifiedPullRequest | null;
    host: string | null;
  },
): ForgeAdapter {
  const payload = options.payload;

  return {
    kind: "mcp",
    capabilities: capabilitiesOf(payload),

    getPr: () => toPullRequest(required(payload, options.host, "read the pull request")),

    getDiff: () => {
      const refs = verified(options.verified, options.host);

      const diff = diffRange(repoRoot, refs.baseRef, refs.headRef);
      if (diff === null) {
        // No theory about why. The refs resolved when the payload was checked and this is a
        // different moment, so anything said here about the cause would be a claim nothing
        // established, which is the one thing this tool exists to stop other things doing.
        throw environmentError(
          `git could not diff ${refs.baseRef}...${refs.headRef} in ${repoRoot}`,
          [
            "The review needs that diff and has no second way to get it.",
            `See what git says about it: git -C ${repoRoot} diff ${refs.baseRef}...${refs.headRef}`,
          ],
        );
      }
      return diff;
    },

    // `?? []` covers only the declared-absent case: with no `comments` capability the review states
    // that existing comments were not read, rather than reading this empty list as "nobody spoke".
    listComments: () =>
      required(payload, options.host, "list the comments").comments?.map(toComment) ?? [],

    // Never rounded up to passed (doc 07 invariant 1): the review reads this instead of running the
    // suite, so a pipeline nobody reported is unknown and says so.
    getCiResult: (): CiResult =>
      required(payload, options.host, "read the CI result").ci ?? {
        state: "unknown",
        detail: "no CI result was supplied by the host",
      },

    comment: () => {
      throw cannotPost("post a comment", options.host);
    },
    approve: () => {
      throw cannotPost("approve", options.host);
    },
    requestChanges: () => {
      throw cannotPost("request changes", options.host);
    },
  };
}

/**
 * Declared from what the payload contains, never from what the host could in principle answer
 * (types.ts, "Declared, not guessed"). The distinction that earns this function its existence is
 * `comments` absent against `comments: []`: the first means the agent did not fetch them and the
 * report has to say so, the second means it fetched them and the pull request has none.
 *
 * `pr` and `diff` are declared even for a null payload, which cannot happen by construction. The
 * alternative is worse than the throw it leads to: an adapter declaring no `diff` would have the
 * review skip the diff and report on nothing, and a review that quietly saw nothing is the one
 * outcome this tool must never produce.
 */
function capabilitiesOf(payload: HostPullRequest | null): ReadonlySet<ForgeCapability> {
  const capabilities: ForgeCapability[] = ["pr", "diff"];
  if (payload?.comments !== undefined) capabilities.push("comments");
  if (payload?.ci !== undefined) capabilities.push("ci");
  // No `post`: writing back would need the connector, which is the one thing the CLI does not have.
  return new Set(capabilities);
}

/**
 * Field for field, deliberately. The payload schema was written to the shape the review already
 * needs, so anything clever here would only be somewhere for the two to drift apart. `comments` and
 * `ci` are not part of a PullRequest and travel through their own methods.
 */
function toPullRequest(payload: HostPullRequest): PullRequest {
  return {
    id: payload.id,
    title: payload.title,
    author: payload.author,
    sourceBranch: payload.sourceBranch,
    baseBranch: payload.baseBranch,
    description: payload.description,
    url: payload.url,
  };
}

function toComment(comment: NonNullable<HostPullRequest["comments"]>[number]): ForgeComment {
  return { author: comment.author, body: comment.body, file: comment.file, line: comment.line };
}

/**
 * Unreachable in the same way `required` is: an adapter with a payload was built from a
 * verification that succeeded, and a verification that succeeded produced these refs.
 */
function verified(refs: VerifiedPullRequest | null, host: string | null): VerifiedPullRequest {
  if (refs !== null) return refs;
  throw environmentError(`The ${named(host)} forge cannot read the diff without verified refs`, [
    "verifyPullRequest hands back the refs that resolved, and the adapter is built from them.",
    "Reaching this means it was built without them, which is a bug in EmPo, not in the payload.",
  ]);
}

/**
 * Unreachable: createForge prints the request block instead of building this adapter when there is
 * no payload. It throws rather than returning an empty pull request all the same, because a
 * synthesized title and base branch would be facts in the review that nobody wrote.
 */
function required(
  payload: HostPullRequest | null,
  host: string | null,
  attempt: string,
): HostPullRequest {
  if (payload !== null) return payload;
  throw environmentError(`The ${named(host)} forge cannot ${attempt} without a payload`, [
    "empo review prints the file to write and is re-run with --pr pointing at it.",
    "Reaching this means the adapter was built without one, which is a bug in EmPo, not in the payload.",
  ]);
}

/**
 * The adapter declares no `post` capability, so the review never calls these. They throw rather
 * than doing nothing so that a future caller that forgets to check the capability finds out.
 */
function cannotPost(action: string, host: string | null): EmpoError {
  return environmentError(`The ${named(host)} forge cannot ${action}`, [
    "It reads a pull request the agent host fetched and has no connector of its own to write back with.",
    "Post it yourself with the tool the pull request was fetched with, or drop --post.",
  ]);
}

/** The configured host name when there is one, so the message says bitbucket rather than mcp. */
function named(host: string | null): string {
  return host === null || host.trim() === "" ? "mcp" : host;
}
