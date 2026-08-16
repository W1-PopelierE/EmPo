/**
 * The contracts. These are the TypeScript form of docs/05-graph-model.md and everything else in
 * the engine consumes them. Written by hand because the graph has no schema: nothing parses a
 * `graph.json` back through zod, so there is no inferred type to take these from.
 *
 * The pack half of the contract (docs/04-language-packs.md) is NOT here. `Pack` and everything
 * under it are inferred from `pack.schema.ts`, because a pack is parsed and a second hand-written
 * statement of the same shape drifts from the parser without TypeScript seeing it.
 */

export type EdgeKind = "import" | "fqcn" | "string" | "template" | "hook" | "bridge";

export interface SymbolRef {
  symbol: string; // "http-route", "event", ...
  key: string; // normalized key, e.g. "POST v1/orders"
  line: number;
  /**
   * The nodes this belongs to, for a pack whose file yields more than one. Absent where the file
   * yields a single node, which is every file of a `fqcn` or `module-path` pack: "all of them" and
   * "the only one" are the same answer there, and writing it out would put a node id in `graph.json`
   * for every ref of every pack that never asked for one.
   */
  owners?: string[];
}

export interface GraphNode {
  id: string; // stable per pack.node.id.strategy
  file: string; // repo-relative
  root: string;
  lang: string;
  kind: string; // from pack kindRules
  name: string;
  produces: SymbolRef[];
  consumes: SymbolRef[];
  isTest: boolean;
  /** A test that uses one of the pack's assertionTerms. Always false on a non-test node. */
  assertsValue: boolean;
  /**
   * The name this node is the export of, for a `symbol`-strategy pack. Absent on a file-level node,
   * which is every node of a `fqcn` or a `module-path` pack and the node a `symbol` pack's file
   * yields when its pattern found no export in it. Present is what tells a printer that a path names
   * several nodes and that saying "export" rather than "file" is the truth about this graph.
   */
  symbol?: string;
  /**
   * The lines this node's declarations span, 1-based and inclusive, in the order the file declares
   * them. Present exactly where `symbol` is: a file-level node spans the whole file and saying so
   * would be a range nobody can narrow with.
   *
   * A list and not a single pair, because a name declared twice owns two disjoint runs of lines
   * (declaration merging, see `extractSymbolExtents` in engine/extractor.ts) and is still one node.
   * A min/max span over the two would swallow every export written between them.
   *
   * It is a line partition and not a parse (section 2 of docs/04-language-packs.md), so a helper
   * written between two exports falls inside the extent of the one above it. Whoever narrows by
   * these lines owes the over-attribution that fact allows, never a miss.
   */
  extents?: { start: number; end: number }[];
}

/** One end-user journey from flows.json. `paths` are repo-relative path prefixes. */
export interface FlowDefinition {
  label?: string;
  paths: string[];
}

export type FlowDefinitions = Record<string, FlowDefinition>;

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  symbol: string | null; // set only for bridge edges
  evidence: { file: string; line: number };
}

export interface CoverageInfo {
  flow: string;
  testNodes: string[];
  /**
   * The files those nodes live in, deduplicated and sorted. It is the count a reader is owed, because
   * "3 tests reach this flow" means three test files and never three exported symbols: a pack whose
   * ids name an export turns one test file that exports three cases into three `testNodes`, and every
   * printer that reported the length of that list would then claim a suite three times the size of
   * the one on disk.
   *
   * Kept beside `testNodes` rather than replacing it, because the two answer different questions. The
   * ids are what a reader follows to the code that does the reaching, and the paths are what they
   * open. Under a pack that yields one node per file the two lists have the same length, which is why
   * nothing needed this before.
   */
  testFiles: string[];
  reaches: boolean;
  assertsValue: boolean;
  blind: boolean; // reaches && !assertsValue
}

/**
 * One queued job dispatched from inside a database transaction without waiting for the commit. The
 * queue does not roll back with the database, so a worker can run the job before the rows it needs
 * are committed (docs/13-glossary.md).
 *
 * `target` is the dispatched job resolved to a node id, or null when no node in this root carries
 * that name. Null is the honest answer and not an omission: a job named through a variable or built
 * by a factory cannot be resolved, and the dispatch is still worth reporting because the enclosure
 * is what makes it a hazard. It follows `GraphEdge.symbol`, which is a present key with a null value
 * rather than an absent one.
 */
export interface Hazard {
  file: string; // repo-relative, the dispatch site
  line: number; // the dispatch
  job: string; // the job as written at the dispatch site
  target: string | null; // resolved node id, null when unresolvable
  transactionLine: number; // the line that opened the enclosing transaction
}

/**
 * One dispatch written inside a loop. Not a hazard and deliberately kept out of `Hazard`: nothing
 * here is wrong, and a reader who found it in the hazards list would go looking for the defect.
 *
 * What it is, is the seam where a change somewhere else becomes traffic here. How many times the
 * loop runs is a property of the data, and EmPo reads source, so the count is not in this record and
 * never will be. The line is, and that is what puts the question in front of whoever is reading a
 * diff that widened the query above it.
 */
export interface Fanout {
  file: string; // repo-relative, the dispatch site
  line: number; // the dispatch
  job: string; // the job as written at the dispatch site
  target: string | null; // resolved node id, null when unresolvable
  loopLine: number; // the line that opened the enclosing loop
}

/**
 * One short name a name-resolving strategy read, and what the node index made of it.
 *
 * Only `observer` and `short-name` produce these, because they are the two strategies whose whole
 * input is a bare name: a `module-path` that resolves to nothing named a package, and a `fqcn` that
 * does named a class in a vendor tree, and neither of those is a refusal a repository can repair.
 * An ambiguous short name is, which is why it is counted apart from the rest.
 */
export interface NameOutcome {
  /** The family the edge would have carried. Never "bridge": a bridge resolves keys, not names. */
  family: Exclude<EdgeKind, "bridge">;
  /** The name as the rule's `normalize` chain left it, which is the spelling the index is keyed by. */
  name: string;
  outcome: NameVerdict;
  /**
   * Nodes carrying the name: 0 for `unknown`, 1 for `resolved`, `wrong-kind`, `local` and `vendor`,
   * 2+ for `ambiguous`. The last two are 1 because they are asked of a name the index had already
   * answered: what they refuse is an edge that was about to be written, not a name nothing carried.
   */
  candidates: number;
}

/**
 * Why a name did or did not become a node id. Five ways to fail rather than one, because they call
 * for five different reactions: `unknown` is the normal cost of reading a language whose vendor
 * components are spelled exactly like local ones, `wrong-kind` is a rule's own `targetKinds` doing
 * what it was declared for, `local` is the reference answering itself, `vendor` is the reference
 * answered by a package this repository installs, and `ambiguous` is the only one of the five that
 * hides a coupling this repository really has.
 *
 * `local` is a refusal that prevents a wrong edge rather than losing a right one: the file rendering
 * the tag declares that name itself, so whatever a file of the same basename elsewhere holds, it is
 * not what this line renders. Measured on marmelab/react-admin, 139 of 2715 template edges pointed
 * at a file the rendering file was shadowing with its own declaration.
 */
export type NameVerdict = "resolved" | "unknown" | "ambiguous" | "wrong-kind" | "local" | "vendor";

/**
 * What one edge family's name-resolving rules did with every name they read, counted per **reference
 * and not per edge**: two files rendering `<OrderCard />` are two resolved references and, after
 * `dedupeEdges`, may be one or two edges. The denominator is the point of the record, so the
 * arithmetic has to be over the thing that was read.
 */
export interface NameResolution {
  family: Exclude<EdgeKind, "bridge">;
  resolved: number;
  /** The name is in no node: a vendor component, a Blade built-in like `<x-slot>`. */
  unknown: number;
  /** The name is in several nodes, so no edge is emitted to any of them. */
  ambiguous: number;
  /** The name is in exactly one node, of a kind the rule does not list in `targetKinds`. */
  wrongKind: number;
  /** The file that wrote the reference declares the name itself, so no other node can be meant. */
  local: number;
  /**
   * The file that wrote the reference imports the name from a package it declares a dependency on,
   * so the node carrying that name is a basename collision and not what the line renders.
   */
  vendor: number;
  /** The distinct names behind `ambiguous`, so the count names something a reader can go and fix. */
  ambiguousNames: AmbiguousName[];
}

/** One name more than one node carries, and how much it cost. */
export interface AmbiguousName {
  name: string;
  /**
   * Nodes carrying it, never fewer than two. Ambiguity is decided against one root's index, so a
   * name ambiguous under two roots is reported with the larger candidate count: that is the index
   * the reader will find the most files in, and summing two roots' candidates would report more
   * files than any single refusal ever weighed.
   */
  nodes: number;
  /** References that named it and got nothing. */
  references: number;
}

export interface Graph {
  /**
   * The graph format this file was written in, not the one this binary writes. A version read off
   * disk is whatever a past binary left there, so narrowing it to the current literal would make the
   * one comparison that matters, "is this graph older than the code reading it", unexpressible.
   */
  schema: number;
  builtAgainst: string; // git sha
  builtAtCommitSubject: string;
  roots: { path: string; lang: string }[];
  packs: Record<string, string>; // name -> version
  stats: { files: number; nodes: number; edges: number; bridgedEdges: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
  flows: Record<string, string[]>; // flow key -> node ids
  fanin: Record<string, number>;
  coverage: Record<string, CoverageInfo>;
  /**
   * Transaction hazards, empty when no pack in this repo declares a `hazards` block. Empty and
   * absent are not the same claim and the empty array is the one that can be printed: `--hazards`
   * has to be able to say "this pack looks for them and found none" rather than falling silent,
   * which is the `flows` rule in docs/05-graph-model.md applied to a second axis.
   */
  hazards: Hazard[];
  /**
   * The languages whose pack declared hazard rules **when this graph was built**, sorted. This is
   * what makes an empty `hazards` readable, and it has to be recorded here rather than read off the
   * pack at query time, which is the trap it exists to close.
   *
   * `--orphans` reads `resolvedBy` from the pack on disk instead (commands/query.ts), and that is
   * correct there for a reason that does not transfer: `resolvedBy` only reclassifies nodes the
   * graph already holds, so the data is present either way and a later pack edit reinterprets it.
   * Hazards are found at index time and stored, so a pack that gained its rules after the graph was
   * built collected nothing. Asking the pack would then answer "this language looks for hazards",
   * the empty list would answer "and found none", and the two together state something no run ever
   * established. Recording the build's own answer makes a stale graph say "nothing looked", which
   * is true, and `empo index` fixes it.
   */
  hazardsScanned: string[];
  /**
   * What the name-resolving strategies did with every bare name they read, one record per edge
   * family, empty when no rule in these packs resolves by name.
   *
   * Absent and empty are not the same claim, on the `hazards` rule above and for a sharper reason:
   * this whole field exists because a family that resolved nothing looked exactly like a family
   * with nothing to find. A reader that defaulted the missing key to the empty list would recreate
   * that silence inside the field built to end it, so `readGraph` leaves it exactly as parsed and
   * every surface prints the absence as an unknown that `empo index` repairs.
   */
  names: NameResolution[];
  /**
   * Dispatches written inside a loop, empty when no pack in this repo declares a `loops` block.
   *
   * Read by `empo review`, which prints the ones inside a changed file as a fact about that file.
   * It rides on `hazardsScanned` rather than carrying a second scanned list, because both blocks
   * live under one pack key and a pack that declares `hazards` at all is a pack that was asked.
   */
  fanout: Fanout[];
}
