import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { buildRoot } from "../../src/engine/build";
import { loadConfig } from "../../src/engine/config";
import { buildGraph, GRAPH_SCHEMA, serializeGraph } from "../../src/engine/graph";
import type { Pack } from "../../src/schema/pack.schema";
import type { GraphEdge, Hazard } from "../../src/schema/types";

/**
 * The guardrail docs/14-implementation-notes.md asks for: build the acme fixture twice and assert
 * the bytes are identical. The fixture is the input because it is the only corpus that exercises
 * every sort at once, with classes, a route file, tests and three flows in one graph.
 *
 * The rules below are re-derived here rather than imported from engine/order.ts. A test that reuses
 * the comparator it is checking would keep passing if that comparator started ordering by locale.
 */

const repoRoot = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

/** Code-unit comparison, the only ordering a graph is allowed to depend on. */
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The documented edge order: (from, to, kind, evidence.line). */
function byDocumentedEdgeOrder(a: GraphEdge, b: GraphEdge): number {
  return (
    byCodeUnits(a.from, b.from) ||
    byCodeUnits(a.to, b.to) ||
    byCodeUnits(a.kind, b.kind) ||
    a.evidence.line - b.evidence.line
  );
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from} ${edge.to} ${edge.kind} ${edge.evidence.line}`;
}

/** The documented hazard order: (file, line, job, target), an unresolved target comparing empty. */
function byDocumentedHazardOrder(a: Hazard, b: Hazard): number {
  return (
    byCodeUnits(a.file, b.file) ||
    a.line - b.line ||
    byCodeUnits(a.job, b.job) ||
    byCodeUnits(a.target ?? "", b.target ?? "")
  );
}

function hazardKey(hazard: Hazard): string {
  return `${hazard.file} ${hazard.line} ${hazard.job} ${hazard.target ?? ""}`;
}

const temps: string[] = [];

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A corpus for the third axis, built here instead of taken from acme, which holds no transaction at
 * all: the order of a list of none proves nothing. The pack is hand-built the way every engine test
 * uses a tiny inline input, and its rules are markers with no language in them, which is what the
 * engine is allowed to know about hazards.
 */
const hazardPack: Pack = {
  name: "hazard-corpus",
  version: "0.0.0",
  match: { extensions: [".txt"] },
  node: { id: { strategy: "module-path" }, kindRules: [] },
  edges: {},
  joins: [],
  produces: [],
  consumes: [],
  tests: { paths: [], assertionTerms: [], assertionExcludes: [] },
  hazards: {
    transactions: [{ pattern: "^begin$", extent: "span", endPattern: "^commit$" }],
    loops: [],
    dispatches: [{ pattern: "send\\(([A-Za-z]+)\\)", job: 1 }],
    deferAtSite: [],
    deferAtDeclaration: [],
  },
};

/**
 * Written in an order no sort would produce by accident: the file that has to come last is written
 * first, one line carries two jobs so the job tiebreak has something to break, and one file
 * dispatches a job that sorts before the one on the line above it.
 */
function hazardCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-hazard-order-"));
  temps.push(dir);
  writeFileSync(join(dir, "zeta.txt"), "begin\nsend(worker) send(alpha)\nsend(charlie)\ncommit\n");
  writeFileSync(join(dir, "alpha.txt"), "begin\nsend(worker)\ncommit\n");
  writeFileSync(join(dir, "middle.txt"), "begin\nsend(zulu)\nsend(alpha)\ncommit\n");
  writeFileSync(join(dir, "worker.txt"), "a dispatched job, and no transaction of its own\n");
  return dir;
}

describe("graph determinism", () => {
  const { config } = loadConfig(repoRoot);
  const first = buildGraph({ repoRoot, config }).graph;
  const second = buildGraph({ repoRoot, config }).graph;

  test("serializes two builds of the same source to identical bytes", () => {
    expect(serializeGraph(second)).toBe(serializeGraph(first));
  });

  test("sorts nodes ascending by id", () => {
    const ids = first.nodes.map((node) => node.id);

    expect(ids.length).toBeGreaterThan(1);
    expect(ids).toEqual([...ids].sort(byCodeUnits));
  });

  test("sorts edges by from, then to, then kind, then the line the evidence sits on", () => {
    const keys = first.edges.map(edgeKey);

    expect(keys.length).toBeGreaterThan(1);
    expect(keys).toEqual([...first.edges].sort(byDocumentedEdgeOrder).map(edgeKey));
  });

  test("orders the keys of every derived map ascending", () => {
    const maps: [string, Record<string, unknown>][] = [
      ["flows", first.flows],
      ["packs", first.packs],
      ["fanin", first.fanin],
      ["coverage", first.coverage],
    ];

    for (const [name, map] of maps) {
      const keys = Object.keys(map);
      expect(keys.length, `${name} is empty, so its order proves nothing`).toBeGreaterThan(0);
      expect(keys, `${name} keys`).toEqual([...keys].sort(byCodeUnits));
    }
  });

  test("writes two-space indent and exactly one trailing newline", () => {
    const serialized = serializeGraph(first);
    const lines = serialized.split("\n");
    const nested = lines.find((line) => line.trimStart().startsWith('"files":'));

    // Read off the constant rather than typed out, because what this line is here to pin is the
    // two-space indent, and a literal version would send it red on every schema bump for a reason
    // that has nothing to do with indentation. The version itself is pinned in commands/index.
    expect(lines[1]).toBe(`  "schema": ${GRAPH_SCHEMA},`);
    expect(nested?.startsWith('    "files":')).toBe(true);
    expect(serialized.endsWith("}\n")).toBe(true);
    expect(serialized.endsWith("\n\n")).toBe(false);
  });

  test("sorts hazards by file, then line, then job, then the job it resolved to", () => {
    const built = buildRoot({
      repoRoot: hazardCorpus(),
      root: { path: ".", lang: hazardPack.name },
      pack: hazardPack,
    });
    const keys = built.hazards.map(hazardKey);

    expect(keys.length).toBeGreaterThan(1);
    expect(keys).toEqual([...built.hazards].sort(byDocumentedHazardOrder).map(hazardKey));

    // Spelled out as well as re-sorted, because a comparator that ordered everything by one field
    // would agree with its own sort and disagree with this. An unresolved job ends the key at the
    // space before its empty target, which is the null in `Hazard.target` and not an id.
    expect(keys).toEqual([
      "alpha.txt 2 worker worker.txt",
      "middle.txt 2 zulu ",
      "middle.txt 3 alpha alpha.txt",
      "zeta.txt 2 alpha alpha.txt",
      "zeta.txt 2 worker worker.txt",
      "zeta.txt 3 charlie ",
    ]);
  });

  test("reports stats that match the arrays it ships", () => {
    expect(first.stats.nodes).toBe(first.nodes.length);
    expect(first.stats.edges).toBe(first.edges.length);
  });
});
