import { trackOrder } from "../tracker";

// Jest's default directory, where a test is often not named `.test.js` at all, so nothing but the
// directory says it is one. The file is deliberately named `tracker.js` to prove that: under the
// old paths it was a module in the graph, reached by the flow that holds it and asserting nothing
// for that flow, which is the direction that invents coverage.
describe("trackOrder", () => {
  it("counts the orders it has seen", () => {
    expect(trackOrder("42")).toBe(1);
  });
});
