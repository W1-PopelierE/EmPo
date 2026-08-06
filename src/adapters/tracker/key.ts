import { configError } from "../../errors";
import type { KeyMatch, KeySource } from "./types";

/**
 * Ticket-key extraction (docs/09-adapters.md, "Tracker adapter"). This is the universal half of the
 * tracker contract, so it is implemented once here and every adapter delegates to it. What is *not*
 * universal is the key convention itself, which is why the pattern arrives as config.
 *
 * The default covers Jira `PLAT-1234` and Linear `ENG-42` without hard-coding either tracker
 * (docs/03-config-schema.md, `keyPattern`).
 */
export const DEFAULT_KEY_PATTERN = "[A-Z]{2,}-\\d+";

/**
 * Search the title, the branch and the body. The title wins the lookup because branch names carry
 * typos, but the branch is what the checkout actually used, so it is reported alongside rather than
 * discarded. When the two name different tickets the review states the disagreement (`disagrees`)
 * instead of resolving it silently: only the author knows which one is right.
 *
 * Returns null when no source carries a key, which the review reports as "no ticket" rather than
 * guessing at one.
 */
export function extractKeyFrom(source: KeySource, pattern?: string): KeyMatch | null {
  const regex = compile(pattern ?? DEFAULT_KEY_PATTERN);

  const titleKey = firstMatch(regex, source.title);
  const branchKey = firstMatch(regex, source.branch);
  const bodyKey = firstMatch(regex, source.body);

  const winner = titleKey ?? branchKey ?? bodyKey;
  if (winner === null) return null;

  const from = titleKey !== null ? "title" : branchKey !== null ? "branch" : "body";

  return {
    key: winner,
    from,
    branchKey,
    // The branch disagrees whenever it carries a key that lost. When the branch key is the winner
    // there is nothing to disagree with, so this reduces to the documented branch-versus-title
    // check while still catching a body key that contradicts the branch.
    disagrees: branchKey !== null && branchKey !== winner,
  };
}

/**
 * An uncompilable pattern is a config error (exit 2), not a silent fallback to the default: a
 * review that quietly used a different pattern than the one configured would grade the wrong
 * ticket. `empo doctor` reports the same problem before a review ever runs.
 */
function compile(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    throw configError(`tracker keyPattern "${pattern}" is not a valid regular expression`, [
      "Fix adapters.tracker.keyPattern in your EmPo config.",
    ]);
  }
}

/**
 * The first non-empty capture group, or the whole match when the pattern captures nothing.
 *
 * Jira and Linear need no groups: `PLAT-1234` is the key wherever it appears, so the whole match is
 * right and the default pattern is unaffected. Asana has no typeable key at all. A task is named by
 * a bare gid or by a permalink, so the branch carries `1234567890123456` and the title carries
 * `https://app.asana.com/1/.../task/1234567890123456`, and the two have to reduce to the same
 * string. Returning the whole match breaks that twice over: the key handed to `getTicket` is a URL
 * when every Asana tool takes a gid, and `disagrees` fires because the two strings differ, telling
 * an author their branch and title name different tickets when they name one. A confident false
 * claim is worse than no claim, which is why this is the group and not the match.
 *
 * First non-empty rather than group 1: a pattern covering several permalink shapes is an
 * alternation, so most of its groups are empty on any one match and which group wins moves with the
 * shape. A group that matched the empty string counts as no answer, same as a whole match that is
 * empty, so a pattern matching nothing still cannot become a key.
 */
function firstMatch(regex: RegExp, text: string): string | null {
  const match = regex.exec(text);
  if (match === null) return null;

  for (const group of match.slice(1)) {
    if (group !== undefined && group !== "") return group;
  }

  const [whole] = match;
  return whole === "" ? null : whole;
}
