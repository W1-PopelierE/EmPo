import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configError, EmpoError } from "../errors";
import type { EmpoConfig } from "../schema/config.schema";
import type { Graph, GraphEdge, GraphNode, Hazard, NameResolution, Pack } from "../schema/types";
import { type BridgeReport, bridgeRoots } from "./bridger";
import { buildRoot, type DuplicateNode, dedupeEdges, dedupeHazards, dedupeNodes } from "./build";
import { computeCoverage } from "./coverage";
import { assignFlows, loadFlows } from "./flows";
import { commitsAhead, gitInfo, shortSha } from "./git";
import { mergeNames } from "./names";
import { byEdgeOrder, compareStrings } from "./order";
import { loadPack, packAvailable } from "./pack-loader";

/**
 * Assembles one graph from every root, computes the derived indexes queries read, and serializes
 * it deterministically. This is the only module that constructs, reads or writes the shape in
 * docs/05-graph-model.md; every command goes through it.
 */

export const GRAPH_PATH = ".empo/generated/graph.json";
export const LOCK_PATH = ".empo/generated/packs.lock.json";

/**
 * The version of the on-disk shape this binary writes, and the only version it can vouch for.
 *
 * It is bumped when a field the readers already know keeps its name and changes its meaning, which
 * is the change nothing else on disk records. A renamed or added field announces itself: the reader
 * looks for it and does not find it. A field whose meaning moved under it does not, and `readGraph`
 * casts the parsed JSON without checking a single key, so an old graph.json is served as though this
 * binary had written it.
 *
 * 2 is that case, and it is why the number exists. Schema 1 put a colocated test node into the flow
 * whose prefix covered it, so a flow's `coverage` answered about its own suite instead of about what
 * reaches its code (engine/flows.ts says which half inverts and how). Schema 2 leaves test nodes out
 * of `flows` entirely. Nothing about the file's shape changed, every reader still parses it, and a
 * TypeScript-only repository has no second pack to bump either, so before this number existed
 * `empo query --blind` went on serving the old membership out of a graph that reported healthy.
 *
 * 3 added `hazards`, and it is the same case rather than the announcing one. An added field
 * announces itself only where its absence and its emptiness mean the same thing, and here they are
 * the two answers the axis exists to tell apart: a schema 2 graph has no `hazards` key because
 * nobody looked, and a reader that defaults a missing key to the empty array turns that into "this
 * repository dispatches nothing from inside a transaction". That is a clean bill of health invented
 * out of a field that was never written.
 *
 * 4 is the case this number was defined for, in its plainest form: `fanin` kept its name and became
 * a count of the nodes that reference one node rather than of the edges that do. Every graph written
 * before it holds numbers computed the other way, and no other signal reaches a repository whose
 * pack did not also move: a php-only checkout would go on serving inflated fan-ins on the same
 * commit with the same pack version, reported healthy.
 *
 * 5 added `names`, and it is `hazards`' case rather than the announcing one, for the same reason.
 * A graph written before it has no `names` key because nobody counted, and a reader that defaulted
 * the absence to the empty array would turn that into "nothing here read a name",
 * which is the one answer this field exists to distinguish from the counts. So the absence has to
 * remain readable, and a graph that predates the count says so rather than reporting a yield no run
 * ever measured.
 *
 * 6 is the plainest case again, twice over. `resolved` kept its name and admits a name a node
 * carries in another case, so every count written before it was taken under a stricter rule and the
 * two cannot be compared. And `names` gained `local`, whose absence and whose zero are the two
 * answers apart: a schema 5 graph has no `local` key because nothing asked whether a file declared
 * the name it rendered, and reading that as "nothing did" is a clean bill of health invented out of
 * a field nobody wrote.
 *
 * 7 is a meaning change under unchanged names, which is the case this list exists for, and the
 * widest one yet. A pack may now identify a node by an exported symbol rather than by a file, so
 * `nodes[].id` can name one export of a file, `edges` point between exports, and `fanin` and `flows`
 * are keyed by those ids. Every one of those keys is spelled exactly as it was in 6. A repository
 * whose only pack is TypeScript holds no second pack whose version would signal the drift, so a
 * graph written before this is indistinguishable from one written after it except by this number,
 * and a stale one would answer every blast radius with file-level fan-ins reported as per-export.
 *
 * It carries an added key too, `coverage[].testFiles`, and that half is `hazards`' case rather than
 * this one: a schema 6 graph has no `testFiles` because a test file and a test node were the same
 * thing when it was written, and a reader defaulting the absence to the empty array would report
 * that nothing tests a flow whose tests it is holding the node ids of.
 */
export const GRAPH_SCHEMA = 7;

export function graphPath(repoRoot: string): string {
  return join(repoRoot, GRAPH_PATH);
}

export interface BuildGraphOptions {
  repoRoot: string;
  config: EmpoConfig;
}

export interface BuiltGraph {
  graph: Graph;
  /** Reported by the caller, not thrown: a collision is a defect in the indexed repo, not here. */
  duplicates: DuplicateNode[];
  /** Per configured bridge, how much of the consume side found a producer. */
  bridges: BridgeReport[];
}

export function buildGraph(options: BuildGraphOptions): BuiltGraph {
  const { repoRoot, config } = options;
  const roots = [...config.roots].sort((a, b) => compareStrings(a.path, b.path));

  const packs = new Map<string, Pack>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const hazards: Hazard[] = [];
  const duplicates: DuplicateNode[] = [];
  const names: NameResolution[] = [];
  const files = new Set<string>();

  for (const root of roots) {
    let pack = packs.get(root.lang);
    if (pack === undefined) {
      pack = loadPack(root.lang);
      packs.set(root.lang, pack);
    }

    const built = buildRoot({
      repoRoot,
      root: { path: root.path, lang: root.lang, aliases: root.aliases },
      pack,
      ignore: config.ignore,
    });

    nodes.push(...built.nodes);
    edges.push(...built.edges);
    hazards.push(...built.hazards);
    duplicates.push(...built.duplicates);
    names.push(...built.names);
    for (const file of built.files) files.add(file);
  }

  // Deduplicated again across roots, because two roots may overlap (a nested root re-scans a file)
  // and because the same rules must hold for a monorepo as for a single root.
  const merged = dedupeNodes(nodes);

  // Bridges join the roots after every root is built, because a bridge edge is the one edge whose
  // two ends come from different packs. Its input is the nodes, never the source.
  const bridged = bridgeRoots(merged.nodes, config.bridges);
  const mergedEdges = dedupeEdges([...edges, ...bridged.edges]).sort(byEdgeOrder);

  const flows = assignFlows(merged.nodes, loadFlows(repoRoot, config.flows));
  const git = gitInfo(repoRoot);

  return {
    duplicates: dedupeReports([...duplicates, ...merged.duplicates]),
    bridges: bridged.reports,
    graph: {
      schema: GRAPH_SCHEMA,
      builtAgainst: git?.sha ?? "",
      builtAtCommitSubject: git?.subject ?? "",
      roots: roots.map((root) => ({ path: root.path, lang: root.lang })),
      packs: sortedRecord(Object.fromEntries([...packs].map(([lang, p]) => [lang, p.version]))),
      stats: {
        files: files.size,
        nodes: merged.nodes.length,
        edges: mergedEdges.length,
        bridgedEdges: mergedEdges.filter((edge) => edge.kind === "bridge").length,
      },
      nodes: merged.nodes,
      edges: mergedEdges,
      flows,
      fanin: computeFanin(mergedEdges),
      coverage: computeCoverage(merged.nodes, mergedEdges, flows),
      // Deduplicated again across roots for the reason the nodes are: two roots may overlap and
      // re-scan one file, and a hazard reported twice is one dispatch site read as two.
      hazards: dedupeHazards(hazards),
      // Read off the packs this build actually loaded, never off the packs on disk at query time.
      // A pack that gained its rules after this graph was written collected nothing, and the
      // difference between "found none" and "nobody looked" is the whole point of the field
      // (schema/types.ts).
      //
      // A present block counts however empty it is, because declaring one is the act of looking and
      // a pack whose rules find nothing here has still looked. `packs` is keyed by lang and loaded
      // once per language above, so two roots of one language contribute one entry and there is
      // nothing to deduplicate.
      hazardsScanned: [...packs]
        .filter(([, loaded]) => loaded.hazards !== undefined)
        .map(([lang]) => lang)
        .sort(compareStrings),
      // Merged across roots the way the counts inside one root are merged across files, so a
      // monorepo and a single root report the same arithmetic. Not deduplicated: two roots that
      // overlap and scan one file twice do read its names twice, which inflates both the numerator
      // and the denominator, and `empo index` already names that overlap as the defect it is.
      names: mergeNames(names),
    },
  };
}

/**
 * How many distinct nodes reference each node, the blast-radius headline number. Only non-zero
 * counts are stored, so a node absent from this map has a fan-in of zero and is an orphan candidate.
 *
 * **Distinct sources and not incoming edges**, which is a correction rather than a preference. An
 * edge is deduplicated per `(from, to, kind)` (engine/build.ts), so one file referencing another
 * through two edge families contributed two, and this document used to accept that as bounded and
 * rare: a php file that both `use`s a class and names it in a quoted string. The typescript pack's
 * JSX and Vue tags made it the common case instead, because a rendered component is nearly always
 * also imported, and the arithmetic then contradicted itself in print: `empo query` on a Vue
 * component rendered by the one page that imports it answered "fan-in 2 direct, 1 transitive (the
 * direct ones included)", where the transitive set is a set of nodes and can never be smaller than
 * a count of the nodes inside it.
 *
 * Both edges are still in the graph, and they are the answer to a different question: how a coupling
 * was found is what `kind` and `evidence` carry, and an import and a render are not the same fact
 * about a change. This number answers "how many things break if I change this", and that is a count
 * of things (docs/05-graph-model.md).
 */
export function computeFanin(edges: GraphEdge[]): Record<string, number> {
  const sources = new Map<string, Set<string>>();
  for (const edge of edges) {
    const bucket = sources.get(edge.to);
    if (bucket) bucket.add(edge.from);
    else sources.set(edge.to, new Set([edge.from]));
  }

  const fanin: Record<string, number> = {};
  for (const id of [...sources.keys()].sort(compareStrings)) fanin[id] = sources.get(id)?.size ?? 0;
  return fanin;
}

/** Two-space indent, trailing newline, and every map already sorted by the time it lands here. */
export function serializeGraph(graph: Graph): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

/**
 * Read a graph a previous `empo index` wrote. Every reading command goes through here.
 *
 * The parse is a cast and checks no key, so every field is whatever the file happened to hold. Two
 * of them arrived at schema 3 and are absent from every graph written before it, and the two are
 * repaired differently on purpose.
 *
 * `hazardsScanned` is coerced to the empty list, because absent and empty are one claim there:
 * no pack looked. A graph that predates the axis is a build during which no pack looked, so the
 * empty list is not a default standing in for the truth, it is the truth, and every reader can
 * iterate it without a guard.
 *
 * `hazards` is left exactly as parsed, missing key included, and that asymmetry is the point.
 * Absent means nobody looked and empty means somebody looked and found none, which are the two
 * answers the axis exists to separate (schema/types.ts). `empo query --hazards` reads the absence
 * as a null it prints a caveat for (commands/query.ts), and defaulting it here would hand that
 * reader a clean bill of health invented out of a field no run ever wrote.
 */
export function readGraph(repoRoot: string): Graph {
  const path = graphPath(repoRoot);
  if (!existsSync(path)) {
    throw configError("No graph found", [`Looked for ${path}`, "Run empo index first."]);
  }

  let parsed: Graph;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Graph;
  } catch (error) {
    throw configError(`${path} is not valid JSON`, [
      (error as Error).message,
      "Run empo index to rebuild it.",
    ]);
  }

  // Outside the catch, so a file that parses and a file that does not keep separate answers: the
  // message above is about the parse and nothing else. Anything that is not an array is treated as
  // no record at all, which is the rule `graphDrift` applies to a schema that is not a number, and
  // for the same reason: nothing guarantees this file was written by this program.
  if (Array.isArray(parsed.hazardsScanned)) return parsed;
  return { ...parsed, hazardsScanned: [] };
}

/**
 * How far behind HEAD a graph is, as two facts rather than as a sentence. The computation is split
 * from its rendering because more than one caller wants the answer and only one of them wants
 * prose: `empo doctor --json` has to put the same numbers in a document a hook reads, and a second
 * caller that re-ran the git call would be a second place for the rule to drift.
 *
 * Both fields are null on an unknown, never zero. A silent zero would claim the graph is current
 * (engine/git.ts says the same thing about `commitsAhead`), and a hook that read an unknown as
 * staleness would warn on every session in a checkout that is not a git repository.
 */
export interface Staleness {
  /** Full sha the graph was built against, or null when it was built outside a git repository. */
  builtAgainst: string | null;
  /** Commits HEAD has gained since, or null when git could not answer. */
  commitsBehind: number | null;
}

export function staleness(repoRoot: string, graph: Graph): Staleness {
  if (graph.builtAgainst === "") return { builtAgainst: null, commitsBehind: null };
  return {
    builtAgainst: graph.builtAgainst,
    commitsBehind: commitsAhead(repoRoot, graph.builtAgainst),
  };
}

/**
 * The staleness line every reading command prints. EmPo never silently serves a stale answer
 * (docs/02-on-disk-layout.md): it serves the answer and states its age.
 */
export function stalenessLine(repoRoot: string, graph: Graph): string {
  return stalenessLineFrom(staleness(repoRoot, graph));
}

/** The same line from an already-computed staleness, so no caller pays for a second git call. */
export function stalenessLineFrom(age: Staleness): string {
  if (age.builtAgainst === null) return "graph      built outside a git repository";

  const built = `built against ${shortSha(age.builtAgainst)}`;
  if (age.commitsBehind === null) return `graph      ${built}, distance from HEAD unknown`;
  if (age.commitsBehind === 0) return `graph      ${built}, current with HEAD`;
  const ahead = age.commitsBehind;
  return `graph      ${built}, HEAD is ${ahead} commit${ahead === 1 ? "" : "s"} ahead`;
}

/**
 * Every line an answer-serving command prints about the age of the answer above it: the git
 * distance, and then each reason the answer is out of date that git distance cannot see.
 *
 * `empo query` and `empo review` print this rather than `stalenessLine` alone because staleness
 * stopped being only a distance. A pack is data and a schema is a meaning, so either can move
 * without one tracked file moving, and a command that printed the git line by itself answered
 * "current with HEAD" over a graph this engine already calls stale. That is the failure the whole
 * staleness line exists to prevent, arriving through the line itself.
 *
 * `empo doctor` is deliberately not a caller. It prints these same facts, from the same two
 * renderers, in its own column layout: the node and edge counts ride on its graph line, so it
 * assembles that half itself and calls `driftLines` for the rest.
 */
export function stalenessLines(repoRoot: string, graph: Graph): string[] {
  const drift = graphDrift(graph);
  return [stalenessLine(repoRoot, graph), ...driftLines(drift.packs, drift.schema)];
}

/**
 * A pack whose version on disk is not the version the graph was built with.
 *
 * Git distance cannot see this. A pack is data, so changing it changes every answer derived from it
 * without changing a single tracked file in the repository being indexed: widening the php
 * `assertionTerms` moved one repository from 15 value-asserting test files to 393, and every
 * graph built before that keeps serving the old number on the same commit, reported healthy.
 */
export interface PackDrift {
  lang: string;
  /**
   * The version the graph records, or null when the graph names the pack and records no version for
   * it. `empo index` cannot write that: `sortedRecord` below substitutes "" for a missing value, and
   * a graph carrying no `packs` map at all throws before it reaches here and is reported unreadable.
   * So a null is a graph.json something other than `empo index` produced.
   */
  built: string | null;
  /** The version of the pack this binary would load now. */
  loaded: string;
}

/**
 * A pack the graph names whose pack.json is installed and will not load.
 *
 * Kept apart from drift because the two want opposite answers. Drift names a version to reindex to;
 * this one has none, and nothing downstream can even ask what the installed pack says. It used to
 * take the same silent path as a pack that is not installed at all, which left the one state where
 * every answer a rebuild would give is unknowable reported as a repository in perfect health.
 */
export interface UnloadablePack {
  lang: string;
  /** The loader's own words, message and details, so the reader is told which file and why. */
  reason: string;
}

/**
 * The graph's own schema, when it is not the one this binary writes. Shaped like `PackDrift` on
 * purpose: both are "what produced this file" against "what this installation would produce", and
 * both have to be able to say that the left-hand side is not recorded at all.
 */
export interface SchemaDrift {
  /** The schema the graph declares, or null when it declares none, or none that is a number. */
  built: number | null;
  /** The schema this binary writes, which is `GRAPH_SCHEMA`. */
  writes: number;
}

/** Everything about a graph's age that git distance cannot see, computed from the graph alone. */
export interface GraphDrift {
  /** Packs whose recorded version is not the installed one. Empty when nothing drifted. */
  packs: PackDrift[];
  /** Packs the graph names that are installed and will not load. Empty on a sound installation. */
  unloadable: UnloadablePack[];
  /** null when the graph carries the schema this binary writes, which is the ordinary case. */
  schema: SchemaDrift | null;
}

/**
 * How the installed version of a pack is looked up. One function with three outcomes, because there
 * are three facts here and each is answered differently: null is "no pack of that name is installed",
 * a string is the version to compare against, and a throw is a pack.json that is there and will not
 * load.
 *
 * It is a parameter with a default rather than a direct call, and that is worth stating so nobody
 * removes it as indirection nothing uses. Packs resolve out of the empo installation and never out
 * of the repository being indexed (engine/pack-loader.ts), so no test can build a repository whose
 * pack.json is invalid, and the throwing outcome is precisely the one that used to be swallowed.
 */
export type PackVersionReader = (lang: string) => string | null;

export const installedPackVersion: PackVersionReader = (lang) => {
  // `packAvailable` answers "is it installed" without opening the pack, so this is the one call
  // that separates an absent pack from a present one, before anything can throw about the contents.
  if (!packAvailable(lang)) return null;
  return loadPack(lang).version;
};

/**
 * What the graph on disk says produced it, against what this installation would produce now.
 *
 * The pack versions are read out of the graph rather than out of `packs.lock.json`, which
 * `empo index` writes beside it. The question here is whether the answers on disk are still the
 * answers a rebuild would give, and that is a property of the graph, so the baseline has to be what
 * the graph itself records. Nothing keeps a separate file in step with it afterwards: a graph copied
 * in from elsewhere, or an index that died between its two writes, leaves two files free to
 * disagree, and a drift report built on the wrong one would either invent drift or miss it. Read
 * from the graph, the comparison cannot be wrong about what produced these nodes, because the graph
 * cannot disagree with itself.
 *
 * That no code reads the lock is not an argument for dropping it. In a repository that commits
 * `generated/` (docs/02-on-disk-layout.md) it is the one tracked file whose diff names a pack bump,
 * where the same fact inside the graph is buried in a hundred kilobytes of regenerated nodes, and a
 * pack moving is precisely the staleness git cannot otherwise see.
 *
 * A pack the graph names and this installation does not have at all is skipped in silence. That is a
 * broken installation rather than a graph that has aged, `checkConfig` in engine/health.ts names it
 * in its own words, and answering "your pack moved" to a pack that is gone would send the reader to
 * reindex against nothing. A pack that is installed and will not load is not that state, and it used
 * to be swallowed by the same `catch`: it comes back in `unloadable` instead. Nothing else in the
 * codebase opens a pack.json on doctor's behalf, `packAvailable` answers as soon as the file exists
 * (engine/pack-loader.ts), and a doctor printing "OK  config is valid" over an unparseable pack was
 * reporting health it had never once looked for.
 */
export function graphDrift(
  graph: Graph,
  version: PackVersionReader = installedPackVersion,
): GraphDrift {
  const packs: PackDrift[] = [];
  const unloadable: UnloadablePack[] = [];

  for (const lang of Object.keys(graph.packs).sort(compareStrings)) {
    let loaded: string | null;
    try {
      loaded = version(lang);
    } catch (error) {
      // The loader's details as well as its message, the way engine/health.ts reports an unreadable
      // spine: "is not a valid pack" does not name the field, and the details do.
      const details = error instanceof EmpoError ? error.details : [];
      unloadable.push({ lang, reason: [(error as Error).message, ...details].join(" ") });
      continue;
    }
    if (loaded === null) continue;

    const built = graph.packs[lang] ?? null;
    if (built !== loaded) packs.push({ lang, built, loaded });
  }

  // `readGraph` casts without checking a key, so this field is whatever the file happened to hold.
  // Anything that is not a number is recorded as no schema at all rather than coerced into one: the
  // reader is being told which empo wrote the file, and inventing a number for it would be the same
  // stale answer in a more confident voice.
  const built = typeof graph.schema === "number" ? graph.schema : null;

  return {
    packs,
    unloadable,
    schema: built === GRAPH_SCHEMA ? null : { built, writes: GRAPH_SCHEMA },
  };
}

/**
 * One line per reason the graph is out of date that the staleness line above cannot state, in the
 * same shape as every other line on those surfaces: the fact, then the command that repairs it.
 *
 * They go directly under the age they contradict, because that line can say "current with HEAD" and
 * be right. A pack is data and a schema is a meaning, so neither moves a tracked file. Widening the
 * php `assertionTerms` moved one repository from 15 value-asserting test files to 393, and a graph
 * built before that keeps serving 15 on the same commit, reported healthy.
 *
 * Packs first and the schema last, so a reader who has seen this block before finds the pack lines
 * where they have always been, and `empo doctor`, `empo query` and `empo review` all word one state
 * identically because all three call this.
 */
export function driftLines(packs: PackDrift[], schema: SchemaDrift | null): string[] {
  const lines = packs.map((pack) => {
    // A graph that names a pack and records no version for it cannot say which one built it, and
    // guessing a version it never wrote down would be the same lie in a quieter voice.
    const built =
      pack.built === null
        ? `graph does not record which ${pack.lang} pack built it`
        : `graph built with ${pack.lang} pack ${pack.built}`;
    return `drift      ${built}, ${pack.loaded} is installed (run empo index)`;
  });

  if (schema !== null) lines.push(`drift      ${schemaDriftClause(schema)} (run empo index)`);

  return lines;
}

/**
 * The clause every surface opens a schema-drift sentence with, in one place so they cannot word one
 * state two ways. Doctor closes it with "(run empo index)" inside its fixed-width column and the
 * SessionStart hook follows it with the consequence, and that divergent tail is exactly where the
 * pack-drift wording, which is still held in step by hand, once grew a claim the data never carried.
 *
 * It refuses to guess a schema a graph never recorded, for the same reason `driftLines` refuses to
 * guess a pack version: naming a number the file does not hold would be the same stale answer in a
 * more confident voice.
 */
export function schemaDriftClause(schema: SchemaDrift): string {
  const built =
    schema.built === null
      ? "graph records no schema"
      : `graph was written at schema ${schema.built}`;
  return `${built}, this empo writes schema ${schema.writes}`;
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort(compareStrings)) sorted[key] = record[key] ?? "";
  return sorted;
}

function dedupeReports(reports: DuplicateNode[]): DuplicateNode[] {
  const byId = new Map<string, Set<string>>();
  for (const report of reports) {
    const bucket = byId.get(report.id) ?? new Set<string>();
    for (const file of report.files) bucket.add(file);
    byId.set(report.id, bucket);
  }

  return [...byId.keys()].sort(compareStrings).map((id) => ({
    id,
    files: [...(byId.get(id) ?? [])].sort(compareStrings),
  }));
}
