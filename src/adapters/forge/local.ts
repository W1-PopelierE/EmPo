import { diffAgainstBase, resolveRef } from "../../engine/git";
import { configError, type EmpoError } from "../../errors";
import type { CiResult, ForgeAdapter, ForgeCapability, ForgeKind } from "./types";

/**
 * The zero-config forge (docs/09-adapters.md, "Graceful degradation"). There is no host and no
 * network: it diffs the working tree against `--base` and states plainly what it cannot answer.
 *
 * This is the adapter that must always work, so it depends on git and nothing else. It is also the
 * fallback every other adapter degrades to, which is why constructing it runs no subprocess: the
 * base ref is checked when the diff is asked for, not when the adapter is built.
 */

const CAPABILITIES: ReadonlySet<ForgeCapability> = new Set<ForgeCapability>(["diff"]);

/**
 * The forge config this adapter is standing in for, or null when none was configured.
 *
 * It exists for one line of printed output, and that line used to be false far more often than it
 * was true. `create.ts` reaches this adapter from five places: one of them covers both "nobody
 * configured a forge" and a forge configured `local`, three have a github or mcp forge in config
 * that this run could not consult, and the last is a kind no version can build. Only the first half
 * of the first is "no forge is configured", and every one of them printed that sentence, which sends
 * a reader to write a config file they already have.
 *
 * The degradation note in the brief says *why* the host went unread, and this deliberately does not
 * repeat it: one fact with two wordings is two wordings that drift apart. What this must carry
 * instead is the fact the note does not, which is whether a CI run could exist at all.
 */
export interface StoodInFor {
  kind: ForgeKind;
  host: string | null;
  /**
   * Whether the review's subject is a pull request.
   *
   * False for the default review of the working diff, and it changes the sentence rather than
   * decorating it: with no pull request there is no pipeline, so saying CI "was not read" states
   * that something existed and went unlooked-at, and an agent reading that goes to find it. The
   * honest answer is that there is nothing to find.
   */
  subjectIsPullRequest: boolean;
}

export interface LocalForgeOptions {
  base: string;
  /**
   * Null when no forge is configured, which is the only case that may say so.
   *
   * Required rather than optional, on the rule that a field whose absence is indistinguishable
   * from a legitimate value is required and never defaulted: null is a real
   * answer here, so a caller that forgot the field would silently get back the exact sentence this
   * exists to stop printing, and no type would say a word.
   */
  standsInFor: StoodInFor | null;
}

export function createLocalForge(repoRoot: string, options: LocalForgeOptions): ForgeAdapter {
  return {
    kind: "local",
    capabilities: CAPABILITIES,

    // Null, not a synthesized pull request. Inventing a title, an author and a base branch would
    // put facts in the review that nobody wrote, and the base branch is load-bearing (doc 07 step 1).
    getPr: () => null,

    getDiff: () => workingDiff(repoRoot, options.base),

    listComments: () => [],

    getCiResult: (): CiResult => ({
      state: "unknown",
      detail: ciDetail(options.standsInFor ?? null),
    }),

    comment: () => {
      throw nowhereToPost("post a comment");
    },
    approve: () => {
      throw nowhereToPost("approve");
    },
    requestChanges: () => {
      throw nowhereToPost("request changes");
    },
  };
}

/**
 * The four sentences this adapter may say about CI, kept apart for the reason `empo doctor` keeps
 * `kind: null` apart from `kind: "local"`: a silence and a statement are different facts.
 *
 * The last two are the pair worth not collapsing. "There is no CI run to read" and "there is one and
 * this run did not read it" send a reader to different places, and the review that prints them most
 * often is the one with no pull request at all, where the second would be a claim about a pipeline
 * that does not exist.
 *
 * The `local` sentence says "contacts no host" rather than "has no host", because `forgeSchema` puts
 * `host` on every kind: `{ "kind": "local", "host": "bitbucket" }` parses, and telling its author
 * they have no host would be this same defect one config away.
 */
function ciDetail(standsInFor: StoodInFor | null): string {
  if (standsInFor === null) return "no forge is configured, so CI was not consulted";
  if (standsInFor.kind === "local") {
    return "the local forge contacts no host, so CI was not consulted";
  }
  if (!standsInFor.subjectIsPullRequest) {
    return "no pull request was named, so there is no CI run to read";
  }
  return `the ${standsInFor.host ?? standsInFor.kind} forge was not consulted on this run, so CI was not read`;
}

/**
 * Two dots, no second ref, so uncommitted work is in the diff. A base that does not resolve fails
 * loudly rather than silently diffing against nothing: an empty diff reads as "no changes" and
 * would produce a review that approves work it never saw.
 */
function workingDiff(repoRoot: string, base: string): string {
  if (resolveRef(repoRoot, base) === null) {
    throw configError(`Base ref "${base}" does not resolve to a commit`, [
      `Either ${base} does not exist here, or ${repoRoot} is not a git checkout.`,
      "Name an existing ref with --base, for example --base main or --base origin/main.",
    ]);
  }

  const diff = diffAgainstBase(repoRoot, base);
  if (diff === null) {
    throw configError(`Cannot diff against "${base}"`, [
      `git diff ${base} failed in ${repoRoot}.`,
      "Run empo review inside a git checkout, or configure adapters.forge in .empo/config.json.",
    ]);
  }

  return diff;
}

function nowhereToPost(action: string): EmpoError {
  return configError(`The local forge cannot ${action}`, [
    "It reads the working diff and has no pull request to write to.",
    "Configure adapters.forge in .empo/config.json, or drop --post.",
  ]);
}
