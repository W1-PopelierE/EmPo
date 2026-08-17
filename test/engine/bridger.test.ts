import { describe, expect, test } from "vitest";
import { bridgeLines, bridgeRoots, normalizeKey } from "../../src/engine/bridger";
import type { EmpoBridge } from "../../src/schema/config.schema";
import type { GraphNode, SymbolRef } from "../../src/schema/types";

/**
 * A bridge reads nodes only, so the fields that decide anything here are `root` (which side of the
 * bridge a node sits on), `produces` and `consumes` (the two symbol tables it joins), `id` (the ends
 * of the edge) and `file` plus the ref's `line` (the evidence). `lang`, `kind`, `name`, `isTest` and
 * `assertsValue` are filled plausibly and never read. Node ids are path-shaped because a route file
 * has no class to be named after and a TypeScript module is its own path.
 */

function node(
  id: string,
  options: { root?: string; produces?: SymbolRef[]; consumes?: SymbolRef[] } = {},
): GraphNode {
  const root = options.root ?? "apps/api";
  return {
    id,
    file: `${root}/${id}`,
    root,
    lang: "php",
    kind: "file",
    name: id,
    produces: options.produces ?? [],
    consumes: options.consumes ?? [],
    isTest: false,
    assertsValue: false,
  };
}

/** One entry in a node's symbol table. The symbol defaults to the kind every bridge below joins. */
function ref(key: string, line: number, symbol = "http-route"): SymbolRef {
  return { symbol, key, line };
}

/** The bridge from the documented example: the API defines the routes, the app calls them. */
const httpRoute: EmpoBridge = {
  kind: "http-route",
  produces: "apps/api",
  consumes: "apps/mobile",
};

describe("normalizeKey", () => {
  test("returns the key untouched when the bridge declares no rules", () => {
    expect(normalizeKey("POST v1/orders/{order}", undefined)).toBe("POST v1/orders/{order}");
    expect(normalizeKey("POST v1/orders/{order}", {})).toBe("POST v1/orders/{order}");
  });

  test("collapses every spelling of a path parameter to one key", () => {
    // Equal to each other is the property the bridge needs. Laravel writes `{order}`, Express
    // writes `:order`, a template literal writes `${id}`, Flask writes `<order>`, and the caller
    // usually has a concrete id in hand. None of them may end up in a bucket of its own.
    const spellings = [
      "POST v1/orders/{order}",
      "POST v1/orders/:order",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the app spells the param this way
      "POST v1/orders/${id}",
      "POST v1/orders/<order>",
      "POST v1/orders/42",
    ];

    const normalized = new Set(spellings.map((key) => normalizeKey(key, { collapseParams: true })));

    expect([...normalized]).toEqual(["POST v1/orders/*"]);
  });

  test("leaves a segment that is a name alone, including one that ends in a digit", () => {
    expect(normalizeKey("GET api/v1/orders", { collapseParams: true })).toBe("GET api/v1/orders");
  });

  test("strips a whole prefix segment, and never a segment that merely starts with it", () => {
    // Eating "api" out of the middle of "apiary" would leave a key nothing produces, and the bridge
    // would report an absent coupling where there is a matched one.
    expect(normalizeKey("POST api/v1/orders", { stripPrefix: ["api"] })).toBe("POST v1/orders");
    expect(normalizeKey("POST v1/apiary", { stripPrefix: ["api"] })).toBe("POST v1/apiary");
  });

  test("reads a stripped prefix written with a slash the same as one written bare", () => {
    // The documented example writes them as "/api" and "/v2"; a hand-written config drops the slash.
    const bare = normalizeKey("POST api/v1/orders", { stripPrefix: ["api"] });
    const slashed = normalizeKey("POST api/v1/orders", { stripPrefix: ["/api"] });

    expect(slashed).toBe(bare);
    expect(slashed).toBe("POST v1/orders");
  });

  test("lowercases the whole key", () => {
    expect(normalizeKey("POST V1/Orders", { lowercase: true })).toBe("post v1/orders");
  });

  test("drops a trailing slash", () => {
    expect(normalizeKey("POST v1/orders/", { stripTrailingSlash: true })).toBe("POST v1/orders");
  });
});

describe("bridgeRoots", () => {
  test("emits one edge from the consumer to the producer, evidenced at the consuming line", () => {
    // Direction matters: the definer's fan-in has to count everyone who would break if it changed,
    // so the edge runs the way an import runs. The evidence stays on the call site, because that is
    // the line a reader has to go and read.
    const routes = node("routes/api.php", { produces: [ref("POST v1/orders", 12)] });
    const checkout = node("src/screens/Checkout.tsx", {
      root: "apps/mobile",
      consumes: [ref("POST v1/orders", 44)],
    });

    expect(bridgeRoots([routes, checkout], [httpRoute]).edges).toEqual([
      {
        from: "src/screens/Checkout.tsx",
        to: "routes/api.php",
        kind: "bridge",
        symbol: "http-route",
        evidence: { file: "apps/mobile/src/screens/Checkout.tsx", line: 44 },
      },
    ]);
  });

  test("joins an Inertia page to the controller that renders it, page as the definer", () => {
    // The page's name came from its path (a pathPattern produce) and the controller's from its
    // source (an Inertia::render call). The bridge does not care which side read what: it joins the
    // keys. The edge runs controller -> page, so the page's fan-in counts the controllers that
    // render it, and `empo query Login.vue` names the controller across the language boundary.
    const page = node("src/Pages/Auth/Login.vue", {
      root: "apps/web",
      produces: [ref("Auth/Login", 1, "inertia-page")],
    });
    const controller = node("app/Http/Controllers/SessionController.php", {
      root: "apps/api",
      consumes: [ref("Auth/Login", 31, "inertia-page")],
    });
    const bridge: EmpoBridge = { kind: "inertia-page", produces: "apps/web", consumes: "apps/api" };

    expect(bridgeRoots([page, controller], [bridge]).edges).toEqual([
      {
        from: "app/Http/Controllers/SessionController.php",
        to: "src/Pages/Auth/Login.vue",
        kind: "bridge",
        symbol: "inertia-page",
        evidence: { file: "apps/api/app/Http/Controllers/SessionController.php", line: 31 },
      },
    ]);
  });

  test("matches the two sides only after the bridge's normalize rules have run", () => {
    // The headline case from docs/03-config-schema.md: the API registers a prefixed route with a
    // param and the app calls it with an id. Untouched, those two strings never meet.
    const routes = node("routes/api.php", { produces: [ref("POST api/v1/orders/{order}", 12)] });
    const orders = node("src/api/orders.ts", {
      root: "apps/mobile",
      consumes: [ref("POST v1/orders/42", 8)],
    });
    const bridge: EmpoBridge = {
      ...httpRoute,
      normalize: { stripPrefix: ["/api"], collapseParams: true },
    };

    const { edges, reports } = bridgeRoots([routes, orders], [bridge]);

    expect(edges).toHaveLength(1);
    expect(edges[0]?.to).toBe("routes/api.php");
    expect(reports).toEqual([
      { kind: "http-route", produced: 1, consumed: 1, matched: 1, unmatched: [] },
    ]);
  });

  test("emits nothing for a consumed key no producer declares, and reports it sorted", () => {
    const routes = node("routes/api.php", { produces: [ref("POST v1/orders", 12)] });
    const checkout = node("src/screens/Checkout.tsx", {
      root: "apps/mobile",
      consumes: [ref("POST v1/refunds", 51), ref("GET v1/orders", 9)],
    });

    const { edges, reports } = bridgeRoots([routes, checkout], [httpRoute]);

    expect(edges).toEqual([]);
    expect(reports).toEqual([
      {
        kind: "http-route",
        produced: 1,
        consumed: 2,
        matched: 0,
        unmatched: ["GET v1/orders", "POST v1/refunds"],
      },
    ]);
  });

  test("counts distinct keys and not edges, so two callers of one route are one matched key", () => {
    // `stats.bridgedEdges` on the line above already counts edges; a report counting them too would
    // contradict it. The edge count belongs to the graph, the match rate belongs to the report.
    const routes = node("routes/api.php", { produces: [ref("POST v1/orders", 12)] });
    const checkout = node("src/screens/Checkout.tsx", {
      root: "apps/mobile",
      consumes: [ref("POST v1/orders", 8)],
    });
    const cart = node("src/screens/Cart.tsx", {
      root: "apps/mobile",
      consumes: [ref("POST v1/orders", 21)],
    });

    const { edges, reports } = bridgeRoots([routes, checkout, cart], [httpRoute]);

    expect(edges).toHaveLength(2);
    expect(reports).toEqual([
      { kind: "http-route", produced: 1, consumed: 1, matched: 1, unmatched: [] },
    ]);
  });

  test("ignores a node in a root the bridge names on neither side", () => {
    // A monorepo has roots a given bridge is not about. If packages/shared counted, its consume
    // would match the API route and its produce would satisfy the app.
    const routes = node("routes/api.php", { produces: [ref("POST v1/orders", 12)] });
    const shared = node("src/orderClient.ts", {
      root: "packages/shared",
      produces: [ref("GET v1/products", 7)],
      consumes: [ref("POST v1/orders", 5)],
    });
    const catalog = node("src/screens/Catalog.tsx", {
      root: "apps/mobile",
      consumes: [ref("GET v1/products", 30)],
    });

    const { edges, reports } = bridgeRoots([routes, shared, catalog], [httpRoute]);

    expect(edges).toEqual([]);
    expect(reports).toEqual([
      {
        kind: "http-route",
        produced: 1,
        consumed: 1,
        matched: 0,
        unmatched: ["GET v1/products"],
      },
    ]);
  });

  test("ignores a produced or consumed ref whose symbol is not the bridge's kind", () => {
    // Two symbol kinds can spell a key the same way, and a bridge joins one kind at a time. If the
    // consuming side did not filter, the refunds key would match and emit an edge.
    const routes = node("routes/api.php", { produces: [ref("POST v1/orders", 12, "event")] });
    const legacy = node("routes/legacy.php", { produces: [ref("POST v1/refunds", 4)] });
    const checkout = node("src/screens/Checkout.tsx", {
      root: "apps/mobile",
      consumes: [ref("POST v1/orders", 44)],
    });
    const cart = node("src/screens/Cart.tsx", {
      root: "apps/mobile",
      consumes: [ref("POST v1/refunds", 7, "event")],
    });

    const { edges, reports } = bridgeRoots([routes, legacy, checkout, cart], [httpRoute]);

    expect(edges).toEqual([]);
    expect(reports).toEqual([
      {
        kind: "http-route",
        produced: 1,
        consumed: 1,
        matched: 0,
        unmatched: ["POST v1/orders"],
      },
    ]);
  });

  test("joins every root of a side written as a list", () => {
    const orders = node("routes/api.php", { produces: [ref("POST v1/orders", 12)] });
    const invoices = node("routes/billing.php", {
      root: "services/billing",
      produces: [ref("GET v1/invoices", 4)],
    });
    const checkout = node("src/screens/Checkout.tsx", {
      root: "apps/mobile",
      consumes: [ref("POST v1/orders", 44)],
    });
    const invoicePage = node("src/pages/Invoices.tsx", {
      root: "apps/web",
      consumes: [ref("GET v1/invoices", 18)],
    });
    const bridge: EmpoBridge = {
      kind: "http-route",
      produces: ["apps/api", "services/billing"],
      consumes: ["apps/mobile", "apps/web"],
    };

    expect(bridgeRoots([orders, invoices, checkout, invoicePage], [bridge]).edges).toEqual([
      {
        from: "src/pages/Invoices.tsx",
        to: "routes/billing.php",
        kind: "bridge",
        symbol: "http-route",
        evidence: { file: "apps/web/src/pages/Invoices.tsx", line: 18 },
      },
      {
        from: "src/screens/Checkout.tsx",
        to: "routes/api.php",
        kind: "bridge",
        symbol: "http-route",
        evidence: { file: "apps/mobile/src/screens/Checkout.tsx", line: 44 },
      },
    ]);
  });

  test("names both producers when two files declare the same key", () => {
    // Two files registering one route is a real ambiguity, and a change to either would break the
    // caller, so the bridge names both rather than picking one and being right half the time.
    const routes = node("routes/api.php", { produces: [ref("POST v1/orders", 12)] });
    const legacy = node("routes/legacy.php", { produces: [ref("POST v1/orders", 3)] });
    const checkout = node("src/screens/Checkout.tsx", {
      root: "apps/mobile",
      consumes: [ref("POST v1/orders", 44)],
    });

    const { edges, reports } = bridgeRoots([routes, legacy, checkout], [httpRoute]);

    expect(edges).toEqual([
      {
        from: "src/screens/Checkout.tsx",
        to: "routes/api.php",
        kind: "bridge",
        symbol: "http-route",
        evidence: { file: "apps/mobile/src/screens/Checkout.tsx", line: 44 },
      },
      {
        from: "src/screens/Checkout.tsx",
        to: "routes/legacy.php",
        kind: "bridge",
        symbol: "http-route",
        evidence: { file: "apps/mobile/src/screens/Checkout.tsx", line: 44 },
      },
    ]);
    expect(reports).toEqual([
      { kind: "http-route", produced: 1, consumed: 1, matched: 1, unmatched: [] },
    ]);
  });

  test("emits no edges and no reports when no bridges are configured", () => {
    // Declaring no bridges is a valid config: every root is an island (docs/03-config-schema.md).
    const routes = node("routes/api.php", { produces: [ref("POST v1/orders", 12)] });
    const checkout = node("src/screens/Checkout.tsx", {
      root: "apps/mobile",
      consumes: [ref("POST v1/orders", 44)],
    });

    expect(bridgeRoots([routes, checkout], [])).toEqual({ edges: [], reports: [] });
  });

  test("gives a node that both produces and consumes a key no edge to itself", () => {
    // A single-root bridge is the framework feature test case: the test calls its own HTTP route
    // rather than importing the controller. A route file that also calls the route it registers is
    // not coupled to itself, and a self-edge would inflate its own fan-in.
    const routes = node("routes/api.php", {
      produces: [ref("POST v1/orders", 12)],
      consumes: [ref("POST v1/orders", 30)],
    });
    const featureTest = node("tests/Feature/OrderTest.php", {
      consumes: [ref("POST v1/orders", 18)],
    });
    const internal: EmpoBridge = { kind: "http-route", produces: "apps/api", consumes: "apps/api" };

    const { edges, reports } = bridgeRoots([routes, featureTest], [internal]);

    expect(edges).toEqual([
      {
        from: "tests/Feature/OrderTest.php",
        to: "routes/api.php",
        kind: "bridge",
        symbol: "http-route",
        evidence: { file: "apps/api/tests/Feature/OrderTest.php", line: 18 },
      },
    ]);
    // The key itself still matched: it is produced and it is consumed, and only the self-pair is
    // dropped. Counting it unmatched would read as a mis-tuned normalize.
    expect(reports).toEqual([
      { kind: "http-route", produced: 1, consumed: 1, matched: 1, unmatched: [] },
    ]);
  });
});

describe("bridgeLines", () => {
  test("names the kind and the matched-over-consumed count", () => {
    const reports = [{ kind: "http-route", produced: 9, consumed: 4, matched: 4, unmatched: [] }];

    expect(bridgeLines(reports)).toEqual([
      "join http-route  4/4 consumed keys matched against 9 produced",
    ]);
  });

  test("names every unmatched key", () => {
    const reports = [
      {
        kind: "http-route",
        produced: 9,
        consumed: 6,
        matched: 4,
        unmatched: ["GET v1/refunds", "POST v1/webhooks"],
      },
    ];

    expect(bridgeLines(reports)).toEqual([
      "join http-route  4/6 consumed keys matched against 9 produced",
      '       no producer declares "GET v1/refunds"',
      '       no producer declares "POST v1/webhooks"',
    ]);
  });

  test("names five unmatched keys and then says how many it did not name", () => {
    // A silently truncated list reads as "that was all of them", and sends a reader hunting through
    // five keys for a cause that is in the two it never saw.
    const unmatched = [
      "GET v1/addresses",
      "GET v1/invoices",
      "GET v1/refunds",
      "POST v1/checkout",
      "POST v1/payments",
      "POST v1/vouchers",
      "PUT v1/orders/*",
    ];
    const reports = [{ kind: "http-route", produced: 9, consumed: 9, matched: 2, unmatched }];

    expect(bridgeLines(reports)).toEqual([
      "join http-route  2/9 consumed keys matched against 9 produced",
      '       no producer declares "GET v1/addresses"',
      '       no producer declares "GET v1/invoices"',
      '       no producer declares "GET v1/refunds"',
      '       no producer declares "POST v1/checkout"',
      '       no producer declares "POST v1/payments"',
      "       and 2 more unmatched keys",
    ]);
  });

  test("says one more key in the singular when exactly one goes unnamed", () => {
    const unmatched = [
      "GET v1/addresses",
      "GET v1/invoices",
      "GET v1/refunds",
      "POST v1/checkout",
      "POST v1/payments",
      "POST v1/vouchers",
    ];
    const reports = [{ kind: "http-route", produced: 9, consumed: 8, matched: 2, unmatched }];

    const lines = bridgeLines(reports);

    expect(lines).toHaveLength(7);
    expect(lines.at(-1)).toBe("       and 1 more unmatched key");
  });
});
