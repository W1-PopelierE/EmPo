import { fetchOrder } from "../src/api/orders";

// The corpus's negative control for assertsValue: this runs the code and then checks only that
// something came back, which is the "asserts HTTP 200" shape the term list exists to exclude. Keep
// every assertion in this file on the far side of that list, and do not make a widening pass by
// editing it, which is the repair the php corpus refused once already and recorded in its own
// fixture. The php side has carried this warning since the day a term list widened under it; this
// file went without one until the list widened here too.
describe("fetchOrder", () => {
  it("returns a response", async () => {
    const order = await fetchOrder("42");

    expect(order).toBeDefined();
  });
});
