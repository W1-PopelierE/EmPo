import { run } from "../../engine/git";
import { compareStrings } from "../../engine/order";
import { type EmpoError, environmentError } from "../../errors";
import { isObject, list, readObject, text } from "../gh-json";
import type {
  CiResult,
  ForgeAdapter,
  ForgeCapability,
  ForgeComment,
  InlineAnchor,
  PullRequest,
} from "./types";

/**
 * The reference forge (docs/09-adapters.md), spoken through the `gh` CLI so EmPo never holds a
 * token and never talks to an API it would have to version.
 *
 * The split in this module is deliberate: the adapter is the part that shells out, and every line
 * that interprets what gh said is a pure exported function. That is what makes the mapping testable
 * without a network, and the mapping is where the mistakes live.
 *
 * What a failure costs decides whether it throws. A fact the review stands on (the pull request,
 * the diff, and any post the human asked for) fails loudly; comments and CI degrade to "unknown",
 * because the contract has a way to say "not checked" and the review is required to use it rather
 * than to invent a green pipeline.
 */

const CAPABILITIES: ReadonlySet<ForgeCapability> = new Set<ForgeCapability>([
  "pr",
  "diff",
  "comments",
  "ci",
  "post",
]);

/** One call for all PR metadata, as the contract requires. */
const PR_FIELDS = "number,title,author,headRefName,baseRefName,body,url";

const FAILING = new Set(["FAILURE", "ERROR"]);
const PENDING = new Set(["PENDING", "IN_PROGRESS", "QUEUED"]);
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export function createGithubForge(repoRoot: string, options: { repo?: string }): ForgeAdapter {
  // `--repo` last so it applies to every subcommand shape below without reordering their arguments.
  const gh = (args: string[]): ReturnType<typeof run> =>
    run(repoRoot, "gh", options.repo === undefined ? args : [...args, "--repo", options.repo]);

  const ghOrFail = (args: string[], attempt: string): string => {
    const result = gh(args);
    if (!result.ok) {
      throw environmentError(`gh could not ${attempt}`, [
        firstLine(result.stderr),
        "Check that gh is installed and authenticated: gh auth status",
      ]);
    }
    return result.stdout;
  };

  return {
    kind: "github",
    capabilities: CAPABILITIES,

    getPr: (id) =>
      parsePrJson(ghOrFail(["pr", "view", id, "--json", PR_FIELDS], `read pull request ${id}`), id),

    getDiff: (id) => ghOrFail(["pr", "diff", id], `read the diff of pull request ${id}`),

    listComments: (id) => {
      // Not a fact the review stands on: an existing-comment list only stops the review repeating
      // what someone already said, so losing it costs a nicety and never the review.
      const result = gh(["pr", "view", id, "--json", "comments,reviews"]);
      return result.ok ? parseComments(result.stdout) : [];
    },

    getCiResult: (id) => {
      const result = gh(["pr", "view", id, "--json", "statusCheckRollup"]);
      if (!result.ok) {
        return {
          state: "unknown",
          detail: `gh could not read the checks: ${firstLine(result.stderr)}`,
        };
      }
      return rollupState(result.stdout);
    },

    comment: (id, body, inline) => {
      ghOrFail(
        ["pr", "comment", id, "--body", anchored(body, inline)],
        `comment on pull request ${id}`,
      );
    },

    approve: (id) => {
      ghOrFail(["pr", "review", id, "--approve"], `approve pull request ${id}`);
    },

    requestChanges: (id, body) => {
      ghOrFail(
        ["pr", "review", id, "--request-changes", "--body", body],
        `request changes on pull request ${id}`,
      );
    },
  };
}

/**
 * `gh pr view --json`, mapped to the contract. The two branch names are required rather than
 * defaulted: the base decides what "the diff" even means for a stacked PR (doc 07 step 1), and a
 * review against a guessed default branch is worse than a review that did not run.
 */
export function parsePrJson(raw: string, id: string): PullRequest {
  const json = readObject(raw);
  if (json === null) throw notJson(`read pull request ${id}`);

  const sourceBranch = text(json.headRefName);
  const baseBranch = text(json.baseRefName);
  if (sourceBranch === "" || baseBranch === "") {
    throw environmentError(`gh returned pull request ${id} without a source or base branch`, [
      "EmPo needs both to know which branch to read and what to compare it against.",
      "Check that gh is authenticated for this repository: gh auth status",
    ]);
  }

  return {
    id: typeof json.number === "number" ? String(json.number) : id,
    title: text(json.title),
    author: login(json.author),
    sourceBranch,
    baseBranch,
    description: text(json.body),
    url: text(json.url),
  };
}

/**
 * Issue comments and review bodies, in the order gh returned them: they are a conversation, and
 * sorting them alphabetically would scramble it.
 *
 * `file` and `line` are null for every one of them. `gh pr view` carries no line anchor for either
 * shape, and a comment that claimed a line it was not read from would be a fabricated citation.
 */
export function parseComments(raw: string): ForgeComment[] {
  const json = readObject(raw);
  // Unlike the pull request itself, an unreadable comment list degrades to none rather than
  // failing the review, which is the same call the adapter makes when the gh call fails outright.
  if (json === null) return [];

  return (
    [...list(json.comments), ...list(json.reviews)]
      .filter(isObject)
      .map((entry) => ({
        author: login(entry.author),
        body: text(entry.body),
        file: null,
        line: null,
      }))
      // An approval with no note is a review row with an empty body. There is nothing there for the
      // review to avoid duplicating, so it is not a comment.
      .filter((comment) => comment.body.trim() !== "")
  );
}

/**
 * `gh pr view --json statusCheckRollup` reduced to one state. Failure wins over pending and pending
 * over success, because the review reads this instead of running the suite (doc 07 invariant 1) and
 * the worst news in the pipeline is the news that matters.
 *
 * Anything gh reports that does not fall in one of the three buckets (a cancelled or timed-out
 * check) is reported as unknown and named. A pipeline that is not green is never rounded up to
 * passed.
 */
export function rollupState(raw: string): CiResult {
  const json = readObject(raw);
  if (json === null) {
    return {
      state: "unknown",
      detail: "gh returned something that is not JSON, so CI was not read",
    };
  }

  const all = list(json.statusCheckRollup).filter(isObject).map(toCheck);
  if (all.length === 0) return { state: "unknown", detail: "no checks reported" };

  const failed = all.filter((check) => FAILING.has(check.state));
  if (failed.length > 0) {
    const names = failed.map((check) => check.name).sort(compareStrings);
    return {
      state: "failed",
      detail: `${countOf(failed.length)} of ${all.length} failed: ${names.join(", ")}`,
    };
  }

  const running = all.filter((check) => PENDING.has(check.state));
  if (running.length > 0) {
    return {
      state: "pending",
      detail: `${countOf(running.length)} of ${all.length} still running`,
    };
  }

  const unclassified = all.filter((check) => !PASSING.has(check.state));
  if (unclassified.length > 0) {
    const named = unclassified
      .map((check) => `${check.name} (${check.state})`)
      .sort(compareStrings);
    return {
      state: "unknown",
      detail: `gh reported states EmPo does not read: ${named.join(", ")}`,
    };
  }

  return { state: "passed", detail: `${countOf(all.length)} reported success, neutral or skipped` };
}

interface Check {
  name: string;
  state: string;
}

function toCheck(entry: Record<string, unknown>): Check {
  // Two shapes share the rollup: a CheckRun has `name` plus `status`/`conclusion`, a StatusContext
  // has `context` plus `state`. A CheckRun that has not finished has no conclusion yet, so `status`
  // is the field that says it is still running.
  const name = text(entry.name) || text(entry.context);
  const status = text(entry.status).toUpperCase();
  const state =
    status !== "" && status !== "COMPLETED" ? status : text(entry.conclusion).toUpperCase();

  return {
    name: name === "" ? "an unnamed check" : name,
    state: state !== "" ? state : text(entry.state).toUpperCase(),
  };
}

/**
 * `gh pr comment` posts at the top level and has no flag for a line anchor: the REST review API has
 * one, gh does not expose it. The anchor is not dropped on the floor, it goes at the head of the
 * body as the repo-relative `file:line` every EmPo citation uses, so the author can still find the
 * line being talked about.
 */
function anchored(body: string, inline: InlineAnchor | undefined): string {
  return inline === undefined ? body : `${inline.file}:${inline.line}\n\n${body}`;
}

function notJson(attempt: string): EmpoError {
  return environmentError(`gh could not ${attempt}`, [
    "gh answered with something that is not JSON.",
    "Check that gh is installed, authenticated and up to date: gh auth status",
  ]);
}

/**
 * gh nests every author as `{login}`, and a comment from a deleted account has no login at all.
 *
 * Stays here rather than joining the coercions in gh-json.ts: `"unknown"` is a forge decision, not a
 * shared one. The github-issues tracker reads a missing login as `""`, and folding the two together
 * would change what one of the two reports prints.
 */
function login(value: unknown): string {
  if (!isObject(value)) return "unknown";
  const name = text(value.login);
  return name === "" ? "unknown" : name;
}

function countOf(count: number): string {
  return `${count} check${count === 1 ? "" : "s"}`;
}

function firstLine(stderr: string): string {
  const line = stderr.split("\n").find((candidate) => candidate.trim() !== "");
  return line === undefined ? "gh reported no reason" : line.trim();
}
