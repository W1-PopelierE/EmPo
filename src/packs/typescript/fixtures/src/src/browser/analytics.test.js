import { reportTotal } from "./analytics";

describe("reportTotal", () => {
  it("formats the total the tracked order carries", () => {
    expect(reportTotal({ id: "42", total: { cents: 1250, currency: "EUR" } })).toBe("12.50 EUR");
  });
});
