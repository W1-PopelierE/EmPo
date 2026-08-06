import type { GraphEdge, GraphNode } from "../schema/types";

/**
 * Every sort in the engine goes through here. `graph.json` has to be byte-identical for identical
 * input on any machine (docs/05-graph-model.md, docs/14-implementation-notes.md), and
 * `localeCompare` is not: it orders "alpha" before "Beta", and it orders Czech "hodina" before
 * "chleba" while English does the reverse. Code units are the same everywhere.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function byNodeId(a: GraphNode, b: GraphNode): number {
  return compareStrings(a.id, b.id);
}

/** The documented edge order: (from, to, kind, evidence.line), file last to break a tie. */
export function byEdgeOrder(a: GraphEdge, b: GraphEdge): number {
  return (
    compareStrings(a.from, b.from) ||
    compareStrings(a.to, b.to) ||
    compareStrings(a.kind, b.kind) ||
    a.evidence.line - b.evidence.line ||
    compareStrings(a.evidence.file, b.evidence.file)
  );
}
