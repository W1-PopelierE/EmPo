import type { CoverageInfo, GraphEdge, GraphNode } from "../schema/types";
import { compareStrings } from "./order";

/**
 * The "would a test notice" half of the graph (docs/05-graph-model.md). A test reaches a flow when
 * some edge path runs from the test node into a node the flow owns, and a flow is blind when it is
 * reached but no reaching test asserts on a value. Blind is the single most important field EmPo
 * computes: the flow is exercised, so it looks safe, and nothing checks the number.
 */

export function computeCoverage(
  nodes: GraphNode[],
  edges: GraphEdge[],
  flows: Record<string, string[]>,
): Record<string, CoverageInfo> {
  const rootOf = new Map(nodes.map((node) => [node.id, node.root]));

  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!carriesCoverage(edge, rootOf)) continue;
    const bucket = outgoing.get(edge.from);
    if (bucket) bucket.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }

  const tests = nodes
    .filter((node) => node.isTest)
    .map((node) => ({ node, reachable: reachableFrom(node.id, outgoing) }));

  const coverage: Record<string, CoverageInfo> = {};

  for (const flow of Object.keys(flows).sort(compareStrings)) {
    const members = flows[flow] ?? [];
    const reaching = tests.filter((test) => members.some((id) => test.reachable.has(id)));
    const reaches = reaching.length > 0;
    const assertsValue = reaching.some((test) => test.node.assertsValue);

    coverage[flow] = {
      flow,
      testNodes: reaching.map((test) => test.node.id).sort(compareStrings),
      reaches,
      assertsValue,
      blind: reaches && !assertsValue,
    };
  }

  return coverage;
}

/**
 * Whether a test's reach travels along this edge. Every intra-language edge carries it. A bridge
 * carries it only inside one root.
 *
 * A bridge between two roots is a call across a process boundary, and a test on one side is not
 * evidence about the other: a mobile test asserting on a rendered string does not check what the
 * api returns. Left in, one such test reached the route file, and through it every controller the
 * route file names, so a whole backend flow stopped being reported blind. That is the exact failure
 * `blind` exists to prevent, and it is worse than the opposite error, because the flow list is a
 * floor and not a ceiling (docs/00-overview.md): a coupling EmPo cannot see is documented, while a
 * test EmPo invents is a broken promise.
 *
 * Inside one root a bridge is an ordinary call, so it does carry coverage. That is what keeps a
 * framework feature test that only hits its own HTTP route counting as a test of the code behind it.
 */
function carriesCoverage(edge: GraphEdge, rootOf: Map<string, string>): boolean {
  if (edge.kind !== "bridge") return true;
  return rootOf.get(edge.from) === rootOf.get(edge.to);
}

/**
 * Everything a node can reach by following edges. The walk seeds its set with the start node, so
 * reach is reflexive and a node always appears in its own set.
 */
export function reachableFrom(start: string, outgoing: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  return seen;
}
