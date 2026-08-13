import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { indexCommand } from "../../src/commands/index";
import {
  blastRadius,
  FLOOR_NOT_CEILING,
  HAZARDS_NOT_RECORDED,
  NO_FLOW_CURATED,
  NO_FLOW_REACHED,
  NO_HAZARD_CLAIM,
  queryCommand,
  resolveNodes,
} from "../../src/commands/query";
import { run } from "../../src/engine/git";
import { GRAPH_SCHEMA, graphPath, readGraph, serializeGraph } from "../../src/engine/graph";
// The two strings live with the axis they explain, because `empo init`'s brief subtracts the same
// kinds and prints the same sentence about them.
import { FRAMEWORK_RESOLVED_REASON, LIST_FRAMEWORK_RESOLVED } from "../../src/engine/kinds";
import { loadPack } from "../../src/engine/pack-loader";
import { EmpoError } from "../../src/errors";
import type { Graph, GraphEdge, GraphNode, Hazard } from "../../src/schema/types";

/**
 * `empo query` over a real graph. The fixture is copied to a temp directory and indexed once,
 * because nothing here writes: these tests read the graph that `empo index` produced and ask the
 * blast-radius question against it.
 *
 * The assertions target `resolveNodes` and `blastRadius` rather than the printed lines, so a change
 * to the layout does not fail a test about reachability. Printing gets one smoke test, for the one
 * sentence that has to survive every layout change.
 */

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

const CALCULATOR = "Acme\\Libraries\\Price\\PriceCalculator";
const CALCULATOR_FILE = "apps/api/app/Libraries/Price/PriceCalculator.php";
const ORDER_CONTROLLER = "Acme\\Http\\Controllers\\OrderController";
const CHECKOUT_CONTROLLER = "Acme\\Http\\Controllers\\CheckoutController";
const ADMIN_CONTROLLER = "Acme\\Http\\Controllers\\AdminController";
const PAGE_CONTROLLER = "Acme\\Http\\Controllers\\OrderPageController";
const INERTIA_PAGE = "apps/portal/src/Pages/Orders/Show.vue";

/**
 * The php pack as installed, read rather than written down. Every hand-made graph below records it,
 * so none of them carries drift it was not written to be about: a graph claiming some other version
 * makes `empo query` print a drift line under every answer, which would be a true statement about a
 * fixture and noise in a test about orphans.
 */
const PHP_INSTALLED = loadPack("php").version;

/** A version no pack will carry, for the cases below that are about drift. */
const PHP_BEFORE = "0.0.1-before";

/**
 * The staleness cases build a real checkout, which spawns git several times over. The 5s default is
 * a limit on a machine doing nothing else, and none of them gets slower because something is wrong.
 */
const GIT_TIMEOUT = 30_000;

let repo: string;
let graph: Graph;

/**
 * The acme fixture has no two nodes sharing a short name, and giving it one to satisfy this rule
 * would change what every other spec sees. Two hand-made nodes are the whole of what it needs.
 */
function ambiguousGraph(): Graph {
  const node = (id: string, file: string): GraphNode => ({
    id,
    file,
    root: "apps/api",
    lang: "php",
    kind: "class",
    name: "Invoice",
    produces: [],
    consumes: [],
    isTest: false,
    assertsValue: false,
  });

  return {
    schema: GRAPH_SCHEMA,
    builtAgainst: "",
    builtAtCommitSubject: "",
    roots: [{ path: "apps/api", lang: "php" }],
    packs: { php: PHP_INSTALLED },
    stats: { files: 2, nodes: 2, edges: 0, bridgedEdges: 0 },
    nodes: [
      node("Acme\\Billing\\Invoice", "apps/api/app/Billing/Invoice.php"),
      node("Acme\\Legacy\\Invoice", "apps/api/app/Legacy/Invoice.php"),
    ],
    edges: [],
    flows: {},
    fanin: {},
    coverage: {},
    hazards: [],
    hazardsScanned: [],
    names: [],
  };
}

/**
 * A graph a `symbol`-strategy pack produced: one file holding two exports, and one consumer that
 * imports both of them. Written by hand rather than indexed from a fixture because the shipped packs
 * still id by path and by fqcn, so no fixture in the tree yields a graph of this shape yet, and the
 * three things this shape is here to prove are all about a path that names more than one node.
 */
function symbolGraph(): Graph {
  const node = (file: string, symbol: string): GraphNode => ({
    id: `${file}#${symbol}`,
    file,
    root: ".",
    lang: "typescript",
    kind: "module",
    name: symbol,
    symbol,
    produces: [],
    consumes: [],
    isTest: false,
    assertsValue: false,
  });
  const edge = (to: string, line: number): GraphEdge => ({
    from: "src/total.ts#total",
    to,
    kind: "import",
    symbol: null,
    evidence: { file: "src/total.ts", line },
  });

  return {
    schema: GRAPH_SCHEMA,
    builtAgainst: "",
    builtAtCommitSubject: "",
    roots: [{ path: ".", lang: "typescript" }],
    packs: { typescript: loadPack("typescript").version },
    stats: { files: 2, nodes: 3, edges: 2, bridgedEdges: 0 },
    nodes: [
      node("src/money.ts", "formatMoney"),
      node("src/money.ts", "parseMoney"),
      node("src/total.ts", "total"),
    ],
    edges: [edge("src/money.ts#formatMoney", 1), edge("src/money.ts#parseMoney", 1)],
    flows: {},
    fanin: { "src/money.ts#formatMoney": 1, "src/money.ts#parseMoney": 1 },
    coverage: {},
    hazards: [],
    hazardsScanned: [],
    names: [],
  };
}

/**
 * One component imported and rendered by one page, which is what every React and Vue file does and
 * what no php file did until the typescript pack declared a `template` family. Both edges are real
 * and the graph keeps both; what the two must not do is make one consumer read as two.
 */
function renderedComponentGraph(): Graph {
  const node = (id: string): GraphNode => ({
    id,
    file: id,
    root: ".",
    lang: "typescript",
    kind: "component",
    name: id.split("/").at(-1)?.replace(".tsx", "") ?? id,
    produces: [],
    consumes: [],
    isTest: false,
    assertsValue: false,
  });
  const edge = (kind: GraphEdge["kind"], line: number): GraphEdge => ({
    from: "src/App.tsx",
    to: "src/Card.tsx",
    kind,
    symbol: null,
    evidence: { file: "src/App.tsx", line },
  });

  return {
    schema: GRAPH_SCHEMA,
    builtAgainst: "",
    builtAtCommitSubject: "",
    roots: [{ path: ".", lang: "typescript" }],
    packs: { typescript: loadPack("typescript").version },
    stats: { files: 2, nodes: 2, edges: 2, bridgedEdges: 0 },
    nodes: [node("src/App.tsx"), node("src/Card.tsx")],
    // In the order the graph itself holds them: from, to, kind, line (engine/order.ts).
    edges: [edge("import", 1), edge("template", 7)],
    flows: {},
    fanin: { "src/Card.tsx": 1 },
    coverage: {},
    hazards: [],
    hazardsScanned: [],
    names: [],
  };
}

const VIEW_FILE = "apps/api/resources/views/orders/index.blade.php";
const MIGRATION_FILE = "apps/api/database/migrations/2024_01_01_create_orders.php";
const DEAD_CLASS = "Acme\\Legacy\\UnusedReport";
const POLICY = "Acme\\Policies\\OrderPolicy";

const temporary: string[] = [];

/**
 * A repository whose graph holds the three sorts of node `--orphans` has to tell apart: one the
 * framework reaches by convention, one that is genuinely referenced by nobody, and one with real
 * consumers. The acme fixture has no views, migrations or policies in it and belongs to the whole
 * suite, so this is written by hand instead: `--orphans` reads the graph on disk and nothing else,
 * which makes a hand-written graph the honest input.
 */
function frameworkGraph(): Graph {
  const node = (id: string, file: string, kind: string): GraphNode => ({
    id,
    file,
    root: "apps/api",
    lang: "php",
    kind,
    name: id.split("\\").at(-1) ?? id,
    produces: [],
    consumes: [],
    isTest: false,
    assertsValue: false,
  });

  return {
    schema: GRAPH_SCHEMA,
    builtAgainst: "",
    builtAtCommitSubject: "",
    roots: [{ path: "apps/api", lang: "php" }],
    packs: { php: PHP_INSTALLED },
    stats: { files: 5, nodes: 5, edges: 1, bridgedEdges: 0 },
    nodes: [
      node(VIEW_FILE, VIEW_FILE, "view"),
      node(MIGRATION_FILE, MIGRATION_FILE, "migration"),
      node(POLICY, "apps/api/app/Policies/OrderPolicy.php", "policy"),
      node(DEAD_CLASS, "apps/api/app/Legacy/UnusedReport.php", "class"),
      node("Acme\\Models\\Order", "apps/api/app/Models/Order.php", "model"),
    ],
    edges: [],
    flows: {},
    // Only the model is referenced. Everything else has a fan-in of zero, which is exactly the
    // input the old rule turned into four dead-code candidates, three of them wrong.
    fanin: { "Acme\\Models\\Order": 1 },
    coverage: {},
    hazards: [],
    hazardsScanned: [],
    names: [],
  };
}

/**
 * The shape the `view` resolve strategy made possible and no fixture had before it: a template that
 * is a sink. One layout, consumed by the page that `@extends` it and by the controller that renders
 * it, and the page itself consumed by nothing much — so the page outranks the controller on its own
 * fan-in and the layout outranks both. Every consumer edge is `template`, which is the point: the
 * family cannot tell these two rows apart and the node kinds can.
 */
function renderedLayoutGraph(): Graph {
  const LAYOUT = "resources/views/layouts/app.blade.php";
  const PAGE = "resources/views/orders/index.blade.php";

  const node = (id: string, kind: string): GraphNode => ({
    id,
    file: id.includes("\\") ? "apps/api/app/Http/Controllers/OrderController.php" : id,
    root: "apps/api",
    lang: "php",
    kind,
    name: id.split(/[\\/]/).at(-1) ?? id,
    produces: [],
    consumes: [],
    isTest: false,
    assertsValue: false,
  });
  const edge = (from: string, to: string, line: number): GraphEdge => ({
    from,
    to,
    kind: "template",
    symbol: null,
    evidence: { file: node(from, "").file, line },
  });

  return {
    schema: GRAPH_SCHEMA,
    builtAgainst: "",
    builtAtCommitSubject: "",
    roots: [{ path: "apps/api", lang: "php" }],
    packs: { php: PHP_INSTALLED },
    stats: { files: 3, nodes: 3, edges: 3, bridgedEdges: 0 },
    nodes: [node(LAYOUT, "view"), node(PAGE, "view"), node(ORDER_CONTROLLER, "class")],
    edges: [
      edge(PAGE, LAYOUT, 1),
      edge(ORDER_CONTROLLER, LAYOUT, 26),
      edge(ORDER_CONTROLLER, PAGE, 12),
    ],
    flows: {},
    fanin: { [LAYOUT]: 2, [PAGE]: 1 },
    coverage: {},
    hazards: [],
    hazardsScanned: [],
    names: [],
  };
}

/**
 * A graph with `count` nodes all of non-zero fan-in, for the one thing `--gods` does that no
 * fixture is large enough to exercise: cap the list and say how many it left out. Fan-in descends
 * with the index so the order is deterministic and the top-20 is a known slice.
 */
function manyGodsGraph(count: number): Graph {
  const nodes: GraphNode[] = [];
  const fanin: Record<string, number> = {};
  for (let i = 0; i < count; i += 1) {
    const id = `Acme\\Wide\\Node${String(i).padStart(3, "0")}`;
    nodes.push({
      id,
      file: `apps/api/app/Wide/Node${i}.php`,
      root: "apps/api",
      lang: "php",
      kind: "class",
      name: `Node${i}`,
      produces: [],
      consumes: [],
      isTest: false,
      assertsValue: false,
    });
    fanin[id] = count - i;
  }

  return {
    schema: GRAPH_SCHEMA,
    builtAgainst: "",
    builtAtCommitSubject: "",
    roots: [{ path: "apps/api", lang: "php" }],
    packs: { php: PHP_INSTALLED },
    stats: { files: count, nodes: count, edges: 0, bridgedEdges: 0 },
    nodes,
    edges: [],
    flows: {},
    fanin,
    coverage: {},
    hazards: [],
    hazardsScanned: [],
    names: [],
  };
}

const DISPATCH_FILE = "apps/api/app/Http/Controllers/CheckoutController.php";
const RESOLVED_JOB = "Acme\\Jobs\\SendInvoice";

/**
 * Two hazards, one of each sort: a dispatch whose job resolves to a node, and a dispatch built at
 * runtime that resolves to nothing. The second is the one worth keeping in the fixture, because a
 * null target is still a hazard and dropping it would make the list read as complete.
 */
function hazardRows(): Hazard[] {
  return [
    {
      file: DISPATCH_FILE,
      line: 42,
      job: "SendInvoice",
      target: RESOLVED_JOB,
      transactionLine: 30,
    },
    { file: DISPATCH_FILE, line: 47, job: "$job", target: null, transactionLine: 30 },
  ];
}

/**
 * A graph that holds nothing but hazards and the record of who scanned for them, which is all
 * `--hazards` reads out of one. `scanned` is the languages whose pack had hazard rules at build
 * time, written by `empo index` and not re-derived here, so a test can state each of the four
 * answers without depending on what a shipped pack happens to declare today.
 */
function hazardGraph(rows: Hazard[], scanned: string[] = ["php"], langs = ["php"]): Graph {
  return {
    schema: GRAPH_SCHEMA,
    builtAgainst: "",
    builtAtCommitSubject: "",
    roots: langs.map((lang) => ({ path: `apps/${lang}`, lang })),
    // Read off the packs installed, so no case below prints a drift line it was not written about.
    packs: Object.fromEntries(langs.map((lang) => [lang, loadPack(lang).version])),
    stats: { files: 1, nodes: 0, edges: 0, bridgedEdges: 0 },
    nodes: [],
    edges: [],
    flows: {},
    fanin: {},
    coverage: {},
    hazards: rows,
    hazardsScanned: scanned,
    names: [],
  };
}

/**
 * The same graph as an older empo really left it: neither hazards key present. `readGraph` casts the
 * parsed JSON without checking one, so this is exactly what the command receives, and the type says
 * both keys are required, which is why the cast is here rather than in the command.
 */
function graphBeforeHazards(): Graph {
  const older: Partial<Graph> = { ...hazardGraph([]), schema: GRAPH_SCHEMA - 1 };
  delete older.hazards;
  delete older.hazardsScanned;
  return older as Graph;
}

/**
 * A synthetic Laravel tree, written and indexed for real, one file per convention the php pack now
 * claims to know. It lives here rather than in fixtures/acme-platform because acme is the fixture
 * every other spec reads and a repository full of empty migrations would change what they see.
 */
function indexedLaravelRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-laravel-"));
  const files: Record<string, string> = {
    ".empo/config.json": JSON.stringify({
      version: 1,
      roots: [{ path: "apps/api", lang: "php", framework: "laravel" }],
      packs: { php: { version: "^1" } },
    }),
    "apps/api/composer.json": JSON.stringify({ name: "acme/api" }),
    "apps/api/routes/api.php": "<?php\n",
    "apps/api/bootstrap/app.php": "<?php\n\nreturn [];\n",
    "apps/api/config/services.php": "<?php\n\nreturn [];\n",
    "apps/api/resources/views/orders/index.blade.php": "<div>orders</div>\n",
    "apps/api/database/migrations/2024_01_01_000000_create_orders_table.php":
      "<?php\n\nreturn new class {};\n",
    "apps/api/database/factories/OrderFactory.php":
      "<?php\n\nnamespace Database\\Factories;\n\nclass OrderFactory {}\n",
    "apps/api/app/Policies/OrderPolicy.php":
      "<?php\n\nnamespace Acme\\Policies;\n\nclass OrderPolicy {}\n",
    "apps/api/app/Console/Commands/PruneOrders.php":
      "<?php\n\nnamespace Acme\\Console\\Commands;\n\nclass PruneOrders {}\n",
    "apps/api/app/Legacy/UnusedReport.php":
      "<?php\n\nnamespace Acme\\Legacy;\n\nclass UnusedReport {}\n",
  };

  for (const [relPath, content] of Object.entries(files)) {
    const path = join(dir, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  temporary.push(dir);
  capture(() => indexCommand(dir));
  return dir;
}

/**
 * A graph holding nothing but flows and their coverage, which is all `--blind` reads out of one.
 * Each entry is stated rather than computed, because the two answers this exists for are ones no
 * honest fixture holds: a repository that curates no flow, and flows no test reaches at all.
 */
function coverageGraph(
  entries: { flow: string; reaches: boolean; assertsValue: boolean }[],
): Graph {
  const node = "Acme\\Wide\\Node000";
  return {
    ...manyGodsGraph(1),
    flows: Object.fromEntries(entries.map((entry) => [entry.flow, [node]])),
    coverage: Object.fromEntries(
      entries.map((entry) => [
        entry.flow,
        {
          flow: entry.flow,
          testNodes: entry.reaches ? ["apps/api/tests/OrderTest.php"] : [],
          testFiles: entry.reaches ? ["apps/api/tests/OrderTest.php"] : [],
          reaches: entry.reaches,
          assertsValue: entry.assertsValue,
          blind: entry.reaches && !entry.assertsValue,
        },
      ]),
    ),
  };
}

/** A repository that holds nothing but a graph, which is all any query mode reads. */
function repoWithGraph(graph: Graph): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-orphans-"));
  const path = graphPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeGraph(graph));
  temporary.push(dir);
  return dir;
}

function git(dir: string, args: string[]): string {
  const result = run(dir, "git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * The same repository as a real checkout, with the graph repointed at its one commit, so the git
 * half of the staleness block reads "current with HEAD" rather than the unknown distance a plain
 * temp directory gives. That distinction is the whole of what the drift cases below are about: an
 * unknown distance already tells the reader not to trust the age, and a graph git is right to call
 * current does not. The `-c` flags are so this passes with no git identity and no signing key.
 */
function gitRepoWithGraph(graph: Graph): { dir: string; head: string } {
  const dir = repoWithGraph(graph);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A", "-f"]);
  git(dir, [
    "-c",
    "user.email=empo@example.com",
    "-c",
    "user.name=EmPo Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "the graph",
  ]);
  const head = git(dir, ["rev-parse", "HEAD"]).trim();

  writeFileSync(graphPath(dir), serializeGraph({ ...graph, builtAgainst: head }));
  return { dir, head };
}

/** Everything the command printed, joined, so a test can look for one line in it. */
function capture(run: () => void): string {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });

  try {
    run();
  } finally {
    log.mockRestore();
  }

  return lines.join("\n");
}

function expectEmpoError(exitCode: number, run: () => void): EmpoError {
  try {
    run();
    return expect.unreachable(`expected a EmpoError with exit code ${exitCode}`);
  } catch (error) {
    expect(error).toBeInstanceOf(EmpoError);
    expect((error as EmpoError).exitCode).toBe(exitCode);
    return error as EmpoError;
  }
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "empo-query-"));
  cpSync(fixture, repo, { recursive: true });
  // A local run may have left generated output in the fixture. Index the copy, do not inherit it.
  rmSync(join(repo, ".empo/generated"), { recursive: true, force: true });

  capture(() => indexCommand(repo));
  graph = readGraph(repo);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

describe("resolveNodes", () => {
  test("finds a node by its full id", () => {
    expect(resolveNodes(graph, CALCULATOR).map((node) => node.id)).toEqual([CALCULATOR]);
  });

  test("finds a node by its repo-relative file path", () => {
    expect(resolveNodes(graph, CALCULATOR_FILE).map((node) => node.id)).toEqual([CALCULATOR]);
  });

  test("finds a node by a path suffix, so a reader can paste the tail of a path", () => {
    expect(resolveNodes(graph, "Price/PriceCalculator.php").map((node) => node.id)).toEqual([
      CALCULATOR,
    ]);
    expect(resolveNodes(graph, "PriceCalculator.php").map((node) => node.id)).toEqual([CALCULATOR]);
  });

  test("finds a node by an unambiguous short name", () => {
    expect(resolveNodes(graph, "PriceCalculator").map((node) => node.id)).toEqual([CALCULATOR]);
  });

  test("refuses an ambiguous name with exit code 2 and names every candidate", () => {
    // Two files wearing one name, which is what ambiguous now means and all it means: several nodes
    // inside one file are the ordinary case under a `symbol` pack and are answered rather than
    // refused, and only a name that spans files leaves a reader with nothing to act on.
    const error = expectEmpoError(2, () => resolveNodes(ambiguousGraph(), "Invoice"));
    const details = error.details.join("\n");

    expect(details).toContain("Acme\\Billing\\Invoice");
    expect(details).toContain("Acme\\Legacy\\Invoice");
  });

  test("refuses a symbol that is not in the graph with exit code 2", () => {
    expectEmpoError(2, () => resolveNodes(graph, "Acme\\Nowhere\\NoSuchClass"));
  });

  test("answers for every symbol of a path", () => {
    const nodes = resolveNodes(symbolGraph(), "src/money.ts");

    expect(nodes.map((node) => node.id)).toEqual([
      "src/money.ts#formatMoney",
      "src/money.ts#parseMoney",
    ]);
  });

  test("answers for one symbol by its bare export name", () => {
    expect(resolveNodes(symbolGraph(), "formatMoney").map((node) => node.id)).toEqual([
      "src/money.ts#formatMoney",
    ]);
  });
});

describe("blastRadius", () => {
  test("counts a consumer of two symbols of one file once", () => {
    // One import statement per line binding two names off one module is the ordinary shape of a
    // TypeScript file, and it yields one edge per bound name. Asked about the module, the reader is
    // owed the number of files that would have to change, not the number of edges that exist.
    const answer = blastRadius(symbolGraph(), resolveNodes(symbolGraph(), "src/money.ts"));

    expect(answer.faninDirect).toBe(1);
    expect(answer.consumers.map((consumer) => consumer.id)).toEqual(["src/total.ts#total"]);
  });

  test("does not count a symbol of the queried file as its own consumer", () => {
    // Both symbols of src/money.ts are in the set, so the transitive count must be the one consumer
    // and not that consumer plus the sibling export the walk started from.
    const answer = blastRadius(symbolGraph(), resolveNodes(symbolGraph(), "src/money.ts"));

    expect(answer.faninTransitive).toBe(1);
  });

  test("reports the controllers that use the calculator, each with file and line evidence", () => {
    const answer = blastRadius(graph, resolveNodes(graph, CALCULATOR));
    const consumers = answer.consumers.map((consumer) => consumer.id);

    expect(consumers).toContain(ORDER_CONTROLLER);
    expect(consumers).toContain(CHECKOUT_CONTROLLER);
    expect(answer.faninDirect).toBe(answer.consumers.length);
    for (const consumer of answer.consumers) {
      expect(consumer.evidence, `evidence for ${consumer.id}`).toMatch(/^apps\/api\/\S+\.php:\d+$/);
    }
  });

  test("lists a file that imports and renders one component once, not twice", () => {
    // A React or Vue file does both, and the graph holds an `import` edge and a `template` edge for
    // the pair. Listed per edge, the same consumer printed twice with two citations and faninDirect
    // came out above faninTransitive, which counts nodes and can never be the smaller of the two.
    // Hand-made, because the acme fixture's one such pair would make this assert the fixture.
    const rendered = renderedComponentGraph();
    const answer = blastRadius(rendered, resolveNodes(rendered, "src/Card.tsx"));

    expect(answer.consumers.map((consumer) => consumer.id)).toEqual(["src/App.tsx"]);
    expect(answer.faninDirect).toBe(1);
    expect(answer.faninDirect).toBeLessThanOrEqual(answer.faninTransitive);
    // The surviving row cites the earliest place the consumer names it, which is the import here.
    expect(answer.consumers[0]?.evidence).toBe("src/App.tsx:1");
  });

  test("cites the earliest coordinate a consumer names it at, not the first kind alphabetically", () => {
    // The php shape rather than the React one, and it is why the rule is the coordinate and not the
    // graph's own order: `fqcn` sorts before `import`, so a file that writes `use App\Models\Order`
    // on line 4 and `\App\Models\Order::query()` on line 10 would be cited at line 10, and a reader
    // opening a consumer list wants the `use`. Both edges are still in the graph.
    const php = renderedComponentGraph();
    php.edges = [
      { ...php.edges[1], kind: "fqcn", evidence: { file: "src/App.tsx", line: 9 } } as GraphEdge,
      { ...php.edges[0] } as GraphEdge,
    ];
    const answer = blastRadius(php, resolveNodes(php, "src/Card.tsx"));

    expect(answer.consumers).toHaveLength(1);
    expect(answer.consumers[0]?.evidence).toBe("src/App.tsx:1");
  });

  test("reaches the orders and checkout flows, and marks only checkout blind", () => {
    const answer = blastRadius(graph, resolveNodes(graph, CALCULATOR));
    const flows = new Map(answer.flows.map((flow) => [flow.flow, flow]));

    expect(flows.get("checkout")?.blind).toBe(true);
    expect(flows.get("checkout")?.reaches).toBe(true);
    expect(flows.get("orders")?.blind).toBe(false);
    expect(flows.get("orders")?.reaches).toBe(true);
    expect(flows.get("orders")?.tests).toBeGreaterThan(0);
  });

  test("says how much of each flow it reaches, not merely that it reaches one", () => {
    // One node of four and four of four are both "reached", and a reader judging a blast radius
    // has to be able to tell them apart. The calculator touches part of orders and all of checkout.
    const answer = blastRadius(graph, resolveNodes(graph, CALCULATOR));
    const flows = new Map(answer.flows.map((flow) => [flow.flow, flow]));
    const orders = flows.get("orders");
    const checkout = flows.get("checkout");

    expect(orders?.flowNodes).toBe(graph.flows.orders?.length);
    expect(orders?.reachedNodes).toBeGreaterThan(0);
    expect(orders?.reachedNodes).toBeLessThan(orders?.flowNodes ?? 0);

    expect(checkout?.flowNodes).toBe(graph.flows.checkout?.length);
    expect(checkout?.reachedNodes).toBe(checkout?.flowNodes);
  });

  test("leaves out the admin flow, which no path from the calculator can reach", () => {
    // This is the point of the whole feature. admin is a real flow with a real controller in it,
    // and a change to the price calculator cannot break it. Listing it anyway would be the false
    // positive that teaches a reader to stop reading the list.
    const answer = blastRadius(graph, resolveNodes(graph, CALCULATOR));

    expect(answer.flows.map((flow) => flow.flow)).not.toContain("admin");
    expect(graph.flows.admin?.length).toBeGreaterThan(0);
  });

  test("answers a change to an Inertia page with the php controller that renders it", () => {
    // The headline cross-language answer, asked the way a developer asks it: rename this page or
    // move it, and what breaks? Nothing in either file names the other, so an import parser reading
    // either root on its own answers "nothing", and that answer is what the bridge exists to
    // correct. The flow the page reaches is on the far side of the bridge too, in the other root.
    const answer = blastRadius(graph, resolveNodes(graph, INERTIA_PAGE));

    expect(answer.consumers.map((consumer) => consumer.id)).toEqual([PAGE_CONTROLLER]);
    expect(answer.consumers[0]?.evidence).toMatch(
      /^apps\/api\/app\/Http\/Controllers\/OrderPageController\.php:\d+$/,
    );
    expect(answer.flows.map((flow) => flow.flow)).toEqual(["orders"]);
    expect(answer.bridges).toContainEqual({
      from: PAGE_CONTROLLER,
      to: INERTIA_PAGE,
      symbol: "inertia-page",
      evidence: answer.consumers[0]?.evidence,
    });
  });

  test("answers the same join from the consuming side by naming the file on the far end", () => {
    // The direction that used to return the question. The controller *is* the consuming side of the
    // inertia-page bridge, so a row built from `edge.from` named the controller to somebody who had
    // just asked about the controller, and `edge.to`, the only file in the answer that is not
    // already in the question, was never printed at all.
    const answer = blastRadius(graph, resolveNodes(graph, PAGE_CONTROLLER));
    const page = answer.bridges.filter((bridge) => bridge.symbol === "inertia-page");

    expect(page).toHaveLength(1);
    expect(page[0]?.to).toBe(INERTIA_PAGE);
    expect(page[0]?.from).toBe(PAGE_CONTROLLER);
  });

  test("names the route file when asked about the mobile client that calls it", () => {
    // The oldest case of the same defect, and the one that has answered
    // `http-route  apps/mobile/src/api/client.ts` since the bridge was written: a typescript file
    // listed against itself under a heading that says cross-language.
    const answer = blastRadius(graph, resolveNodes(graph, "apps/mobile/src/api/client.ts"));

    expect(answer.bridges).toContainEqual({
      from: "apps/mobile/src/api/client.ts",
      to: "apps/api/routes/api.php",
      symbol: "http-route",
      evidence: expect.stringMatching(/^apps\/mobile\/src\/api\/client\.ts:\d+$/),
    });
  });

  test("counts every bridge edge in the graph, whether or not one is in this radius", () => {
    // The denominator an empty `bridges` needs, so the printed form can tell "this repository
    // indexes no cross-language join" from "its joins are nowhere near this node".
    const admin = blastRadius(graph, resolveNodes(graph, ADMIN_CONTROLLER));

    expect(admin.bridges).toEqual([]);
    expect(admin.bridgeEdgesInGraph).toBe(2);
  });

  test("keeps the page's own coverage on its own side of the bridge", () => {
    // The orders flow is covered, and no test in apps/portal exists at all. The flow answer above
    // therefore has to come from the php tests that reach the flow's php nodes, never from the page
    // being treated as tested because something across the bridge is (docs/05-graph-model.md).
    const page = graph.nodes.find((node) => node.id === INERTIA_PAGE);
    const tests = graph.coverage.orders?.testNodes ?? [];

    expect(page?.isTest).toBe(false);
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.every((id) => !id.startsWith("apps/portal/"))).toBe(true);
  });

  test("counts transitive dependents and never counts the node itself", () => {
    // The tests and the route file reach the calculator only through the controllers, so the
    // transitive count has to be the larger one.
    const calculator = blastRadius(graph, resolveNodes(graph, CALCULATOR));
    expect(calculator.faninTransitive).toBeGreaterThan(calculator.faninDirect);

    // Nothing imports AdminController, so it depends on itself and on nothing else.
    const admin = blastRadius(graph, resolveNodes(graph, ADMIN_CONTROLLER));
    expect(admin.consumers).toEqual([]);
    expect(admin.faninTransitive).toBe(0);
  });
});

describe("queryCommand", () => {
  test("prints the blind marker and the floor-not-ceiling sentence on a blast radius", () => {
    const printed = capture(() => queryCommand(repo, CALCULATOR));

    expect(printed).toContain("BLIND");
    expect(printed).toContain(FLOOR_NOT_CEILING);
    expect(printed).toMatch(/via \S+ \(\d+ of \d+ nodes? reached\)/);
  });

  test("prints the floor-not-ceiling sentence on every answer, --gods included", () => {
    const printed = capture(() => queryCommand(repo, undefined, { gods: true }));

    expect(printed).toContain(CALCULATOR);
    expect(printed).toContain(FLOOR_NOT_CEILING);
  });

  test("--gods says how many nodes its top-20 left out, rather than dropping them silently", () => {
    // A graph with more than 20 nodes of non-zero fan-in. The cap is real, so the honest thing is
    // to name the count it hides, the same rule --orphans follows one mode over.
    const repoDir = repoWithGraph(manyGodsGraph(25));
    const printed = capture(() => queryCommand(repoDir, undefined, { gods: true }));

    expect(printed).toContain("and 5 more nodes with a non-zero fan-in, not shown.");
    // The JSON carries the total, since an agent reads it and never sees the printed line.
    const answer = JSON.parse(
      capture(() => queryCommand(repoDir, undefined, { gods: true, json: true })),
    );
    expect(answer.total).toBe(25);
    expect(answer.rows).toHaveLength(20);
  });

  test("--gods names each row's kind, because the widest fan-in is often a layout", () => {
    // The ranking is right and was unreadable. Once `view` made a template a sink, a Laravel
    // layout `@extends`-ed by every page in the application takes the top of this list on merit,
    // and the row printed a count, an id and a path — enough to tell a class from a template only
    // if the reader recognizes the naming convention. Nothing here holds a view back or reorders
    // one: it says what each row is and leaves the widest 20 the widest 20.
    const repoDir = repoWithGraph(renderedLayoutGraph());
    const printed = capture(() => queryCommand(repoDir, undefined, { gods: true }));

    expect(printed).toMatch(/resources\/views\/layouts\/app\.blade\.php\s+view/);
    // The id of a path-ided node IS its file, so the row names it once. A red here means the two
    // columns went back to printing the same string twice, which on this list is now the widest
    // thing on the line.
    expect(printed).not.toMatch(/layouts\/app\.blade\.php\s+view\s+resources/);
    // The order is untouched: the layout outranks the controller because it really does have the
    // wider fan-in, and a red here means somebody started filtering this list.
    const rows = JSON.parse(
      capture(() => queryCommand(repoDir, undefined, { gods: true, json: true })),
    ).rows;
    expect(rows[0]).toMatchObject({ id: "resources/views/layouts/app.blade.php", kind: "view" });
  });

  test("names the kind of every consumer, so a controller does not read like a sibling blade", () => {
    // The row a changed layout answers with. `consumers` is ranked by the consumer's own fan-in, so
    // the sibling template that is itself extended outranks the controller that renders the page,
    // and printed as bare ids the two are the same shape. A reviewer given five identical-looking
    // rows cannot tell that the controller is the sixth; given `view template` five times, they can.
    const repoDir = repoWithGraph(renderedLayoutGraph());
    const printed = capture(() =>
      queryCommand(repoDir, "resources/views/layouts/app.blade.php", {}),
    );

    expect(printed).toMatch(/resources\/views\/orders\/index\.blade\.php\s+view template\s/);
    expect(printed).toMatch(/Acme\\Http\\Controllers\\OrderController\s+class template\s/);

    const answer = JSON.parse(
      capture(() => queryCommand(repoDir, "resources/views/layouts/app.blade.php", { json: true })),
    );
    // The edge family and not the directive: a graph records which rule family matched, never
    // whether the php said `@extends` or `view(`, and a column claiming the second would invent it.
    expect(answer.consumers).toContainEqual(
      expect.objectContaining({ id: ORDER_CONTROLLER, kind: "class", edge: "template" }),
    );
  });

  test("--gods adds no not-shown line when nothing was left out", () => {
    const repoDir = repoWithGraph(manyGodsGraph(12));
    const printed = capture(() => queryCommand(repoDir, undefined, { gods: true }));

    expect(printed).not.toContain("not shown");
  });

  test("carries the caveat in the JSON of a symbol query", () => {
    // The machine half of the same rule, and the half that matters more: an agent reads the JSON
    // and never sees the printed sentence.
    const answer = JSON.parse(capture(() => queryCommand(repo, CALCULATOR, { json: true })));

    expect(answer.nodes.map((node: { id: string }) => node.id)).toEqual([CALCULATOR]);
    expect(answer.caveat).toBe(FLOOR_NOT_CEILING);
  });

  test("carries the caveat in the JSON of a mode answer too", () => {
    const answer = JSON.parse(
      capture(() => queryCommand(repo, undefined, { json: true, blind: true })),
    );

    expect(answer.mode).toBe("blind");
    expect(answer.rows.map((row: { flow: string }) => row.flow)).toEqual(["checkout"]);
    expect(answer.caveat).toBe(FLOOR_NOT_CEILING);
  });

  test("states what the name-resolving rules yielded beside the answer they helped build", () => {
    // The surface the count was missing from. `empo index` and `empo doctor` have printed it since
    // it was counted, and neither is what a reader is looking at when they decide what a change can
    // reach. Measured on a real React Native application: `template` resolved 3 of 1531 tag
    // references and `empo query` said nothing, so a blast radius holding almost none of that
    // repository's component edges read exactly like a complete one.
    const graph = renderedComponentGraph();
    const printed = capture(() =>
      queryCommand(
        repoWithGraph({
          ...graph,
          names: [
            {
              family: "template",
              resolved: 3,
              unknown: 1528,
              ambiguous: 0,
              wrongKind: 0,
              local: 0,
              vendor: 0,
              ambiguousNames: [],
            },
          ],
        }),
        "src/Card.tsx",
      ),
    );

    expect(printed).toContain("names      template 3 of 1531 resolved, 1528 in no node");
  });

  test("says nothing about names where no rule read one, rather than a line about zero", () => {
    // The two silences `nameLines` keeps apart are answers about the graph, not about the node being
    // queried, and both already print under `empo index` and `empo doctor`. An answer over a graph
    // whose rules read no name at all that ended with a sentence about name-resolving rules would be
    // one more line to skim past on every query, which is how the line that matters stops being read.
    const printed = capture(() =>
      queryCommand(repoWithGraph(ambiguousGraph()), "Acme\\Billing\\Invoice"),
    );

    expect(printed).not.toContain("names      ");
  });

  test("refuses a query with no symbol and no mode flag, with exit code 2", () => {
    const error = expectEmpoError(2, () => capture(() => queryCommand(repo, undefined)));

    // The refusal names every mode there is. A mode the error forgets is a mode nobody finds.
    expect(error.details.join("\n")).toContain("--gods, --blind, --orphans, --hazards");
  });
});

/**
 * The age `empo query` states under every answer. EmPo never silently serves a stale answer
 * (docs/02-on-disk-layout.md): it serves the answer and states its age, and for a while that meant
 * only the git distance. A pack is data and a schema is a meaning, so both move without a tracked
 * file moving, and this command answered "current with HEAD" over a graph engine/health.ts already
 * called stale, to the one reader deciding whether to trust the numbers above the line.
 *
 * Every case here builds a real checkout with the graph at HEAD, because the git line being right is
 * what makes the point: under "distance from HEAD unknown" the reader was already warned.
 */
describe("queryCommand staleness", () => {
  test(
    "a moved pack is stated under a git line that is right to say current with HEAD",
    () => {
      const { dir, head } = gitRepoWithGraph({
        ...manyGodsGraph(1),
        packs: { php: PHP_BEFORE },
      });

      const printed = capture(() => queryCommand(dir, undefined, { gods: true })).split("\n");
      const graphLine = printed.findIndex((line) => line.startsWith("graph      "));

      expect(PHP_BEFORE).not.toBe(PHP_INSTALLED);
      // As a pair and in order, so neither the pairing nor either sentence can move unnoticed. It is
      // the same renderer `empo doctor` prints, so the two surfaces cannot word one state two ways.
      expect(printed.slice(graphLine, graphLine + 2)).toEqual([
        `graph      built against ${head.slice(0, 7)}, current with HEAD`,
        `drift      graph built with php pack ${PHP_BEFORE}, ${PHP_INSTALLED} is installed (run empo index)`,
      ]);
    },
    GIT_TIMEOUT,
  );

  test(
    "a graph an older empo wrote is stated too, which no pack version could have recorded",
    () => {
      // The case a TypeScript-only repository could not otherwise reach at all: one pack, so no
      // second version to bump, and `readGraph` casts the parsed JSON without checking a key. Before
      // the schema was written down, `empo query --blind` served the old flow membership forever.
      const { dir, head } = gitRepoWithGraph({ ...manyGodsGraph(1), schema: 1 });

      const printed = capture(() => queryCommand(dir, undefined, { gods: true })).split("\n");
      const graphLine = printed.findIndex((line) => line.startsWith("graph      "));

      expect(printed.slice(graphLine, graphLine + 2)).toEqual([
        `graph      built against ${head.slice(0, 7)}, current with HEAD`,
        `drift      graph was written at schema 1, this empo writes schema ${GRAPH_SCHEMA} (run empo index)`,
      ]);
    },
    GIT_TIMEOUT,
  );

  test(
    "a graph with nothing drifted gets the git line and no drift block at all",
    () => {
      // The half that keeps this from crying wolf. A block that appears under every answer is a
      // block a reader learns to skip, and then skips on the day it says something.
      const { dir, head } = gitRepoWithGraph(manyGodsGraph(1));

      const printed = capture(() => queryCommand(dir, undefined, { gods: true })).split("\n");

      expect(printed).toContain(`graph      built against ${head.slice(0, 7)}, current with HEAD`);
      expect(printed.some((line) => line.startsWith("drift      "))).toBe(false);
    },
    GIT_TIMEOUT,
  );
});

/**
 * The printed cross-language block. Read as raw lines and never through a helper that trims or
 * collapses them: the indent under the symbol column is the whole of what pairs a row's two halves,
 * and the last three defects in printed output here were invisible to every assertion in the suite
 * because the helper reading it stopped at a blank line and squashed runs of whitespace.
 */
describe("queryCommand cross-language reach", () => {
  function block(printed: string): string[] {
    const lines = printed.split("\n");
    const start = lines.indexOf("cross-language reach");
    expect(start).toBeGreaterThan(-1);
    const end = lines.indexOf("", start + 1);
    return lines.slice(start + 1, end === -1 ? undefined : end);
  }

  test("prints the far end of a join on its own line under the near one", () => {
    // The whole block, as an exact list of raw lines, and deliberately not one row of it. Asserting
    // only the `inertia-page` row proves less than it looks: that symbol is the widest in this
    // answer, so `padEnd` is a no-op on exactly the row being read and the column alignment the
    // printer's comment calls load-bearing goes untested. `http-route` is the row that pays for the
    // padding, and the second continuation line is the one that pays for the indent being computed
    // from the column width rather than from each symbol's own length.
    const lines = block(capture(() => queryCommand(repo, PAGE_CONTROLLER)));
    const rows = blastRadius(graph, resolveNodes(graph, PAGE_CONTROLLER)).bridges;
    const evidence = (symbol: string): string =>
      rows.find((bridge) => bridge.symbol === symbol)?.evidence ?? "";

    expect(lines).toEqual([
      `  inertia-page  ${PAGE_CONTROLLER}`,
      // The claim and its citation, separated by a word. Both halves of this line are paths, so
      // without one it reads as a list of two files and neither is labelled.
      `                consumes ${INERTIA_PAGE}  named at ${evidence("inertia-page")}`,
      "  http-route    apps/mobile/src/api/client.ts",
      `                consumes apps/api/routes/api.php  named at ${evidence("http-route")}`,
    ]);
  });

  test("carries the bridge count on an answer that has bridges too, not only on an empty one", () => {
    // The field's own docstring says "always present, even when `bridges` is not empty", and a
    // number nothing reads on the populated path can be zeroed there without a test noticing.
    const answer = JSON.parse(capture(() => queryCommand(repo, PAGE_CONTROLLER, { json: true })));

    expect(answer.bridges.length).toBeGreaterThan(0);
    expect(answer.bridgeEdgesInGraph).toBe(2);
  });

  test("says which of the two silences an empty block is in", () => {
    // A repository with bridges configured and none of them near this node used to be told "the
    // graph holds no bridge edges yet", which reads as "cross-language reach is not set up here"
    // and sends a reader to fix a config that is already right.
    const near = block(capture(() => queryCommand(repo, ADMIN_CONTROLLER)));

    expect(near).toEqual([
      "  none: of the 2 bridge edges in the graph, none is in this blast radius",
    ]);

    const none = block(
      capture(() => queryCommand(repoWithGraph(manyGodsGraph(1)), "Acme\\Wide\\Node000")),
    );

    expect(none).toEqual([
      "  none: the graph holds no bridge edges at all, so nothing here crosses a language",
    ]);
  });

  test("writes the one-edge sentence as a noun rather than as a count", () => {
    // `plural()` gets this branch grammatically wrong ("of the 1 bridge edge in the graph, none
    // is..."), and this block is read by an agent that quotes what it is given.
    const single = manyGodsGraph(3);
    const [first, second] = single.nodes;
    if (first === undefined || second === undefined) throw new Error("expected two nodes");
    single.edges = [
      {
        from: first.id,
        to: second.id,
        kind: "bridge",
        symbol: "http-route",
        evidence: { file: first.file, line: 1 },
      },
    ];

    // A third node, which the one bridge edge touches at neither end: querying either end keeps the
    // edge, since the radius is closed under consumers and `from` is one of them.
    const lines = block(capture(() => queryCommand(repoWithGraph(single), "Acme\\Wide\\Node002")));

    expect(lines).toEqual(["  none: the one bridge edge in the graph is not in this blast radius"]);
  });

  test("caps the list and says how many it held back", () => {
    // The one list in a blast radius that had no cap, in the shape that made it one: every bridge
    // edge whose `from` is in the radius, and a radius on a real monorepo closes over thousands of
    // nodes. Two printed lines per row, so an uncapped block is a wall and the count under it is
    // what keeps the wall from reading as the whole answer.
    const wide = manyGodsGraph(15);
    const [target] = wide.nodes;
    if (target === undefined) throw new Error("expected a node");
    wide.edges = wide.nodes.slice(1).map((node) => ({
      from: node.id,
      to: target.id,
      kind: "bridge" as const,
      symbol: "http-route",
      evidence: { file: node.file, line: 1 },
    }));

    const lines = block(capture(() => queryCommand(repoWithGraph(wide), target.id)));

    // Ten rows of two lines, then the exclusion. The far ends stay unnamed past the cap, which is
    // the trade the count is there to declare.
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toBe("  ... and 4 more");

    // The JSON keeps all fourteen: the cap is a property of what is printed, the same as the
    // consumer list's, and an agent reading `--json` gets the whole set.
    const answer = JSON.parse(
      capture(() => queryCommand(repoWithGraph(wide), target.id, { json: true })),
    );
    expect(answer.bridges).toHaveLength(14);
  });
});

/**
 * `--blind` answers `[]` for three different reasons and used to print one of them. The list is a
 * numerator; without its denominator "none" is unreadable, and the reading everybody takes is the
 * good one. The honest answer measured 9 of 9 flows asserting, and the
 * identical `[]` had been printed before two pack fixes for entirely false reasons.
 */
describe("queryCommand --blind", () => {
  test("carries the denominator in the JSON, with no reason when the list reads as it stands", () => {
    const answer = JSON.parse(
      capture(() => queryCommand(repo, undefined, { blind: true, json: true })),
    );

    expect(answer.rows.map((row: { flow: string }) => row.flow)).toEqual(["checkout"]);
    // The acme fixture holds one covered flow, one blind and one no test reaches, on purpose.
    expect(answer.flowsConsidered).toEqual({
      total: 3,
      reached: 2,
      asserting: 1,
      reason: null,
    });
    // A flow is blind exactly when a test reaches it and none asserts, so the three counts and the
    // list are one arithmetic statement. A row count that stops satisfying this is a defect in one
    // of them and the answer no longer describes a single graph.
    expect(answer.rows).toHaveLength(
      answer.flowsConsidered.reached - answer.flowsConsidered.asserting,
    );
  });

  test("prints the denominator beside the list, not only when the list is empty", () => {
    const printed = capture(() => queryCommand(repo, undefined, { blind: true }));

    expect(printed).toContain("checkout");
    expect(printed).toContain(
      "of 3 flows, 2 are reached by a test and 1 has one that asserts a value",
    );
  });

  test("says no flow is curated rather than letting an empty list read as good news", () => {
    const dir = repoWithGraph(coverageGraph([]));

    const printed = capture(() => queryCommand(dir, undefined, { blind: true }));
    const answer = JSON.parse(
      capture(() => queryCommand(dir, undefined, { blind: true, json: true })),
    );

    expect(answer.rows).toEqual([]);
    expect(answer.flowsConsidered).toEqual({
      total: 0,
      reached: 0,
      asserting: 0,
      reason: NO_FLOW_CURATED,
    });
    expect(printed).toContain(NO_FLOW_CURATED);
    // And no count sentence beside it: "of 0 flows, 0 are reached" states nothing twice.
    expect(printed).not.toContain("of 0 flows");
    // This mode reads a graph and never the config, so the sentence is about the graph and carries
    // the remedy, exactly as HAZARDS_NOT_RECORDED does. A repository that curated its flows after
    // its last index gets this answer with the flows file sitting there contradicting it.
    expect(NO_FLOW_CURATED).toContain("run empo index");
  });

  test("says no flow is reached rather than none is blind, which is the worse empty answer", () => {
    const dir = repoWithGraph(
      coverageGraph([
        { flow: "checkout", reaches: false, assertsValue: false },
        { flow: "orders", reaches: false, assertsValue: false },
      ]),
    );

    const printed = capture(() => queryCommand(dir, undefined, { blind: true }));
    const answer = JSON.parse(
      capture(() => queryCommand(dir, undefined, { blind: true, json: true })),
    );

    expect(answer.rows).toEqual([]);
    expect(answer.flowsConsidered.reason).toBe(NO_FLOW_REACHED);
    // The count is printed too, under it, because "no test reaches any flow" is the sort of claim a
    // reader wants the size of.
    expect(printed).toContain(
      "of 2 flows, 0 are reached by a test and 0 have one that asserts a value",
    );
    expect(printed).toContain(NO_FLOW_REACHED);
  });
});

/**
 * The point of the whole mode: a zero fan-in is evidence of dead code only for a kind something in
 * the repository would have had to reference. A view, a migration and a policy are reached by the
 * framework, by name, so they can sit at zero while being used every day, and listing them taught
 * an agent to propose deleting working code. The `view` strategy narrowed that set without closing
 * it: a blade file named by `view('orders.show')` now has a fan-in and leaves this list through the
 * fan-in test, while the one rendered by `view($name)` beside it is as invisible as ever. What is left out is counted and named, because an omitted list that says
 * nothing about its omission reads as the whole list.
 */
describe("queryCommand --orphans", () => {
  test("leaves out a framework-resolved node and keeps a genuinely unreferenced class", () => {
    const answer = JSON.parse(
      capture(() =>
        queryCommand(repoWithGraph(frameworkGraph()), undefined, { orphans: true, json: true }),
      ),
    );
    const ids = answer.rows.map((row: { id: string }) => row.id);

    expect(ids).toEqual([DEAD_CLASS]);
    expect(ids).not.toContain(VIEW_FILE);
    expect(ids).not.toContain(MIGRATION_FILE);
    expect(ids).not.toContain(POLICY);
  });

  test("names how many it excluded and under which kinds, in the human output", () => {
    const printed = capture(() =>
      queryCommand(repoWithGraph(frameworkGraph()), undefined, { orphans: true }),
    );

    expect(printed).toContain(DEAD_CLASS);
    expect(printed).toContain("3 nodes with no fan-in are not listed");
    expect(printed).toContain("1 view");
    expect(printed).toContain("1 migration");
    expect(printed).toContain("1 policy");
    expect(printed).toContain(FRAMEWORK_RESOLVED_REASON);
    expect(printed).toContain(LIST_FRAMEWORK_RESOLVED);
  });

  test("carries the same exclusion in the JSON, which is the form an agent reads", () => {
    const answer = JSON.parse(
      capture(() =>
        queryCommand(repoWithGraph(frameworkGraph()), undefined, { orphans: true, json: true }),
      ),
    );

    expect(answer.frameworkResolved.listed).toBe(false);
    expect(answer.frameworkResolved.total).toBe(3);
    expect(answer.frameworkResolved.byKind).toEqual([
      { kind: "migration", count: 1 },
      { kind: "policy", count: 1 },
      { kind: "view", count: 1 },
    ]);
    expect(answer.frameworkResolved.reason).toBe(FRAMEWORK_RESOLVED_REASON);
    expect(answer.frameworkResolved.listWith).toBe(LIST_FRAMEWORK_RESOLVED);
    expect(answer.caveat).toBe(FLOOR_NOT_CEILING);
  });

  test("--all lists the excluded nodes, each marked with what resolves it", () => {
    const repoRoot = repoWithGraph(frameworkGraph());

    const printed = capture(() => queryCommand(repoRoot, undefined, { orphans: true, all: true }));
    const answer = JSON.parse(
      capture(() => queryCommand(repoRoot, undefined, { orphans: true, all: true, json: true })),
    );

    expect(printed).toContain(VIEW_FILE);
    expect(printed).toContain("[view, resolved by the framework]");
    expect(printed).toContain("listed because --all asked");

    expect(answer.rows).toHaveLength(4);
    expect(answer.frameworkResolved.listed).toBe(true);
    expect(answer.frameworkResolved.total).toBe(3);
    const byId = new Map(
      answer.rows.map((row: { id: string; resolvedBy: string | null }) => [row.id, row.resolvedBy]),
    );
    expect(byId.get(VIEW_FILE)).toBe("framework");
    expect(byId.get(DEAD_CLASS)).toBe(null);
  });

  test("says nothing about exclusions when the packs mark no kind that has zero fan-in", () => {
    // Every orphan in the acme fixture is an ordinary class, so the notice must not appear at all.
    // A line saying "0 nodes are not listed" is noise, and noise is what teaches a reader to skip.
    const printed = capture(() => queryCommand(repo, undefined, { orphans: true }));
    const answer = JSON.parse(
      capture(() => queryCommand(repo, undefined, { orphans: true, json: true })),
    );

    expect(answer.frameworkResolved.total).toBe(0);
    expect(answer.frameworkResolved.byKind).toEqual([]);
    expect(printed).not.toContain("not listed");
  });

  test("holds over a graph empo index really built from conventional Laravel paths", () => {
    // The hand-written graph proves the rule. This proves the php pack's globs match the paths a
    // Laravel repository really has, which is the half a hand-made `kind` cannot check: a glob with
    // a typo in it puts all 142 views straight back on the dead-code list.
    const laravel = indexedLaravelRepo();

    const answer = JSON.parse(
      capture(() => queryCommand(laravel, undefined, { orphans: true, all: true, json: true })),
    );
    const kinds = new Map(
      answer.rows.map((row: { file: string; resolvedBy: string | null }) => [
        row.file.split("/").slice(2).join("/"),
        row.resolvedBy,
      ]),
    );

    expect(kinds.get("resources/views/orders/index.blade.php")).toBe("framework");
    expect(kinds.get("database/migrations/2024_01_01_000000_create_orders_table.php")).toBe(
      "framework",
    );
    expect(kinds.get("database/factories/OrderFactory.php")).toBe("framework");
    expect(kinds.get("config/services.php")).toBe("framework");
    expect(kinds.get("bootstrap/app.php")).toBe("framework");
    expect(kinds.get("app/Policies/OrderPolicy.php")).toBe("framework");
    expect(kinds.get("app/Console/Commands/PruneOrders.php")).toBe("framework");

    // And the one file in that tree nobody reaches by any convention at all is still reported.
    expect(kinds.get("app/Legacy/UnusedReport.php")).toBe(null);
  });

  test("refuses --all outside --orphans with exit code 2, rather than ignoring it", () => {
    const error = expectEmpoError(2, () =>
      capture(() => queryCommand(repo, undefined, { gods: true, all: true })),
    );

    expect(error.details.join("\n")).toContain(LIST_FRAMEWORK_RESOLVED);
  });
});

/**
 * The whole of this mode is one distinction: a language whose pack had no hazard rules scanned
 * nothing, and an empty list over its files is not a finding. `graph.hazards` cannot carry that
 * difference, so the answer states which languages scanned and which did not, in the text and in the
 * JSON both. Every case here writes `hazardsScanned` by hand rather than asking a shipped pack, so
 * none of them changes its meaning on the day a pack gains or loses a hazards block.
 */
describe("queryCommand --hazards", () => {
  test("prints the dispatch, the job and the transaction it sits inside, with a citation", () => {
    const printed = capture(() =>
      queryCommand(repoWithGraph(hazardGraph(hazardRows())), undefined, { hazards: true }),
    );

    expect(printed).toContain(`${DISPATCH_FILE}:42`);
    expect(printed).toContain(`${DISPATCH_FILE}:47`);
    expect(printed).toContain("opened at line 30");
    expect(printed).toContain(`dispatches ${RESOLVED_JOB}`);
    // The unresolvable dispatch says so rather than being dropped or printed as a bare blank.
    expect(printed).toContain("no node in the graph carries that name");
    expect(printed).toContain(FLOOR_NOT_CEILING);
  });

  test("carries every field of every hazard in the JSON, which is the form an agent reads", () => {
    const answer = JSON.parse(
      capture(() =>
        queryCommand(repoWithGraph(hazardGraph(hazardRows())), undefined, {
          hazards: true,
          json: true,
        }),
      ),
    );

    expect(answer.mode).toBe("hazards");
    expect(answer.rows).toEqual(hazardRows());
    expect(answer.declared).toEqual({ looking: ["php"], silent: [], reason: null });
    expect(answer.caveat).toBe(FLOOR_NOT_CEILING);
  });

  test("an empty list from a language that scanned is not the answer nothing scanned gives", () => {
    // The point of the mode, in one pair. Identical rows, and they must not be the same answer: the
    // rows are exactly what cannot tell the two apart.
    const looked = repoWithGraph(hazardGraph([], ["php"]));
    const nobody = repoWithGraph(hazardGraph([], []));

    const lookedText = capture(() => queryCommand(looked, undefined, { hazards: true }));
    const nobodyText = capture(() => queryCommand(nobody, undefined, { hazards: true }));

    expect(lookedText).toContain("none: the php pack scanned for them and found none");
    expect(lookedText).not.toContain(NO_HAZARD_CLAIM);

    expect(nobodyText).toContain("none: nothing scanned for one when this graph was built");
    expect(nobodyText).toContain("1 root language scanned for no hazard at all: php.");
    expect(nobodyText).toContain(NO_HAZARD_CLAIM);
    expect(nobodyText).not.toContain("found none");
  });

  test("the JSON tells the same two apart, which is the form that gets acted on", () => {
    const json = (dir: string) =>
      JSON.parse(capture(() => queryCommand(dir, undefined, { hazards: true, json: true })));

    const looked = json(repoWithGraph(hazardGraph([], ["php"])));
    const nobody = json(repoWithGraph(hazardGraph([], [])));

    expect(looked.rows).toEqual([]);
    expect(nobody.rows).toEqual([]);
    expect(looked.declared).toEqual({ looking: ["php"], silent: [], reason: null });
    expect(nobody.declared).toEqual({ looking: [], silent: ["php"], reason: NO_HAZARD_CLAIM });
  });

  test("names the language that scanned nothing even when it did find hazards", () => {
    // The partial answer, and the one most likely to be read as whole: php scanned, typescript did
    // not, and every file under the typescript root is missing from the list without a word.
    const dir = repoWithGraph(hazardGraph(hazardRows(), ["php"], ["php", "typescript"]));

    const printed = capture(() => queryCommand(dir, undefined, { hazards: true }));
    const answer = JSON.parse(
      capture(() => queryCommand(dir, undefined, { hazards: true, json: true })),
    );

    expect(printed).toContain("1 root language scanned for no hazard at all: typescript.");
    expect(printed).toContain(NO_HAZARD_CLAIM);
    expect(answer.declared).toEqual({
      looking: ["php"],
      silent: ["typescript"],
      reason: NO_HAZARD_CLAIM,
    });
  });

  test("believes the build's record, not the pack installed now", () => {
    // The trap this closes. The graph says nothing scanned, whatever the php pack declares today: a
    // pack that gained its rules after this graph was built collected nothing, and pairing "php
    // scans for hazards" with an empty list would state a clean result no run ever produced.
    const answer = JSON.parse(
      capture(() =>
        queryCommand(repoWithGraph(hazardGraph([], [])), undefined, { hazards: true, json: true }),
      ),
    );

    expect(answer.declared.looking).toEqual([]);
    expect(answer.declared.silent).toEqual(["php"]);
  });

  test("a graph built before hazards existed answers unknown, never none", () => {
    // The failure the null is for: a missing key defaulted to an empty list is a clean bill of
    // health invented out of a field no empo ever wrote (engine/graph.ts, GRAPH_SCHEMA 3).
    const dir = repoWithGraph(graphBeforeHazards());

    const printed = capture(() => queryCommand(dir, undefined, { hazards: true }));
    const answer = JSON.parse(
      capture(() => queryCommand(dir, undefined, { hazards: true, json: true })),
    );

    expect(printed).toContain(`  ${HAZARDS_NOT_RECORDED}`);
    expect(printed).not.toContain("none:");
    expect(answer.rows).toBe(null);
    expect(answer.declared).toEqual({ looking: [], silent: [], reason: HAZARDS_NOT_RECORDED });
    // And no language is named as having scanned nothing. The graph records who scanned nowhere, so
    // calling php silent here would be an answer inventing a fact about a build it never saw.
    expect(printed).not.toContain("scanned for no hazard at all");
    // The drift line above it says why, rather than leaving the reader to guess at the age.
    expect(printed).toContain(`graph was written at schema ${GRAPH_SCHEMA - 1}`);
  });

  test("answers over the graph empo index really built for the fixture", () => {
    const answer = JSON.parse(
      capture(() => queryCommand(repo, undefined, { hazards: true, json: true })),
    );
    const langs = [...new Set(graph.roots.map((root) => root.lang))].sort();

    // The two lists partition the languages in play: every root is accounted for, in one list or the
    // other, whatever the packs declare on the day this runs.
    expect([...answer.declared.looking, ...answer.declared.silent].sort()).toEqual(langs);
    // And the rows are the graph's, unfiltered. Nothing in this command computes a hazard, or could.
    expect(answer.rows).toEqual(graph.hazards ?? null);
  });
});
