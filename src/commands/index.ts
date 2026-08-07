import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bridgeLines } from "../engine/bridger";
import type { DuplicateNode } from "../engine/build";
import { loadConfig } from "../engine/config";
import { shortSha } from "../engine/git";
import { buildGraph, graphPath, LOCK_PATH, serializeGraph } from "../engine/graph";
import { nameLines } from "../engine/names";
import { loadPack } from "../engine/pack-loader";
import { gateFailure } from "../errors";
import type { Graph } from "../schema/types";

/**
 * `empo index`: rebuild .empo/generated/graph.json from source. Deterministic, no network, no LLM
 * (docs/06-cli.md). The command file is index.ts to match the command name, but the export is
 * `indexCommand`, because `index` is a loaded module name in JS.
 */

export interface IndexOptions {
  /** Exit 1 if the graph on disk is not what a rebuild would produce. A CI staleness gate. */
  check?: boolean;
}

export function indexCommand(repoRoot: string, options: IndexOptions = {}): void {
  const { config, path: configPath } = loadConfig(repoRoot);
  const { graph, duplicates, bridges } = buildGraph({ repoRoot, config });
  const serialized = serializeGraph(graph);

  const coverage = Object.values(graph.coverage);
  const reached = coverage.filter((entry) => entry.reaches).length;
  const blind = coverage.filter((entry) => entry.blind);

  console.log("");
  console.log(`config     ${configPath}`);
  console.log(`roots      ${graph.roots.map((r) => `${r.path} (${r.lang})`).join(", ")}`);
  console.log(
    `graph      ${graph.stats.files} files, ${graph.stats.nodes} nodes, ` +
      `${graph.stats.edges} edges, ${graph.stats.bridgedEdges} bridged`,
  );
  // The reached count is the denominator `blind` is a numerator of, and it is here for the reason
  // `flowsConsidered` is in commands/query.ts: a flow no test reaches at all can never be blind, so
  // `8 defined, 0 blind` is printed both by the repository whose every flow is asserted on and by
  // the one nothing tests, and those are opposite results. Printed on every run and not only on the
  // zero, because a denominator that appears only in the good case is one nobody learns to look for.
  // Two numbers rather than query's three: `asserting` is `reached` minus `blind` here, since a flow
  // asserts on a value only through a test that reaches it (engine/coverage.ts).
  console.log(
    `flows      ${Object.keys(graph.flows).length} defined, ${reached} reached by a test, ` +
      `${blind.length} blind` +
      (blind.length > 0 ? `: ${blind.map((entry) => entry.flow).join(", ")}` : ""),
  );
  // Beside the flow line rather than among the warnings below, because a family that refuses is not
  // a defect the way a duplicated node id is: a vendor component resolving to nothing is the
  // strategy working. What the reader needs is the ratio, on every run, so the run where it collapses
  // reads as a change rather than as the first time anybody looked.
  for (const line of nameLines(graph.names)) console.log(line);
  console.log(`built      ${describeBuild(graph)}`);
  console.log("");

  for (const line of duplicateLines(duplicates, graph.roots)) console.log(line);
  for (const line of bridgeLines(bridges)) console.log(line);

  if (options.check === true) {
    checkAgainstDisk(repoRoot, graph, serialized);
    console.log("OK  graph on disk is current");
    return;
  }

  const target = graphPath(repoRoot);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serialized);
  writeFileSync(join(repoRoot, LOCK_PATH), serializeLock(graph));

  console.log(`OK  wrote ${target}`);
}

/**
 * Two conditions arrive in one list and they call for different repairs, so they get different
 * sentences. The count decides which: `dedupeReports` in engine/graph.ts unions the paths per id,
 * so a report naming one file is not two files claiming an id at all. It is one file scanned more
 * than once, because a configured root contains another, and the repair is a root or an ignore
 * rather than a rename. The old line said "two files claim node id X" over both and then printed
 * the same path on both of its lines, which read as a contradiction and sent the reader looking
 * for a second file that does not exist.
 */
function duplicateLines(
  duplicates: DuplicateNode[],
  roots: { path: string; lang: string }[],
): string[] {
  const lines: string[] = [];
  // Filled by `rootsContaining` as it needs them, once per language rather than once per root:
  // reading a pack is a file read, and the run that prints nothing here at all is the normal one.
  const extensions = new Map<string, string[]>();

  for (const duplicate of duplicates) {
    const files = duplicate.files;

    if (files.length > 1) {
      lines.push(
        `warn   ${files.length} files claim node id "${duplicate.id}": ${files.join(", ")}`,
      );
      lines.push(`       only ${files[0]} is in the graph. Rename one or change the id rule.`);
      continue;
    }

    // The roots are named rather than counted alone, because "narrow a root" is only actionable
    // once the reader knows which two.
    const file = files[0] ?? "";
    const containing = rootsContaining(file, roots, extensions);
    const distinct = [...new Set(containing)];

    if (distinct.length > 1) {
      lines.push(
        `warn   node id "${duplicate.id}" is claimed by one file that ` +
          `${distinct.length} roots scan: ${file}`,
      );
      lines.push(`       roots ${quoteAll(distinct)} overlap. Narrow one or add an ignore.`);
      continue;
    }

    // One root, declared more than once. schema/config.schema.ts flattens `apps/api` and `apps/api/`
    // to one string while the config is validated but leaves both entries standing, so the file is
    // scanned once per entry and two roots really are named here. Told they overlap, the reader gets
    // `roots "apps/api" and "apps/api" overlap. Narrow one or add an ignore.`, which asks them to
    // narrow one of two roots that are one root, and cannot even show the two spellings they wrote,
    // because those are gone by the time the graph records a path. It is a different defect with a
    // different repair, so it says so and counts the declarations instead of naming them twice.
    if (containing.length > 1) {
      lines.push(
        `warn   node id "${duplicate.id}" is claimed by one file that root ` +
          `${quoteAll(distinct)} scans ${containing.length} times: ${file}`,
      );
      lines.push(
        `       ${quoteAll(distinct)} is declared ${containing.length} times in the config. ` +
          "Remove all but one.",
      );
      continue;
    }

    // Defensive, and no config reaches it. Do not go looking for the case: a single-file report
    // means two nodes carried the identical `file` string, engine/scanner.ts builds that string out
    // of the scanning root's own path, and schema/config.schema.ts has already flattened that path
    // into the spelling graph.roots carries. So a file always starts with the path of the root that
    // found it, and its pack read the file or there would be no node, which are the two things
    // `rootsContaining` asks: it always names at least that root. Two nodes on one path means
    // the path was scanned twice, one root scans a path once because globSync deduplicates across
    // its patterns, so the second scan came from a second declared root, which contains the file by
    // the same rule. That is two entries, and the two branches above have taken both of the ways two
    // entries can read: two different paths, or one path declared twice.
    //
    // It is kept rather than deleted because a count is a fact about data and this one has to be
    // handled: the alternative below one is "1 roots scan" followed by `roots "apps/api" overlap`,
    // which names a repair the config cannot support, and inventing an explanation nobody can act
    // on is the defect this whole function exists to avoid.
    lines.push(
      `warn   node id "${duplicate.id}" is claimed by one file that was scanned ` +
        `more than once: ${file}`,
    );
    lines.push("       no two configured roots contain it, so the overlap is not in the roots.");
  }

  return lines;
}

/**
 * The configured roots a repo-relative path falls under, in the order the graph records them. One
 * entry per declaration, repeats included, because the caller needs both numbers: how many roots
 * contain the file, and how many times the file was scanned. Deduplicating here would hide the
 * second one and there would be nothing left to tell a doubled declaration from a single root.
 *
 * "Falls under" is the path prefix *and* the extension, because that is all engine/build.ts scans
 * with: it hands the pack's `match.extensions` to the scanner, which globs one recursive `*.php`
 * pattern per entry, so a suffix test here asks that same question of one path. Prefix alone counted
 * a typescript root `.` standing over a php root among the roots that produced a duplicated `.php`
 * node. The warning
 * then said three roots scan a file two of them scan, and asked the reader to narrow one of three
 * roots, one of which had never read a file of that extension in its life. Advice nobody can act on
 * is the thing this whole function is here to avoid.
 *
 * A `.` root is a prefix of everything and so is not spelled as one. The empty string is not tested
 * for any more: schema/config.schema.ts refuses a root path that is empty and lands every spelling
 * of the repository root on `.`, so that guard matched no config and hid the fact that `.` is the
 * one spelling to handle.
 */
function rootsContaining(
  file: string,
  roots: { path: string; lang: string }[],
  extensions: Map<string, string[]>,
): string[] {
  return roots
    .filter(
      (root) =>
        (root.path === "." || file === root.path || file.startsWith(`${root.path}/`)) &&
        scannedBy(root.lang, file, extensions),
    )
    .map((root) => root.path);
}

/**
 * Would this root's pack have read this file? The pack is loaded rather than guessed at, and it
 * cannot be the first failure of the run: `buildGraph` above has already loaded the pack of every
 * configured root to produce the duplicates being explained here.
 */
function scannedBy(lang: string, file: string, extensions: Map<string, string[]>): boolean {
  let owned = extensions.get(lang);
  if (owned === undefined) {
    owned = loadPack(lang).match.extensions;
    extensions.set(lang, owned);
  }
  return owned.some((extension) => file.endsWith(extension));
}

function quoteAll(paths: string[]): string {
  const quoted = paths.map((path) => `"${path}"`);
  const last = quoted[quoted.length - 1];
  if (quoted.length < 2 || last === undefined) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * The gate compares bytes, not just counts: a graph is only current if a rebuild would produce
 * exactly this file. The reasons are separated because "HEAD moved" and "the code changed" call
 * for different reactions from whoever is reading the CI log.
 */
function checkAgainstDisk(repoRoot: string, graph: Graph, serialized: string): void {
  const target = graphPath(repoRoot);
  if (!existsSync(target)) {
    throw gateFailure("No graph on disk", [`Expected ${target}`, "Run empo index."]);
  }

  const onDisk = readFileSync(target, "utf8");
  if (onDisk === serialized) return;

  const details: string[] = [];
  const { graph: previous, reason } = parsePrevious(onDisk, target);

  if (previous === null) {
    details.push(reason);
  } else {
    if (previous.builtAgainst !== graph.builtAgainst) {
      details.push(
        `built against ${shortSha(previous.builtAgainst)}, a rebuild would say ` +
          `${shortSha(graph.builtAgainst)}`,
      );
    }
    if (previous.stats.nodes !== graph.stats.nodes || previous.stats.edges !== graph.stats.edges) {
      details.push(
        `nodes ${previous.stats.nodes} -> ${graph.stats.nodes}, ` +
          `edges ${previous.stats.edges} -> ${graph.stats.edges}`,
      );
    } else if (details.length === 0) {
      details.push("same node and edge counts, but the contents differ");
    }
  }

  throw gateFailure("Graph is stale", [...details, "Run empo index."]);
}

function describeBuild(graph: Graph): string {
  if (graph.builtAgainst === "") return "not a git repository, no staleness tracking";
  const subject = graph.builtAtCommitSubject === "" ? "" : ` "${graph.builtAtCommitSubject}"`;
  return `${shortSha(graph.builtAgainst)}${subject}`;
}

/** Machine-owned like the graph: which pack versions produced it (docs/02-on-disk-layout.md). */
function serializeLock(graph: Graph): string {
  return `${JSON.stringify({ schema: 1, packs: graph.packs }, null, 2)}\n`;
}

/**
 * A graph that does not parse and a graph that parses but is not a graph are different failures, so
 * they get different sentences. Telling someone their hand-truncated file "is not valid JSON" sends
 * them looking for a syntax error that is not there.
 */
function parsePrevious(source: string, path: string): { graph: Graph | null; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { graph: null, reason: `${path} is not valid JSON` };
  }

  const graph = parsed as Graph;
  if (graph === null || typeof graph !== "object" || graph.stats === undefined) {
    return { graph: null, reason: `${path} parses but has no stats block, so it is not a graph` };
  }

  return { graph, reason: "" };
}
