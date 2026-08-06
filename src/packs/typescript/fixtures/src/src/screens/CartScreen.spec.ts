import { CartScreen } from "./CartScreen";

// A `.spec.ts` beside its source, which is what Angular, Nest and every Jasmine-descended runner
// name a test, and what mocha suites usually hold. Adding a dialect to assertionTerms and not its
// naming convention to tests.paths leaves the terms unreachable in the repositories that use it,
// and the file scores as production code that consumes the module it is testing.
//
// It also carries chai's `should` interface and a negated assertion, which are the two spellings a
// chain matched on its head would miss.
describe("CartScreen", () => {
  it("hands back the panel it renders", async () => {
    const panel = await CartScreen();

    panel.should.not.equal(null);
  });
});
