/**
 * The contracts. These are the TypeScript form of docs/05-graph-model.md and
 * docs/04-language-packs.md and everything else in the engine consumes them.
 */

export type EdgeKind = "import" | "fqcn" | "string" | "template" | "hook" | "bridge";
export type NodeStrategy = "fqcn" | "module-path" | "symbol";

/** How a captured string becomes a target node id. Engine-side, not pack-extensible. */
export type ResolveStrategy =
  | "fqcn"
  | "fqcn-string"
  | "module-path"
  | "view"
  | "observer"
  | "short-name";

export interface SymbolRef {
  symbol: string; // "http-route", "event", ...
  key: string; // normalized key, e.g. "POST v1/orders"
  line: number;
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
   * Nodes carrying the name: 0 for `unknown`, `local` and `vendor`, 1 for `resolved` and
   * `wrong-kind`, 2+ for `ambiguous`.
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
}

/** One extraction rule in an `edges.<family>` list. Capture group 1 is the target. */
export interface ExtractRule {
  pattern: string;
  resolve: ResolveStrategy;
  /**
   * Only run this rule over files whose root-relative path matches, the same glob dialect
   * `kindRules` uses. Absent means every file the pack matches, which is what every rule did before
   * this field existed. See src/schema/pack.schema.ts.
   */
  pathGlob?: string;
  /**
   * Kinds a name-resolving strategy may land on. A tag names a component, never a type module, and
   * a pack that says so keeps a coincidence of basenames out of the graph. See
   * src/schema/pack.schema.ts.
   */
  targetKinds?: string[];
  /**
   * Blank the contents of every string literal before this rule runs, so a name written inside
   * quotes cannot match it. Absent means read the source as written, which is what every rule did
   * before this field existed and what most rules still need: the `string` family, php's
   * `@livewire('cart')` and every route path a `consumes` rule reads all live inside quotes. Only a
   * rule whose shape is code and never prose about code asks for it. See src/schema/pack.schema.ts.
   */
  maskStrings?: boolean;
  /**
   * String operations applied to every capture group before the strategy reads it, so a pack can
   * say that its language spells a name one way at the call site and another way at the
   * declaration. A Blade `<x-forms.text-input>` names the class `Forms\TextInput`, and turning the
   * first spelling into the second is a fact about Blade, not about graphs.
   */
  normalize?: Normalizer[];
}

/**
 * String operations a pack composes, applied per part before a symbol key is assembled and per
 * capture group before an edge rule's `resolve` strategy reads it. The vocabulary is engine-side
 * and closed: a pack selects and orders them, it cannot define one.
 */
export type Normalizer =
  | "upper"
  | "lower"
  | "strip-leading-slash"
  | "last-dot-segment"
  | "pascal-case";

export interface SymbolRule {
  symbol: string; // "http-route", "event", ...
  /** A regex over the file's source. Exactly one of pattern / pathPattern is set. */
  pattern?: string;
  /** A regex over the file's path, for a symbol whose identity is its location (an Inertia page). */
  pathPattern?: string;
  map: Record<string, number>; // part name -> capture group
  key?: string; // template over parts, e.g. "{method} {path}". Default: parts joined by space.
  normalize?: Record<string, Normalizer[]>;
}

export interface PackNodeId {
  strategy: NodeStrategy;
  namespacePattern?: string;
  namePattern?: string;
  /** What to do when the strategy cannot produce an id (a file with no class). */
  fallback?: "path";
  /**
   * Basenames that stand for their own directory, so a module path naming a folder resolves to a
   * file. "index" in Node, "__init__" in Python. The pack declares it because it is a language
   * convention, and an engine that assumed "index" would be assuming Node.
   */
  indexNames?: string[];
}

/**
 * How this language writes comments and string literals, so the engine can blank comments before
 * the rules run. String literals are tracked so the masker knows where a comment does not start;
 * their contents are blanked only for a rule that declared `maskStrings`, and left as written for
 * every other, which is what the `string` family and every route path need.
 */
export interface CommentSyntax {
  line?: string[];
  block?: [string, string][];
  stringQuotes?: string[];
  stringEscape?: string;
  /**
   * The subset of `stringQuotes` whose literal may hold a raw newline. Absent means every quote
   * may, which is what PHP means and what the masker assumed before this existed. JavaScript means
   * the opposite for all but its backtick, and a pack that says so stops one stray apostrophe in a
   * Vue template from unmasking the rest of the file. See src/engine/mask.ts.
   */
  multilineQuotes?: string[];
}

/** Who reaches a node of this kind, when it is not an edge the pack's own rules can see. */
export type KindResolver = "framework";

/** Who or what arrives at a node of this kind from outside the code. */
export type KindArrival = "user";

export interface PackKindRule {
  kind: string;
  pathGlob?: string;
  contentPattern?: string;
  /**
   * Blank the contents of every string literal before `contentPattern` runs, so tag-shaped text
   * written inside quotes cannot label the file. The same field an edge rule declares, for the same
   * reason and with the same default: absent reads the source as written. A kind rule asks for it
   * only where its pattern describes code and never prose about code; a rule keying off a string the
   * framework itself reads must not. Inert without `contentPattern`, and rejected at load in that
   * case. See src/schema/pack.schema.ts.
   */
  maskStrings?: boolean;
  /**
   * Set when the framework resolves this kind by name or convention (a view, a migration, a
   * policy). Such a node's fan-in is zero whether it is used or not, which is what keeps
   * `empo query --orphans` from calling it dead code. See src/schema/pack.schema.ts.
   */
  resolvedBy?: KindResolver;
  /**
   * Set when somebody outside the code arrives at this kind: a route file, a console command, a
   * Livewire component. A separate axis from `resolvedBy` on purpose, because the two answer
   * different questions about one set of zero-fan-in nodes, "is this dead?" against "does a
   * journey start here?", and a route file answers no to the first and yes to the second. Read by
   * `empo init`'s map brief. See src/engine/kinds.ts.
   */
  arrivedBy?: KindArrival;
}

/**
 * How a transaction's extent is found once its opening pattern matched. Two forms, because the two
 * ways to open one are structurally different and neither expresses the other.
 *
 * `balanced` is the closure form (`DB::transaction(function () { ... })`): the extent runs from the
 * match to the delimiter that balances the first `open` after it. `span` is the manual form
 * (`DB::beginTransaction() ... DB::commit()`): the extent runs to the next `endPattern` match, or to
 * the end of the file when none arrives, because an unclosed transaction is the worse hazard rather
 * than a reason to report nothing.
 *
 * The mechanism is the engine's and the markers are the pack's, which is the same split
 * engine/mask.ts already makes for comments: a pack names its delimiters, the engine walks them. No
 * language name appears in either.
 */
export type HazardExtent = "balanced" | "span";

export interface HazardTransactionRule {
  pattern: string;
  extent: HazardExtent;
  /** `balanced` only: the delimiter pair to count. */
  open?: string;
  close?: string;
  /** `span` only: what closes the transaction. */
  endPattern?: string;
}

export interface HazardDispatchRule {
  pattern: string;
  /** 1-based capture group holding the dispatched job's name. */
  job: number;
}

/**
 * The optional transaction-hazard axis. A pack populates it or leaves it out, because not every
 * language or framework has the hazard. Absent means this pack makes
 * no claim, which is why `empo query --hazards` distinguishes "found none" from "nobody looked".
 */
export interface PackHazards {
  transactions: HazardTransactionRule[];
  dispatches: HazardDispatchRule[];
  /** Matched at the dispatch site: this one dispatch waits for the commit. */
  deferAtSite: string[];
  /** Matched in the dispatched job's own file: every dispatch of that job waits. */
  deferAtDeclaration: string[];
}

export interface Pack {
  name: string;
  version: string;
  match: { extensions: string[]; manifest?: string[] };
  node: {
    id: PackNodeId;
    kindRules: PackKindRule[];
  };
  comments?: CommentSyntax;
  /**
   * Comment syntax that overrides `comments` for files of a given extension (keyed ".vue"). One
   * pack, one language, but two syntaxes: an SFC's template is html and its script is not. See
   * src/schema/pack.schema.ts.
   */
  commentsByExtension?: Record<string, CommentSyntax>;
  edges: Partial<Record<Exclude<EdgeKind, "bridge">, ExtractRule[]>>;
  produces: SymbolRule[];
  consumes: SymbolRule[];
  tests: {
    paths: string[];
    importsRule: string;
    assertionTerms: string[];
    /** Removed from the source before assertionTerms are matched. See pack.schema.ts. */
    assertionExcludes: string[];
  };
  /**
   * Patterns whose first group is a name **this file declares itself**, read by the two
   * name-resolving strategies and by nothing else. A pack that declares none behaves exactly as
   * every pack did before the field existed. See src/schema/pack.schema.ts.
   */
  declares?: string[];
  /**
   * Where this language's manifest names the packages a repository depends on, so a bare specifier
   * can be told from a path into this repository. Optional; a pack that declares none behaves as
   * every pack did before the field existed. See src/schema/pack.schema.ts.
   */
  packages?: PackPackageSource;
  /** Optional: a pack that declares none makes no hazard claim at all. See PackHazards. */
  hazards?: PackHazards;
  /** Optional: where this toolchain writes import aliases, read by `empo init` only. */
  aliasSources?: PackAliasSource[];
  module?: string; // path to optional refine() escape hatch
}

/**
 * A manifest this language's package manager writes, described by field names rather than by values
 * so the engine needs no knowledge of the language it belongs to.
 *
 * Two facts come out of it and both are needed: which packages a repository **declares a dependency
 * on**, and which package names the repository **is** — a monorepo's own workspaces are spelled
 * exactly like third-party ones at an import site, and only the manifests say which is which.
 */
export interface PackPackageSource {
  /** Manifest basename, matched anywhere under the repository ("package.json", "composer.json"). */
  file: string;
  /** Field holding this package's own name ("name"). */
  name: string;
  /** Fields whose **keys** are dependency names ("dependencies", "require"). */
  dependencies: string[];
}

/**
 * A file `empo init` reads to seed config `aliases`, described by dotted field paths rather than by
 * values so the engine needs no knowledge of the language it belongs to. See pack.schema.ts.
 */
export interface PackAliasSource {
  /** Relative to the root's directory ("tsconfig.json"). */
  file: string;
  /** Dotted path to the map of pattern to target ("compilerOptions.paths"). */
  paths: string;
  /** Dotted path to the directory targets are relative to ("compilerOptions.baseUrl"). */
  base?: string;
  /** Dotted path to a file this one inherits from ("extends"). Relative spellings only. */
  extends?: string;
}

export interface PackModule {
  refine(
    node: GraphNode,
    edges: GraphEdge[],
    source: string,
  ): { node: GraphNode; edges: GraphEdge[] };
}
