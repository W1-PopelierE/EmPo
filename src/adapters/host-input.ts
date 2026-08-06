import { existsSync, readFileSync } from "node:fs";
import type { z } from "zod";
import { resolveRef, shortSha } from "../engine/git";
import {
  type HostPullRequest,
  type HostTicket,
  hostPullRequestSchema,
  hostTicketSchema,
} from "../schema/host-payload.schema";

/**
 * The gate between what an agent host says it fetched and what this repository can confirm
 * (docs/09-adapters.md, the `mcp` adapters). This module is the entire justification for letting an
 * agent fetch the pull request instead of having EmPo fetch it: a model's answer is only acceptable
 * when it is checked against something the model does not control, and git is that something.
 *
 * So the check is deliberately not "does this JSON look right". A hallucinated pull request looks
 * perfectly right: it has an id, a title and two plausible branch names. What it does not have is
 * branches that exist in the checkout the review is about to run in, and that is what fails it.
 *
 * Problems are returned rather than thrown, as a list. The caller turns them into one `configError`
 * (exit 2, docs/06-cli.md) naming every problem at once, because an agent that has to re-fetch
 * should learn everything wrong with its payload on the first try, not one problem per round trip.
 * Exit 2 and not 3 on purpose: nothing about the environment is broken, the agent handed over a
 * payload it can fix and hand over again.
 *
 * Nothing here writes to the repository, and in particular nothing fetches. A gate that mutated the
 * checkout to make itself pass would not be a gate, and "this checkout has not fetched the commit
 * yet" is a thing the review needs told rather than papered over. Fetching belongs to `review.ts`,
 * which already owns it for the github path.
 */

export type HostRead<T> = { ok: true; value: T } | { ok: false; problems: string[] };

export function readHostPullRequest(path: string): HostRead<HostPullRequest> {
  return read(path, hostPullRequestSchema, "pull request");
}

export function readHostTicket(path: string): HostRead<HostTicket> {
  return read(path, hostTicketSchema, "ticket");
}

/**
 * The two refs the review will actually run git against.
 *
 * Handed back rather than recomputed by the caller, because the spelling that resolves is the one
 * thing verification learns and it is the one thing the diff needs. A pull request's source branch
 * is usually only `origin/<branch>` on the machine reviewing it, so a caller that re-derived the
 * name from the payload would ask git for a ref this checkout does not have, and the two copies of
 * that rule would drift apart the first time one of them changed.
 */
export interface VerifiedPullRequest {
  /** The ref git will accept, which is "main" or "origin/main" depending on what resolved. */
  baseRef: string;
  headRef: string;
}

export type Verification =
  | { ok: true; value: VerifiedPullRequest }
  | { ok: false; problems: string[] };

/**
 * Whether this payload is consistent with this repository, and if it is, what to diff.
 *
 * The branch checks are what catch an invented pull request: a branch name a model wrote out of the
 * shape of the ticket resolves to nothing here, and the review stops before it reads a diff of the
 * wrong two commits. The sha check catches the subtler one, a payload that was true when it was
 * written and is not any more.
 */
export function verifyPullRequest(repoRoot: string, pr: HostPullRequest, id: string): Verification {
  const problems: string[] = [];

  // The id it was asked for and the id it fetched can drift by one keystroke, and the payload that
  // comes back is a real pull request, just not this one. Nothing downstream would notice.
  if (pr.id !== id) {
    problems.push(
      `The payload describes pull request ${pr.id}, but the review was asked for ${id}. ` +
        "Fetch the pull request that was asked for, or run the review against the one that was fetched.",
    );
  }

  const baseRef = locateBranch(repoRoot, pr.baseBranch);
  const headRef = locateBranch(repoRoot, pr.sourceBranch);
  if (baseRef === null) problems.push(unresolved("base branch", pr.baseBranch, repoRoot));
  if (headRef === null) problems.push(unresolved("source branch", pr.sourceBranch, repoRoot));

  if (headRef !== null) {
    const stale = staleness(repoRoot, pr, headRef);
    if (stale !== null) problems.push(stale);
  }

  if (baseRef === null || headRef === null || problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { baseRef, headRef } };
}

/**
 * The ref that names a payload's branch in this checkout: the branch itself when it is here, its
 * remote-tracking ref when it is not. Null when neither exists.
 *
 * Deliberately not exported. This is the one implementation of that rule, and `verifyPullRequest`
 * hands its answer on in `VerifiedPullRequest`, so anything needing the ref takes it from there.
 * A second caller would resolve at a second moment against a repository that may have moved, and
 * the module boundary is a better place to say that than a comment asking nicely.
 */
function locateBranch(repoRoot: string, branch: string): string | null {
  if (resolveRef(repoRoot, branch) !== null) return branch;
  if (resolveRef(repoRoot, `origin/${branch}`) !== null) return `origin/${branch}`;
  return null;
}

/**
 * The two causes are named together because they cannot be told apart from here. Whether a branch
 * exists on the remote is a question only the network answers, and this gate does not ask it, so
 * "you have not fetched it" and "it is not a branch" arrive as one sentence rather than as a guess
 * dressed up as a diagnosis.
 */
function unresolved(label: string, branch: string, repoRoot: string): string {
  return (
    `The ${label} "${branch}" does not resolve to a commit in ${repoRoot}: neither "${branch}" ` +
    `nor "origin/${branch}" is a ref there. Either this checkout has not fetched it, or the name ` +
    "in the payload is not a branch. EmPo does not fetch on your behalf: run git fetch and try again."
  );
}

/**
 * Whether the branch here is at the commit the host said the pull request is at.
 *
 * Compared by prefix and not by equality. Bitbucket reports an abbreviated 12-character hash while
 * git resolves a branch to the full 40, so `===` would report staleness on every Bitbucket payload
 * ever written. It would fail in the direction that looks safe, which is how a check like this ends
 * up deleted for crying wolf rather than fixed.
 */
function staleness(repoRoot: string, pr: HostPullRequest, headRef: string): string | null {
  // Absent is silent: not every host supplies a head sha, and demanding one would refuse payloads
  // from hosts that are otherwise fine.
  if (pr.headSha === undefined) return null;

  const here = resolveRef(repoRoot, headRef);
  if (here === null || sameCommit(pr.headSha, here)) return null;

  return (
    `The payload says pull request ${pr.id} is at ${pr.headSha}, but ${headRef} is at ` +
    `${shortSha(here)} in ${repoRoot}. Either this checkout has not fetched the newer commit, or ` +
    "the payload was written against an older push. Either way the review would read code the pull " +
    "request does not contain: run git fetch, and fetch the pull request again if it still differs."
  );
}

/** The shorter matched against the longer, so an abbreviated hash and a full one agree. */
function sameCommit(reported: string, resolved: string): boolean {
  const [short, long] =
    reported.length <= resolved.length ? [reported, resolved] : [resolved, reported];
  // An empty sha would prefix-match every commit there is, which is the opposite of a check.
  if (short === "") return false;
  return long.toLowerCase().startsWith(short.toLowerCase());
}

/**
 * One reader for both payloads. Each of the three ways this can fail is a sentence about the file,
 * because the agent that has to fix it never sees a stack trace, only what the CLI printed.
 */
function read<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  what: string,
): HostRead<z.infer<Schema>> {
  if (!existsSync(path)) {
    return {
      ok: false,
      problems: [`There is no file at ${path}, so no ${what} was handed back to EmPo.`],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, problems: [`${path} is not valid JSON: ${(error as Error).message}`] };
  }

  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };

  // The same field-first shape parseFindingsFile and parseSpineFile print, so a payload problem
  // and a findings problem read alike. A strictObject names the offending key in the message, and
  // the path is the object that carried it.
  const problems = result.error.issues.map((issue) => {
    const where = issue.path.join(".");
    return where ? `${where}: ${issue.message}` : issue.message;
  });
  return { ok: false, problems };
}
