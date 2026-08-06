import type { EmpoBridge } from "../schema/config.schema";
import type { GraphEdge, GraphNode, SymbolRef } from "../schema/types";
import { compareStrings } from "./order";

/**
 * Level 2: the cross-language join (docs/01-architecture.md). One root's pack writes a symbol into
 * `produces`, another root's pack writes the same symbol into `consumes`, and a `bridge` in config
 * says which roots to join for which symbol kind. This module matches the two tables and emits an
 * edge per match. It is the mechanism that lets `empo query` on a controller name the mobile screen
 * that calls it.
 *
 * It reads nodes only, never source, so it runs identically on a graph just built and on one read
 * back from disk. That is what lets `empo doctor` report match rates without a rebuild.
 */

/**
 * What a bridge matched and what it did not, so a mis-tuned `normalize` is visible as a number.
 *
 * Counted in keys, never in edges. One edge per (from, to, kind) is the graph's rule
 * (docs/05-graph-model.md), so a mobile file calling two routes in one route file is two matched
 * keys and one edge, and a report counting edges would contradict the `stats.bridgedEdges` that
 * `empo index` prints in its header block. The edge count belongs to the graph; the match rate
 * belongs here. `empo doctor` prints these lines and no edge total at all, so the contradiction
 * would surface in `empo index` rather than beside the rates themselves.
 */
export interface BridgeReport {
  kind: string;
  /** Distinct normalized keys per side, not occurrences: two files calling one route are one key. */
  produced: number;
  consumed: number;
  matched: number;
  /** Consumed keys no producer declares, sorted. The honest half of the match rate. */
  unmatched: string[];
}

export interface BridgeResult {
  edges: GraphEdge[];
  reports: BridgeReport[];
}

interface Occurrence {
  node: GraphNode;
  ref: SymbolRef;
}

export function bridgeRoots(nodes: GraphNode[], bridges: EmpoBridge[]): BridgeResult {
  const edges: GraphEdge[] = [];
  const reports: BridgeReport[] = [];

  for (const bridge of bridges) {
    const produced = collect(nodes, roots(bridge.produces), bridge, "produces");
    const consumed = collect(nodes, roots(bridge.consumes), bridge, "consumes");

    const unmatched: string[] = [];
    let matched = 0;

    for (const key of [...consumed.keys()].sort(compareStrings)) {
      const producers = produced.get(key);
      if (producers === undefined) {
        unmatched.push(key);
        continue;
      }
      matched += 1;

      // The edge runs from the caller to the definer, the same direction an import runs, so the
      // definer's fan-in counts everyone who would break if it changed. Evidence stays on the call
      // site: that is the line a reader has to go and read.
      for (const consumer of consumed.get(key) ?? []) {
        for (const producer of producers) {
          if (consumer.node.id === producer.node.id) continue;
          edges.push({
            from: consumer.node.id,
            to: producer.node.id,
            kind: "bridge",
            symbol: bridge.kind,
            evidence: { file: consumer.node.file, line: consumer.ref.line },
          });
        }
      }
    }

    reports.push({
      kind: bridge.kind,
      produced: produced.size,
      consumed: consumed.size,
      matched,
      unmatched,
    });
  }

  return { edges, reports };
}

/** How many unmatched keys to name before summarizing the rest. Never truncated silently. */
const UNMATCHED_SHOWN = 5;

/**
 * The match rate, worded once so `empo index` and `empo doctor` cannot drift apart. A rate below
 * 100% is not a failure: it is either a mis-tuned `normalize` or a call to a route this repository
 * does not define, and naming the keys is what lets a reader tell those two apart
 * (docs/03-config-schema.md).
 */
export function bridgeLines(reports: BridgeReport[]): string[] {
  const lines: string[] = [];

  for (const report of reports) {
    lines.push(
      `bridge ${report.kind}  ${report.matched}/${report.consumed} consumed keys matched ` +
        `against ${report.produced} produced`,
    );

    if (report.unmatched.length === 0) continue;
    for (const key of report.unmatched.slice(0, UNMATCHED_SHOWN)) {
      lines.push(`       no producer declares "${key}"`);
    }
    const rest = report.unmatched.length - UNMATCHED_SHOWN;
    if (rest > 0) lines.push(`       and ${rest} more unmatched key${rest === 1 ? "" : "s"}`);
  }

  return lines;
}

/** A bridge side is one root or a list of them (docs/03-config-schema.md). */
function roots(side: string | string[]): Set<string> {
  return new Set([side].flat());
}

function collect(
  nodes: GraphNode[],
  rootPaths: Set<string>,
  bridge: EmpoBridge,
  side: "produces" | "consumes",
): Map<string, Occurrence[]> {
  const table = new Map<string, Occurrence[]>();

  for (const node of nodes) {
    if (!rootPaths.has(node.root)) continue;
    for (const ref of node[side]) {
      if (ref.symbol !== bridge.kind) continue;
      const key = normalizeKey(ref.key, bridge.normalize);
      const bucket = table.get(key);
      if (bucket) bucket.push({ node, ref });
      else table.set(key, [{ node, ref }]);
    }
  }

  return table;
}

/**
 * The two sides are written by different people in different languages, so they are only equal
 * after they are made comparable. The backend registers `v1/orders/{order}` and the app calls
 * `/v1/orders/${id}`; without collapsing the param those are two different strings forever, and the
 * bridge reports no coupling where there is one.
 *
 * Every rule is applied to the whole key rather than to a part of it, because a key is whatever the
 * pack's `key` template made it and the engine cannot know its shape. Both sides run through the
 * same function, so a rule can only ever make a match more likely, never wrong in one direction.
 */
export function normalizeKey(key: string, rules: EmpoBridge["normalize"]): string {
  if (rules === undefined) return key;

  let result = key;

  for (const prefix of rules.stripPrefix ?? []) {
    const segment = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
    if (segment === "") continue;
    // Only a whole segment: stripping "api" must not turn "v1/apiary" into "v1/ary".
    result = result.replace(
      new RegExp(`(^|[ /])${escapeRegex(segment)}/`, "g"),
      (_, before: string) => before,
    );
  }

  if (rules.collapseParams === true) result = collapseParams(result);
  if (rules.lowercase === true) result = result.toLowerCase();
  if (rules.stripTrailingSlash === true) result = result.replace(/\/+$/, "");

  return result;
}

/**
 * Every spelling of "this segment is a value, not a name" becomes one wildcard: `{order}` (Laravel,
 * Rails), `:order` (Express, Angular), `${id}` (a TypeScript template literal), `<order>` (Flask),
 * and a segment that is already a concrete number, because the caller side is often a literal id.
 */
function collapseParams(key: string): string {
  return key
    .split("/")
    .map((segment) => (isParam(segment) ? "*" : segment))
    .join("/");
}

function isParam(segment: string): boolean {
  return (
    /^\$\{[^}]*\}$/.test(segment) ||
    /^\{[^}]*\}$/.test(segment) ||
    /^:[A-Za-z_$][\w$]*$/.test(segment) ||
    /^<[^>]*>$/.test(segment) ||
    /^\d+$/.test(segment)
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
