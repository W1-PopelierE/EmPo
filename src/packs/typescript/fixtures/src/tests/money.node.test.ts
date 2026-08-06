import { strictEqual } from "node:assert/strict";
import { formatMoney } from "../src/shared/money";

// The dialect this language ships with and no framework provides. A pack owns every test dialect
// of its language or it owns none of them (docs/04-language-packs.md section 6), so this file and
// the jest-shaped ones beside it have to score the same.
test("formats cents as a decimal beside the currency", () => {
  strictEqual(formatMoney({ cents: 1250, currency: "EUR" }), "12.50 EUR");
});
