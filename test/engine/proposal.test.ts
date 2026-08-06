import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig } from "../../src/engine/config";
import { readGraph } from "../../src/engine/graph";
import { applyProposal, gateProposal } from "../../src/engine/proposal";
import type { EmpoConfig } from "../../src/schema/config.schema";
import { parseProposalFile } from "../../src/schema/proposal.schema";
import { parseSpineFile } from "../../src/schema/spine.schema";
import type { Graph } from "../../src/schema/types";

/**
 * The gate over `empo init`'s step 5. A proposal is a claim an agent made about a repository it read
 * quickly, and the whole point of running it through here is that no part of it reaches `.empo/`
 * until the graph and the source agreed with it.
 *
 * Everything below runs against `fixtures/acme-platform`, whose files, line numbers and existing
 * `pricing` spine are real, so a corrected line number in a test is a fact about a file on disk
 * rather than a number the test and the code agreed on between themselves. The fixture is copied to
 * a throwaway directory first, because applyProposal writes.
 */

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

/** Facts about the fixture every case below turns on, asserted once in the first test. */
const CALCULATOR = "apps/api/app/Libraries/Price/PriceCalculator.php";
const CONTROLLER = "apps/api/app/Http/Controllers/OrderController.php";
const OBSERVER = "apps/api/app/Observers/OrderObserver.php";
const ORDER_TEST = "apps/api/tests/Feature/OrderTest.php";

/** `return $order->subtotal + $this->tax(` really sits on line 13 of the calculator. */
const TOTAL_LINE = 13;
const TOTAL_ANCHOR = "return $order->subtotal + $this->tax(";

let repo: string;
let config: EmpoConfig;
let graph: Graph;
const temps: string[] = [];

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-proposal-"));
  temps.push(dir);
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  repo = checkout();
  config = loadConfig(repo).config;
  graph = readGraph(repo);
});

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hop(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    n,
    title: `hop ${n}`,
    file: CALCULATOR,
    line: TOTAL_LINE,
    anchor: TOTAL_ANCHOR,
    ...overrides,
  };
}

/** Built through the real schema, so every case starts from input the CLI would have accepted. */
function proposal(raw: Record<string, unknown>) {
  return parseProposalFile({ version: 1, ...raw }, "/tmp/empo-init/proposal.json");
}

function gate(raw: Record<string, unknown>) {
  return gateProposal(repo, config, graph, proposal(raw));
}

describe("gateProposal, flows", () => {
  test("keeps a flow whose every path matches a node, and counts what it covers", () => {
    const { flows } = gate({
      flows: {
        payments: {
          label: "Take a payment",
          paths: [
            "apps/api/app/Http/Controllers/CheckoutController.php",
            "apps/mobile/src/screens",
          ],
        },
      },
    });

    expect(flows).toHaveLength(1);
    expect(flows[0]?.name).toBe("payments");
    expect(flows[0]?.label).toBe("Take a payment");
    expect(flows[0]?.kept).toBe(true);
    expect(flows[0]?.existing).toBe(false);
    expect(flows[0]?.unmatched).toEqual([]);
    expect(flows[0]?.nodes).toBe(2);
    expect(flows[0]?.note).toBeUndefined();
  });

  test("drops the one path that matches nothing and keeps the rest, in the order proposed", () => {
    const { flows } = gate({
      flows: {
        payments: {
          paths: [
            "apps/api/app/Libraries/Price",
            "apps/api/app/Payments",
            "apps/api/app/Models/Order.php",
          ],
        },
      },
    });

    expect(flows[0]?.kept).toBe(true);
    expect(flows[0]?.paths).toEqual([
      "apps/api/app/Libraries/Price",
      "apps/api/app/Models/Order.php",
    ]);
    // The paths are what this case is about, so the reasons beside them are read off rather than
    // asserted. The reason each one carries has its own cases below.
    expect(flows[0]?.unmatched.map((entry) => entry.path)).toEqual(["apps/api/app/Payments"]);
    expect(flows[0]?.nodes).toBe(2);
  });

  test("matches a prefix the way the graph does, at a path boundary and never mid-segment", () => {
    // `apps/api/app/Models/Order` claims Order.php the way engine/flows.ts claims it. Reusing that
    // matcher rather than restating it is what keeps the gate's answer and the graph's identical.
    const { flows } = gate({
      flows: { orders_only: { paths: ["apps/api/app/Models/Order", "apps/api/app/Model"] } },
    });

    expect(flows[0]?.paths).toEqual(["apps/api/app/Models/Order"]);
    expect(flows[0]?.unmatched.map((entry) => entry.path)).toEqual(["apps/api/app/Model"]);
  });

  test("does not let a longer sibling path steal the nodes a shorter one matched", () => {
    // The calculator is the only node under `apps/api/app/Libraries`, and longest-prefix assignment
    // gives it to the deeper path. Judged as one set, the shallower path would come back matching
    // nothing and be reported as fiction, so each proposed path is asked about on its own.
    const { flows } = gate({
      flows: {
        wide: {
          paths: ["apps/api/app/Libraries", "apps/api/app/Libraries/Price/PriceCalculator.php"],
        },
      },
    });

    expect(flows[0]?.unmatched).toEqual([]);
    expect(flows[0]?.paths).toHaveLength(2);
    expect(flows[0]?.nodes).toBe(1);
  });

  test("keeps a path spelled with a leading ./ instead of calling the tree unindexed", () => {
    // The fourth way of matching nothing, which was never one of the three the gate can explain.
    // `join(repoRoot, "./apps/...")` normalizes the `./` away, so the path passed the existence
    // check, and the matcher then compared a node file against a prefix starting `.`, which fails
    // at the first character. The verdict came back "exists on disk, but nothing under it is a node
    // in the graph": the human is sent to re-index or add a root, when the repair is deleting two
    // characters. engine/flows.ts normalizes the spelling now, so the gate and the graph agree
    // about `./` the way they already agree about a trailing slash.
    const dotted = gate({
      flows: { orders: { paths: ["./apps/api/app/Http/Controllers"] } },
    }).flows;
    const bare = gate({ flows: { orders: { paths: ["apps/api/app/Http/Controllers"] } } }).flows;

    expect(dotted[0]?.kept).toBe(true);
    expect(dotted[0]?.unmatched).toEqual([]);
    // Kept as proposed, because `paths` is what would be written into the human's file.
    expect(dotted[0]?.paths).toEqual(["./apps/api/app/Http/Controllers"]);
    expect(dotted[0]?.nodes).toBe(bare[0]?.nodes);
    expect(dotted[0]?.nodes).toBe(4);
  });

  test("drops a flow whose every path matches nothing, and says which paths those were", () => {
    const { flows } = gate({
      flows: { payments: { paths: ["apps/api/app/Payments", "apps/web"] } },
    });

    expect(flows[0]?.kept).toBe(false);
    expect(flows[0]?.paths).toEqual([]);
    // Which paths, and why each one, is `unmatched` and only `unmatched`, so two dead paths are two
    // entries a reader can count. The note beside them is the verdict on the flow, asserted whole:
    // it once listed these same two pairs in prose, which put every reason on screen twice.
    expect(flows[0]?.unmatched).toEqual([
      { path: "apps/api/app/Payments", reason: "no file or directory of that name" },
      { path: "apps/web", reason: "no file or directory of that name" },
    ]);
    expect(flows[0]?.nodes).toBe(0);
    expect(flows[0]?.note).toBe("no proposed path matches a node in the graph.");
  });

  test("separates a path that is fiction from one the graph has simply not indexed", () => {
    // The distinction is the difference between an agent inventing a directory and a graph that is
    // stale or a root that is unconfigured. Both drop, and the human fixes them differently.
    mkdirSync(join(repo, "apps/api/database/migrations"), { recursive: true });
    writeFileSync(join(repo, "apps/api/database/migrations/001_orders.sql"), "-- orders\n");

    const { flows } = gate({ flows: { schema: { paths: ["apps/api/database"] } } });

    expect(flows[0]?.kept).toBe(false);
    // Asserted on the path's own reason, because that is where the answer lives for every dropped
    // path, kept flow or not. The note a flow that lost every path gets says only that the flow is
    // dead; it does not restate the reason, so the two are asserted apart and neither can drift into
    // repeating the other.
    expect(flows[0]?.unmatched[0]?.reason).toBe(
      "exists on disk, but nothing under it is a node in the graph",
    );
    expect(flows[0]?.note).toBe("no proposed path matches a node in the graph.");
  });

  test("keeps a flow that names its suite beside its code, and says the suite is tests", () => {
    // The defect the whole `unmatched` shape exists for. A proposal naming a test directory beside
    // real code keeps the flow, and the reason used to be computed only for a flow that lost every
    // path, so this reader was told the path matched no node. Untrue: the graph holds two nodes
    // under `apps/api/tests` and engine/flows.ts deliberately assigns neither, because a flow is
    // the code of a journey. A red here is a kept flow whose dropped path is unexplained, or
    // explained as fiction or as a stale index, both of which send the human to repair the wrong
    // thing: the repair is to name the code the suite covers.
    const { flows } = gate({
      flows: { payments: { paths: ["apps/api/app/Models/Order.php", "apps/api/tests"] } },
    });

    expect(flows[0]?.kept).toBe(true);
    expect(flows[0]?.paths).toEqual(["apps/api/app/Models/Order.php"]);
    expect(flows[0]?.nodes).toBe(1);
    expect(flows[0]?.unmatched.map((entry) => entry.path)).toEqual(["apps/api/tests"]);
    expect(flows[0]?.unmatched[0]?.reason).toContain(
      "every node the graph holds under it is a test",
    );
    // And no note, because the flow survived. A note is read as the verdict on the flow itself.
    expect(flows[0]?.note).toBeUndefined();
  });

  test("drops a flow whose only path is a directory of tests, and says so on the path", () => {
    // The same mistake with nothing to survive it. Both halves are asserted, and the point is that
    // they say different things: the path carries the reason, once, and the note says only that the
    // flow is dead. The note used to repeat every path and reason, which the printer had already put
    // on a `dropped:` line directly above it, so the human read the same sentence twice and had to
    // work out that it was one dropped path and not two. The note is asserted whole, because a
    // fragment is exactly what let that duplication pass green.
    const { flows } = gate({ flows: { payments: { paths: ["apps/mobile/tests"] } } });

    expect(flows[0]?.kept).toBe(false);
    expect(flows[0]?.paths).toEqual([]);
    expect(flows[0]?.unmatched[0]?.reason).toBe(
      "every node the graph holds under it is a test, and a flow is the code of a journey rather than its tests",
    );
    expect(flows[0]?.note).toBe("no proposed path matches a node in the graph.");
  });

  test("tells the three ways of matching nothing apart, within one kept flow", () => {
    // Three dead paths, three different repairs: delete the invented one, name the code the suite
    // covers, re-index or configure a root for the tree that is really there. A red where two of
    // them come back with one reason is the gate handing a human the wrong instruction for two
    // paths out of three, which is worse than saying nothing, and it survives a kept flow now
    // rather than only appearing when a flow lost everything.
    mkdirSync(join(repo, "apps/api/database/migrations"), { recursive: true });
    writeFileSync(join(repo, "apps/api/database/migrations/001_orders.sql"), "-- orders\n");

    const { flows } = gate({
      flows: {
        payments: {
          paths: [
            "apps/api/app/Models/Order.php",
            "apps/api/app/Payments",
            "apps/api/tests",
            "apps/api/database",
          ],
        },
      },
    });

    const unmatched = flows[0]?.unmatched ?? [];
    const reasonFor = (path: string) =>
      unmatched.find((entry) => entry.path === path)?.reason ?? "no verdict for that path";

    expect(flows[0]?.kept).toBe(true);
    expect(reasonFor("apps/api/app/Payments")).toBe("no file or directory of that name");
    expect(reasonFor("apps/api/tests")).toContain("every node the graph holds under it is a test");
    expect(reasonFor("apps/api/database")).toBe(
      "exists on disk, but nothing under it is a node in the graph",
    );
    expect(new Set(unmatched.map((entry) => entry.reason)).size).toBe(3);
  });

  test("calls an extension-less path onto one test node a suite, not an invented directory", () => {
    // `apps/api/tests/Feature/OrderTest` is the spelling a proposal uses for a single class, and the
    // graph resolves it onto exactly one node by the boundary rule engine/flows.ts matched it with.
    // The filesystem has no entry of that name, so asking the disk first answered "no file or
    // directory of that name": the human is told an agent invented a path, over a path the graph
    // holds a node under, and the test-only answer this file pins two cases above was unreachable
    // for the one spelling most likely to reach it. Both halves are asserted, so a red here can
    // only be the verdict and never the fixture.
    expect(existsSync(join(repo, "apps/api/tests/Feature/OrderTest"))).toBe(false);
    expect(graph.nodes.some((node) => node.file === ORDER_TEST && node.isTest)).toBe(true);

    const { flows } = gate({
      flows: { orders: { paths: ["apps/api/tests/Feature/OrderTest"] } },
    });

    expect(flows[0]?.kept).toBe(false);
    expect(flows[0]?.unmatched[0]?.reason).toBe(
      "every node the graph holds under it is a test, and a flow is the code of a journey rather than its tests",
    );
  });

  test("sends an extension-less path onto a file under no root to re-index, not to delete it", () => {
    // The same spelling over a tree no configured root reaches. `apps/web/src/checkout.ts` is on
    // disk and the graph holds nothing under it, which is the third answer's case exactly: add a
    // root or re-index. `existsSync("apps/web/src/checkout")` is false, so the check that reads the
    // disk has to read it by the matcher's rule or it hands this reader the one instruction that
    // destroys a true path, delete it.
    mkdirSync(join(repo, "apps/web/src"), { recursive: true });
    writeFileSync(join(repo, "apps/web/src/checkout.ts"), "export const checkout = 1;\n");

    expect(existsSync(join(repo, "apps/web/src/checkout"))).toBe(false);
    expect(graph.nodes.some((node) => node.file.startsWith("apps/web/"))).toBe(false);

    const { flows } = gate({ flows: { checkout: { paths: ["apps/web/src/checkout"] } } });

    expect(flows[0]?.kept).toBe(false);
    expect(flows[0]?.unmatched[0]?.reason).toBe(
      "exists on disk, but nothing under it is a node in the graph",
    );
  });

  test("drops a flow that states no paths at all rather than writing an empty journey", () => {
    const { flows } = gate({ flows: { payments: { paths: [] } } });

    expect(flows[0]?.kept).toBe(false);
    // This note names the flow, and has to: there is no dropped path to carry the message, so
    // `unmatched` is empty and the note is the only thing the human gets. Asserted whole to hold it
    // there, because the sibling note for a flow that stated paths and lost them all deliberately
    // names nothing.
    expect(flows[0]?.unmatched).toEqual([]);
    expect(flows[0]?.note).toBe('"payments" states no paths, so no node could ever belong to it.');
  });

  test("reports a flow the human already owns as a change, never as a merge", () => {
    const { flows } = gate({
      flows: { orders: { label: "Place an order", paths: ["apps/api/app/Models", "apps/mobile"] } },
    });

    expect(flows[0]?.existing).toBe(true);
    expect(flows[0]?.kept).toBe(true);
    expect(flows[0]?.note).toContain(".empo/flows.json");
    // What the proposal would add and what it would drop, so the diff a human approves is legible.
    expect(flows[0]?.note).toContain("apps/mobile");
    expect(flows[0]?.note).toContain("apps/api/app/Http/Controllers/OrderController.php");
  });

  test("calls a re-spelling of the entry on disk the change of nothing that it is", () => {
    // The same six paths the human's file already holds, each spelled with a leading `./`. Both
    // spellings claim an identical set of nodes, because engine/flows.ts flattens the `./` off
    // before it matches, so there is nothing here for a human to approve. Compared raw, every
    // proposed path is unknown and every path on disk is unproposed, and the note reports a change
    // of nothing at all as six paths added and six dropped, to the one person whose whole job at
    // this point is to tell a real change from a cosmetic one. The full string is asserted rather
    // than a fragment, because the wording is what that person reads.
    const onDisk = JSON.parse(readFileSync(join(repo, config.flows), "utf8")).flows.orders
      .paths as string[];
    const { flows } = gate({ flows: { orders: { paths: onDisk.map((path) => `./${path}`) } } });

    expect(flows[0]?.existing).toBe(true);
    expect(flows[0]?.kept).toBe(true);
    // Every one of them survived the matcher, so "adds no path" is an answer about six live paths
    // and not about a proposal the gate had already emptied.
    expect(flows[0]?.unmatched).toEqual([]);
    expect(flows[0]?.paths).toHaveLength(onDisk.length);
    expect(flows[0]?.note).toBe(
      `${config.flows} already defines "orders" and the file is the human's, so the entry on disk ` +
        "stands. This proposal adds no path and drops none.",
    );
  });

  test("still names a real addition and a real drop when one side is spelled with a ./", () => {
    // The guard that keeps the case above from passing for the wrong reason. Flattening both sides
    // must not flatten a genuine change into silence, so this proposal restates two of the eight
    // paths (one of them dotted), adds a controller the entry does not have, and leaves six
    // behind. `apps/api/app/Models` is the one that separates the two rules: it counts as neither
    // added nor dropped only because the dotted spelling and the plain one are recognised as the
    // same path.
    const { flows } = gate({
      flows: {
        orders: {
          paths: [
            "./apps/api/app/Models",
            "apps/mobile/src/screens",
            "apps/api/app/Http/Controllers/CheckoutController.php",
          ],
        },
      },
    });

    expect(flows[0]?.existing).toBe(true);
    expect(flows[0]?.note).toBe(
      `${config.flows} already defines "orders" and the file is the human's, so the entry on disk ` +
        "stands. This proposal adds apps/api/app/Http/Controllers/CheckoutController.php and " +
        "drops apps/api/app/Http/Controllers/OrderController.php, " +
        "apps/api/app/Http/Controllers/OrderPageController.php, apps/api/app/Libraries/Price, " +
        "apps/api/app/Observers, apps/mobile/src/api/client.ts, apps/portal/src/Pages.",
    );
  });

  test("reports flows in name order, whatever order the proposal listed them in", () => {
    const { flows } = gate({
      flows: {
        payments: { paths: ["apps/api/app/Http/Controllers/CheckoutController.php"] },
        admin: { paths: ["apps/api/app/Http/Controllers/AdminController.php"] },
      },
    });

    expect(flows.map((flow) => flow.name)).toEqual(["admin", "payments"]);
  });
});

describe("gateProposal, spines", () => {
  test("keeps a spine whose every citation resolves, and corrects nothing", () => {
    const { spines } = gate({
      spines: [
        {
          version: 1,
          name: "orders",
          hops: [hop(0, { file: CONTROLLER, line: 13, anchor: "$order->subtotal = 1000" }), hop(1)],
          traps: [
            {
              what: "the cache is refreshed on save",
              file: OBSERVER,
              line: 11,
              anchor: "the order summary cache is refreshed here",
            },
          ],
        },
      ],
    });

    expect(spines).toHaveLength(1);
    expect(spines[0]?.kept).toBe(true);
    expect(spines[0]?.corrected).toBe(0);
    expect(spines[0]?.fictional).toEqual([]);
    expect(spines[0]?.note).toBeUndefined();
    expect(spines[0]?.spine.hops[1]?.line).toBe(TOTAL_LINE);
  });

  test("corrects a hop whose anchor moved, to the line the anchor is really on", () => {
    const { spines } = gate({
      spines: [{ version: 1, name: "orders", hops: [hop(0, { line: 9 })] }],
    });

    expect(spines[0]?.kept).toBe(true);
    expect(spines[0]?.corrected).toBe(1);
    expect(spines[0]?.spine.hops[0]?.line).toBe(TOTAL_LINE);
    // The anchor itself is untouched: only the coordinate drifted.
    expect(spines[0]?.spine.hops[0]?.anchor).toBe(TOTAL_ANCHOR);
  });

  test("corrects an invariant's citation and a trap's line by the same rule", () => {
    const { spines } = gate({
      spines: [
        {
          version: 1,
          name: "orders",
          invariants: [
            {
              id: 1,
              statement: "total equals subtotal plus tax on that subtotal",
              citation: { file: ORDER_TEST, line: 3, anchor: "assertSame(1210," },
            },
          ],
          traps: [
            {
              what: "the cache is refreshed on save",
              file: OBSERVER,
              line: 4,
              anchor: "the order summary cache is refreshed here",
            },
          ],
        },
      ],
    });

    expect(spines[0]?.corrected).toBe(2);
    expect(spines[0]?.spine.invariants[0]?.citation?.line).toBe(15);
    expect(spines[0]?.spine.traps[0]?.line).toBe(11);
  });

  test("drops the whole spine for one invented anchor, and names what was invented", () => {
    const { spines } = gate({
      spines: [
        {
          version: 1,
          name: "orders",
          hops: [
            hop(0),
            hop(1, { title: "rounding", anchor: "$total = round($subtotal * 1.21);" }),
          ],
        },
      ],
    });

    expect(spines[0]?.kept).toBe(false);
    expect(spines[0]?.fictional).toHaveLength(1);
    expect(spines[0]?.fictional[0]).toContain("rounding");
    expect(spines[0]?.fictional[0]).toContain(CALCULATOR);
    expect(spines[0]?.note).toContain("1 citation");
    // The skeleton still comes back, so a human can salvage the hops that were real.
    expect(spines[0]?.spine.hops).toHaveLength(2);
  });

  test("drops a spine citing a file that is not there", () => {
    const { spines } = gate({
      spines: [
        {
          version: 1,
          name: "orders",
          hops: [hop(0, { file: "apps/api/app/Payments/Refund.php" })],
        },
      ],
    });

    expect(spines[0]?.kept).toBe(false);
    expect(spines[0]?.fictional[0]).toContain("apps/api/app/Payments/Refund.php");
  });

  test("drops a spine whose citation climbs out of the repository", () => {
    const { spines } = gate({
      spines: [{ version: 1, name: "orders", hops: [hop(0, { file: "../../etc/passwd" })] }],
    });

    expect(spines[0]?.kept).toBe(false);
    expect(spines[0]?.fictional[0]).toContain("escapes");
  });

  test("refuses to propose over a spine a human already owns", () => {
    const { spines } = gate({ spines: [{ version: 1, name: "pricing", hops: [hop(0)] }] });

    expect(spines[0]?.kept).toBe(false);
    expect(spines[0]?.corrected).toBe(0);
    expect(spines[0]?.fictional).toEqual([]);
    expect(spines[0]?.note).toContain(".empo/spines/pricing.json");
  });

  test("refuses a spine whose name would write outside the spines directory", () => {
    // The name is a string an agent wrote, and applyProposal builds a path to write to out of it.
    const { spines } = gate({ spines: [{ version: 1, name: "../../escaped", hops: [hop(0)] }] });

    expect(spines[0]?.kept).toBe(false);
    expect(spines[0]?.note).toContain("is not a file name");
    expect(existsSync(join(repo, "../../escaped.json"))).toBe(false);
  });

  test("returns a corrected spine that still satisfies the spine schema", () => {
    const { spines } = gate({
      spines: [
        {
          version: 1,
          name: "orders",
          principle: "Nothing recomputes the total after the calculator produced it.",
          hops: [hop(0, { line: 9, entry: "PriceCalculator::total", note: "sole funnel" })],
          guarded: ["apps/api/app/Libraries/Price/**"],
          assertionTerms: ["assertSame("],
          flows: ["orders"],
          moneyType: { class: "int", note: "whole cents" },
        },
      ],
    });

    const spine = spines[0]?.spine;
    expect(spine).toBeDefined();
    expect(parseSpineFile(spine, "proposed")).toEqual(spine);
  });

  test("reports spines in the order proposed", () => {
    const { spines } = gate({
      spines: [
        { version: 1, name: "orders", hops: [hop(0)] },
        { version: 1, name: "auth", hops: [hop(0)] },
      ],
    });

    expect(spines.map((spine) => spine.name)).toEqual(["orders", "auth"]);
  });
});

describe("applyProposal", () => {
  function flowsOnDisk(): Record<string, { label?: string; paths: string[] }> {
    return JSON.parse(readFileSync(join(repo, config.flows), "utf8")).flows;
  }

  test("merges a surviving flow into the file and leaves the human's entries alone", () => {
    const result = gate({
      flows: {
        payments: {
          label: "Take a payment",
          paths: ["apps/api/app/Http/Controllers/CheckoutController.php"],
        },
        orders: { label: "Something else", paths: ["apps/mobile/src/shared/money.ts"] },
      },
    });

    const applied = applyProposal(repo, config, result);

    expect(applied).toEqual([{ path: ".empo/flows.json", state: "wrote" }]);
    const flows = flowsOnDisk();
    expect(Object.keys(flows)).toEqual(["admin", "checkout", "orders", "payments"]);
    expect(flows.payments?.label).toBe("Take a payment");
    // The human owns orders. The proposal for it is a change to approve, not a write to make.
    expect(flows.orders?.label).toBe("Place an order");
    expect(flows.orders?.paths).toContain("apps/api/app/Http/Controllers/OrderController.php");
  });

  test("writes only the paths that survived, never the ones that matched nothing", () => {
    const result = gate({
      flows: { payments: { paths: ["apps/api/app/Libraries/Price", "apps/api/app/Payments"] } },
    });

    applyProposal(repo, config, result);

    expect(flowsOnDisk().payments?.paths).toEqual(["apps/api/app/Libraries/Price"]);
  });

  test("leaves the flows file untouched when nothing survived", () => {
    const before = readFileSync(join(repo, config.flows), "utf8");
    const result = gate({ flows: { payments: { paths: ["apps/api/app/Payments"] } } });

    const applied = applyProposal(repo, config, result);

    expect(applied).toEqual([]);
    expect(readFileSync(join(repo, config.flows), "utf8")).toBe(before);
  });

  test("leaves the flows file untouched when every surviving flow is already on disk", () => {
    const before = readFileSync(join(repo, config.flows), "utf8");
    const result = gate({ flows: { orders: { paths: ["apps/mobile/src/shared/money.ts"] } } });

    const applied = applyProposal(repo, config, result);

    expect(applied).toEqual([{ path: ".empo/flows.json", state: "kept" }]);
    expect(readFileSync(join(repo, config.flows), "utf8")).toBe(before);
  });

  test("writes a surviving spine where empo verify will look for it", () => {
    const result = gate({
      spines: [
        {
          version: 1,
          name: "orders",
          hops: [hop(0, { line: 9 })],
          guarded: ["apps/api/app/Libraries/Price/**"],
          assertionTerms: ["assertSame("],
        },
      ],
    });

    const applied = applyProposal(repo, config, result);

    expect(applied).toEqual([{ path: ".empo/spines/orders.json", state: "wrote" }]);
    const written = JSON.parse(readFileSync(join(repo, ".empo/spines/orders.json"), "utf8"));
    // Corrected, not as proposed: what lands on disk is what the source agreed with.
    expect(written.hops[0].line).toBe(TOTAL_LINE);
    expect(parseSpineFile(written, "orders").name).toBe("orders");
  });

  test("writes nothing for a dropped verdict", () => {
    const result = gate({
      spines: [
        {
          version: 1,
          name: "orders",
          hops: [hop(0, { anchor: "$total = round($subtotal * 1.21);" })],
        },
      ],
    });

    const applied = applyProposal(repo, config, result);

    expect(applied).toEqual([]);
    expect(existsSync(join(repo, ".empo/spines/orders.json"))).toBe(false);
  });

  test("never overwrites a spine file that appeared after the gate ran", () => {
    const result = gate({ spines: [{ version: 1, name: "orders", hops: [hop(0)] }] });
    writeFileSync(join(repo, ".empo/spines/orders.json"), '{"human": "wrote this"}\n');

    const applied = applyProposal(repo, config, result);

    expect(applied).toEqual([{ path: ".empo/spines/orders.json", state: "kept" }]);
    expect(readFileSync(join(repo, ".empo/spines/orders.json"), "utf8")).toBe(
      '{"human": "wrote this"}\n',
    );
  });

  test("refuses to write a spine whose name escapes the directory, whatever the verdict says", () => {
    // The gate already drops such a name, so this is the second lock: applyProposal is the code
    // that turns a name into a path to write to, and it never writes outside the spines directory.
    const gated = gate({ spines: [{ version: 1, name: "orders", hops: [hop(0)] }] });
    const escaping = {
      flows: [],
      spines: gated.spines.map((verdict) => ({
        ...verdict,
        name: "../escaped",
        spine: { ...verdict.spine, name: "../escaped" },
      })),
    };

    expect(applyProposal(repo, config, escaping)).toEqual([
      { path: ".empo/escaped.json", state: "kept" },
    ]);
    expect(existsSync(join(repo, ".empo/escaped.json"))).toBe(false);
  });

  test("carries a proposed spine's assertionPaths into the file it writes", () => {
    // `spineDocument` rebuilds a spine key by key rather than serializing what the schema parsed, so
    // a field added to the schema and not to it is written as nothing at all: the proposal validates,
    // the gate keeps it, and the spine lands on disk with its scope silently gone. That is the
    // `multilineQuotes` scar one layer up (docs/14-implementation-notes.md), and it is why this
    // asserts the written bytes rather than the verdict the gate returned.
    const result = gate({
      spines: [
        {
          version: 1,
          name: "orders",
          hops: [hop(0)],
          guarded: ["apps/api/app/Libraries/Price/**"],
          assertionTerms: ["assertSame("],
          assertionPaths: ["apps/api/tests/Feature/OrderTest.php"],
        },
      ],
    });

    applyProposal(repo, config, result);

    const written = JSON.parse(readFileSync(join(repo, ".empo/spines/orders.json"), "utf8")) as {
      assertionPaths: string[];
    };
    expect(written.assertionPaths).toEqual(["apps/api/tests/Feature/OrderTest.php"]);
  });

  test("creates the spines directory when the repository has none", () => {
    rmSync(join(repo, ".empo/spines"), { recursive: true, force: true });
    const result = gate({ spines: [{ version: 1, name: "orders", hops: [hop(0)] }] });

    applyProposal(repo, config, result);

    expect(existsSync(join(repo, ".empo/spines/orders.json"))).toBe(true);
  });

  test("writes two-space JSON with a trailing newline, keys in a fixed order", () => {
    const result = gate({
      flows: { payments: { paths: ["apps/api/app/Http/Controllers/CheckoutController.php"] } },
      spines: [{ version: 1, name: "orders", hops: [hop(0, { note: "sole funnel" })] }],
    });

    applyProposal(repo, config, result);

    expect(readFileSync(join(repo, ".empo/spines/orders.json"), "utf8")).toBe(
      `${JSON.stringify(
        {
          version: 1,
          name: "orders",
          hops: [
            {
              n: 0,
              title: "hop 0",
              file: CALCULATOR,
              line: TOTAL_LINE,
              anchor: TOTAL_ANCHOR,
              note: "sole funnel",
            },
          ],
          guarded: [],
          assertionTerms: [],
          assertionPaths: [],
          invariants: [],
          traps: [],
          flows: [],
          unguardedFlows: [],
        },
        null,
        2,
      )}\n`,
    );
    expect(readFileSync(join(repo, config.flows), "utf8").endsWith("\n")).toBe(true);
  });

  test("writes the same bytes into two checkouts of the same repository", () => {
    const other = checkout();
    const raw = {
      flows: { payments: { paths: ["apps/api/app/Http/Controllers/CheckoutController.php"] } },
      spines: [
        {
          version: 1,
          name: "orders",
          principle: "Nothing recomputes the total.",
          hops: [
            hop(0, { line: 9 }),
            hop(1, { file: CONTROLLER, line: 13, anchor: "$order->subtotal = 1000" }),
          ],
          invariants: [{ id: "INV-1", statement: "the total is whole cents" }],
          moneyType: { class: "int" },
        },
      ],
    };

    applyProposal(repo, config, gate(raw));
    applyProposal(
      other,
      loadConfig(other).config,
      gateProposal(other, loadConfig(other).config, readGraph(other), proposal(raw)),
    );

    for (const file of [".empo/flows.json", ".empo/spines/orders.json"]) {
      expect(readFileSync(join(other, file), "utf8")).toBe(readFileSync(join(repo, file), "utf8"));
    }
  });

  test("reports the flows file before the spines it wrote", () => {
    const result = gate({
      flows: { payments: { paths: ["apps/api/app/Http/Controllers/CheckoutController.php"] } },
      spines: [
        { version: 1, name: "orders", hops: [hop(0)] },
        { version: 1, name: "auth", hops: [hop(0)] },
      ],
    });

    expect(applyProposal(repo, config, result).map((file) => file.path)).toEqual([
      ".empo/flows.json",
      ".empo/spines/orders.json",
      ".empo/spines/auth.json",
    ]);
  });
});
