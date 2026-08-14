import { run } from "../../engine/git";
import { isObject, list, readObject, text } from "../gh-json";
import { parseCriteria } from "./criteria";
import { extractKeyFrom } from "./key";
import type { Ticket, TicketComment, TicketType, TrackerAdapter } from "./types";

/**
 * The `github-issues` tracker (docs/09-adapters.md), over the `gh` CLI. Subprocesses go through
 * `run` from engine/git.ts, never execa directly, so there is exactly one module to audit for what
 * this tool executes.
 */

/**
 * GitHub issue keys are `#123`, not `PLAT-123`, so this adapter overrides the cross-tracker default
 * from key.ts when config supplies no `keyPattern`.
 */
export const GITHUB_ISSUE_KEY_PATTERN = "#\\d+";

export interface GithubIssuesOptions {
  keyPattern?: string;
  /** `owner/name`. Omitted, `gh` infers it from the checkout's remote. */
  repo?: string;
}

export function createGithubIssuesTracker(
  repoRoot: string,
  options: GithubIssuesOptions,
): TrackerAdapter {
  return {
    kind: "github-issues",
    skipReason: null,

    extractKey: (source) => extractKeyFrom(source, options.keyPattern ?? GITHUB_ISSUE_KEY_PATTERN),

    getTicket: (key) => {
      const number = key.replace(/^#/, "").trim();
      if (number === "") return null;

      const args = [
        "issue",
        "view",
        number,
        "--json",
        "number,title,body,state,url,labels,comments",
      ];
      if (options.repo !== undefined && options.repo !== "") args.push("--repo", options.repo);

      const result = run(repoRoot, "gh", args);

      // A `gh` failure (no such issue, no auth, no network) returns null instead of throwing. The
      // review still has real impact and coverage findings to give, and a missing ticket must not
      // kill it: step 6 reports "ticket not found" and grades nothing.
      if (!result.ok) return null;
      return parseIssueJson(result.stdout);
    },
  };
}

/**
 * The pure half of `getTicket`, exported so the mapping is testable without a network or a `gh`.
 * Everything is read defensively through gh-json.ts: this JSON comes from outside the process, and
 * malformed input degrades to null for the same reason a failed call does.
 */
export function parseIssueJson(raw: string): Ticket | null {
  const issue = readObject(raw);
  if (issue === null) return null;

  // The issue number is the identity. Without it there is nothing to cite, so there is no ticket.
  const number = issue.number;
  if (typeof number !== "number") return null;

  const body = text(issue.body);

  return {
    key: `#${number}`,
    title: text(issue.title),
    type: ticketType(labelNames(issue.labels)),
    body,
    criteria: parseCriteria(body),
    comments: comments(issue.comments),
    url: text(issue.url),
    completed: text(issue.state).toUpperCase() === "CLOSED",
  };
}

/**
 * GitHub labels are free-form, so this normalizes them to the only distinction the review acts on
 * (types.ts): a bug wants a regression test, a feature wants a test per new entry point. `bug` is
 * checked first because a ticket labelled both `bug` and `enhancement` still wants the regression
 * test. Anything unrecognized is `unknown`, which grades neither and says so.
 */
function ticketType(labels: string[]): TicketType {
  const match = (term: string): boolean => labels.some((label) => label.includes(term));

  if (match("bug")) return "bug";
  if (match("feature") || match("enhancement")) return "feature";
  if (match("chore") || match("refactor") || match("docs")) return "chore";
  return "unknown";
}

function labelNames(value: unknown): string[] {
  return list(value)
    .map((label) => (isObject(label) ? text(label.name) : ""))
    .map((name) => name.toLowerCase())
    .filter((name) => name !== "");
}

/**
 * Step 6 reads these: a comment may have scoped a sub-item out, and that is not a finding.
 *
 * Null where the key is absent or is not a list, and `[]` only where `gh` answered with a list of
 * none. This is the one field read here where the defensive `list` coercion from gh-json.ts that the
 * rest of this file uses would have been a lie: `comments` is asked for by name in the `--json` call
 * above, so a response without it is `gh` not having answered rather than an issue nobody commented
 * on, and `[]` reads as "nothing was scoped out" (types.ts). A label list is different and stays
 * coerced, because absent labels and no labels both mean the same thing to `ticketType`.
 */
function comments(value: unknown): TicketComment[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => {
    const comment: Record<string, unknown> = isObject(entry) ? entry : {};
    return {
      // Empty rather than the forge's `"unknown"` for a missing login: the ticket section prints an
      // author it has, and names nobody where gh named nobody (gh-json.ts).
      author: isObject(comment.author) ? text(comment.author.login) : "",
      body: text(comment.body),
    };
  });
}
