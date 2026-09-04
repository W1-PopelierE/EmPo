import { compareStrings } from "../engine/order";

/**
 * The forbidden phrasings of docs/07-review-discipline.md, as a mechanical lint.
 *
 * Scope, and it is the whole point of the module: these apply to **a finding's own text** and to
 * nothing else. A verification prompt is supposed to read "check whether this may break the kiosk
 * flow" and a suggestion is allowed to be tentative; a finding is not, because a finding is what
 * reaches the author as an assertion. Linting a prompt with this list would forbid asking the
 * question, which is the opposite of the discipline. Callers pass a finding's title and claim, and
 * only those (see src/discipline/findings.ts).
 *
 * One red flag in docs/07 is deliberately absent: the callee-behaviour family ("X never saves",
 * "does not persist", "returns null"). That wording is exactly what a *verified* finding says after
 * reading the callee's body, and no regex can tell whether the body was read. Banning it would
 * delete true findings and teach agents to write vaguer ones to slip past the lint. What enforces
 * that rule is the citation gate: the claim only ships if it quotes a real line of the callee.
 */

export interface ForbiddenPhrasing {
  /**
   * The phrase as a regular expression source. Matched case-insensitively against the finding's
   * text with its whitespace collapsed, so a phrase that wrapped across lines still reads as one
   * phrase, and boundary-guarded by `forbiddenPhrasings` so a word inside a longer word, an
   * identifier, or a path never trips it.
   */
  pattern: string;
  /** The remedy docs/07 prescribes, so a dropped finding tells its author what to go read. */
  why: string;
}

export interface PhrasingHit {
  /** The pattern that matched, so a hit can be traced back to its rule. */
  phrase: string;
  /** The text it matched, as it reads in the finding. */
  matched: string;
  why: string;
}

const HEDGE =
  "a hedge is a guess wearing a finding's clothes: read the code the claim rests on, cite the line where it holds or fails, or drop the finding";

const SPECULATION =
  "grep the callers and read them, then cite the caller line that breaks; a finding names a break that is present, not one that could be";

const UNREAD_BRANCH =
  "read X: if the call happens, cite the line it happens on; if it cannot happen, there is no finding";

const WISHLIST =
  "a finding names a break, not work the branch could also have done: state the defect flatly and put the improvement in `suggestion`, or drop it";

const UNTRACED_ACCESS =
  "trace the actual middleware, policy and guard chain and cite the line that grants the access, or drop the finding";

export const FORBIDDEN_PHRASINGS: ForbiddenPhrasing[] = [
  { pattern: "likely", why: HEDGE },
  { pattern: "probably", why: HEDGE },
  { pattern: "presumably", why: HEDGE },
  { pattern: "possibly", why: HEDGE },
  { pattern: "I assume(?:s|d)?", why: HEDGE },
  { pattern: "I believe", why: HEDGE },
  { pattern: "seem(?:s|ed)? to", why: HEDGE },
  { pattern: "appear(?:s|ed)? to", why: HEDGE },
  { pattern: "(?:may|might|could) break", why: SPECULATION },
  { pattern: "if\\b[^.!?]*?\\bever", why: UNREAD_BRANCH },
  {
    pattern: "ever (?:call|calls|called|fire|fires|fired|reach|reaches|reached|run|runs)",
    why: UNREAD_BRANCH,
  },
  { pattern: "anyone with access", why: UNTRACED_ACCESS },
  // Each of these is the reviewer's own voice asking for work. Two obvious candidates are absent:
  // "recommends" and "for consistency" are what a document, a README or a code comment does, and a
  // finding quoting one ("the docs recommend an idempotency key, the client never sends one") is
  // reporting a real contradiction. No lint can tell a quotation from a wish, so those two stay
  // legal and the narrower phrasings below carry the rule.
  //
  // "consider" only where the reviewer is the one considering. A finding that says a callee "does
  // not consider retrying" or "fails to consider queueing" is asserting something it read, and the
  // negation is what separates the two: the lookbehind is the whole difference between reporting a
  // gap in the code and asking the author to fill one.
  { pattern: "(?<!(?:not|to) )consider \\w+ing", why: WISHLIST },
  {
    pattern: "(?:it |that )?would be (?:better|good|nice|cleaner|safer|clearer|worth)",
    why: WISHLIST,
  },
  { pattern: "(?:should|could) (?:also|ideally|probably)", why: WISHLIST },
  { pattern: "nice to have", why: WISHLIST },
  { pattern: "as a follow(?:-| )up", why: WISHLIST },
];

/**
 * Guards around every pattern. `\w` on both sides is what keeps "unlikely" from tripping "likely";
 * the path and member characters on the left keep `src/likely.ts` and `$order.probably` from
 * tripping either. A `.` is excluded on the left but allowed on the right on purpose: a finding
 * ends its sentences, and "the total is probably wrong." must still be caught.
 */
const LEFT_GUARD = "(?<![\\w/\\\\.-])";
const RIGHT_GUARD = "(?![\\w/\\\\-])";

export function forbiddenPhrasings(text: string): PhrasingHit[] {
  // Same whitespace rule as a citation anchor (src/engine/citations.ts): a claim that wrapped
  // across two lines in the findings file is still the same claim.
  const subject = text.replace(/\s+/g, " ").trim();

  const found: { index: number; hit: PhrasingHit }[] = [];
  for (const phrasing of FORBIDDEN_PHRASINGS) {
    // Compiled per call: a shared global regex carries `lastIndex` between calls and would then
    // skip hits depending on what was linted before it, which is not an option here.
    const pattern = new RegExp(`${LEFT_GUARD}(?:${phrasing.pattern})${RIGHT_GUARD}`, "gi");
    for (const match of subject.matchAll(pattern)) {
      found.push({
        index: match.index,
        hit: { phrase: phrasing.pattern, matched: match[0], why: phrasing.why },
      });
    }
  }

  // Position first, then the pattern, so two rules that hit the same offset still order the same
  // way on every run regardless of how the list above is edited.
  found.sort((a, b) => a.index - b.index || compareStrings(a.hit.phrase, b.hit.phrase));
  return found.map((entry) => entry.hit);
}
