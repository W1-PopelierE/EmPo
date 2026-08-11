import { reachableFrom } from "../engine/coverage";
import { readGraph, stalenessLines } from "../engine/graph";
import { nameHealth } from "../engine/health";
import {
  claims,
  FRAMEWORK_RESOLVED_REASON,
  kindAxes,
  LIST_FRAMEWORK_RESOLVED,
} from "../engine/kinds";
import { nameLines } from "../engine/names";
import { compareStrings } from "../engine/order";
import { configError } from "../errors";
import type { Graph, GraphEdge, GraphNode, Hazard, NameResolution } from "../schema/types";
import { columnWidth } from "../term";

/**
 * `empo query`: the blast-radius answer (docs/06-cli.md). Every line it prints is a lookup in the
 * graph with a file or file:line behind it. It computes nothing a human could not re-derive by
 * reading graph.json, and it never guesses.
 */

/** Printed with every answer. The most important sentence EmPo says (docs/05-graph-model.md). */
export const FLOOR_NOT_CEILING =
  "Treat the flow list as a floor, not a ceiling. Absence of evidence is not evidence of absence.";

/**
 * What a silent language means under `--hazards`. A pack with no hazard rules scanned nothing, so an
 * empty list over the files under its roots is not a finding. Printed and carried in the JSON,
 * because the reader who would take "none" for "clean" is the agent reading the machine form.
 */
export const NO_HAZARD_CLAIM =
  "A language whose pack had no hazard rules when the graph was built scanned nothing, so silence " +
  "about the files under its roots is not a finding.";

/**
 * The answer a graph older than the axis gets. It holds neither the hazards nor the record of who
 * scanned for them, so this mode knows nothing about that build, which is a third answer and not a
 * quiet "none". Printed as the whole line and carried as the JSON reason, one string for both.
 */
export const HAZARDS_NOT_RECORDED =
  "unknown: this graph was built before hazards were recorded, so it holds no answer either way " +
  "(run empo index)";

/**
 * What an empty `--blind` list means over a graph holding no flow. Layer 2 is human-owned
 * (docs/01-architecture.md), so a graph with no flow in it is the state every repository starts in
 * and the one this answer must never report as a clean bill of health.
 *
 * Worded about the **graph** and not about the repository, which is the whole of what this mode
 * reads: `queryCommand` loads a graph and never the config, so "this repository curates no flow" is
 * a claim it has no evidence for. A repository that curated its flows after its last `empo index`
 * produces exactly this answer, and the flows file it wrote is sitting there contradicting it.
 * `HAZARDS_NOT_RECORDED` two constants down is careful about the same distinction and names the
 * same remedy, which is why this one now does too.
 */
export const NO_FLOW_CURATED =
  "this graph holds no flow at all, so nothing in it could be blind: either the repository curates " +
  "none, or the graph was built before it did (run empo index)";

/**
 * The other empty answer worth telling apart. A flow is blind when a test reaches it and none of
 * the reaching tests asserts a value, so a flow no test reaches at all can never be blind however
 * untested it is. A repository whose flows are all in that state answers `[]` for the worst
 * possible reason, and the count alone is what separates it from the good answer.
 */
export const NO_FLOW_REACHED =
  "no test reaches any flow, so none of them could be blind: an unreached flow is not a blind one, " +
  "and this answer is empty for the worse of the two reasons";

export interface QueryOptions {
  json?: boolean;
  blind?: boolean;
  gods?: boolean;
  orphans?: boolean;
  hazards?: boolean;
  all?: boolean;
}

export interface BlastRadius {
  node: GraphNode;
  faninDirect: number;
  faninTransitive: number;
  flows: {
    flow: string;
    blind: boolean;
    reaches: boolean;
    tests: number;
    reachedNodes: number;
    flowNodes: number;
    evidence: string;
  }[];
  consumers: { id: string; fanin: number; evidence: string }[];
  bridges: BridgeReach[];
  /**
   * How many bridge edges the whole graph holds, so an empty `bridges` can say which of the two
   * silences it is: a repository that indexed no cross-language join at all, or one whose joins are
   * simply nowhere near this node. Always present, even when `bridges` is not empty.
   */
  bridgeEdgesInGraph: number;
}

/**
 * One end of a cross-language join, from the side the blast radius sits on. Both ends are named,
 * because either one can be the file the reader came to ask about and neither is derivable from the
 * other: a bridge edge runs from the caller to the definer (engine/bridger.ts), so `from` is the
 * root whose source holds the reference and `to` is the root that defines what it names.
 *
 * This carried `id` alone, meaning `from`, which answered the question from one direction and not
 * the other. Asked about the Inertia page, the row named the php controller, which is what somebody
 * wanted; asked about that controller, the row named the controller again, because the controller
 * *is* the consuming side, and the file on the far end was never printed at all.
 */
export interface BridgeReach {
  /** The consuming side, whose source holds the reference. `evidence` is always a line in this file. */
  from: string;
  /** The producing side, which defines what `from` names. The end the answer used to drop. */
  to: string;
  /** The bridge kind config declared, e.g. `http-route` or `inertia-page`. */
  symbol: string | null;
  evidence: string;
}

export function queryCommand(
  repoRoot: string,
  symbol: string | undefined,
  options: QueryOptions = {},
): void {
  // Refused rather than ignored, and before the graph is even read. `--all` lifts exactly one
  // omission, and a flag that quietly does nothing anywhere else teaches a reader that some other
  // mode was also holding rows back.
  if (options.all === true && options.orphans !== true) {
    throw configError("empo query --all only means something with --orphans", [
      "--orphans is the one mode that leaves rows out: the kinds a pack marks framework-resolved.",
      `Run: ${LIST_FRAMEWORK_RESOLVED}`,
    ]);
  }

  const graph = readGraph(repoRoot);

  if (options.gods === true) {
    report(repoRoot, graph, gods(graph), options);
    return;
  }
  if (options.blind === true) {
    report(repoRoot, graph, blindFlows(graph), options);
    return;
  }
  if (options.orphans === true) {
    report(repoRoot, graph, orphans(graph, options.all === true), options);
    return;
  }
  if (options.hazards === true) {
    report(repoRoot, graph, hazards(graph), options);
    return;
  }

  if (symbol === undefined || symbol === "") {
    throw configError("empo query needs a symbol", [
      "Pass a node id, a file path, or a short name.",
      "Or one of: --gods, --blind, --orphans, --hazards.",
    ]);
  }

  report(repoRoot, graph, blastRadius(graph, resolveNode(graph, symbol)), options);
}

/** A node id, a repo-relative file path, a path suffix, or a short name, in that order. */
export function resolveNode(graph: Graph, symbol: string): GraphNode {
  const byId = graph.nodes.find((node) => node.id === symbol);
  if (byId !== undefined) return byId;

  const byFile = graph.nodes.filter(
    (node) => node.file === symbol || node.file.endsWith(`/${symbol}`),
  );
  if (byFile.length === 1 && byFile[0] !== undefined) return byFile[0];

  const byName = graph.nodes.filter((node) => node.name === symbol);
  if (byName.length === 1 && byName[0] !== undefined) return byName[0];

  const candidates = [...byFile, ...byName];
  if (candidates.length > 1) {
    throw configError(`"${symbol}" is ambiguous`, [
      ...candidates.map((node) => `${node.id}  ${node.file}`),
      "Pass the full id or the full path.",
    ]);
  }

  throw configError(`"${symbol}" is not in the graph`, [
    "It may be under no configured root, or the graph may be stale. Run empo doctor.",
  ]);
}

export function blastRadius(graph: Graph, node: GraphNode): BlastRadius {
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const bucket = incoming.get(edge.to);
    if (bucket) bucket.push(edge.from);
    else incoming.set(edge.to, [edge.from]);
  }

  const radius = reachableFrom(node.id, incoming);
  // One row per referencing node, not one per edge. A React or Vue file that imports a component
  // and then renders it produces an `import` edge and a `template` edge between the same pair, and
  // listing it twice printed one consumer as two and made `faninDirect` exceed `faninTransitive`,
  // which counts nodes.
  const direct = earliestPerSource(graph.edges.filter((edge) => edge.to === node.id));

  const flows = Object.entries(graph.flows)
    .map(([flow, members]) => {
      const reached = members.filter((id) => radius.has(id)).sort(compareStrings);
      return { flow, reached, members };
    })
    .filter((entry) => entry.reached.length > 0)
    .map(({ flow, reached, members }) => {
      const coverage = graph.coverage[flow];
      const first = reached[0];
      return {
        flow,
        blind: coverage?.blind ?? false,
        reaches: coverage?.reaches ?? false,
        tests: coverage?.testNodes.length ?? 0,
        // How much of the flow this change can reach. One node of twelve and twelve of twelve are
        // both "reached", and a reader judging a blast radius needs to be able to tell them apart.
        reachedNodes: reached.length,
        flowNodes: members.length,
        evidence: graph.nodes.find((candidate) => candidate.id === first)?.file ?? "",
      };
    })
    .sort((a, b) => compareStrings(a.flow, b.flow));

  return {
    node,
    faninDirect: direct.length,
    // The node itself is in the reachable set and is not its own consumer.
    faninTransitive: radius.size - 1,
    flows,
    consumers: direct
      .map((edge) => ({
        id: edge.from,
        fanin: graph.fanin[edge.from] ?? 0,
        evidence: `${edge.evidence.file}:${edge.evidence.line}`,
      }))
      .sort((a, b) => b.fanin - a.fanin || compareStrings(a.id, b.id)),
    // Matching on `from` alone is not the narrower half of a pair: the radius is closed under
    // consumers and a bridge edge is an ordinary edge inside it, so a bridge whose `to` is in the
    // radius has its `from` in there too. Every join worth printing was already being kept, and the
    // whole of the defect was that the far end went unnamed. Widening this to either end would
    // change nothing at all: the second half of the predicate can never be the one that admits an
    // edge. It reads as the safer spelling and is only the redundant one.
    bridges: graph.edges
      .filter((edge) => edge.kind === "bridge" && radius.has(edge.from))
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        symbol: edge.symbol,
        evidence: `${edge.evidence.file}:${edge.evidence.line}`,
      })),
    bridgeEdgesInGraph: graph.edges.filter((edge) => edge.kind === "bridge").length,
  };
}

/**
 * One edge per referencing node: the earliest place in that file where it names this one.
 *
 * Kept as a named function rather than inlined because it is the one place `empo query` decides that
 * a consumer is a node and not an edge, which is the rule `computeFanin` follows too.
 *
 * **Earliest by coordinate, not first in graph order.** `graph.edges` is sorted by from, to, kind,
 * and `kind` is an alphabetical accident: `fqcn` sorts before `import`, so keeping the first would
 * send a reader of a php answer to a `\App\Models\Order::query()` on line 10 rather than to the
 * `use` statement on line 4 that a consumer list is usually read for. The coordinate is the thing a
 * human acts on, so the lowest one wins and the remaining ties fall back to the graph's own order,
 * which keeps the choice identical on every machine.
 */
function earliestPerSource(edges: GraphEdge[]): GraphEdge[] {
  const best = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const held = best.get(edge.from);
    if (held === undefined || earlierEvidence(edge, held)) best.set(edge.from, edge);
  }
  return [...best.values()];
}

function earlierEvidence(edge: GraphEdge, held: GraphEdge): boolean {
  return (
    compareStrings(edge.evidence.file, held.evidence.file) < 0 ||
    (edge.evidence.file === held.evidence.file && edge.evidence.line < held.evidence.line)
  );
}

/** How many of the widest-blast-radius nodes to name before summarizing the rest. */
const GODS_SHOWN = 20;

/**
 * How many cross-language joins to name before summarizing the rest. Ten, and not the twenty
 * `--gods` prints, because a bridge is two printed lines per row and this keeps the block to the
 * same twenty lines that mode costs.
 *
 * The number is a measurement and not a taste. On a 5,048-node Laravel monorepo, the blast radius of
 * an ordinary model (`App\Models\Club`, 528 direct consumers) closes over 2,752 nodes and encloses
 * 15,809 edges, and the p90 radius across every node with fan-in is that same 2,752. This list is
 * `graph.edges.filter(from in radius)`, so whatever share of a repository's bridge edges lives in
 * that surface is what got printed: uncapped, a bridged repository of that size prints a wall, not a
 * list. The measured repository is single-root and configures no bridges, so the count it could give
 * is the radius the filter runs over rather than the matches inside it.
 */
const BRIDGES_SHOWN = 10;

interface GodsAnswer {
  mode: "gods";
  rows: { id: string; fanin: number; file: string }[];
  /**
   * How many nodes have a non-zero fan-in in all, so the printed and JSON forms can say how many
   * the top-20 left out. A cap that does not say what it dropped reads as "all of it", the same
   * failure `--orphans` was carrying, and this is the one mode that silently held rows back.
   */
  total: number;
}

function gods(graph: Graph): GodsAnswer {
  const ranked = Object.entries(graph.fanin).sort(
    (a, b) => b[1] - a[1] || compareStrings(a[0], b[0]),
  );
  const rows = ranked.slice(0, GODS_SHOWN).map(([id, fanin]) => ({
    id,
    fanin,
    file: graph.nodes.find((node) => node.id === id)?.file ?? "",
  }));
  return { mode: "gods", rows, total: ranked.length };
}

export interface BlindAnswer {
  mode: "blind";
  rows: { flow: string; tests: string[]; nodes: number }[];
  /**
   * The denominator `rows` is a numerator of. Always present, all three counts, even when every
   * flow is blind, so a reader of the JSON never has to decide what an empty list meant.
   *
   * `rows: []` is three different results wearing one shape: no flow is curated, no flow is reached
   * by any test, or every flow that is reached has a test asserting a value. Only the last is the
   * good news, and it is the one a reader assumes. The honest answer measured 9 of 9 flows
   * asserting, which is a genuinely good result, and the same `[]` had been
   * printed before two pack fixes for entirely false reasons: the counts are what tell the two
   * apart, and nothing else in the answer can.
   */
  flowsConsidered: {
    /** Flows the graph holds coverage for, which is every flow `.empo/flows.json` names. */
    total: number;
    /** Of those, how many some test reaches at all. A flow outside this count cannot be blind. */
    reached: number;
    /** Of the reached, how many have at least one reaching test that asserts on a value. */
    asserting: number;
    /**
     * Why an empty `rows` may not mean what it looks like: `NO_FLOW_CURATED` or `NO_FLOW_REACHED`
     * where one applies, null where the list can be read as it stands. Same rule as `--hazards`.
     */
    reason: string | null;
  };
}

function blindFlows(graph: Graph): BlindAnswer {
  const entries = Object.values(graph.coverage);
  const rows = entries
    .filter((entry) => entry.blind)
    .map((entry) => ({
      flow: entry.flow,
      tests: entry.testNodes,
      nodes: graph.flows[entry.flow]?.length ?? 0,
    }));

  const total = entries.length;
  const reached = entries.filter((entry) => entry.reaches).length;

  return {
    mode: "blind",
    rows,
    flowsConsidered: {
      total,
      reached,
      asserting: entries.filter((entry) => entry.assertsValue).length,
      reason: total === 0 ? NO_FLOW_CURATED : reached === 0 ? NO_FLOW_REACHED : null,
    },
  };
}

export interface OrphanRow {
  id: string;
  file: string;
  kind: string;
  /** Non-null only for a row `--all` asked for: the framework reaches it, nothing in the graph does. */
  resolvedBy: "framework" | null;
}

export interface OrphansAnswer {
  mode: "orphans";
  rows: OrphanRow[];
  /**
   * What `--orphans` leaves out, and why. Always present, even when it excluded nothing, so a
   * reader of the JSON never has to decide whether a missing key means "none" or "old version".
   */
  frameworkResolved: {
    /** True under `--all`, when the excluded rows are in `rows` after all. */
    listed: boolean;
    total: number;
    byKind: { kind: string; count: number }[];
    reason: string;
    listWith: string;
  };
}

/**
 * Nodes nothing references. Zero fan-in alone is not the answer: a Laravel view, a migration or a
 * policy is reached by the framework, by name, so a list built on fan-in alone is mostly false
 * positives and an agent acting on it deletes working code.
 *
 * A view is the kind where that is now a judgement rather than an impossibility. The php pack reads
 * `view('orders.index')` and `@extends`, so a rendered blade file has a fan-in and never reaches
 * this list; what is left marked is the view reached through `view($name)`, a composer or a
 * computed include, which no rule can see and which therefore still looks exactly like a view
 * nobody renders. The mark says who resolves the kind, not how many edges an instance of it has
 * (engine/kinds.ts).
 *
 * Excluding them silently would be the other failure, so nothing here is dropped without being
 * counted, named by kind and reachable through `--all`.
 *
 * Which kinds those are is `engine/kinds.ts`'s answer, not this file's, because `empo init`'s map
 * brief classifies the same nodes on the same axis and a second copy of the rule would let the two
 * disagree. That module also records why the packs are read here rather than at index time.
 */
function orphans(graph: Graph, all: boolean): OrphansAnswer {
  const { frameworkResolved } = kindAxes(graph);

  const candidates: OrphanRow[] = graph.nodes
    .filter((node) => !node.isTest && (graph.fanin[node.id] ?? 0) === 0)
    .map((node) => ({
      id: node.id,
      file: node.file,
      kind: node.kind,
      resolvedBy: claims(frameworkResolved, node) ? ("framework" as const) : null,
    }));

  const excluded = candidates.filter((row) => row.resolvedBy !== null);
  const counts = new Map<string, number>();
  for (const row of excluded) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);

  return {
    mode: "orphans",
    rows: all ? candidates : candidates.filter((row) => row.resolvedBy === null),
    frameworkResolved: {
      listed: all,
      total: excluded.length,
      // Widest kind first: which convention produced the bulk of them is the useful read.
      byKind: [...counts]
        .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
        .map(([kind, count]) => ({ kind, count })),
      reason: FRAMEWORK_RESOLVED_REASON,
      listWith: LIST_FRAMEWORK_RESOLVED,
    },
  };
}

/**
 * Which languages in play looked for a transaction hazard and which never did. Two lists rather than
 * one flag, because a repository with a php root and a typescript root gets a partial answer, and a
 * partial answer that does not name what it skipped reads as a whole one.
 */
export interface HazardClaims {
  /** Languages whose pack had hazard rules when this graph was built, and so really scanned. */
  looking: string[];
  /** Languages in play that scanned nothing, whose files are absent from `rows` without a word. */
  silent: string[];
}

export interface HazardsAnswer {
  mode: "hazards";
  /**
   * In the order the graph holds them, which `empo index` has already made deterministic. Null, and
   * never an empty list, when the graph predates the axis and holds no such key: those are the two
   * answers this mode exists to tell apart (engine/graph.ts, GRAPH_SCHEMA 3).
   */
  rows: Hazard[] | null;
  /**
   * Always present, both lists, even when every pack looked. A reader of the JSON must never have to
   * decide whether an empty `rows` means "looked and found none" or "nobody looked", and `rows`
   * alone cannot tell those apart.
   */
  declared: HazardClaims & {
    /**
     * Why an empty list may not mean none: `NO_HAZARD_CLAIM` when some language in play scanned for
     * nothing, `HAZARDS_NOT_RECORDED` when the graph predates the record, null when every language
     * in play scanned and the list can be read as it stands.
     */
    reason: string | null;
  };
}

/**
 * Read off the graph's own record of the build, and deliberately not off the packs on disk the way
 * `frameworkResolvedKinds` reads `resolvedBy` one mode above. The asymmetry is the point, and
 * `Graph.hazardsScanned` carries the argument: `resolvedBy` reclassifies nodes the graph already
 * holds, so the data is there either way, while a hazard is found at index time and stored. A pack
 * that gained its rules after this graph was built collected nothing, and asking that pack now would
 * pair "php looks for hazards" with an empty list to state a clean result no run ever produced.
 *
 * A graph too old to carry the record is not run through here at all: it says which languages are in
 * play and nothing about which of them scanned, and calling those languages silent would be this
 * answer inventing a fact about a build it never saw.
 */
function hazardClaims(graph: Graph, scanned: string[]): HazardClaims {
  const looked = new Set(scanned);
  const langs = [...new Set(graph.roots.map((root) => root.lang))].sort(compareStrings);

  return {
    looking: langs.filter((lang) => looked.has(lang)),
    silent: langs.filter((lang) => !looked.has(lang)),
  };
}

/**
 * A job dispatched inside a transaction, which the queue does not roll back with the database, so a
 * worker can run it before the rows it needs are committed (docs/13-glossary.md).
 *
 * Answered from the graph and nothing else, packs included: `--orphans` stays the one mode that
 * needs a pack on disk, for the reason `frameworkResolvedKinds` gives and `hazardClaims` refuses.
 */
function hazards(graph: Graph): HazardsAnswer {
  // Null and never an empty list on a graph too old to hold the key, which would turn "nobody ever
  // looked" into a clean bill of health invented out of a field that was never written.
  const rows = graph.hazards ?? null;

  // Keyed on `hazards` rather than on `hazardsScanned`, because `readGraph` normalizes a missing or
  // malformed record to the empty array and `hazards` is the key it leaves alone. On such a graph no
  // language is named as silent either: that build left no record of who scanned, and calling php
  // silent off a field nothing wrote would be this answer inventing a fact about a run it never saw.
  const claims =
    rows === null ? { looking: [], silent: [] } : hazardClaims(graph, graph.hazardsScanned ?? []);

  return {
    mode: "hazards",
    rows,
    declared: { ...claims, reason: hazardReason(rows !== null, claims.silent) },
  };
}

/** One string per state, so the printed form and the JSON cannot word the same silence two ways. */
function hazardReason(recorded: boolean, silent: string[]): string | null {
  if (!recorded) return HAZARDS_NOT_RECORDED;
  return silent.length === 0 ? null : NO_HAZARD_CLAIM;
}

type Answer =
  | BlastRadius
  | ReturnType<typeof gods>
  | ReturnType<typeof blindFlows>
  | ReturnType<typeof orphans>
  | HazardsAnswer;

function report(repoRoot: string, graph: Graph, answer: Answer, options: QueryOptions): void {
  if (options.json === true) {
    // The caveat rides along in the JSON too. An agent reading this consumes the machine form and
    // never sees the printed line, and it is the one sentence no consumer of an answer may miss.
    console.log(JSON.stringify({ ...answer, caveat: FLOOR_NOT_CEILING }, null, 2));
    return;
  }

  console.log("");
  if ("mode" in answer) printMode(answer);
  else printBlastRadius(answer);

  console.log("");
  // What the name-resolving rules yielded on this repository, beside the answer they helped build.
  // `empo index` and `empo doctor` have printed it since it was counted, and neither is the surface
  // a reader is looking at when they decide what a change can reach: measured on a real React Native
  // application, `template` resolved 3 of 1531 tag references, and `empo query` said nothing about
  // it. A blast radius whose component edges nearly all failed to resolve is not wrong, it is thin,
  // and thin is indistinguishable from complete unless the yield prints where the answer does.
  const read = namesRead(graph);
  if (read.length > 0) {
    for (const line of nameLines(read)) console.log(line);
    console.log("");
  }
  // Every reason the answer above is out of date, not only the git distance. A pack that moved and
  // a schema this empo does not write both leave the git line saying "current with HEAD" and being
  // right, and a reader deciding whether to trust the numbers above would take that as the whole
  // answer (engine/graph.ts).
  for (const line of stalenessLines(repoRoot, graph)) console.log(line);
  console.log("");
  console.log(FLOOR_NOT_CEILING);
}

/**
 * The families that actually read a name, so a query prints a yield where there is one and stays
 * silent where there is none.
 *
 * The two silences `nameLines` keeps apart — nobody counted, and nothing read a name — are answers
 * about the graph rather than about the node being queried, and `empo index` and `empo doctor` both
 * say them already. What belongs beside an answer is the case a reader of that answer can be misled
 * by: rules that read names here and resolved few of them.
 */
function namesRead(graph: Graph): NameResolution[] {
  return (nameHealth(graph) ?? []).filter(
    (report) =>
      report.resolved +
        report.unknown +
        report.ambiguous +
        report.wrongKind +
        report.local +
        report.vendor >
      0,
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function printBlastRadius(answer: BlastRadius): void {
  const { node } = answer;

  console.log(`symbol     ${node.id}`);
  console.log(`file       ${node.file}`);
  console.log(`kind       ${node.kind} (${node.lang}, root ${node.root})`);
  console.log(
    `fan-in     ${answer.faninDirect} direct, ` +
      `${answer.faninTransitive} transitive (the direct ones included)`,
  );
  console.log("");

  console.log("flows reached");
  if (answer.flows.length === 0) {
    console.log("  none: this node is in no flow's paths, and neither is anything that uses it");
  }
  const width = columnWidth(answer.flows, (flow) => flow.flow);
  for (const flow of answer.flows) {
    const reach = `${plural(flow.tests, "test")} ${flow.tests === 1 ? "reaches" : "reach"} it`;
    const state = flow.blind
      ? `BLIND  ${reach}, none asserts a value`
      : flow.reaches
        ? `covered  ${reach}, at least one asserts a value`
        : "no test reaches this flow at all";
    console.log(`  ${flow.flow.padEnd(width)}  ${state}`);
    console.log(
      `  ${" ".repeat(width)}  via ${flow.evidence} ` +
        `(${flow.reachedNodes} of ${plural(flow.flowNodes, "node")} reached)`,
    );
  }
  console.log("");

  console.log("top consumers");
  if (answer.consumers.length === 0) console.log("  none: nothing in the graph references it");
  const idWidth = columnWidth(answer.consumers.slice(0, 10), (row) => row.id);
  for (const consumer of answer.consumers.slice(0, 10)) {
    console.log(
      `  ${String(consumer.fanin).padStart(4)}  ${consumer.id.padEnd(idWidth)}  ${consumer.evidence}`,
    );
  }
  if (answer.consumers.length > 10) {
    console.log(`  ... and ${answer.consumers.length - 10} more`);
  }
  console.log("");

  console.log("cross-language reach");
  if (answer.bridges.length === 0) {
    // Two silences, and the old line stated the first one whichever it was in. A repository with
    // bridges configured and none of them near this node was told "the graph holds no bridge edges
    // yet", which reads as "cross-language reach is not set up here" and is a different, wrong
    // thing to go and act on. Same rule as `--hazards` and `spinesCurated`.
    // Three spellings and not two, because `plural()` cannot write the one-edge sentence: "of the
    // 1 bridge edge in the graph, none is in this blast radius" is a count where the reader wants
    // a noun, and this section is read by an agent that quotes what it is given.
    console.log(
      answer.bridgeEdgesInGraph === 0
        ? "  none: the graph holds no bridge edges at all, so nothing here crosses a language"
        : answer.bridgeEdgesInGraph === 1
          ? "  none: the one bridge edge in the graph is not in this blast radius"
          : `  none: of the ${plural(answer.bridgeEdgesInGraph, "bridge edge")} in the graph, ` +
            "none is in this blast radius",
    );
  }
  const shown = answer.bridges.slice(0, BRIDGES_SHOWN);
  const symbolWidth = columnWidth(shown, (bridge) => bridge.symbol ?? "?");
  for (const bridge of shown) {
    // Both ends, always, on two lines. Either one can be the file the reader asked about, so a row
    // naming one of them alone answers the question from one direction and repeats the question
    // back from the other. The evidence is a line in `from`, which is the side that spells the
    // name, and the indent puts `to` under it rather than beside it because ids across two roots
    // are long enough that one line wraps in a terminal and stops being readable as a pair.
    console.log(`  ${(bridge.symbol ?? "?").padEnd(symbolWidth)}  ${bridge.from}`);
    // `named at`, and not the bare `file:line` every other section ends a row with, because this is
    // the one row whose two halves are both paths: `consumes <path>  <path>:11` reads as a list of
    // two files rather than as a claim and its citation.
    console.log(`  ${" ".repeat(symbolWidth)}  consumes ${bridge.to}  named at ${bridge.evidence}`);
  }
  if (answer.bridges.length > BRIDGES_SHOWN) {
    console.log(`  ... and ${answer.bridges.length - BRIDGES_SHOWN} more`);
  }
}

/**
 * The exclusion, said out loud. A capped or filtered list that does not say what it left out reads
 * as "all of it", which is the failure this whole change exists to fix and not one to reintroduce
 * one layer up.
 */
function printFrameworkResolved(skipped: OrphansAnswer["frameworkResolved"]): void {
  if (skipped.total === 0) return;

  const summary = skipped.byKind.map((entry) => `${entry.count} ${entry.kind}`).join(", ");
  console.log("");
  console.log(
    skipped.listed
      ? `${plural(skipped.total, "node")} above ${skipped.total === 1 ? "is" : "are"} framework-resolved (${summary}), listed because --all asked.`
      : `${plural(skipped.total, "node")} with no fan-in ${skipped.total === 1 ? "is" : "are"} not listed: ${summary}.`,
  );
  console.log(`  ${skipped.reason}`);
  if (!skipped.listed) console.log(`  List them anyway with: ${skipped.listWith}`);
}

/**
 * The `--hazards` block, as lines rather than as prints. Four states, and the whole mode is keeping
 * them apart: hazards found, none found by a language that scanned, nothing scanned at all, and a
 * graph too old to hold the record either way. Only the first is a list, and the other three are the
 * ones a reader turns into "clean" if the line does not stop them.
 */
function hazardLines(answer: HazardsAnswer): string[] {
  const { looking, silent, reason } = answer.declared;
  const lines = ["transaction hazards: a job dispatched inside a transaction, before it commits"];

  const rows = answer.rows ?? [];

  if (answer.rows === null) {
    lines.push(`  ${HAZARDS_NOT_RECORDED}`);
  } else if (rows.length === 0) {
    lines.push(
      looking.length === 0
        ? "  none: nothing scanned for one when this graph was built, which is not finding none"
        : `  none: the ${looking.join(", ")} ${looking.length === 1 ? "pack" : "packs"} scanned ` +
            "for them and found none",
    );
  }

  const jobWidth = columnWidth(rows, (row) => row.job);
  const lineWidth = columnWidth(rows, (row) => String(row.transactionLine));
  for (const row of rows) {
    lines.push(
      `  ${row.job.padEnd(jobWidth)}  opened at line ` +
        `${String(row.transactionLine).padStart(lineWidth)}  ${row.file}:${row.line}`,
    );
    // The second line is the one that decides what a reader does next: a resolved target is a file
    // to open, and a null one is a dispatch through a variable or a factory, still worth reporting
    // because the enclosure is what makes it a hazard.
    lines.push(
      `  ${" ".repeat(jobWidth)}  ` +
        (row.target === null
          ? "no node in the graph carries that name"
          : `dispatches ${row.target}`),
    );
  }

  if (silent.length > 0 && reason !== null) {
    lines.push("");
    lines.push(
      `${plural(silent.length, "root language")} scanned for no hazard at all: ${silent.join(", ")}.`,
    );
    lines.push(`  ${reason}`);
  }

  return lines;
}

/**
 * The `--blind` denominator, as lines rather than as prints, so a spec can read the sentence rather
 * than the layout around it. Three states and one of them prints two lines: a repository with no
 * flows has no denominator to state at all, and "of 0 flows, 0 are reached" says nothing twice.
 */
function blindDenominatorLines(considered: BlindAnswer["flowsConsidered"]): string[] {
  const { total, reached, asserting, reason } = considered;
  if (total === 0) return [NO_FLOW_CURATED];

  const lines = [
    `of ${plural(total, "flow")}, ${reached} ${reached === 1 ? "is" : "are"} reached by a test ` +
      `and ${asserting} ${asserting === 1 ? "has" : "have"} one that asserts a value`,
  ];
  // Indented under the count it qualifies, the same shape `--orphans` and `--hazards` use for the
  // sentence that says why a number is not the number a reader would take it for.
  if (reason !== null) lines.push(`  ${reason}`);
  return lines;
}

function printMode(answer: Exclude<Answer, BlastRadius>): void {
  if (answer.mode === "gods") {
    console.log("widest blast radius");
    if (answer.rows.length === 0) console.log("  none: the graph has no edges");
    for (const row of answer.rows) {
      console.log(`  ${String(row.fanin).padStart(4)}  ${row.id}  ${row.file}`);
    }
    const rest = answer.total - answer.rows.length;
    if (rest > 0) {
      console.log("");
      console.log(`  and ${plural(rest, "more node")} with a non-zero fan-in, not shown.`);
    }
    return;
  }

  if (answer.mode === "blind") {
    console.log("blind flows: reached by a test, but no test asserts a value");
    if (answer.rows.length === 0) console.log("  none");
    for (const row of answer.rows) {
      console.log(`  ${row.flow}  (${plural(row.nodes, "node")})`);
      for (const test of row.tests) console.log(`    reached by ${test}`);
    }
    console.log("");
    // Printed under every answer and not only under an empty one. A reader who sees three blind
    // flows still needs to know whether that is three of four or three of ninety, and a denominator
    // that appears only in the good case is one nobody learns to look for.
    for (const line of blindDenominatorLines(answer.flowsConsidered)) console.log(line);
    return;
  }

  if (answer.mode === "hazards") {
    for (const line of hazardLines(answer)) console.log(line);
    return;
  }

  if (answer.mode === "orphans") {
    console.log("orphans: nothing in the graph references these");
    if (answer.rows.length === 0) console.log("  none");
    for (const row of answer.rows) {
      // Under --all the two sorts of row are mixed, so each framework-resolved one says so on its
      // own line. A reader scanning for something to delete must never have to remember a header.
      const mark = row.resolvedBy === null ? "" : `  [${row.kind}, resolved by the framework]`;
      console.log(`  ${row.id}  ${row.file}${mark}`);
    }

    printFrameworkResolved(answer.frameworkResolved);

    console.log("");
    // It no longer says "a route file": the php pack marks that kind framework-resolved, so a route
    // file is now filtered above and never reaches this list. What is left is the entrypoint no pack
    // has a kind for, which is the one a reader still has to recognise unaided.
    console.log("An entrypoint no pack knows as a kind (a bin script) has no consumers by design.");
    return;
  }

  unprintableMode(answer);
}

/**
 * The compiler's proof that every mode above has a branch: `answer` is `never` here, so a mode added
 * to `Answer` without a printer stops this file compiling.
 *
 * Until this existed the orphans body was an unguarded fall-through, and a fourth mode would have
 * been printed under the orphans heading, with the orphans footer under it: an answer that looks
 * generated, reads as complete and is about something else. `--json` would have been right at the
 * same moment the printed form was wrong, which is the pair hardest to notice.
 *
 * The whole answer rather than its discriminant, unlike `unbuildableForge`, because a narrowed-away
 * union has no property left to read: `never` carries no `mode`.
 */
function unprintableMode(answer: never): never {
  const mode = (answer as { mode?: unknown }).mode;
  throw configError(`empo query has no printer for the ${JSON.stringify(mode)} answer`, [
    "This is a defect in empo, not in the repository being queried.",
    "Run the same query with --json, which prints any answer whatever its mode.",
  ]);
}
