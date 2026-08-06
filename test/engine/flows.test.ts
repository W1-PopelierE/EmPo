import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseConfig } from "../../src/engine/config";
import { assignFlows, loadFlows } from "../../src/engine/flows";
import { repoRelative } from "../../src/engine/scanner";
import { EmpoError } from "../../src/errors";
import type { FlowDefinitions, GraphNode } from "../../src/schema/types";

/**
 * Flows join the human-owned journeys to layer 1 by repo-relative path prefix, so the node fields
 * that decide anything here are `id`, `file` and `isTest`, the last because a flow is the code of a
 * journey and `assignFlows` refuses a test node whatever prefix matched it. Everything else is filled
 * in plausibly and never read, `assertsValue` included: the cases below override it where a real
 * suite would have set it, but nothing here reads it, since it decides coverage rather than
 * assignment. The paths below are deep on purpose: prefix length is what breaks a tie between two
 * flows.
 */

function node(id: string, file: string): GraphNode {
  return {
    id,
    file,
    root: "apps/api",
    lang: "php",
    kind: "class",
    name: id,
    produces: [],
    consumes: [],
    isTest: false,
    assertsValue: false,
  };
}

const calculator = node(
  "Acme\\Libraries\\Price\\Calculator",
  "apps/api/app/Libraries/Price/Calculator.php",
);
const order = node("Acme\\Models\\Order", "apps/api/app/Models/Order.php");
const orderLine = node("Acme\\Models\\OrderLine", "apps/api/app/Models/OrderLine.php");
const orderState = node("Acme\\Models\\Order\\State", "apps/api/app/Models/Order/State.php");

describe("assignFlows", () => {
  test("gives a node to the flow whose declared prefix matches it longest, and to that one only", () => {
    const flows: FlowDefinitions = {
      api: { paths: ["apps/api/app"] },
      pricing: { paths: ["apps/api/app/Libraries/Price"] },
    };

    expect(assignFlows([calculator], flows)).toEqual({
      api: [],
      pricing: ["Acme\\Libraries\\Price\\Calculator"],
    });
  });

  test("gives a node to both flows when they declare the same prefix", () => {
    // One file belongs to more than one journey, which is the point of sharing rather than picking.
    const flows: FlowDefinitions = {
      checkout: { paths: ["apps/api/app/Libraries/Price"] },
      refunds: { paths: ["apps/api/app/Libraries/Price"] },
    };

    expect(assignFlows([calculator], flows)).toEqual({
      checkout: ["Acme\\Libraries\\Price\\Calculator"],
      refunds: ["Acme\\Libraries\\Price\\Calculator"],
    });
  });

  test("claims both spellings of the unit it names, and never a sibling that merely starts the same", () => {
    // `Order` swallowing `OrderLine.php` is the silent mis-assignment the boundary rule exists for,
    // and `Order` missing `Order.php` is the same mistake pointed the other way.
    const flows: FlowDefinitions = { orders: { paths: ["apps/api/app/Models/Order"] } };

    expect(assignFlows([order, orderLine, orderState], flows)).toEqual({
      orders: ["Acme\\Models\\Order", "Acme\\Models\\Order\\State"],
    });
  });

  test("does not let the file spelling reach past its own path segment", () => {
    // `Order.d/` starts with `Order.` too, so the extension case has to end where the segment does.
    const legacy = node("Acme\\Models\\Legacy", "apps/api/app/Models/Order.d/legacy.php");
    const flows: FlowDefinitions = { orders: { paths: ["apps/api/app/Models/Order"] } };

    expect(assignFlows([legacy, order], flows)).toEqual({ orders: ["Acme\\Models\\Order"] });
  });

  test("claims a single file when the declared prefix names that file exactly", () => {
    // A flow can own one file out of a directory another flow owns.
    const flows: FlowDefinitions = { orders: { paths: ["apps/api/app/Models/Order.php"] } };

    expect(assignFlows([order, orderLine, orderState], flows)).toEqual({
      orders: ["Acme\\Models\\Order"],
    });
  });

  test("reads a declared prefix the same way with or without a trailing slash", () => {
    const nodes = [order, orderLine, orderState];

    const bare = assignFlows(nodes, { orders: { paths: ["apps/api/app/Models/Order"] } });
    const slashed = assignFlows(nodes, { orders: { paths: ["apps/api/app/Models/Order/"] } });

    expect(slashed).toEqual(bare);
    expect(slashed).toEqual({ orders: ["Acme\\Models\\Order", "Acme\\Models\\Order\\State"] });
  });

  test("shares a node between a prefix written with a trailing slash and one written without", () => {
    // The two spell the same prefix, so neither is more specific and the tie has to share.
    const flows: FlowDefinitions = {
      fulfilment: { paths: ["apps/api/app/Models/Order/"] },
      orders: { paths: ["apps/api/app/Models/Order"] },
    };

    expect(assignFlows([orderState], flows)).toEqual({
      fulfilment: ["Acme\\Models\\Order\\State"],
      orders: ["Acme\\Models\\Order\\State"],
    });
  });

  test("reads a declared prefix the same way with or without a leading ./", () => {
    // The spelling a human types into flows.json and an agent proposes in `empo init`. The gate in
    // engine/proposal.ts joins the path to the repo root to ask whether it exists, and join()
    // normalizes the `./` away, so a `./`-prefixed path passed that check and then failed the
    // matcher at its first character: the human was told to re-index a graph that was fine.
    const nodes = [order, orderLine, orderState];

    const bare = assignFlows(nodes, { orders: { paths: ["apps/api/app/Models/Order"] } });
    const dotted = assignFlows(nodes, { orders: { paths: ["./apps/api/app/Models/Order"] } });
    const doubled = assignFlows(nodes, { orders: { paths: [".//apps/api/app/Models/Order"] } });

    expect(dotted).toEqual(bare);
    expect(doubled).toEqual(bare);
    expect(bare).toEqual({ orders: ["Acme\\Models\\Order", "Acme\\Models\\Order\\State"] });
  });

  test("does not let a leading ./ widen what the prefix claims", () => {
    // Normalizing a spelling must not loosen the boundary rule with it. `./apps/.../Order` claims
    // both spellings of the unit it names and still never claims the sibling `OrderLine.php`, which
    // is the same silent mis-assignment the bare spelling is guarded against above.
    const flows: FlowDefinitions = { orders: { paths: ["./apps/api/app/Models/Order"] } };

    expect(assignFlows([order, orderLine, orderState], flows)).toEqual({
      orders: ["Acme\\Models\\Order", "Acme\\Models\\Order\\State"],
    });
  });

  test("claims nothing for a declared path that spells only the repository root", () => {
    // `./` and `.//` normalize to `.`, which matches no node, exactly as a bare `.` always did.
    // Stripping them to the empty string instead would leave a prefix of length zero: it matches a
    // top-level dotfile, and it ties with every other prefix at that length, so a path naming
    // nothing would start claiming nodes nobody assigned to it. The real path beside it is what
    // proves the normalization is running at all rather than the whole case passing by accident.
    const dotfile = node("Acme\\Support\\Config", ".acme.php");
    const flows: FlowDefinitions = {
      everything: { paths: ["./"] },
      orders: { paths: ["./apps/api/app/Models/Order.php"] },
    };

    expect(assignFlows([order, dotfile], flows)).toEqual({
      everything: [],
      orders: ["Acme\\Models\\Order"],
    });
  });

  test("assigns the same nodes whichever spelling of a root the config used", () => {
    // The two sides of the comparison, joined the way the engine joins them. A node's `file` is
    // built by engine/scanner.ts out of the configured root, and the declared prefix is matched
    // against that `file` here, so flattening the declared side on its own does not make the two
    // agree: it moves the disagreement. A root spelled `./apps/api` used to produce files spelled
    // `./apps/api/...`, which the flattened prefix `apps/api/app/Models` then matched at none of
    // its characters, and the flow came back empty with no diagnostic anywhere. Both sides go
    // through schema/config.schema.ts now, and this walks the whole chain rather than either half.
    const spellings = ["apps/api", "./apps/api", "apps/api/", "./apps/api/"];
    const flows: FlowDefinitions = { orders: { paths: ["./apps/api/app/Models"] } };

    const assignments = spellings.map((path) => {
      const config = parseConfig(
        {
          version: 1,
          roots: [{ path, lang: "php" }],
          packs: { php: { version: "^1" } },
        },
        "the config under test",
      );
      const root = config.roots[0]?.path ?? "";
      const nodes = [
        node("Acme\\Models\\Order", repoRelative(root, "app/Models/Order.php")),
        node("Acme\\Support\\Clock", repoRelative(root, "app/Support/Clock.php")),
      ];
      return { files: nodes.map((entry) => entry.file), assigned: assignFlows(nodes, flows) };
    });

    for (const assignment of assignments) {
      expect(assignment.files).toEqual([
        "apps/api/app/Models/Order.php",
        "apps/api/app/Support/Clock.php",
      ]);
      expect(assignment.assigned).toEqual({ orders: ["Acme\\Models\\Order"] });
    }
  });

  test("keeps a flow that matches nothing, because an empty journey is a fact worth seeing", () => {
    const flows: FlowDefinitions = {
      models: { paths: ["apps/api/app/Models"] },
      web: { paths: ["apps/web/src"] },
    };

    expect(assignFlows([order, orderLine], flows)).toEqual({
      models: ["Acme\\Models\\Order", "Acme\\Models\\OrderLine"],
      web: [],
    });
  });

  test("sorts the node ids of a flow by code unit, not by the order the nodes arrived in", () => {
    const flows: FlowDefinitions = { models: { paths: ["apps/api/app/Models"] } };

    expect(assignFlows([orderLine, orderState, order], flows)).toEqual({
      models: ["Acme\\Models\\Order", "Acme\\Models\\OrderLine", "Acme\\Models\\Order\\State"],
    });
  });

  test("leaves a node out of every flow when no prefix matches it", () => {
    const stray = node("Acme\\Support\\Clock", "apps/api/app/Support/Clock.php");
    const flows: FlowDefinitions = { models: { paths: ["apps/api/app/Models"] } };

    expect(assignFlows([stray, order], flows)).toEqual({ models: ["Acme\\Models\\Order"] });
  });

  test("never gives a flow a test node, even one its prefix matches", () => {
    // The colocated test is the case that matters. A prefix over a directory of components claims
    // `OrderScreen.test.tsx` along with `OrderScreen.tsx`, and coverage then reports the flow as
    // asserting on the strength of a test the flow itself owns. The acme fixture cannot show this,
    // because both of its roots keep tests in their own tree.
    const screen = node(
      "apps/mobile/src/screens/OrderScreen.tsx",
      "apps/mobile/src/screens/OrderScreen.tsx",
    );
    const colocated: GraphNode = {
      ...node(
        "apps/mobile/src/screens/OrderScreen.test.tsx",
        "apps/mobile/src/screens/OrderScreen.test.tsx",
      ),
      isTest: true,
      assertsValue: true,
    };
    const flows: FlowDefinitions = { orders: { paths: ["apps/mobile/src/screens"] } };

    expect(assignFlows([screen, colocated], flows)).toEqual({
      orders: ["apps/mobile/src/screens/OrderScreen.tsx"],
    });
  });

  test("leaves a flow empty when every node its prefix matches is a test", () => {
    // The stronger half of the rule: the flow still exists and is visibly empty, rather than being
    // quietly populated by its own suite. An empty flow is a fact a human can act on.
    const onlyTests: GraphNode = {
      ...node("apps/api/tests/Feature/OrderTest.php", "apps/api/tests/Feature/OrderTest.php"),
      isTest: true,
      assertsValue: true,
    };
    const flows: FlowDefinitions = { orders: { paths: ["apps/api/tests"] } };

    expect(assignFlows([onlyTests], flows)).toEqual({ orders: [] });
  });
});

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "empo-flows-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function write(relPath: string, contents: string): void {
  const target = join(repo, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

describe("loadFlows", () => {
  test("returns no flows when the file does not exist, because a repo without flows still indexes", () => {
    expect(loadFlows(repo, ".empo/flows.json")).toEqual({});
  });

  test("fails with exit code 2 on a flows file whose shape is wrong, naming the flow at fault", () => {
    // `paths` is a list of prefixes; one bare string is the mistake a hand-edited file makes.
    write(
      ".empo/flows.json",
      JSON.stringify({ version: 1, flows: { checkout: { paths: "apps/api" } } }),
    );

    try {
      loadFlows(repo, ".empo/flows.json");
      expect.unreachable("expected a config error");
    } catch (error) {
      expect(error).toBeInstanceOf(EmpoError);
      expect((error as EmpoError).exitCode).toBe(2);
      expect((error as EmpoError).details.join("\n")).toContain("flows.checkout.paths");
    }
  });
});
