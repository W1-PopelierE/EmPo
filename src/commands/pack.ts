import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRoot } from "../engine/build";
import { fixturesDir, loadPack } from "../engine/pack-loader";
import { configError, gateFailure } from "../errors";
import type { GraphEdge, GraphNode, Hazard, NameResolution, Pack } from "../schema/types";

/**
 * `empo pack test <name>`: run a pack against its synthetic fixtures and diff the result against
 * the checked-in snapshot. This is the gate for every pack, built-in or community
 * (docs/04-language-packs.md).
 */

export interface FixtureSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * The third axis, held to the same snapshot as the other two. A pack's hazard rules are regexes
   * over source like every other rule it declares, and a rule that is gated by nothing is a rule
   * that can start reporting a transaction the framework never opened without one line of this
   * repository changing. A pack declaring no hazards snapshots an empty array, which is the same
   * shape a pack with rules and a corpus that trips none writes.
   */
  hazards: Hazard[];
  /**
   * The fourth axis, and the one a snapshot is the only possible gate for. A pack's name-resolving
   * rules refuse silently by design, so nothing about a corpus whose yield went to zero looks
   * different from a corpus with nothing to find: no edge disappears from a diff that was never
   * there. Pinning the counts makes the refusal itself the thing under the gate, so a rule that
   * stops resolving, or a fixture that quietly makes a name ambiguous, fails here rather than in
   * somebody's repository. A pack with no name-resolving rule snapshots an empty array.
   */
  names: NameResolution[];
}

/** The fixture corpus is a convention: <pack>/fixtures/src is the tree, expected.json the snapshot. */
export function runPackFixtures(name: string): { pack: Pack; actual: FixtureSnapshot } {
  const pack = loadPack(name);
  const source = join(fixturesDir(name), "src");

  if (!existsSync(source)) {
    throw configError(`Pack "${name}" has no fixture corpus`, [
      `Expected a source tree at ${source}`,
    ]);
  }

  const built = buildRoot({
    repoRoot: source,
    root: { path: ".", lang: pack.name },
    pack,
  });

  return {
    pack,
    actual: {
      nodes: built.nodes,
      edges: built.edges,
      hazards: built.hazards,
      names: built.names,
    },
  };
}

export function packTestCommand(name: string, options: { update?: boolean } = {}): void {
  const { pack, actual } = runPackFixtures(name);
  const snapshotPath = join(fixturesDir(name), "expected.json");

  console.log("");
  console.log(`pack       ${pack.name} ${pack.version}`);
  console.log(`fixtures   ${join(fixturesDir(name), "src")}`);
  console.log(
    `result     ${actual.nodes.length} nodes, ${actual.edges.length} edges, ` +
      `${actual.hazards.length} hazards`,
  );
  console.log("");

  if (options.update === true) {
    writeFileSync(snapshotPath, serialize(actual));
    console.log(`UPDATED  ${snapshotPath}`);
    return;
  }

  if (!existsSync(snapshotPath)) {
    throw configError(`Pack "${name}" has no expected.json`, [
      `Write the snapshot first, or run: empo pack test ${name} --update`,
    ]);
  }

  const expected = parseSnapshot(snapshotPath);
  if (serialize(actual) === serialize(expected)) {
    console.log(`OK  matches ${snapshotPath}`);
    return;
  }

  throw gateFailure(`Pack "${name}" does not match its fixture snapshot`, [
    ...differences(expected, actual),
    "",
    `Run: empo pack test ${name} --update  (only after checking every line above)`,
  ]);
}

function parseSnapshot(path: string): FixtureSnapshot {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    // A snapshot written before an axis existed carries no key, and it reads as an empty list
    // rather than as a failure: it was written by a pack that declared no hazard rules, so there is
    // nothing it could have recorded and nothing for the diff below to find. `names` follows it,
    // and this is deliberately not the rule `Graph.names` follows, whose absence has to stay
    // readable: a snapshot is regenerated from a corpus this repository owns, so the counts
    // arriving read as a diff somebody reviews, not as an answer served about a repository.
    return {
      nodes: parsed.nodes ?? [],
      edges: parsed.edges ?? [],
      hazards: parsed.hazards ?? [],
      names: parsed.names ?? [],
    };
  } catch (error) {
    throw configError(`${path} is not valid JSON`, [(error as Error).message]);
  }
}

/** Deterministic serialization, matching the rules in docs/14-implementation-notes.md. */
function serialize(snapshot: FixtureSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function differences(expected: FixtureSnapshot, actual: FixtureSnapshot): string[] {
  const lines: string[] = [];

  const expectedNodes = new Map(expected.nodes.map((node) => [node.id, node]));
  const actualNodes = new Map(actual.nodes.map((node) => [node.id, node]));

  for (const id of expectedNodes.keys()) {
    if (!actualNodes.has(id)) lines.push(`missing node     ${id}`);
  }
  for (const [id, node] of actualNodes) {
    const counterpart = expectedNodes.get(id);
    if (counterpart === undefined) lines.push(`unexpected node  ${id}`);
    else if (JSON.stringify(counterpart) !== JSON.stringify(node)) {
      lines.push(`changed node     ${id}`);
      lines.push(`  expected  ${JSON.stringify(counterpart)}`);
      lines.push(`  actual    ${JSON.stringify(node)}`);
    }
  }

  const expectedEdges = new Map(expected.edges.map((edge) => [edgeKey(edge), edge]));
  const actualEdges = new Map(actual.edges.map((edge) => [edgeKey(edge), edge]));

  for (const [key, edge] of expectedEdges) {
    if (!actualEdges.has(key)) lines.push(`missing edge     ${key} at ${evidenceOf(edge)}`);
  }
  for (const [key, edge] of actualEdges) {
    const counterpart = expectedEdges.get(key);
    if (counterpart === undefined) lines.push(`unexpected edge  ${key} at ${evidenceOf(edge)}`);
    else if (evidenceOf(counterpart) !== evidenceOf(edge)) {
      lines.push(
        `moved edge       ${key}: expected ${evidenceOf(counterpart)}, got ${evidenceOf(edge)}`,
      );
    }
  }

  const expectedHazards = new Map(expected.hazards.map((hazard) => [hazardKey(hazard), hazard]));
  const actualHazards = new Map(actual.hazards.map((hazard) => [hazardKey(hazard), hazard]));

  // Keyed on the dispatch site rather than on the whole record, so a hazard whose target stopped
  // resolving reads as one changed line and not as two unrelated ones. That is the difference
  // between "the job resolution rule broke" and "a hazard appeared out of nowhere".
  for (const key of expectedHazards.keys()) {
    if (!actualHazards.has(key)) lines.push(`missing hazard   ${key}`);
  }
  for (const [key, hazard] of actualHazards) {
    const counterpart = expectedHazards.get(key);
    if (counterpart === undefined) lines.push(`unexpected hazard ${key}`);
    else if (JSON.stringify(counterpart) !== JSON.stringify(hazard)) {
      lines.push(`changed hazard   ${key}`);
      lines.push(`  expected  ${JSON.stringify(counterpart)}`);
      lines.push(`  actual    ${JSON.stringify(hazard)}`);
    }
  }

  // Keyed on the family, because that is the unit the tally has one record of and the unit a reader
  // repairs: the whole record printed on both sides is what says which of the four numbers moved,
  // and a count that moved is the only thing a corpus can report about a refusal.
  const expectedNames = new Map(expected.names.map((report) => [report.family, report]));
  const actualNames = new Map(actual.names.map((report) => [report.family, report]));

  for (const [family, report] of expectedNames) {
    if (!actualNames.has(family)) {
      lines.push(`missing names    ${family}: ${JSON.stringify(report)}`);
    }
  }
  for (const [family, report] of actualNames) {
    const counterpart = expectedNames.get(family);
    if (counterpart === undefined) {
      lines.push(`unexpected names ${family}: ${JSON.stringify(report)}`);
    } else if (JSON.stringify(counterpart) !== JSON.stringify(report)) {
      lines.push(`changed names    ${family}`);
      lines.push(`  expected  ${JSON.stringify(counterpart)}`);
      lines.push(`  actual    ${JSON.stringify(report)}`);
    }
  }

  return lines;
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from} -> ${edge.to} (${edge.kind})`;
}

function evidenceOf(edge: GraphEdge): string {
  return `${edge.evidence.file}:${edge.evidence.line}`;
}

function hazardKey(hazard: Hazard): string {
  return `${hazard.file}:${hazard.line} dispatches ${hazard.job}`;
}
