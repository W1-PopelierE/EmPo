import { expect } from "chai";
import { formatMoney } from "../src/shared/money";

// The third dialect, and the one whose assertion is a chain of properties rather than a call, so
// the term list has to carry a spelling with no parenthesis in it at all.
describe("formatMoney", () => {
  it("keeps two decimals on a round amount", () => {
    expect(formatMoney({ cents: 900, currency: "EUR" })).to.equal("9.00 EUR");
  });
});
