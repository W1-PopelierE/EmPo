/**
 * The tracker adapter contract (docs/09-adapters.md). A tracker is where acceptance criteria live.
 * The review's ticket-fit step (docs/07-review-discipline.md step 6) is identical across trackers;
 * only `getTicket` differs.
 *
 * `extractKey` is the one piece that is universal, so it is implemented once in `key.ts` and every
 * adapter uses it. The ticket key convention itself is config (`adapters.tracker.keyPattern`),
 * which is what keeps Jira `PLAT-1234` and Linear `ENG-42` out of the engine.
 */

/**
 * One `mcp` kind covers Jira, Asana and Linear alike, for the reason `ForgeKind` states: the agent
 * host holds the connector, so the ticket arrives as a payload empo validates rather than as an API
 * call empo makes. `adapters.tracker.host` names which one, and nothing here branches on it.
 */
export type TrackerKind = "mcp" | "github-issues" | "none";

/**
 * Each tracker's type vocabulary normalized to the only distinction the review acts on: a bug
 * wants a regression test that reproduces the original defect, a feature wants a test per new
 * entry point. `unknown` grades neither and says so.
 */
export type TicketType = "bug" | "feature" | "chore" | "unknown";

export interface TicketComment {
  author: string;
  body: string;
}

export interface Ticket {
  key: string;
  title: string;
  type: TicketType;
  body: string;
  /**
   * One entry per acceptance criterion, in the order the ticket states them. Step 6 maps each to
   * file:line evidence, so an empty list is honest ("the ticket states no criteria") and never a
   * reason to invent some.
   */
  criteria: string[];
  /**
   * Read too: the author may have deferred a sub-item, so do not flag what a comment scoped out.
   *
   * Nullable because the two empty answers are different claims. `null` is "nobody fetched them",
   * `[]` is "somebody looked and the ticket carries none". Collapsing them manufactures a false
   * positive out of an absence: step 6 is told not to report as missing what a comment retracted,
   * so an empty list reads as "nothing was retracted" and licenses exactly the finding a fetched
   * list would have withdrawn. Every adapter therefore has to say which of the two it means, and
   * the report prints them apart. Same rule as `--hazards` answering `rows: null` on a graph older
   * than the axis, and `spinesCurated` beside `spines`: a silence and a statement are different
   * facts, and only the statement is something a reader can act on.
   */
  comments: TicketComment[] | null;
  url: string;
  completed: boolean;
}

/** Where a key may be hiding. All three are searched; the title wins (docs/09-adapters.md). */
export interface KeySource {
  branch: string;
  title: string;
  body: string;
}

export interface KeyMatch {
  /** The key to look the ticket up with. From the title when the title has one. */
  key: string;
  from: "title" | "branch" | "body";
  /** The key the branch name carries, which is what the checkout used. Null when it carries none. */
  branchKey: string | null;
  /**
   * True when branch and title name different tickets. Branch names carry typos, so this is a
   * thing the review states rather than a thing it resolves silently.
   */
  disagrees: boolean;
}

export interface TrackerAdapter {
  readonly kind: TrackerKind;
  /**
   * Why the review could not grade ticket-fit, or null when it can. A configured `none` tracker is
   * not a broken review: it is a review that states it skipped ticket-fit and why.
   */
  readonly skipReason: string | null;
  extractKey(source: KeySource): KeyMatch | null;
  /** `null` when the key resolves to nothing, which the review reports rather than guessing at. */
  getTicket(key: string): Ticket | null;
}
