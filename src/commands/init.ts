import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { forgeSlug } from "../adapters/forge/types";
import { mapWorkflow } from "../discipline/load";
import { type AliasSeed, seedAliases, sortedAliases } from "../engine/aliases";
import { findConfigPath, loadConfig } from "../engine/config";
import { type DetectedForge, detectForge, detectRoots } from "../engine/detect";
import { readGraph } from "../engine/graph";
import { claims, kindAxes, LIST_FRAMEWORK_RESOLVED, NOT_AN_ARRIVAL_REASON } from "../engine/kinds";
import { compareStrings } from "../engine/order";
import { loadPack } from "../engine/pack-loader";
import { applyProposal, gateProposal, type ProposalResult } from "../engine/proposal";
import { scaffold } from "../engine/scaffold";
import { loadSpines } from "../engine/spines";
import { configError } from "../errors";
import { writeAgents } from "../host/agents";
import { writeClaude } from "../host/claude";
import { writeCodex } from "../host/codex";
import type { EmpoAdapters, EmpoConfig } from "../schema/config.schema";
import { parseProposalFile } from "../schema/proposal.schema";
import type { Graph, GraphNode } from "../schema/types";
import { indexCommand } from "./index";

/**
 * `empo init`: the on-ramp (docs/06-cli.md). Detect the languages, scaffold `.empo/`, wire the host,
 * build the first graph, then hand an agent the facts it needs to propose flows and spines.
 *
 * Two properties are worth stating out loud, because both are departures from the doc as written.
 *
 * It is **non-interactive**. docs/02 says init "asks" where the config goes and whether `generated/`
 * is committed; those are two flags here instead. A command that prompts cannot run in a hook, in
 * CI, or under an agent, which is where a scaffolding command is most useful, and both questions
 * have a defensible default that a human can change afterwards in a file they own.
 *
 * It **never overwrites what a human owns**. Every file the `.empo/` scaffold would write and finds
 * already there is reported as kept. That is what makes it safe to rerun on a repository that
 * already has a `.empo/`, so it doubles as the repair command for a half-scaffolded project, and it
 * is why there is no `--force`: the files it writes are human-owned from the moment they exist.
 *
 * The host wiring is the exception, and has to be, because none of it is human-owned. `writeClaude`
 * and `writeCodex` regenerate their skill files whole out of the config and `writeAgents` merges
 * the managed block, so all report `created`, `updated` or `unchanged` and none can report `kept`.
 * A skill kept as it was found would go on describing the roots and packs of a config that has since
 * changed, which is the one outcome the wiring exists to prevent.
 */

export interface InitOptions {
  /** Comma-separated pack names, to force detection instead of letting it look. */
  lang?: string;
  /** Commander sets this false for `--no-host`. */
  host?: boolean;
  /** Write `empo.config.json` at the repository root instead of `.empo/config.json`. */
  configAtRoot?: boolean;
  /** Keep `generated/` in version control (docs/02's "alternative some teams prefer"). */
  commitGenerated?: boolean;
  /**
   * The tracker host ("jira", "asana", "linear"), written as `{ kind: "mcp", host }`. A flag
   * rather than a prompt, and rather than a detection: nothing in a checkout names the system the
   * tickets live in, so the only alternatives are being told and guessing.
   */
  tracker?: string;
  /** Phase 2: gate an agent's proposal file instead of scaffolding. */
  proposal?: string;
  /** Write what the gate kept. Without it the verdict is printed and nothing is touched. */
  apply?: boolean;
}

export function initCommand(repoRoot: string, options: InitOptions = {}): void {
  if (options.proposal === undefined) {
    if (options.apply === true) {
      throw configError("empo init --apply needs a proposal to apply", [
        "Run empo init first, let the agent write the proposal file it names,",
        "then empo init --proposal <path> --apply.",
      ]);
    }
    scaffoldPhase(repoRoot, options);
    return;
  }

  proposalPhase(repoRoot, options.proposal, options);
}

// ---------------------------------------------------------------------------------------------
// Phase 1: detect, scaffold, wire, index, brief
// ---------------------------------------------------------------------------------------------

function scaffoldPhase(repoRoot: string, options: InitOptions): void {
  const detection = detectRoots(repoRoot, { langs: parseLangs(options.lang) });
  // Parsed before anything is written, so a malformed flag fails with the repository untouched.
  const trackerHost = parseTracker(options.tracker);
  const forge = detectForge(repoRoot);

  console.log("");
  printDetection(repoRoot, detection);

  if (detection.roots.length === 0) {
    throw configError("Detected nothing EmPo can index", [
      `Looked under ${resolve(repoRoot)} for the file types the installed packs own.`,
      "If the source lives somewhere this walk skipped (vendored, built, or dot-prefixed),",
      "write .empo/config.json by hand: docs/03-config-schema.md has a complete example.",
    ]);
  }

  // Read before anything is written, so the alias section below describes the same run that seeded
  // the config rather than a second walk of the tree.
  const seeded = detection.roots.map((root) => ({
    root,
    seed: seedAliases(repoRoot, root.path, loadPack(root.lang)),
  }));

  const existing = findConfigPath(repoRoot);
  const files = scaffold(repoRoot, {
    roots: seeded.map(({ root, seed }) => ({
      path: root.path,
      lang: root.lang,
      aliases: sortedAliases(seed.aliases),
    })),
    configAtRoot: options.configAtRoot === true,
    commitGenerated: options.commitGenerated === true,
    ...(forge === null ? {} : { forge }),
    ...(trackerHost === undefined ? {} : { trackerHost }),
  });

  console.log("");
  console.log("scaffold");
  for (const file of files)
    console.log(`  ${file.state === "wrote" ? "wrote" : "kept "} ${file.path}`);
  if (existing !== null) {
    console.log("");
    console.log(
      `  ${relativeTo(repoRoot, existing)} was already there, so the detected roots above`,
    );
    console.log("  were not written. It is yours; edit it if detection disagrees with it.");
  }

  const { config } = loadConfig(repoRoot);
  printAliases(config, seeded, existing === null);
  // The config as it now stands on disk, not what was detected, so both blocks below can tell a
  // rerun that changed nothing from a rerun that silently kept something else.
  printForge(config, forge, existing === null);
  printTracker(config, trackerHost, existing === null);
  printBridgeGap(config);

  console.log("");
  console.log("host");
  if (options.host === false) {
    console.log("  skipped (--no-host). Nothing outside .empo/ was touched.");
  } else {
    // Claude first, for the reason empo update does it in that order: this target can refuse before
    // the generated Codex skills or shared AGENTS.md change.
    const claude = writeClaude(repoRoot, config);
    const codex = writeCodex(repoRoot, config);
    const agents = writeAgents(repoRoot, config);
    for (const file of [{ path: agents.path, state: agents.state }, ...claude, ...codex]) {
      console.log(`  ${file.state.padEnd(9)} ${relativeTo(repoRoot, file.path)}`);
    }
    console.log("");
    console.log("  AGENTS.md is shared; .claude/ and .codex/ each hold the EmPo skills. Claude's");
    console.log(
      "  hooks fire on their own; Codex uses the skills and AGENTS.md. CI runs the gates",
    );
    console.log("  for every host, and Claude's hooks fail open when empo is not on PATH");
    console.log("  (docs/10-distribution.md).");
  }

  // Step 4 exists so step 5 stands on real data rather than on a directory listing. A failure here
  // is a real one and propagates: everything above it is already written and rerunning is free.
  console.log("");
  console.log("index");
  indexCommand(repoRoot);

  printMapBrief(repoRoot, config);
}

/**
 * What each root's toolchain says an alias means, and what was not seeded.
 *
 * The section is printed only where some pack declares an alias source, because a repository of a
 * language whose imports carry no aliases has nothing to be told. Where it is printed it follows
 * the rule the forge block above learned: the outcome first, then what the outcome means, and a
 * rerun that wrote nothing says so before it says anything else.
 *
 * A silent absence here is expensive in a way the other sections' are not. An alias config never
 * seeded and never written by hand does not narrow an answer, it removes every aliased import edge
 * in the repository, and a file half its importers reach through `@/` then reads as barely used.
 * So a root that found no map is named as explicitly as one that found ten.
 */
function printAliases(
  config: EmpoConfig,
  seeded: { root: { path: string; lang: string }; seed: AliasSeed }[],
  written: boolean,
): void {
  const packs = new Map(seeded.map(({ root }) => [root.lang, loadPack(root.lang)]));
  const relevant = seeded.filter(
    ({ root }) => (packs.get(root.lang)?.aliasSources ?? []).length > 0,
  );
  if (relevant.length === 0) return;

  // What the config on disk resolves with, against what the toolchain says it should. On a fresh
  // scaffold these are the same object; on a rerun they are two answers and only one of them is
  // read by anything. A root missing from the config disagrees with any seed at all, which is the
  // case a human is being asked to settle.
  const missing = relevant.filter(({ root, seed }) => {
    const configured = config.roots.find((entry) => entry.path === root.path)?.aliases ?? {};
    return Object.entries(seed.aliases).some(
      ([pattern, targets]) => !sameTargets(configured[pattern], targets),
    );
  });

  console.log("");
  console.log("aliases");

  // Only where the two really differ. "NOT written" printed over a rerun that had nothing to write
  // is the failure the forge block's docstring above describes: an alarm that is usually false is
  // an alarm nobody reads the day it is true.
  if (!written && missing.length > 0) {
    console.log("  NOT written: a config was already there, and empo init never overwrites one.");
    console.log("  The toolchain declares the aliases below and the config does not, so every");
    console.log("  import written through them is an edge the graph does not hold. Copy");
    console.log("  whichever of them is correct into roots[].aliases by hand.");
    // The blank line every other block here puts between prose and rows. Without it the map reads
    // as a continuation of the sentence above rather than as the table it is.
    console.log("");
  }

  for (const { root, seed } of relevant) {
    const patterns = Object.keys(seed.aliases).sort(compareStrings);

    if (patterns.length === 0) {
      const read =
        seed.read.length === 0
          ? "no toolchain config under it, so no aliases"
          : `no aliases in ${seed.read.join(", ")}`;
      console.log(`  ${root.path.padEnd(24)} ${read}`);
    } else {
      const count = plural(patterns.length, "alias", "aliases");
      console.log(`  ${root.path.padEnd(24)} ${count} from ${seed.read.join(", ")}`);
      for (const pattern of patterns) {
        console.log(`      ${pattern.padEnd(20)} -> ${(seed.aliases[pattern] ?? []).join(", ")}`);
      }
    }

    // Every gap the seeder hit, in its own words. A map that is quietly narrower than the one the
    // build uses does not narrow an answer, it deletes edges.
    for (const note of seed.notes) {
      for (const line of wrapNote(note, "      ")) console.log(line);
    }
  }

  if (relevant.some(({ seed }) => Object.keys(seed.aliases).length > 0)) {
    console.log("");
    console.log("  This map is a copy taken once. It does not follow later edits to the toolchain");
    console.log("  config, and an alias the config does not name resolves to nothing.");
  }
}

/**
 * Two target lists, compared as lists. Order is semantic in an alias map, since the first target
 * that names a node wins, so `["a", "b"]` and `["b", "a"]` are two different maps.
 */
function sameTargets(configured: string[] | undefined, seeded: string[]): boolean {
  if (configured === undefined || configured.length !== seeded.length) return false;
  return configured.every((target, index) => target === seeded[index]);
}

/**
 * What the origin remote said, and what it buys. The `mcp` case is worth spelling out at init time
 * rather than at the first review: it is the one adapter that needs the agent to do something, and
 * a human reading "kind: mcp" in a config with no explanation would reasonably read it as a server
 * they are expected to go and run.
 *
 * Both this and the tracker block below are written against a rule learned the hard way: **the
 * outcome comes first, and only then what the outcome means.** Init never overwrites, so on a rerun
 * these blocks describe something that did not happen, and three lines of present-tense prose about
 * a working adapter followed by a quiet negation reads as a success with a footnote. Which is why
 * both take the config as it now stands on disk rather than a boolean: "not written" is alarming
 * when the config configures nothing, and completely uninteresting when the config already says
 * exactly what was detected, and telling those two apart is the difference between a warning worth
 * reading and one worth learning to ignore.
 */
function printForge(config: EmpoConfig, forge: DetectedForge | null, written: boolean): void {
  const configured = config.adapters?.forge;
  console.log("");
  console.log("forge");

  if (forge === null) {
    // A config that names a forge is still the answer: init reads git, it does not overrule a file.
    if (configured !== undefined) {
      console.log("  none detected: this checkout has no origin remote.");
      console.log(
        `  The config configures ${describeConfigured(configured)}, and that is what every command reads.`,
      );
      return;
    }
    console.log(
      "  none: this checkout has no origin remote to read one from, so empo review works",
    );
    console.log("  on the local diff against a base ref. There is no pull request description, no");
    console.log("  review comments and no CI result, and nothing can be posted anywhere.");
    return;
  }

  if (!written && !sameForge(configured, forge)) {
    console.log("  NOT written: a config was already there, and empo init never overwrites one.");
    console.log(`  The origin remote says ${summarize(forge)}.`);
    console.log(
      `  The config says ${configured === undefined ? "no forge at all" : describeConfigured(configured)}, and the config is what every command reads.`,
    );
    console.log("  If the remote is right, put this in it by hand:");
    console.log(`      "forge": ${inlineJson(forge)}`);
    return;
  }

  console.log(`  ${summarize(forge)}, from the origin remote.`);
  if (forge.kind === "github") {
    console.log(
      "  empo review reads the pull request, its comments and its CI result through the gh CLI.",
    );
    console.log("  It posts only when it is asked to, never by default.");
  } else {
    console.log("  empo reaches no host and holds no token, so empo review prints exactly what it");
    console.log(
      "  needs and the agent running it fetches the pull request with its own connector.",
    );
    console.log(
      "  What comes back is checked against this repository before the review believes it.",
    );
  }
  // Said, rather than left out, because a rerun printing a forge with no verdict beside it is the
  // same ambiguity in a quieter form.
  if (!written) console.log("  Already in the config, unchanged.");
}

/**
 * The other half of the same paragraph, and the reason it is printed even when there is nothing to
 * report. A tracker cannot be detected from anything in a checkout, so the silent outcome is a
 * review that skips ticket-fit entirely: it grades a diff against no acceptance criteria and the
 * only person who could have supplied them finds out weeks later, in a review. Said here instead.
 */
function printTracker(config: EmpoConfig, host: string | undefined, written: boolean): void {
  const configured = config.adapters?.tracker;
  console.log("");
  console.log("tracker");

  if (host === undefined) {
    if (configured !== undefined) {
      console.log(`  ${describeConfigured(configured)}, from the config. No --tracker was given,`);
      console.log("  and nothing detects a tracker, so what is on disk stands.");
      return;
    }
    console.log(
      "  none. Nothing in a checkout names the system the tickets live in, so unlike the",
    );
    console.log("  forge above this cannot be detected and no tracker section was written. Until");
    console.log("  one is configured every empo review skips ticket-fit: it grades the change");
    console.log("  against no acceptance criteria at all, and says so in the report. Rerun with");
    console.log("  empo init --tracker <host> (jira, asana, linear), or add adapters.tracker by");
    console.log("  hand: docs/03-config-schema.md has the shape.");
    return;
  }

  const already = configured?.kind === "mcp" && configured.host === host;
  if (!written && !already) {
    console.log(`  --tracker ${host} was NOT written: a config was already there, and empo init`);
    console.log("  never overwrites one.");
    if (configured === undefined) {
      console.log("  This repository still configures no tracker at all, so every empo review");
      console.log("  skips ticket-fit: it grades the change against no acceptance criteria, and");
      console.log("  says so in the report.");
    } else {
      console.log(
        `  This repository still configures ${describeConfigured(configured)}, which is what reviews will use.`,
      );
    }
    console.log("  Put it in the config by hand:");
    console.log(`      "tracker": ${inlineJson({ kind: "mcp", host })}`);
    return;
  }

  console.log(`  mcp, host ${host}, from --tracker. Same round trip as an mcp forge: empo prints`);
  console.log("  what it needs, the agent fetches the ticket with its own connector, and the");
  console.log("  review grades the change against the criteria the ticket really states.");
  if (!written) console.log("  Already in the config, unchanged.");
}

/** "mcp, host bitbucket, acme/acme-platform", the one-line form both blocks lead with. */
function summarize(forge: DetectedForge): string {
  const where = forgeSlug(forge) ?? forge.repo;
  const host = forge.kind === "github" ? "" : `, host ${forge.host ?? "unnamed"}`;
  return `${forge.kind}${host}, ${where}`;
}

/** The same, for whatever the config on disk says, which detection may know nothing about. */
function describeConfigured(adapter: { kind: string; host?: string }): string {
  return adapter.host === undefined ? adapter.kind : `${adapter.kind}, host ${adapter.host}`;
}

/**
 * One line of JSON in the shape a `.empo/config.json` is written in, so the repair above is a copy
 * rather than a translation. `JSON.stringify` alone emits `{"kind":"mcp"}`, which is valid and looks
 * nothing like the file the reader is about to paste it into.
 */
function inlineJson(value: object): string {
  const body = Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .map(([key, field]) => `"${key}": ${JSON.stringify(field)}`)
    .join(", ");
  return `{ ${body} }`;
}

/** Whether the config already says exactly what was detected, field for field. */
function sameForge(configured: EmpoAdapters["forge"], forge: DetectedForge): boolean {
  return (
    configured !== undefined &&
    configured.kind === forge.kind &&
    configured.host === forge.host &&
    configured.workspace === forge.workspace &&
    configured.repo === forge.repo
  );
}

/**
 * The one thing a generated config cannot contain and a monorepo needs most. A bridge says two roots
 * exchange a symbol under some normalization, and neither half of that is visible in a file listing,
 * so init writes none. Left unsaid, the result is a repository where cross-language reach silently
 * reads as zero and a backend change looks like it touches no app at all, which is indistinguishable
 * from a repository that genuinely has no coupling. So it is said.
 */
function printBridgeGap(config: EmpoConfig): void {
  const langs = new Set(config.roots.map((root) => root.lang));
  if (langs.size < 2 || config.bridges.length > 0) return;

  console.log("");
  console.log("bridges");
  console.log(`  none, across ${plural(langs.size, "language")}. A bridge cannot be detected, so`);
  console.log("  until one is configured empo query reports no cross-language reach, which is the");
  console.log("  same answer it would give for a repository that genuinely has none.");
  console.log("  docs/03-config-schema.md has the shape; empo doctor prints the match rate.");
}

function printDetection(repoRoot: string, detection: ReturnType<typeof detectRoots>): void {
  console.log(`detected   ${plural(detection.roots.length, "root")} under ${resolve(repoRoot)}`);
  for (const root of detection.roots) {
    console.log(
      `  ${root.path.padEnd(24)} ${root.lang.padEnd(12)} ` +
        `${plural(root.files, "file")} (${root.via === "manifest" ? "manifest" : "by extension"})`,
    );
  }

  // Printed, not swallowed. A root the human expected and does not see is the first thing they
  // will ask about, and the reason is always here.
  for (const dropped of detection.dropped) {
    console.log(`  skipped ${dropped.path} (${dropped.lang}): ${dropped.reason}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Step 5, phase 1: the brief
// ---------------------------------------------------------------------------------------------

/** Every list in the brief is capped, and a capped list says so. A silent cap reads as "all of it". */
const BRIEF_CAP = 12;

function printMapBrief(repoRoot: string, config: EmpoConfig): void {
  const graph = readGraph(repoRoot);
  const target = proposalPath(repoRoot);
  mkdirSync(dirname(target), { recursive: true });

  console.log("");
  console.log("=".repeat(96));
  console.log("");
  console.log("the map brief: the facts to propose flows and spines from");
  console.log("");
  console.log(
    `graph      ${graph.stats.nodes} nodes, ${graph.stats.edges} edges across ` +
      `${graph.roots.map((root) => `${root.path} (${root.lang})`).join(", ")}`,
  );

  printSection("structure", directoryRows(graph), "no nodes, so there is nothing to map yet");
  printSection("kinds", kindRows(graph), "the packs tagged no node with a kind");
  const entrypoints = entrypointRows(graph);
  printSection(
    "entrypoints (nothing in the graph references these, so a journey starts here)",
    entrypoints.rows,
    "every node is referenced by another, which usually means the entrypoints are not indexed",
    entrypoints.note,
  );
  printSection(
    "produced symbols (a route is the strongest flow signal there is)",
    symbolRows(graph),
    "no pack extracted a symbol here",
  );
  printSection(
    "widest blast radius (the code many journeys touch)",
    faninRows(graph),
    "nothing is referenced twice",
  );
  printSection(
    "repair-verb signals (docs/08 tombstone commands: candidates, confirm by reading)",
    tombstoneRows(graph),
    "none, which is common and is not evidence that no spine is warranted",
  );

  console.log("");
  console.log("already defined, do not propose these again");
  const flows = Object.keys(graph.flows).sort(compareStrings);
  console.log(`  flows      ${flows.length === 0 ? "none" : flows.join(", ")}`);
  const spines = loadSpines(repoRoot, config).map((entry) => entry.spine.name);
  console.log(`  spines     ${spines.length === 0 ? "none" : spines.join(", ")}`);

  console.log("");
  console.log("write the proposal to");
  console.log(`  ${target}`);
  console.log("then");
  console.log(`  empo init --proposal ${target}            the verdict, nothing written`);
  console.log(`  empo init --proposal ${target} --apply    write what survived`);

  console.log("");
  console.log("=".repeat(96));
  console.log("");
  console.log(mapWorkflow());
}

interface SectionNote {
  /** Printed under the section, after a blank line. Empty means the section held nothing back. */
  lines: string[];
  /** The command that shows what the cap hid, where `empo query` alone would not show it. */
  truncationHint?: string;
}

/**
 * A section, capped, with an optional note under it.
 *
 * The note is separated by a blank line and by its own indent, because at row indent a sentence
 * about the list reads as an entry in it, and this one names counts and a command.
 *
 * **The `empty` sentence is suppressed when there is a note**, and that is not tidiness. Every
 * `empty` string here explains an absence by its own section's rule, and the entrypoints one says
 * "every node is referenced by another, which usually means the entrypoints are not indexed". On a
 * repository whose only zero-fan-in nodes are framework-resolved kinds nobody arrives at, that
 * sentence is false twice over: nothing is referenced by anything, and the indexing is fine. It
 * would also prescribe the wrong action to the agent about to propose flows. Where a note exists it
 * already says what happened, with counts, so the note is the whole answer.
 */
function printSection(
  title: string,
  rows: string[],
  empty: string,
  note: SectionNote = { lines: [] },
): void {
  console.log("");
  console.log(title);
  if (rows.length === 0) {
    if (note.lines.length === 0) console.log(`  ${empty}`);
  } else {
    for (const row of rows.slice(0, BRIEF_CAP)) console.log(`  ${row}`);
    if (rows.length > BRIEF_CAP) {
      // Named per section where the generic command cannot show what was hidden. The entrypoints
      // section ranks framework-resolved kinds first, and `empo query --orphans` drops exactly
      // those, so the default line would send a reader to a command that answers "none".
      const hint = note.truncationHint ?? "empo query";
      console.log(`  ... ${rows.length - BRIEF_CAP} more, run ${hint} for the rest`);
    }
  }
  if (note.lines.length > 0) {
    console.log("");
    for (const line of note.lines) console.log(`    ${line}`);
  }
}

function directoryRows(graph: Graph): string[] {
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.isTest) continue;
    const directory = dirname(node.file);
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
    .map(([directory, count]) => `${directory.padEnd(56)} ${plural(count, "node")}`);
}

function kindRows(graph: Graph): string[] {
  const counts = new Map<string, number>();
  for (const node of graph.nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
    .map(([kind, count]) => `${kind.padEnd(24)} ${count}`);
}

/** Said of a row the pack marks `arrivedBy: "user"`, so the agent can see why it is ranked first. */
const ARRIVED_BY_USER = "arrived by user";

/**
 * Where a journey starts: a node nothing in the graph references.
 *
 * Zero fan-in alone is the wrong list, for the reason `empo query --orphans` does not use it
 * either. A framework reaches a view, a migration or a policy by name, so those can sit at zero
 * while being used every day. Measured on one real Laravel repository this section held 285
 * rows of which 278 were framework-resolved kinds, and **the five route files sat at positions
 * 280 to 284 and never printed**, under a heading that says a journey starts here while
 * `discipline/map.md` tells the agent a route is the strongest flow signal there is.
 *
 * But `--orphans`' filter is the wrong filter here, and reusing it would leave 7 rows and throw
 * away the route files, the console commands and the Livewire components with the migrations. The
 * two commands ask different questions of one set: `--orphans` asks "is this dead?", where
 * framework-resolved means there is no evidence either way and so hide it, and the brief asks
 * "does a journey start here?", where a route file is emphatically yes. So the pack's second axis
 * decides, and the rule has three cases rather than two:
 *
 * - marked `arrivedBy`: kept, and ranked first, so the cap can never hide one behind a directory
 *   of migrations. Whatever resolves it: a route file carries both marks and is not a conflict.
 * - marked `resolvedBy` alone: dropped, counted and named in the note, never dropped silently.
 * - marked neither: kept, unranked. The pack makes no claim, and an unclaimed node is the honest
 *   "nothing references this", which is the row this section printed before either axis existed.
 */
function entrypointRows(graph: Graph): { rows: string[]; note: SectionNote } {
  const { frameworkResolved, userArrived } = kindAxes(graph);

  const candidates = graph.nodes
    .filter((node) => !node.isTest && (graph.fanin[node.id] ?? 0) === 0)
    .sort((a, b) => compareStrings(a.file, b.file));

  const hidden = (node: GraphNode): boolean =>
    claims(frameworkResolved, node) && !claims(userArrived, node);

  const dropped = candidates.filter(hidden);
  const rows = candidates
    .filter((node) => !hidden(node))
    // A stable partition, not a re-sort: within each half the file order above is untouched.
    .sort((a, b) => Number(claims(userArrived, b)) - Number(claims(userArrived, a)))
    .map((node) => {
      const arrival = claims(userArrived, node) ? `  ${ARRIVED_BY_USER}` : "";
      // The file, except where the node is one export of it. An export nothing references is an
      // entrypoint while the file holding it may be imported by half the repository, so printing
      // the path there tells a reader the file is unreferenced when it is the export that is.
      // Keyed off `symbol` and not off the id, because a `fqcn` pack's id is a class name and the
      // path is the more useful of the two coordinates for every row that pack produces.
      const where = node.symbol === undefined ? node.file : node.id;
      return `${where.padEnd(56)} ${node.kind.padEnd(12)}${arrival}`.trimEnd();
    });

  // `--orphans --all` and not `--orphans`: the plain form drops every framework-resolved kind, so
  // it answers "none" for exactly the rows this section ranks first. One string for both the note
  // and the cap, because both send a reader to see what they were not shown.
  const note: SectionNote = { lines: [], truncationHint: LIST_FRAMEWORK_RESOLVED };
  if (dropped.length === 0) return { rows, note };

  const counts = new Map<string, number>();
  for (const node of dropped) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  // Widest kind first: which convention produced the bulk of them is the useful read, which is the
  // same ordering `--orphans` gives its own excluded rows.
  const byKind = [...counts]
    .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");

  note.lines = [
    `${plural(dropped.length, "row")} held back (${byKind}).`,
    NOT_AN_ARRIVAL_REASON,
    `${LIST_FRAMEWORK_RESOLVED} lists them.`,
  ];
  return { rows, note };
}

function symbolRows(graph: Graph): string[] {
  const rows: string[] = [];
  for (const node of graph.nodes) {
    for (const symbol of node.produces) {
      rows.push(`${symbol.symbol.padEnd(14)} ${symbol.key.padEnd(32)} ${node.file}:${symbol.line}`);
    }
  }
  return rows.sort(compareStrings);
}

function faninRows(graph: Graph): string[] {
  return graph.nodes
    .filter((node) => (graph.fanin[node.id] ?? 0) > 1)
    .sort(
      (a, b) => (graph.fanin[b.id] ?? 0) - (graph.fanin[a.id] ?? 0) || compareStrings(a.id, b.id),
    )
    .map((node) => `${node.id.padEnd(48)} fan-in ${graph.fanin[node.id] ?? 0}  ${node.file}`);
}

/**
 * docs/08's first spine signal, and the only one of the four a graph can hint at on its own: a
 * repair script is a grave marker, and nobody writes one speculatively. The other three (value
 * columns, idempotency machinery, an existing integrity check) live in schema and migrations that
 * no pack indexes, so the workflow asks the agent to read for them instead of pretending otherwise.
 */
const REPAIR_VERB =
  /(?:^|[^a-z])(fix|repair|regenerate|rebuild|backfill|recompute|recalculate|resync|reconcile|reprocess)(?:[^a-z]|$)/i;

function tombstoneRows(graph: Graph): string[] {
  return graph.nodes
    .filter((node) => !node.isTest)
    .filter((node) => REPAIR_VERB.test(node.name) || REPAIR_VERB.test(basename(node.file)))
    .sort((a, b) => compareStrings(a.file, b.file))
    .map((node: GraphNode) => `${node.file.padEnd(56)} ${node.kind}`);
}

// ---------------------------------------------------------------------------------------------
// Step 5, phase 2: the gate
// ---------------------------------------------------------------------------------------------

/**
 * Nothing an agent proposes reaches `.empo/` until it survives this and a human passes `--apply`
 * (docs/06: "never as fait accompli"). The gate resolves what it can and drops what it cannot, and
 * it exits 0 either way: a proposal is a suggestion, and only the mechanical gates (`check`,
 * `verify`, `index --check`) return 1. What a dropped proposal costs is the agent's next attempt,
 * not somebody's commit.
 */
function proposalPhase(repoRoot: string, path: string, options: InitOptions): void {
  const { config } = loadConfig(repoRoot);
  const graph = readGraph(repoRoot);

  if (!existsSync(path)) {
    throw configError(`No proposal at ${path}`, [
      "Run empo init, then have the agent write the file the brief names.",
    ]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw configError(`${path} is not valid JSON`, [(error as Error).message]);
  }

  const result = gateProposal(repoRoot, config, graph, parseProposalFile(raw, path));

  console.log("");
  console.log(`proposal   ${path}`);
  printFlowVerdicts(result);
  printSpineVerdicts(result);

  // What `--apply` would really write, which is not the same as what survived: a flow the human
  // already defines survives the gate and is still not written, because their entry stands. Counting
  // survivors here would promise a change that never comes and read as a bug the first time someone
  // checked the file afterwards.
  const keptFlows = result.flows.filter((flow) => flow.kept && !flow.existing).length;
  const keptSpines = result.spines.filter((spine) => spine.kept).length;

  console.log("");
  if (options.apply !== true) {
    console.log(
      `${plural(keptFlows, "flow")} and ${plural(keptSpines, "spine")} would be written. ` +
        "Nothing was touched.",
    );
    console.log(`Read the above, then: empo init --proposal ${path} --apply`);
    return;
  }

  // The writer decides, not the counts above: it reports a file it left alone as kept, which is the
  // honest answer when every surviving flow was one the human had already written.
  const applied = applyProposal(repoRoot, config, result);
  if (applied.length === 0) {
    console.log("Nothing survived the gate, so nothing was written.");
    return;
  }

  for (const file of applied) {
    console.log(`  ${file.state === "wrote" ? "wrote" : "kept "} ${file.path}`);
  }
  console.log("");
  console.log("These files are yours now. Rename, merge and prune them: an agent proposed them,");
  console.log("it did not decide them.");
}

function printFlowVerdicts(result: ProposalResult): void {
  console.log("");
  console.log("flows");
  if (result.flows.length === 0) {
    console.log("  none proposed");
    return;
  }

  for (const flow of result.flows) {
    const verdict = flow.kept ? "keep " : "DROP ";
    console.log(`  ${verdict} ${flow.name.padEnd(24)} ${plural(flow.nodes, "node")}`);
    for (const path of flow.paths) console.log(`         ${path}`);
    for (const entry of flow.unmatched) {
      console.log(`         dropped: ${entry.path} (${entry.reason})`);
    }
    if (flow.note !== undefined) console.log(`         ${flow.note}`);
  }
}

function printSpineVerdicts(result: ProposalResult): void {
  console.log("");
  console.log("spines");
  if (result.spines.length === 0) {
    console.log("  none proposed, which is the right answer for most repositories");
    return;
  }

  for (const spine of result.spines) {
    const verdict = spine.kept ? "keep " : "DROP ";
    const hops = plural(spine.spine.hops.length, "hop");
    console.log(`  ${verdict} ${spine.name.padEnd(24)} ${hops}, ${spine.corrected} corrected`);
    for (const fictional of spine.fictional) {
      console.log(`         invented: ${fictional}`);
    }
    if (spine.note !== undefined) console.log(`         ${spine.note}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------------------------

/**
 * Scratch lives in the OS temp directory and never under `.empo/`, the same rule `empo review`
 * follows (docs/14): a proposal is a draft passing between two processes, and `.empo/` holds only
 * what a human has approved.
 */
export function proposalPath(repoRoot: string): string {
  const name = basename(resolve(repoRoot)).replace(/[^A-Za-z0-9._-]/g, "-");
  return join(tmpdir(), "empo-init", name === "" ? "repo" : name, "proposal.json");
}

function parseLangs(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;

  const langs = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (langs.length === 0) {
    throw configError("--lang was given no pack names", ["For example: --lang php,typescript"]);
  }
  return langs;
}

/**
 * Free text, validated only for being text: `host` is the name the request block prints at the
 * agent, and an enum here would refuse a host this version has never heard of for no gain, since
 * nothing in the engine branches on the value.
 */
function parseTracker(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const host = value.trim();
  if (host === "") {
    throw configError("--tracker was given no host", ["For example: --tracker jira"]);
  }
  return host;
}

function relativeTo(repoRoot: string, path: string): string {
  const prefix = `${resolve(repoRoot)}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * `plural` appends an "s", which is right for every noun this command had until "alias", the first
 * one whose plural is not the singular plus a letter. So the irregular form is a parameter rather
 * than a rule: a caller that knows its noun passes both, and every existing caller is unchanged.
 */
function plural(count: number, noun: string, plural?: string): string {
  if (count === 1) return `${count} ${noun}`;
  return `${count} ${plural ?? `${noun}s`}`;
}

/**
 * A note wrapped to the width the rest of this command's prose is written at.
 *
 * The notes come from `engine/aliases.ts`, where they are assembled for source width and know
 * nothing about a terminal, and one of them runs to 137 characters against the 78 every other block
 * here wraps at. docs/14 says to read the printed text as the agent receiving it: a line that
 * overflows a terminal is one a reader skips, and these are the lines that say what was not seeded.
 */
function wrapNote(text: string, indent: string, width = 78): string[] {
  const lines: string[] = [];
  let current = "";

  for (const word of text.split(" ")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (`${indent}${candidate}`.length > width && current !== "") {
      lines.push(`${indent}${current}`);
      current = word;
      continue;
    }
    current = candidate;
  }
  if (current !== "") lines.push(`${indent}${current}`);

  return lines;
}
