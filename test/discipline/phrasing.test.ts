import { describe, expect, test } from "vitest";
import { FORBIDDEN_PHRASINGS, forbiddenPhrasings } from "../../src/discipline/phrasing";

/**
 * Two failure modes, and both are expensive. A hedge that slips through reaches the author as an
 * assertion nobody checked, which is what docs/07-review-discipline.md forbids. A false hit deletes
 * a true finding because a variable happened to be named `likelyTotal`, which teaches an agent that
 * the gate is noise. Every case below pins one side or the other.
 */

/** The matched text of every hit, which is what a dropped finding's detail quotes back. */
function matches(text: string): string[] {
  return forbiddenPhrasings(text).map((hit) => hit.matched);
}

describe("forbiddenPhrasings", () => {
  test("says nothing about a finding that asserts", () => {
    const claim =
      "total() subtracts the discount from the gross amount, so a taxed line is discounted twice.";

    expect(forbiddenPhrasings(claim)).toEqual([]);
  });

  test.each([
    ["likely", "This is likely wrong."],
    ["probably", "The observer probably runs first."],
    ["presumably", "Presumably the guard covers it."],
    ["possibly", "The total is possibly negative."],
    ["I assume", "I assume the callee saves."],
    ["I assumed", "I assumed the callee saves."],
    ["I believe", "I believe this is unreachable."],
    ["seems to", "The method seems to skip validation."],
    ["appears to", "The listener appears to fire twice."],
  ])("flags the hedge %s", (_phrase, claim) => {
    expect(forbiddenPhrasings(claim)).toHaveLength(1);
    expect(forbiddenPhrasings(claim)[0]?.why).toContain("cite the line");
  });

  test.each([
    ["may break", "This may break the kiosk flow."],
    ["might break", "This might break the kiosk flow."],
    ["could break", "This could break the kiosk flow."],
  ])("flags the speculation %s", (phrase, claim) => {
    expect(matches(claim)).toEqual([phrase]);
    expect(forbiddenPhrasings(claim)[0]?.why).toContain("grep the callers");
  });

  test("flags a branch nobody read, in either word order", () => {
    expect(matches("If the webhook ever fires, the ledger is written twice.")).toEqual([
      "If the webhook ever",
      "ever fires",
    ]);
    expect(matches("The fallback is dead unless it is ever reached.")).toEqual(["ever reached"]);
  });

  test("flags the untraced access claim", () => {
    const claim = "Anyone with access to the endpoint can read another tenant's orders.";

    expect(matches(claim)).toEqual(["Anyone with access"]);
    expect(forbiddenPhrasings(claim)[0]?.why).toContain("middleware");
  });

  // Scope creep is not a hedge: the claim can be perfectly certain and still be asking the author
  // for work the pull request never owed. It reaches the same gate, because it costs the author the
  // same time and the register of what a review may ask for is what keeps a review converging.
  test.each([
    ["consider extracting", "Consider extracting the tax maths into its own class."],
    ["would be cleaner", "It would be cleaner to fold the two branches together."],
    ["should also", "The controller should also reject a negative quantity."],
    ["nice to have", "A named constant here is nice to have."],
    ["as a follow-up", "Split the migration out as a follow-up."],
  ])("flags the wishlist phrasing %s", (phrase, claim) => {
    expect(matches(claim).join(" ").toLowerCase()).toContain(phrase);
    expect(forbiddenPhrasings(claim)[0]?.why).toContain("names a break");
  });

  test("leaves a certain claim about what code does alone, near-miss wording and all", () => {
    // Each of these reads like a wishlist phrase and is not one: the first asserts what the callee
    // does, the second is the author's own deferral being honoured, the third is a fact.
    expect(forbiddenPhrasings("dispatch() does not consider a failed job.")).toEqual([]);
    // What a document recommends or a comment claims is for consistency is quoted by half of these
    // findings, and the contradiction with the code is the finding itself.
    expect(
      forbiddenPhrasings("The retry policy suggests three attempts; the handler stops after one."),
    ).toEqual([]);
    expect(
      forbiddenPhrasings("The docs recommend an idempotency key, which the client never sends."),
    ).toEqual([]);
    expect(
      forbiddenPhrasings("The comment says the branch exists for consistency, and it diverges."),
    ).toEqual([]);
    expect(forbiddenPhrasings("The ticket defers the CSV header to a follow-up ticket.")).toEqual(
      [],
    );
    expect(forbiddenPhrasings("The retry is a robustness measure that never runs.")).toEqual([]);
  });

  test("does not trip on a longer word that contains a forbidden one", () => {
    expect(forbiddenPhrasings("An unlikely path, and an impossibly rare one.")).toEqual([]);
  });

  test("does not trip on an identifier or a path that contains a forbidden one", () => {
    const claim = "src/likely.ts calls $order.probably and LIKELY_TOTAL feeds likelyTotal().";

    expect(forbiddenPhrasings(claim)).toEqual([]);
  });

  test("still flags a hedge that ends a sentence or wraps across lines", () => {
    expect(matches("The discount is applied twice, probably.")).toEqual(["probably"]);
    expect(matches("The observer seems\n   to fire twice.")).toEqual(["seems to"]);
  });

  test("orders hits by their position in the text, not by the order of the rule list", () => {
    const claim = "It appears to double-charge, and the refund job probably could break too.";

    expect(matches(claim)).toEqual(["appears to", "probably", "could break"]);
  });

  test("every rule carries a remedy, so a dropped finding says what to go read", () => {
    for (const phrasing of FORBIDDEN_PHRASINGS) {
      expect(phrasing.why.length).toBeGreaterThan(0);
      expect(() => new RegExp(phrasing.pattern)).not.toThrow();
    }
  });
});
