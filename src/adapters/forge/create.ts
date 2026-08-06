import { existsSync } from "node:fs";
import { commandExists } from "../../engine/git";
import type { EmpoConfig } from "../../schema/config.schema";
import type { HostPullRequest } from "../../schema/host-payload.schema";
import type { VerifiedPullRequest } from "../host-input";
import { createGithubForge } from "./github";
import { createLocalForge } from "./local";
import { createMcpForge } from "./mcp";
import { type ForgeAdapter, forgeSlug } from "./types";

/**
 * Picks the forge from config (docs/09-adapters.md, "Graceful degradation"). Every path here ends
 * in a working adapter: a missing CLI, or a pull request the agent host has not handed over yet,
 * degrades to the local diff and returns a note saying so, because a user with no adapters
 * configured still gets a review.
 *
 * The note is returned rather than printed. It is a fact about what the review could see, so it
 * belongs in the report next to the findings, not in a log line the reader has already scrolled
 * past by the time the verdict arrives.
 *
 * Nothing here reads a file, runs a subprocess or validates a payload, and nothing here throws.
 * That is not tidiness: this function is the degradation path itself, so a constructor that
 * validated would turn a review that could still say something useful into a review that failed.
 * `existsSync` is the exception the rule allows, because asking whether a file is there is not
 * reading it, and the answer only ever decides which sentence the note is.
 */

export interface ForgeSelection {
  adapter: ForgeAdapter;
  /** Why this is not the forge that was configured, or null when it is. */
  note: string | null;
}

/**
 * A payload and the refs it was proved to name, which travel together because neither is usable
 * alone: an unverified payload is a claim, and the verified refs are what the diff is taken from.
 * Splitting them into two optional fields would let a caller hand over one without the other and
 * make the impossible state representable.
 */
export interface HostPullRequestInput {
  payload: HostPullRequest;
  verified: VerifiedPullRequest;
}

export interface ForgeOptions {
  base: string;
  /**
   * The pull request under review, or undefined for a review of the local working diff.
   *
   * Required rather than optional, though it may be undefined. Every caller has to state which it
   * is, because the answer changes which adapter comes back and a caller that forgot would get the
   * local forge without being told it had chosen anything.
   */
  pr: string | undefined;
  /**
   * The pull request an `mcp` host fetched, already validated and checked against this repository
   * by the command layer. Null when none was handed over, which is a degraded review and never an
   * error: the host has not fetched yet, and the review says so and reads the local diff.
   */
  pullRequest?: HostPullRequestInput | null;
  /** Where that payload is expected. Derived from the review's session directory, never configured. */
  payloadPath?: string;
}

export function createForge(
  config: EmpoConfig,
  repoRoot: string,
  options: ForgeOptions,
): ForgeSelection {
  const forge = config.adapters?.forge;

  // What the local adapter is standing in for, so its own printed lines can tell "nobody configured
  // a forge" from "the configured one went unread on this run", and both from "there is no pull
  // request here, so no CI run exists". Every path below except the first half of the first hands
  // this adapter back with a forge sitting in config.
  const standsInFor =
    forge === undefined
      ? null
      : {
          kind: forge.kind,
          host: forge.host ?? null,
          subjectIsPullRequest: options.pr !== undefined,
        };
  const local = (note: string | null): ForgeSelection => ({
    adapter: createLocalForge(repoRoot, { base: options.base, standsInFor }),
    note,
  });

  if (forge === undefined || forge.kind === "local") return local(null);

  // No pull request id means no pull request, whatever is configured. docs/06-cli.md: "With no
  // argument the subject is the local working diff against the base branch." This is checked
  // before the kind because it is true of every kind, and putting it here is what makes it one
  // rule instead of one guard per adapter: `empo review` in a repository configured for github
  // used to run `gh pr diff local` and die with exit 3 on a pull request nobody had named, and an
  // mcp forge would have gone looking for the payload of a pull request that cannot exist.
  if (options.pr === undefined) {
    return local(
      `no pull request was named, so the ${forge.host ?? forge.kind} forge was not consulted and ` +
        `the review reads the local diff against ${options.base}`,
    );
  }

  if (forge.kind === "github") {
    if (!commandExists("gh")) {
      return local(
        `gh is not on PATH, so the review reads the local diff against ${options.base} instead of the pull request`,
      );
    }
    return { adapter: createGithubForge(repoRoot, { repo: forgeSlug(forge) }), note: null };
  }

  if (forge.kind === "mcp") {
    const host = forge.host ?? "mcp";
    const pullRequest = options.pullRequest ?? null;
    if (pullRequest !== null) {
      return {
        adapter: createMcpForge(repoRoot, {
          payload: pullRequest.payload,
          verified: pullRequest.verified,
          host: forge.host ?? null,
        }),
        note: null,
      };
    }

    // No payload, so this is the local diff and the note has to say why. Which sentence depends on
    // whether the file is there at all, because "the host has not fetched it yet" and "it was
    // fetched and this command was not pointed at it" are different mistakes with different fixes,
    // and a reader told the wrong one goes looking in the wrong place.
    const fetched = options.payloadPath !== undefined && existsSync(options.payloadPath);
    return local(
      fetched
        ? `a ${host} pull request is waiting at ${options.payloadPath} but this run was not pointed ` +
            `at it, so the review reads the local diff against ${options.base} instead of the pull request`
        : `no ${host} pull request has been fetched, so the review reads the local diff against ` +
            `${options.base} instead of the pull request`,
    );
  }

  return unbuildableForge(forge.kind, local, options.base);
}

/**
 * The compiler's proof that every `ForgeKind` has a branch above: `kind` is `never` here, so
 * adding a kind to the union without adding a branch stops this file compiling.
 *
 * That is the point, and it is not hypothetical. The branch this replaced formatted the kind into
 * a "not implemented in this version" note, so when `mcp` joined the union it fell straight through
 * into it: a build that compiled happily and, at runtime, reviewed the local diff while telling the
 * reader that the kind they had configured did not exist.
 *
 * The parameter is the discriminant rather than the object, because `EmpoForge` is one object
 * type and not a union of them: `forge` itself never narrows however many kinds are excluded, while
 * `forge.kind` does. Handing over the object would compile with the check proving nothing.
 *
 * It still returns a working adapter rather than throwing, because nothing in this module may
 * throw. A kind that reached here past the compiler (hand-edited config against an older binary) is
 * still a review that should happen and say what it could not do.
 */
function unbuildableForge(
  kind: never,
  local: (note: string) => ForgeSelection,
  base: string,
): ForgeSelection {
  return local(
    `"${String(kind)}" is not a forge this version can build, so the review reads the local diff ` +
      `against ${base} instead of the pull request`,
  );
}
