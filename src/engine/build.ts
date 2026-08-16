import type { Pack } from "../schema/pack.schema";
import type { GraphEdge, GraphNode, Hazard, NameOutcome, NameResolution } from "../schema/types";
import {
  collectFileScopes,
  compilePack,
  type ExtractedFile,
  extractFile,
  symbolNodes,
} from "./extractor";
import { tallyNames } from "./names";
import { byEdgeOrder, byNodeId, compareStrings } from "./order";
import { readPackages } from "./packages";
import {
  buildNodeIndex,
  compileAliases,
  type NodeIndex,
  normalizeFqcn,
  type ResolveContext,
  resolveEdges,
} from "./resolver";
import { scanRoot } from "./scanner";

/**
 * One pack over one root: scan, extract, resolve. Sorted and deduplicated here so every caller
 * (pack test today, empo index next) gets the same deterministic pieces.
 */

export interface RootGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * The dispatches this root makes from inside a transaction that nothing defers. Empty when the
   * pack declares no hazards block, which is where the axis is silent rather than clean: the
   * distinction is `Graph.hazards` at the top and it is the pack, not this, that draws it.
   */
  hazards: Hazard[];
  /**
   * Every repo-relative path this root scanned, not a count. Two roots may overlap, and a count
   * summed per root would report more files than the repository holds while nodes and edges are
   * deduplicated across roots. The caller unions these instead.
   */
  files: string[];
  duplicates: DuplicateNode[];
  /**
   * What this root's name-resolving rules did with every bare name they read, one record per edge
   * family. Empty where no rule in the pack resolves by name, which is a different fact from a rule
   * that read names and resolved none of them, and the counts are what tells them apart.
   */
  names: NameResolution[];
}

/** Two files that claim the same node id. Only the first survives, and the collision is reported. */
export interface DuplicateNode {
  id: string;
  files: string[];
}

export interface BuildRootOptions {
  repoRoot: string;
  /**
   * `aliases` is the root's config field and nothing else reaches it. A pack corpus has no config,
   * so `empo pack test` builds every root without one and a snapshot can never come to depend on a
   * mapping only somebody's repository declares.
   */
  root: { path: string; lang: string; aliases?: Record<string, string[]> };
  pack: Pack;
  ignore?: string[];
}

export function buildRoot(options: BuildRootOptions): RootGraph {
  // Compiled before the scan, because compiling is what refuses a pack the engine cannot honour
  // (`compilePack` in engine/extractor.ts) and `scanRoot` reads the source of every file it globs.
  // A pack that is going to be refused should be refused without a repository being read first.
  const compiled = compilePack(options.pack);

  const scanned = scanRoot({
    repoRoot: options.repoRoot,
    root: options.root,
    extensions: options.pack.match.extensions,
    ignore: options.ignore,
  });

  // Read before any file is extracted, because it is the one thing a file cannot answer about
  // itself: what some other file says encloses it. A Laravel route file's paths are short by the
  // prefix its RouteServiceProvider mounts it under, and nothing inside the route file says so
  // (engine/extractor.ts, `collectFileScopes`). Empty for every pack that declares no `file` scope,
  // which is every pack that declares no scopes at all.
  const fileScopes = collectFileScopes(compiled, scanned);

  const extracted: ExtractedFile[] = [];
  for (const file of scanned) {
    const result = extractFile(compiled, file, fileScopes.get(file.file));
    if (result !== null) extracted.push(result);
  }

  const index = buildNodeIndex(extracted, options.pack.views);
  const packages = readPackages(options.repoRoot, options.pack.packages, options.ignore);
  const context: ResolveContext = {
    extensions: options.pack.match.extensions,
    indexNames: options.pack.node.id.indexNames ?? [],
    aliases: compileAliases(options.root.aliases),
    // Read per pack rather than once for the repository: the manifest that says what a package is
    // belongs to the language the pack speaks, so a repository whose php and TypeScript halves both
    // declared a `packages` block would get two sets and neither could refuse a name in the other's
    // files. Two roots of the same language read the same manifests and get the same set, which is
    // the same answer computed twice and not a per-root fact. Both halves come out of one read
    // because they are one subtraction seen from either side: what the manifests declare is what
    // `internalPackages` maps and what `vendorPackages` has had taken out of it.
    vendorPackages: packages.vendor,
    internalPackages: packages.internal,
  };
  const edges: GraphEdge[] = [];
  const names: NameOutcome[] = [];
  for (const file of extracted) {
    const resolved = resolveEdges(file, index, context);
    edges.push(...resolved.edges);
    names.push(...resolved.names);
  }
  const deduped = dedupeNodes(extracted.flatMap(toNodes));

  return {
    nodes: deduped.nodes,
    edges: dedupeEdges(edges).sort(byEdgeOrder),
    hazards: resolveHazards(extracted, index),
    files: scanned.map((file) => file.file),
    duplicates: deduped.duplicates,
    // Tallied before the edges are deduplicated, and deliberately: an edge deduplicated away was a
    // reference the rules did read and resolve, so counting after would shrink the numerator while
    // leaving every refusal standing and report a yield lower than the one measured.
    names: tallyNames(names),
  };
}

/**
 * The dispatches that survive into hazards, and what each one points at.
 *
 * Two things drop a dispatch and they are not the same fact. `deferredAtSite` is this one call
 * saying it waits for the commit, decided during extraction because it is written at the call site.
 * A deferring declaration is the dispatched job saying every dispatch of it waits, which cannot be
 * decided until the job's name is a node, so it is decided here.
 *
 * A job that resolves to nothing is kept with a null target. The enclosure is what makes a dispatch
 * a hazard, and a job named through a variable is still dispatched from inside the transaction; a
 * silent drop would report the repository clean precisely where the graph can see least.
 */
function resolveHazards(files: ExtractedFile[], index: NodeIndex): Hazard[] {
  // Any file claiming an id and declaring the deferral defers it. Two files claiming one id is
  // already a defect the graph reports (dedupeNodes), and between inventing a hazard and missing
  // one, this axis misses one: a hazard is a thing a reader goes and reads the source about.
  const deferring = new Set<string>();
  for (const file of files) {
    if (!file.defersCommit) continue;
    // Every node the file yields, and not the file's own id, because a deferral is a property of the
    // job's file and never of one export of it: the marker is a line of source somewhere in the file
    // and a dispatch resolves to whichever node carries the job's name. Under a pack that yields one
    // node per exported symbol those two are different ids, so keying this by `file.id` would have
    // read the deferral out of the source, found no dispatch target matching it, and reported a
    // hazard against code that already waits for the commit. A fabricated hazard is the worse error
    // on this axis, because a hazard is a thing a reader goes and opens the source about.
    for (const id of index.byFile.get(file.file) ?? []) deferring.add(id);
  }

  const hazards: Hazard[] = [];
  for (const file of files) {
    for (const dispatch of file.dispatches) {
      if (dispatch.deferredAtSite) continue;
      const target = resolveJob(index, dispatch.job);
      if (target !== null && deferring.has(target)) continue;
      hazards.push({
        file: file.file,
        line: dispatch.line,
        job: dispatch.job,
        target,
        transactionLine: dispatch.transactionLine,
      });
    }
  }

  return dedupeHazards(hazards);
}

/**
 * The dispatched name against the index the edges already resolve through, in the two forms a
 * dispatch is written in: a qualified name is a node id outright, a bare one is the short name a
 * node carries. An ambiguous short name resolves to nothing, the same answer `observer` edges give,
 * because picking one of two candidates would name a file the reader then finds is not the one.
 */
function resolveJob(index: NodeIndex, job: string): string | null {
  const name = normalizeFqcn(job);
  if (name === "") return null;
  if (index.ids.has(name)) return name;

  const candidates = index.byShortName.get(name);
  if (candidates === undefined || candidates.length !== 1) return null;
  return candidates[0] ?? null;
}

/**
 * The nodes one file yields. A file whose pack found symbols in it yields one per symbol and no node
 * of its own, which is what keeps this from doubling every name in the index: a `Button.tsx`
 * exporting `Button` carried one node named `Button` before and carries one now. A file whose pack
 * found none yields exactly the node it always did, so nothing about a `fqcn` or a `module-path`
 * pack moves, and neither does a `symbol` pack's file that exports nothing.
 *
 * One node per unique id, which is `symbolNodes`' job: a name declared twice owns two extents and is
 * still one export, so the two fold back together here rather than being reported as two files
 * claiming one id by `dedupeNodes`, which is a different defect about a different thing.
 *
 * `kind`, `isTest` and `assertsValue` are file-level facts copied onto each node, and honestly so: a
 * kind rule reads a path glob and a content pattern over the whole file, and a test file asserts or
 * does not assert as a file. Naming them per symbol would invent a distinction the pack contract
 * does not draw. `produces` and `consumes` are the two that are not, because extraction attributed
 * every one of them to the exports whose lines wrote it.
 */
function toNodes(file: ExtractedFile): GraphNode[] {
  if (file.symbols.length === 0) return [fileNode(file, file.id, file.name)];
  return symbolNodes(file.symbols).map((symbol) => ({
    ...fileNode(file, symbol.id, symbol.name),
    symbol: symbol.name,
    // Every extent this id owns, not the first: the two the fold above collapses are two runs of
    // lines, and a node that reported only one of them would hand the other one's edits to whatever
    // export happens to be declared above it. `empo review` reads these to narrow a hunk to the
    // exports that own it.
    extents: file.symbols
      .filter((extent) => extent.id === symbol.id)
      .map((extent) => ({ start: extent.startLine, end: extent.endLine })),
    produces: file.produces.filter((ref) => owns(ref.owners, symbol.id)),
    consumes: file.consumes.filter((ref) => owns(ref.owners, symbol.id)),
  }));
}

/**
 * Absent owners mean every node the file yields, which is what an unattributable line says: the
 * whole file may be the thing. See `Capture.owners` in engine/extractor.ts.
 */
function owns(owners: string[] | undefined, id: string): boolean {
  return owners === undefined || owners.includes(id);
}

function fileNode(file: ExtractedFile, id: string, name: string): GraphNode {
  return {
    id,
    file: file.file,
    root: file.root,
    lang: file.lang,
    kind: file.kind,
    name,
    produces: file.produces,
    consumes: file.consumes,
    isTest: file.isTest,
    assertsValue: file.assertsValue,
  };
}

/**
 * A node id is an identity, so two files claiming one is a defect in the indexed repository, not a
 * reason to refuse to build: a stub directory or a copied class does this. The file that sorts
 * first wins and the collision is reported by whoever called (empo index prints it, empo doctor
 * lists it). Edges found in the losing file keep their own evidence, which still points at real
 * source, and merge into the surviving id.
 *
 * Shared by buildRoot and by graph.ts across roots, so one root and a whole monorepo behave the same.
 */
export function dedupeNodes(nodes: GraphNode[]): {
  nodes: GraphNode[];
  duplicates: DuplicateNode[];
} {
  const byId = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const bucket = byId.get(node.id);
    if (bucket) bucket.push(node);
    else byId.set(node.id, [node]);
  }

  const kept: GraphNode[] = [];
  const duplicates: DuplicateNode[] = [];

  for (const [id, bucket] of byId) {
    // A tie on `file` is not two files claiming one id, it is one file scanned by two roots that
    // overlap, and the two nodes differ in what the pack decided about it. A pack matches its
    // tests.paths and kindRules against the path relative to the root that scanned the file, so
    // apps/api/tests/Feature/OrderTest.php is "tests/Feature/OrderTest.php" under root apps/api and
    // matches the pack's "tests/" prefix, while under root "." it is the full path and matches
    // nothing. Sorting on `file` alone leaves both orderings equal and keeps whichever came first,
    // which is always the outer root: the containing root is a prefix of the nested one and so
    // sorts ahead of it. The test silently stops being a test, drops out of the test set, and every
    // flow it covers reports as never exercised. The most specific root is the one whose relative
    // path the pack's rules were written against, so it wins.
    const sorted = [...bucket].sort((a, b) => {
      const byFile = compareStrings(a.file, b.file);
      if (byFile !== 0) return byFile;
      if (a.root.length !== b.root.length) return b.root.length - a.root.length;
      return compareStrings(a.root, b.root);
    });
    const winner = sorted[0];
    if (winner === undefined) continue;
    kept.push(winner);
    if (sorted.length > 1) duplicates.push({ id, files: sorted.map((node) => node.file) });
  }

  return {
    nodes: kept.sort(byNodeId),
    duplicates: duplicates.sort((a, b) => compareStrings(a.id, b.id)),
  };
}

/**
 * One edge per (from, to, kind). A second reference between the same pair is the same coupling,
 * and counting it twice would inflate fan-in. The earliest evidence wins.
 *
 * The key is joined on a NUL, written as an escape so this file stays plain text rather than
 * something git calls binary and refuses to diff. A NUL and not a space, because a node id is a
 * class name or a path and a path may hold a space: joining on one would let `"a b" -> "c"` and
 * `"a" -> "b c"` collapse into a single edge and lose a real coupling.
 */
export function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const byPair = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
    const existing = byPair.get(key);
    if (existing === undefined || earlier(edge, existing)) byPair.set(key, edge);
  }
  return [...byPair.values()];
}

/**
 * One hazard per dispatch site, sorted. Two overlapping roots scan one file twice and two dispatch
 * rules can match one call, and either way the reader is being shown the same line of source twice.
 *
 * The key joins on a NUL for the reason `dedupeEdges` does, and it is written as an escape so this
 * file stays greppable: a path holds spaces, and a space join would let two dispatch sites collapse
 * into one. Shared by buildRoot and by graph.ts across roots, so one root and a whole monorepo
 * behave the same.
 */
export function dedupeHazards(hazards: Hazard[]): Hazard[] {
  const byKey = new Map<string, Hazard>();
  for (const hazard of hazards) {
    const site = `${hazard.file}\u0000${hazard.line}\u0000${hazard.job}`;
    const key = `${site}\u0000${hazard.target ?? ""}\u0000${hazard.transactionLine}`;
    if (!byKey.has(key)) byKey.set(key, hazard);
  }
  return [...byKey.values()].sort(byHazardOrder);
}

/**
 * (file, line, job, target). The file first because a reader reads hazards a file at a time, and the
 * line before the job because that is the order the source they are about to open holds them in.
 *
 * An unresolved target compares as the empty string, which sorts it ahead of every node id. That is
 * a tiebreak between two dispatches of one job on one line of one file and never a claim about the
 * null, and it lives here rather than in engine/order.ts because a hazard is resolved in this file.
 */
function byHazardOrder(a: Hazard, b: Hazard): number {
  return (
    compareStrings(a.file, b.file) ||
    a.line - b.line ||
    compareStrings(a.job, b.job) ||
    compareStrings(a.target ?? "", b.target ?? "")
  );
}

function earlier(a: GraphEdge, b: GraphEdge): boolean {
  if (a.evidence.file !== b.evidence.file) return a.evidence.file < b.evidence.file;
  return a.evidence.line < b.evidence.line;
}
