import { commandExists } from "../../engine/git";
import type { EmpoConfig } from "../../schema/config.schema";
import type { HostTicket } from "../../schema/host-payload.schema";
import { forgeSlug } from "../forge/types";
import { createGithubIssuesTracker } from "./github-issues";
import { createMcpTracker } from "./mcp";
import { createNoneTracker } from "./none";
import type { TrackerAdapter } from "./types";

/**
 * Config to tracker adapter (docs/09-adapters.md). Every path here returns a working adapter:
 * "graceful degradation" means an absent or unreachable tracker produces a review without
 * ticket-fit grading that states why, never a crashed command. That is why nothing in this module
 * throws, and why nothing here reads a file or runs a subprocess either.
 *
 * The `note` is for the command layer to print once at the top of a run. It is separate from the
 * adapter's `skipReason`, which is what the review report itself carries.
 */
export interface TrackerSelection {
  adapter: TrackerAdapter;
  /** A line explaining a degraded choice, or null when the configured tracker is the one used. */
  note: string | null;
}

export interface TrackerOptions {
  /**
   * The ticket an `mcp` host fetched, already validated by `readHostTicket` in the command layer.
   * Null when none was handed over, which is a skipped step and never an error: an agent that
   * found no ticket key in the pull request correctly fetches nothing.
   */
  payload?: HostTicket | null;
}

export function createTracker(
  config: EmpoConfig,
  repoRoot: string,
  options: TrackerOptions = {},
): TrackerSelection {
  const tracker = config.adapters?.tracker;
  if (tracker === undefined || tracker.kind === "none") {
    return { adapter: createNoneTracker(), note: null };
  }

  if (tracker.kind === "mcp") {
    // Note stays null even with no ticket, unlike the forge above, because the configured adapter
    // is the one in use: nothing degraded, the host simply had nothing to hand over. The fact
    // itself is not lost, it travels as the adapter's `skipReason`, which is what the report's
    // ticket section prints. Carrying it in both would print one sentence twice in one brief.
    return {
      adapter: createMcpTracker({
        payload: options.payload ?? null,
        keyPattern: tracker.keyPattern,
        host: tracker.host ?? null,
      }),
      note: null,
    };
  }

  if (tracker.kind === "github-issues") {
    if (!commandExists("gh")) {
      return {
        adapter: createNoneTracker(
          'the tracker is "github-issues" but the gh CLI is not on PATH, so acceptance criteria were not checked',
        ),
        note: 'tracker "github-issues" needs the gh CLI, which is not installed; ticket-fit was skipped',
      };
    }

    return {
      adapter: createGithubIssuesTracker(repoRoot, {
        keyPattern: tracker.keyPattern,
        // `project` is where a github-issues tracker names `owner/name`. Falling back to the github
        // forge's repo covers the common case where issues live with the pull requests, and it beats
        // letting `gh` infer from the remote when the review runs against a fork.
        repo: tracker.project ?? githubForgeRepo(config),
      }),
      note: null,
    };
  }

  return unbuildableTracker(tracker.kind);
}

/**
 * The compiler's proof that every `TrackerKind` has a branch above: `kind` is `never` here, so
 * adding a kind to the union without adding a branch stops this file compiling.
 *

 * The parameter is the discriminant rather than the object, because `EmpoTracker` is one object
 * type and not a union of them: `tracker` itself never narrows however many kinds are excluded,
 * while `tracker.kind` does. Handing over the object would compile with the check proving nothing.
 *
 * The branch this replaced formatted the kind into a "not implemented in this version" note, which
 * compiled happily when `mcp` joined the union and would have told anyone who configured it that
 * their tracker did not exist, while grading no acceptance criteria at all. A note nobody can act
 * on is worse than a build failure the day the kind is added.
 *
 * It still returns a working adapter rather than throwing, for the reason this whole module does:
 * an absent tracker produces a review that states the gap, never a crashed command.
 */
function unbuildableTracker(kind: never): TrackerSelection {
  return {
    adapter: createNoneTracker(
      `"${String(kind)}" is not a tracker this version can build, so acceptance criteria were not checked`,
    ),
    note: `tracker "${String(kind)}" is not one this version can build; ticket-fit was skipped`,
  };
}

/**
 * The github forge's repository as `OWNER/REPO`, the only form `gh --repo` accepts.
 *
 * Through `forgeSlug` and not `forge.repo`, because config keeps the workspace and the repo apart
 * (detection splits an origin remote that way for the Bitbucket calls that want them separate) and
 * the bare repo name makes `gh issue view --repo EmPo` die on `expected the "[HOST/]OWNER/REPO"
 * format`. The forge side was fixed for exactly this; the tracker kept its own unjoined copy.
 *
 * Undefined stays undefined: `createGithubIssuesTracker` leaves the flag off entirely then, so gh
 * infers the repository from the checkout, which is the right answer and `--repo ""` is not.
 */
function githubForgeRepo(config: EmpoConfig): string | undefined {
  const forge = config.adapters?.forge;
  return forge?.kind === "github" ? forgeSlug(forge) : undefined;
}
