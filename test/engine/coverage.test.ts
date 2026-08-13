import { describe, expect, test } from "vitest";
import { computeCoverage, reachableFrom } from "../../src/engine/coverage";
import { assignFlows } from "../../src/engine/flows";
import type { FlowDefinitions, GraphEdge, GraphNode } from "../../src/schema/types";

/**
 * Coverage answers "would a test notice", so the only node fields that decide anything are `isTest`
 * and `assertsValue`, and the only thing an edge contributes is the pair it connects. The flows
 * argument arrives already assigned, flow key to node ids, exactly as assignFlows leaves it, so the
 * cases in `computeCoverage` hand it over by hand and none of them touches a path prefix. The
 * `assignFlows into computeCoverage` block at the end is the exception, and the reason it exists: an
 * answer this file cannot state on its own is decided by which nodes assignFlows hands over, so that
 * block spells the file paths out and runs the real assignment into the real coverage.
 */

function node(
  id: string,
  options: { isTest?: boolean; assertsValue?: boolean; root?: string; file?: string } = {},
): GraphNode {
  const root = options.root ?? "apps/api";
  return {
    id,
    file: options.file ?? `${root}/app/${id}.php`,
    root,
    lang: "php",
    kind: options.isTest ? "test" : "class",
    name: id,
    produces: [],
    consumes: [],
    isTest: options.isTest ?? false,
    assertsValue: options.assertsValue ?? false,
  };
}

/** A plain intra-language edge. Every one of these carries a test's reach. */
function edge(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    kind: "import",
    symbol: null,
    evidence: { file: `apps/api/app/${from}.php`, line: 1 },
  };
}

/** A level-2 edge: this file calls that route. Whether it carries reach depends on the roots. */
function bridge(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    kind: "bridge",
    symbol: "http-route",
    evidence: { file: `apps/mobile/src/${from}.ts`, line: 1 },
  };
}

describe("computeCoverage", () => {
  test("reports a flow no test reaches as unreached, and not blind", () => {
    // Not blind: blind means exercised with nothing checking the value, and this is not exercised.
    const nodes = [
      node("Calculator"),
      node("Mailer"),
      node("MailerTest", { isTest: true, assertsValue: true }),
    ];
    const edges = [edge("MailerTest", "Mailer")];

    expect(computeCoverage(nodes, edges, { pricing: ["Calculator"] })).toEqual({
      pricing: {
        flow: "pricing",
        testNodes: [],
        testFiles: [],
        reaches: false,
        assertsValue: false,
        blind: false,
      },
    });
  });

  test("reports a flow reached by a test that asserts on a value as covered", () => {
    const nodes = [node("Calculator"), node("PriceTest", { isTest: true, assertsValue: true })];
    const edges = [edge("PriceTest", "Calculator")];

    expect(computeCoverage(nodes, edges, { pricing: ["Calculator"] })).toEqual({
      pricing: {
        flow: "pricing",
        testNodes: ["PriceTest"],
        testFiles: ["apps/api/app/PriceTest.php"],
        reaches: true,
        assertsValue: true,
        blind: false,
      },
    });
  });

  test("reports a flow reached only by a test that asserts nothing as blind", () => {
    // The whole reason the field exists: the flow is exercised, so it looks safe, and nothing
    // checks the number it produces.
    const nodes = [node("Calculator"), node("SmokeTest", { isTest: true })];
    const edges = [edge("SmokeTest", "Calculator")];

    expect(computeCoverage(nodes, edges, { pricing: ["Calculator"] })).toEqual({
      pricing: {
        flow: "pricing",
        testNodes: ["SmokeTest"],
        testFiles: ["apps/api/app/SmokeTest.php"],
        reaches: true,
        assertsValue: false,
        blind: true,
      },
    });
  });

  test("is not blind when one of several reaching tests asserts, and lists every reaching test", () => {
    const nodes = [
      node("Calculator"),
      node("SmokeTest", { isTest: true }),
      node("PriceTest", { isTest: true, assertsValue: true }),
    ];
    const edges = [edge("SmokeTest", "Calculator"), edge("PriceTest", "Calculator")];

    expect(computeCoverage(nodes, edges, { pricing: ["Calculator"] })).toEqual({
      pricing: {
        flow: "pricing",
        testNodes: ["PriceTest", "SmokeTest"],
        testFiles: ["apps/api/app/PriceTest.php", "apps/api/app/SmokeTest.php"],
        reaches: true,
        assertsValue: true,
        blind: false,
      },
    });
  });

  test("counts a flow as reached through a chain of edges, not only a direct one", () => {
    // The realistic shape: a feature test hits a controller, and the controller calls the money code.
    const nodes = [
      node("Calculator"),
      node("OrderController"),
      node("OrderTest", { isTest: true, assertsValue: true }),
    ];
    const edges = [edge("OrderTest", "OrderController"), edge("OrderController", "Calculator")];

    const coverage = computeCoverage(nodes, edges, { pricing: ["Calculator"] });

    expect(coverage.pricing?.reaches).toBe(true);
    expect(coverage.pricing?.testNodes).toEqual(["OrderTest"]);
    expect(coverage.pricing?.blind).toBe(false);
  });

  test("does not carry a test's reach across a bridge into another root", () => {
    // Found by the acme fixture the day the second root landed: a mobile test asserting on a
    // rendered string reached the api route file through a bridge edge, and through it every
    // controller that route file names, so a backend flow with no value assertion anywhere stopped
    // being reported blind. A test EmPo invents is worse than a coupling EmPo cannot see.
    const nodes = [
      node("CheckoutController"),
      node("routes/api.php"),
      node("client", { root: "apps/mobile" }),
      node("ScreenTest", { isTest: true, assertsValue: true, root: "apps/mobile" }),
    ];
    const edges = [
      edge("ScreenTest", "client"),
      bridge("client", "routes/api.php"),
      edge("routes/api.php", "CheckoutController"),
    ];

    const coverage = computeCoverage(nodes, edges, { checkout: ["CheckoutController"] });

    expect(coverage.checkout?.reaches).toBe(false);
    expect(coverage.checkout?.testNodes).toEqual([]);
  });

  test("does carry a test's reach across a bridge inside one root", () => {
    // The framework feature test: it calls its own HTTP route rather than importing the controller,
    // and it really does exercise the code behind it, because there is no process boundary between.
    const nodes = [
      node("OrderController"),
      node("routes/api.php"),
      node("OrderTest", { isTest: true, assertsValue: true }),
    ];
    const edges = [
      bridge("OrderTest", "routes/api.php"),
      edge("routes/api.php", "OrderController"),
    ];

    const coverage = computeCoverage(nodes, edges, { orders: ["OrderController"] });

    expect(coverage.orders?.reaches).toBe(true);
    expect(coverage.orders?.testNodes).toEqual(["OrderTest"]);
  });

  test("seeds reach with the flow's own members, so a member needs no edge to be reached", () => {
    // A property of computeCoverage in isolation, and not a shape any repository produces:
    // `reachableFrom` seeds its set with the start node, so a flow member is reached by being
    // itself. Stated here because everything above it depends on that seeding, and a test node is
    // simply the cheapest member to state it with.
    //
    // assignFlows never hands this input over: it skips test nodes outright (engine/flows.ts), so
    // no flow it assigns ever holds one. That rule exists because of what this case would otherwise
    // mean end to end: a test inside a flow makes the flow reached and asserting by construction,
    // which is the one answer docs/05 says matters most, silently unable to come back blind. So
    // read this as computeCoverage's contract for the members it is given, never as a claim that a
    // flow may contain its tests. The last block in this file is where that end is stated.
    const nodes = [node("PriceTest", { isTest: true, assertsValue: true })];

    expect(computeCoverage(nodes, [], { pricing: ["PriceTest"] })).toEqual({
      pricing: {
        flow: "pricing",
        testNodes: ["PriceTest"],
        testFiles: ["apps/api/app/PriceTest.php"],
        reaches: true,
        assertsValue: true,
        blind: false,
      },
    });
  });

  test("counts a test file once however many nodes it yields", () => {
    // The shape a pack that identifies a node by an exported symbol produces: one test file
    // exporting three cases is three nodes, all of them reaching the flow. `testNodes` says three
    // because three ids really did reach it, and `testFiles` says one because one file did, which
    // is the number every printer that says "N tests" is quoting.
    const cases = ["describeOne", "describeTwo", "describeThree"].map((name) =>
      node(`src/checkout.test.ts#${name}`, {
        isTest: true,
        assertsValue: true,
        file: "src/checkout.test.ts",
      }),
    );
    const nodes = [node("Checkout"), ...cases];
    const edges = cases.map((test) => edge(test.id, "Checkout"));

    const coverage = computeCoverage(nodes, edges, { checkout: ["Checkout"] });

    expect(coverage.checkout?.testNodes.length).toBe(3);
    expect(coverage.checkout?.testFiles).toEqual(["src/checkout.test.ts"]);
  });
});

/**
 * The two halves joined, because neither half can state this alone. `assignFlows` decides which nodes
 * a flow owns and `computeCoverage` reads that ownership back, so the answer a human is shown about a
 * colocated test is a property of the pair. The nodes below are the shape docs/04 says a pack must
 * cope with and the acme fixture structurally cannot produce: both of its roots keep tests in their
 * own tree, so no fixture run reaches a flow prefix that matches a test file.
 */
describe("assignFlows into computeCoverage", () => {
  const screen = node("OrderScreen", {
    root: "apps/mobile",
    file: "apps/mobile/src/screens/OrderScreen.tsx",
  });
  const colocated = node("OrderScreenTest", {
    isTest: true,
    root: "apps/mobile",
    file: "apps/mobile/src/screens/OrderScreen.test.tsx",
  });
  const flows: FlowDefinitions = { orders: { paths: ["apps/mobile/src/screens"] } };

  test("does not let a flow prefix that matches a colocated test answer about the flow's code", () => {
    // The test file sits under the flow's prefix and has no edge to the screen, so nothing reaches
    // the flow's code and the honest answer is unreached. Were the test assigned to the flow, the
    // flow would own the test id, `reachableFrom` seeds with the start node, and the test would
    // reach the flow by being it: `reaches` true and, since it asserts nothing, `blind` true on the
    // evidence of a test that reaches nothing but itself. That is what `assignFlows` skipping test
    // nodes buys, and it is why the false below is the assertion that matters.
    const coverage = computeCoverage(
      [screen, colocated],
      [],
      assignFlows([screen, colocated], flows),
    );

    expect(coverage.orders).toEqual({
      flow: "orders",
      testNodes: [],
      testFiles: [],
      reaches: false,
      assertsValue: false,
      blind: false,
    });
  });

  test("still reports the same flow blind once that same test really does reach its code", () => {
    // The inverse, and the reason the case above is not simply coverage going dark on colocated
    // tests: same nodes, same prefix, one import edge added. The test is outside the flow either
    // way, so `blind` here is earned by a reach through the graph rather than granted by ownership.
    const coverage = computeCoverage(
      [screen, colocated],
      [edge("OrderScreenTest", "OrderScreen")],
      assignFlows([screen, colocated], flows),
    );

    expect(coverage.orders).toEqual({
      flow: "orders",
      testNodes: ["OrderScreenTest"],
      testFiles: ["apps/mobile/src/screens/OrderScreen.test.tsx"],
      reaches: true,
      assertsValue: false,
      blind: true,
    });
  });
});

describe("reachableFrom", () => {
  test("terminates on a cycle and returns each node once", () => {
    const outgoing = new Map([
      ["Order", ["Calculator"]],
      ["Calculator", ["Discount"]],
      ["Discount", ["Order"]],
    ]);

    const reachable = reachableFrom("Order", outgoing);

    expect([...reachable].sort()).toEqual(["Calculator", "Discount", "Order"]);
    expect(reachable.size).toBe(3);
  });
});
