import type { TrackerAdapter } from "./types";

/**
 * The no-tracker tracker (docs/09-adapters.md, "Graceful degradation"). Every adapter is optional
 * and its absence has to degrade cleanly, so this is a null object rather than a stub: the review
 * still runs its impact and coverage steps in full, it just skips ticket-fit grading and *says so*
 * with `skipReason`. A repo with no tracker gets a review that names the gap, not a broken one.
 *
 * The same object serves a tracker that is configured but unreachable (a missing CLI, a kind this
 * version does not implement), which is why the reason is a parameter.
 *
 * It is the one adapter with nothing to say about `Ticket.comments` being null or empty, and that
 * is not an omission: `getTicket` answers null, so no ticket is ever built here and there is no
 * comment list to have fetched or not fetched. The absence is carried a level up, by `skipReason`,
 * which says ticket-fit was not graded at all rather than that one field went unread.
 */
export function createNoneTracker(reason?: string): TrackerAdapter {
  return {
    kind: "none",
    skipReason: reason ?? "no tracker is configured, so acceptance criteria were not checked",
    extractKey: () => null,
    getTicket: () => null,
  };
}
