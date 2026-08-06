import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { type EmpoConfig, normalizeRepoPath } from "../schema/config.schema";
import type { ProposalFile } from "../schema/proposal.schema";
import { parseSpineFile, type SpineFile } from "../schema/spine.schema";
import type { FlowDefinition, Graph } from "../schema/types";
import { type Citation, checkCitation } from "./citations";
import { assignFlows, loadFlows, matchesDeclaredPath } from "./flows";
import { compareStrings } from "./order";
import { spineCitations, spinesDir } from "./spines";

/**
 * The gate over step 5 of `empo init` (docs/06-cli.md): the agent proposes flows and spine
 * skeletons, and nothing it proposed reaches `.empo/` until the graph and the real source agreed
 * with it. This is the shape `empo review`'s findings gate already proved, for the same reason
 * (docs/00-overview.md principle 2): a proposal is a claim, and a claim is worth nothing until
 * something checked it. The difference is only in what the claim is about. A finding claims a defect
 * at a line; a proposal claims that a directory holds a journey and that a chain runs through these
 * coordinates, and both fail the same way, by naming somewhere that is not there.
 *
 * Two rules carry the whole module. A flow path that matches no node in the graph is dropped,
 * because a journey pointing at a directory that does not exist is the fiction this tool exists to
 * prevent. A spine citation is resolved by the same checker `empo verify` uses (engine/citations.ts):
 * one that moved is corrected to the line its anchor is really on, one that is nowhere kills the
 * whole spine.
 *
 * The gate decides only what is eligible, never what lands. It returns a verdict per flow and per
 * spine, with the reason attached to each, so the caller can print the diff a human approves and
 * `applyProposal` writes nothing the human's own files already own. That is what "never as fait
 * accompli" means in docs/06.
 */

/**
 * A dropped path and why it was dropped, which travel together because the path alone is the
 * message that was wrong. A flow mixing a code path with a test-only path keeps the flow, so the
 * reason used to be computed only when *every* path failed and the reader of a kept flow was told
 * the path "matches no node", untrue of a directory whose nodes are all tests.
 */
export interface UnmatchedPath {
  path: string;
  reason: string;
}

export interface FlowVerdict {
  name: string;
  label?: string;
  /** The paths that survived, in the order proposed. */
  paths: string[];
  /** Proposed paths that matched no node, dropped, each with the reason it matched none. */
  unmatched: UnmatchedPath[];
  /** Nodes the surviving paths cover. */
  nodes: number;
  kept: boolean;
  /** Why it was dropped, or how it differs from what is already on disk. */
  note?: string;
  /** True when flows.json already defines this name. */
  existing: boolean;
}

export interface SpineVerdict {
  name: string;
  kept: boolean;
  /** Citations whose anchor moved and were corrected to the line the anchor is really on. */
  corrected: number;
  /** Citations whose anchor is nowhere, which is what kills the spine. */
  fictional: string[];
  /** The spine as it would be written, with corrections applied. */
  spine: SpineFile;
  note?: string;
}

export interface ProposalResult {
  flows: FlowVerdict[];
  spines: SpineVerdict[];
}

export function gateProposal(
  repoRoot: string,
  config: EmpoConfig,
  graph: Graph,
  proposal: ProposalFile,
): ProposalResult {
  // Read from disk, not from graph.flows: the graph is as old as the last index, and the question
  // being asked is whether the human's file already owns this name.
  const onDisk = loadFlows(repoRoot, config.flows);

  return {
    // Sorted, because a JSON object's key order is not something a verdict should inherit. The
    // spines arrived as an array and keep the order they were proposed in.
    flows: Object.entries(proposal.flows)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([name, definition]) => gateFlow(repoRoot, config, graph, name, definition, onDisk)),
    spines: proposal.spines.map((spine) => gateSpine(repoRoot, config, spine)),
  };
}

function gateFlow(
  repoRoot: string,
  config: EmpoConfig,
  graph: Graph,
  name: string,
  definition: FlowDefinition,
  onDisk: Record<string, FlowDefinition>,
): FlowVerdict {
  const covered = new Set<string>();
  const paths: string[] = [];
  const unmatched: UnmatchedPath[] = [];

  for (const path of definition.paths) {
    // Each path is asked about on its own, never as a set. assignFlows gives a node to the longest
    // matching prefix, so judging the whole flow at once would let `apps/api/app/Models` swallow
    // every node `apps/api` matched and report the wider path as matching nothing. That would be
    // the gate discarding a true path over an artefact of its own bookkeeping. One key, one path,
    // and the matcher is engine/flows.ts's, so the gate's answer and the graph's cannot disagree.
    const matched = assignFlows(graph.nodes, { [path]: { paths: [path] } })[path] ?? [];
    if (matched.length === 0) {
      unmatched.push({ path, reason: whyUnmatched(repoRoot, graph, path) });
      continue;
    }
    paths.push(path);
    for (const id of matched) covered.add(id);
  }

  const existing = onDisk[name] !== undefined;
  const notes: string[] = [];

  // Either way the note says the flow itself is dead rather than merely thinned, which is the one
  // thing no other field carries, and `changeNote` may still be appended after it. A flow that
  // stated no paths has to name itself, because it produced no `unmatched` entry for anything else
  // to name it by. A flow that stated paths and lost them all names none of them: each dropped path
  // already carries its reason on `unmatched`, and the printer puts one `dropped:` line per entry
  // directly above this note. Quoting the pairs here printed every reason twice, verbatim and
  // adjacent, which reads as two separate verdicts on one path.
  if (definition.paths.length === 0) {
    notes.push(`"${name}" states no paths, so no node could ever belong to it.`);
  } else if (paths.length === 0) {
    notes.push("no proposed path matches a node in the graph.");
  }
  if (existing) notes.push(changeNote(config, name, onDisk[name]?.paths ?? [], paths));

  return {
    name,
    ...(definition.label === undefined ? {} : { label: definition.label }),
    paths,
    unmatched,
    nodes: covered.size,
    kept: paths.length > 0,
    ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
    existing,
  };
}

/**
 * The three ways a path matches nothing are not the same mistake and are not fixed the same way. A
 * path with nothing behind it is an agent inventing a directory. A path whose only nodes are tests
 * is a journey named by its suite rather than its code, since engine/flows.ts assigns no test node
 * to a flow. A path that is really there and holds no node at all means the graph is stale, or that
 * tree is under no configured root, and the human should re-index or add a root rather than delete a
 * true path from the proposal.
 *
 * The middle answer is worded as a fact about the graph and not about the directory, because the
 * check reads the graph. A directory holding a colocated test beside source no pack matches (a
 * `.js` file under the typescript pack) satisfies it too, and telling that reader the directory
 * holds only tests would hide the extension list, which is where the repair actually is.
 *
 * The third answer is also where a path lands that is spelled in a way the filesystem accepts and the
 * matcher does not, because `join` is more forgiving than a string comparison: a leading `/`, an
 * interior `..`, a case a case-insensitive filesystem folds. Each of those exists on disk, matches no
 * node, and sends the reader to re-index over what is really a typo. A leading `./` used to be the
 * common one and is no longer: `normalizeRepoPath` in schema/config.schema.ts flattens it off a
 * declared path and off a configured root alike, so `./apps/api` and `apps/api` claim the same nodes
 * whichever of the two a human spelled that way, and neither arrives here. The rest stay rare, and a
 * guess in the message about which spelling was meant would be its own wrong repair, so they are
 * named here for the next reader instead of in what the human is told.
 *
 * The graph is asked before the disk, and the existence check is the matcher's rule rather than
 * `existsSync` alone. Both of those are the same fact: a declared path may be spelled without an
 * extension and still name exactly one thing, because the boundary rule the caller above just matched
 * this path with claims `app/Models/Order.php` for `app/Models/Order` (engine/flows.ts,
 * docs/05-graph-model.md). The filesystem does not know that rule. Asked first, it answered for
 * `apps/api/tests/Feature/OrderTest` that there is no file or directory of that name, which tells a
 * human an agent invented a path the graph holds one node under, and it hid the test-only answer
 * behind the spelling a proposal is most likely to use for a single class. Asked with `existsSync`
 * alone, it says the same about `apps/web/src/checkout` when `checkout.ts` is sitting right there
 * under no configured root, which is the third answer's case and not the first's. The three answers
 * and their wording are unchanged; only which of them a path lands on is.
 */
function whyUnmatched(repoRoot: string, graph: Graph, path: string): string {
  if (graph.nodes.some((node) => node.isTest && matchesDeclaredPath(node.file, path))) {
    return "every node the graph holds under it is a test, and a flow is the code of a journey rather than its tests";
  }

  if (!claimsSomethingOnDisk(repoRoot, path)) return "no file or directory of that name";

  return "exists on disk, but nothing under it is a node in the graph";
}

/**
 * Is there anything on disk this path claims, by the rule the matcher above uses? That is `existsSync`
 * plus the one spelling `existsSync` cannot see: an extension-less path claims its `prefix.ext`
 * sibling, so `apps/web/src/checkout` claims `checkout.ts` and answering "no file of that name" over
 * it is a wrong verdict about a file the reader can open.
 *
 * The listing is read only when the path itself is absent, so the common case is one `stat`. The
 * parent can exist and not be a directory (`a/b.ts/c`), which is a path that claims nothing and is
 * also the one case `readdirSync` throws on rather than returning empty.
 */
function claimsSomethingOnDisk(repoRoot: string, path: string): boolean {
  const absolute = join(repoRoot, path);
  if (existsSync(absolute)) return true;

  const prefix = `${basename(absolute)}.`;
  try {
    return readdirSync(dirname(absolute)).some((entry) => entry.startsWith(prefix));
  } catch {
    return false;
  }
}

/**
 * flows.json is human-owned, so a proposal for a name it already holds is a change to approve, never
 * a merge to perform. The note is that change spelled out, because "already exists" alone leaves the
 * human diffing two files by eye.
 *
 * The two sides are compared flattened, by the rule engine/flows.ts matches with. A raw string
 * comparison read `./apps/api` against an on-disk `apps/api` as one path added and one dropped, which
 * is a change of nothing at all reported as a change of two things: both spellings claim an identical
 * set of nodes. A human asked to approve that has to know the matcher's spelling rule to see that
 * there is nothing to approve, and the note exists precisely so they do not have to.
 */
function changeNote(config: EmpoConfig, name: string, before: string[], after: string[]): string {
  const known = new Set(before.map(normalizeRepoPath));
  const proposed = new Set(after.map(normalizeRepoPath));
  const added = after.filter((path) => !known.has(normalizeRepoPath(path)));
  const dropped = before.filter((path) => !proposed.has(normalizeRepoPath(path)));
  const parts = [
    `${config.flows} already defines "${name}" and the file is the human's, so the entry on disk stands.`,
    added.length === 0 ? "This proposal adds no path" : `This proposal adds ${added.join(", ")}`,
    dropped.length === 0 ? "and drops none." : `and drops ${dropped.join(", ")}.`,
  ];
  return parts.join(" ");
}

function gateSpine(repoRoot: string, config: EmpoConfig, proposed: SpineFile): SpineVerdict {
  const checks = spineCitations(proposed).map((entry) => ({
    ...entry,
    check: checkCitation(repoRoot, entry.citation),
  }));

  // Keyed by the coordinate, not by position in the list. checkCitation is a pure function of
  // (file, line, anchor), so two hops citing one line get one answer, and pairing a result back to
  // its field by index would silently mis-apply a correction the day the enumeration order changes.
  const corrections = new Map<string, number>();
  const fictional: string[] = [];
  let corrected = 0;

  for (const entry of checks) {
    if (entry.check.status === "moved" && entry.check.actualLine !== null) {
      corrections.set(coordinate(entry.citation), entry.check.actualLine);
      corrected += 1;
      continue;
    }
    if (entry.check.status === "verified") continue;
    // Named, so the human reading the verdict sees what was invented rather than a count.
    fictional.push(`${entry.where}: ${entry.check.note}`);
  }

  // Re-validated rather than trusted: what a generator hands a human to approve has to satisfy the
  // schema that will refuse it at load, or the proposal is a file nobody can use.
  const spine = parseSpineFile(
    correctLines(proposed, corrections),
    `the proposed spine "${proposed.name}"`,
  );

  const target = spineTarget(repoRoot, config, spine.name);
  const notes: string[] = [];

  if (!target.contained) {
    notes.push(
      `"${spine.name}" is not a file name, and a spine's name is the file it lives in ` +
        "(docs/08-spines.md), so nothing could be written for it.",
    );
  }
  if (fictional.length > 0) {
    // One invented coordinate holds back the whole skeleton. A hop is a `file:line` a human opens
    // to locate themselves before changing anything, and a map handed over for approval with one
    // coordinate that leads nowhere costs more than the true hops beside it save: the reader stops
    // trusting the ones that were right. The skeleton still comes back in `spine`, so nothing is
    // lost, it is simply not written.
    notes.push(
      `${fictional.length} citation${fictional.length === 1 ? "" : "s"} could not be resolved ` +
        "against the source, so the whole skeleton is held back for a human to check.",
    );
  }
  if (target.exists) {
    notes.push(
      `${target.path} already exists. A spine is human-owned and appended in place ` +
        "(docs/08-spines.md), so a generator never writes over one.",
    );
  }

  return {
    name: spine.name,
    kept: notes.length === 0,
    corrected,
    fictional,
    spine,
    ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
  };
}

/**
 * A drifted coordinate is repaired, exactly as `empo review` repairs a finding's citation
 * (docs/14-implementation-notes.md): the quoted source is there and only the line number slipped, so
 * the skeleton survives pointing at the line the human will actually open.
 */
function correctLines(spine: SpineFile, corrections: Map<string, number>): SpineFile {
  if (corrections.size === 0) return spine;

  return {
    ...spine,
    hops: spine.hops.map((hop) => ({ ...hop, line: corrections.get(coordinate(hop)) ?? hop.line })),
    invariants: spine.invariants.map((invariant) => {
      const citation = invariant.citation;
      if (citation === undefined) return invariant;
      return {
        ...invariant,
        citation: { ...citation, line: corrections.get(coordinate(citation)) ?? citation.line },
      };
    }),
    traps: spine.traps.map((trap) => ({
      ...trap,
      line: corrections.get(coordinate(trap)) ?? trap.line,
    })),
  };
}

/**
 * The key a correction is looked up by, joined on a NUL and written as an escape rather than as the
 * byte, which is the rule engine/build.ts states at `dedupeEdges` and the reason it states it: a
 * source file holding a literal NUL is a file git calls binary and stops diffing, and this one is
 * where a reviewer goes to see what a gate did or did not keep. A NUL and not a space, because an
 * anchor is a line of source and a line of source holds spaces, so joining on one would let two
 * citations that differ only in where the anchor starts collapse onto a single key and correct the
 * wrong hop.
 */
function coordinate(citation: Citation): string {
  return `${citation.file}\u0000${citation.line}\u0000${citation.anchor}`;
}

export interface AppliedFile {
  path: string;
  state: "wrote" | "kept";
}

/** Writes only what `gateProposal` kept. Never overwrites a human-owned spine file. */
export function applyProposal(
  repoRoot: string,
  config: EmpoConfig,
  result: ProposalResult,
): AppliedFile[] {
  const applied: AppliedFile[] = [];

  const flows = applyFlows(repoRoot, config, result.flows);
  if (flows !== null) applied.push(flows);

  for (const verdict of result.spines) {
    if (!verdict.kept) continue;

    const target = spineTarget(repoRoot, config, verdict.name);
    // Checked again here, not only in the gate. The verdict may have been built minutes ago, and
    // between the human approving it and this call a spine of that name can appear. A generator
    // that overwrites a curated spine destroys the one artifact in EmPo nothing can regenerate.
    if (!target.contained || existsSync(target.absolute)) {
      applied.push({ path: target.path, state: "kept" });
      continue;
    }

    mkdirSync(dirname(target.absolute), { recursive: true });
    writeFileSync(target.absolute, serialize(spineDocument(verdict.spine)), "utf8");
    applied.push({ path: target.path, state: "wrote" });
  }

  return applied;
}

function applyFlows(
  repoRoot: string,
  config: EmpoConfig,
  verdicts: FlowVerdict[],
): AppliedFile | null {
  const kept = verdicts.filter((verdict) => verdict.kept);
  if (kept.length === 0) return null;

  const absolute = join(repoRoot, config.flows);
  const path = repoRelative(repoRoot, absolute);
  const onDisk = loadFlows(repoRoot, config.flows);

  // An entry already on disk wins, so a proposal that only restates what the human wrote changes
  // nothing at all. Rewriting the file to reorder its keys would put a machine's diff on a
  // human-owned file for no gain, so that case does not write.
  const additions = kept.filter((verdict) => onDisk[verdict.name] === undefined);
  if (additions.length === 0) return { path, state: "kept" };

  const merged: Record<string, FlowDefinition> = {};
  for (const verdict of additions) {
    merged[verdict.name] = {
      ...(verdict.label === undefined ? {} : { label: verdict.label }),
      // Only what survived: writing a path the graph could not match would put the fiction the
      // gate just caught into the file it was protecting.
      paths: verdict.paths,
    };
  }
  for (const [name, definition] of Object.entries(onDisk)) merged[name] = definition;

  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, serialize(flowsDocument(merged)), "utf8");
  return { path, state: "wrote" };
}

interface SpineTarget {
  absolute: string;
  /** Repo-relative, so every message names the path a human would open. */
  path: string;
  exists: boolean;
  /**
   * Whether `<name>.json` stays inside the spines directory. The name comes from a file an agent
   * wrote, so it is checked before it is used to build a path to write to, the way citations.ts
   * checks a cited file before reading it: resolve and compare, so `a/../../x` is caught as surely
   * as `../x`.
   */
  contained: boolean;
}

function spineTarget(repoRoot: string, config: EmpoConfig, name: string): SpineTarget {
  const dir = resolve(spinesDir(repoRoot, config));
  const absolute = resolve(dir, `${name}.json`);
  // The file has to land in the directory itself, not merely somewhere reachable from it. Comparing
  // the resolved parent is what catches `../escaped` and `sub/orders` alike; comparing the relative
  // form against the name it was built from proves nothing, because that always agrees with itself.
  const contained = dirname(absolute) === dir;
  return {
    absolute,
    path: repoRelative(repoRoot, absolute),
    exists: contained && existsSync(absolute),
    contained,
  };
}

/**
 * Derived from the path really written, never echoed back from the config, for the reason
 * engine/spines.ts gives: a `spines` of `./tools/spines` has to report as `tools/spines/money.json`,
 * which is the repo-relative form every other path EmPo prints takes. Separators are forced to `/`.
 */
function repoRelative(repoRoot: string, absolute: string): string {
  return relative(repoRoot, absolute).split(sep).join("/");
}

/**
 * Every key in a fixed order, which is the doc's order (docs/08-spines.md) and the schema's. Two
 * runs over the same proposal on two machines have to produce the same bytes, and a file a human is
 * about to edit should read in the order the doc taught them, not alphabetically and not in whatever
 * order a parser happened to build the object. `undefined` fields drop out in JSON.stringify, so an
 * optional nobody filled in leaves no trace.
 */
function spineDocument(spine: SpineFile): unknown {
  return {
    version: spine.version,
    name: spine.name,
    principle: spine.principle,
    hops: spine.hops.map((hop) => ({
      n: hop.n,
      title: hop.title,
      entry: hop.entry,
      file: hop.file,
      line: hop.line,
      anchor: hop.anchor,
      note: hop.note,
    })),
    guarded: spine.guarded,
    assertionTerms: spine.assertionTerms,
    assertionPaths: spine.assertionPaths,
    invariants: spine.invariants.map((invariant) => ({
      id: invariant.id,
      statement: invariant.statement,
      assertableAtWriteTime: invariant.assertableAtWriteTime,
      citation:
        invariant.citation === undefined
          ? undefined
          : {
              file: invariant.citation.file,
              line: invariant.citation.line,
              anchor: invariant.citation.anchor,
            },
    })),
    traps: spine.traps.map((trap) => ({
      what: trap.what,
      file: trap.file,
      line: trap.line,
      anchor: trap.anchor,
    })),
    flows: spine.flows,
    unguardedFlows: spine.unguardedFlows,
    moneyType:
      spine.moneyType === undefined
        ? undefined
        : { class: spine.moneyType.class, note: spine.moneyType.note },
  };
}

function flowsDocument(flows: Record<string, FlowDefinition>): unknown {
  const ordered: Record<string, unknown> = {};
  for (const name of Object.keys(flows).sort(compareStrings)) {
    const definition = flows[name];
    if (definition === undefined) continue;
    ordered[name] = { label: definition.label, paths: definition.paths };
  }
  return { version: 1, flows: ordered };
}

/** Two-space JSON with a trailing newline, the way every other artifact EmPo writes is spelled. */
function serialize(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
