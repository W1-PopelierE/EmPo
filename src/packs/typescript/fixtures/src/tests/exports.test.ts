import { createOrder, fetchOrder } from "../src/api/orders";

// The liveness spelling of a term the pack does take, and the reason this pack declares
// assertionExcludes at all: this file checks that two functions exist and never once looks at
// anything either one computed. It must come out asserting nothing, exactly as the php corpus's
// method_exists test does. Every assertion here has to stay on the far side of the term list, so
// do not add a real check to this file: add it to one of the three beside it.
describe("the orders client", () => {
  it("exposes the two calls the screens reach for", () => {
    expect(typeof createOrder).toBe("function");
    expect(typeof fetchOrder).toBe("function");
  });
});
