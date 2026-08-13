import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ForgeKind } from "../adapters/forge/types";
import { forgeSlug } from "../adapters/forge/types";
import type { TrackerKind } from "../adapters/tracker/types";
import { EmpoError } from "../errors";
import { type WiredHook, wiredHooks } from "../host/claude";
import type { EmpoConfig } from "../schema/config.schema";
import type { Graph, NameResolution } from "../schema/types";
import { type BridgeReport, bridgeRoots } from "./bridger";
import { loadConfig } from "./config";
import { type DetectedForge, detectForge, recognizedHost } from "./detect";
import { commandExists, ignoresPath, runShell, type ShellResult } from "./git";
import {
  graphDrift,
  graphPath,
  installedPackVersion,
  type PackDrift,
  type PackVersionReader,
  readGraph,
  type SchemaDrift,
  staleness,
  type UnloadablePack,
} from "./graph";
import { compareStrings } from "./order";
import { packAvailable } from "./pack-loader";
import { loadSpines, type SpineReport, verifySpines } from "./spines";

/**
 * What `empo doctor` knows, computed once and rendered twice. Doctor prints prose for a human and
 * `--json` prints this object for a machine (docs/06-cli.md), and the SessionStart hook in
 * docs/10-distribution.md is the machine: it wants a quiet answer to "is the graph stale, has a
 * spine drifted", and a hook that parses prose breaks the first time a sentence is reworded.
 *
 * So the facts live here and neither renderer computes anything of its own. That is the only way
 * the two surfaces cannot disagree, and disagreement is the failure that matters: a human told the
 * graph is current while the hook is told it is stale is worse than either answer alone.
 *
 * Every unknown is null rather than a zero or an empty string. A graph whose distance from HEAD
 * cannot be measured is not a graph that is current, and `stale` is false on it deliberately: a
 * hook that treated an unknown as staleness would warn on every session in a checkout that git
 * cannot answer for, and a warning that always fires is uninstalled within a day.
 */

export interface HealthFinding {
  level: "error" | "warn";
  message: string;
}

/**
 * The two drift facts below are declared in engine/graph.ts and only carried here. They are read off
 * the graph, they are rendered by a printer that lives beside them, and nothing about either is
 * doctor's, so this module states them and does not own them.
 */
export interface GraphHealth {
  state: "missing" | "unreadable" | "built";
  /** Full sha the graph was built against. null when unknown or built outside a git repository. */
  builtAgainst: string | null;
  /** null when git could not answer or the graph is not readable. */
  commitsBehind: number | null;
  nodes: number | null;
  edges: number | null;
  /**
   * True when the graph is behind its commit, was built by a different pack version, or was written
   * at a schema this binary does not write. All three are staleness, because all three mean the
   * answers on disk are not the answers a rebuild would give.
   */
  stale: boolean;
  /** Packs whose version moved since the graph was built. Empty when nothing drifted. */
  packDrift: PackDrift[];
  /** The graph's own schema, when it is not this binary's. null when the graph is current. */
  schemaDrift: SchemaDrift | null;
}

/**
 * The flow map measured against the files it could have claimed. A flow list is layer 2 and a human
 * owns it (docs/01-architecture.md), so a new module joins the graph and belongs to no journey until
 * somebody remembers, and nothing anywhere printed that: two engine modules of this repository's own
 * drifted out when they shipped and stayed out for weeks, through daily reads of the graph, and
 * both were found by reading flows.json against `src/` by hand.
 *
 * A fact in doctor's block and never a HealthFinding, for the reason the adapters block is a fact.
 * commands/hook.ts prints every finding this module produces, on every session, and files are
 * routinely unclaimed on purpose: the machinery every journey passes through is a journey of none,
 * and so is a build config that happens to fall under a root. A warning that fires forever on a
 * deliberate state is a warning somebody turns off, so the number is the whole of the answer and
 * whether it is the right number is the human's judgement.
 *
 * Counted over the non-test files **the graph holds**, and both halves of that are deliberate. The
 * graph rather than the directory, because a flow claims nodes and a file no root scans was never a
 * candidate for one; a directory under no root is already `unmappedDirectories`' finding above, and
 * counting those here would answer a second question in the same number. Non-test, because
 * engine/flows.ts assigns no test node to a flow whatever prefix would have claimed it, so counting
 * tests would report a total that can never reach zero, which is a number nobody can act on.
 *
 * Every field is null where the graph is missing or unreadable, never zero. "No file is unclaimed"
 * and "nothing was counted" are opposite answers, and only the first one is good news.
 */
export interface FlowHealth {
  /** Flows the graph was built with, which is every flow `.empo/flows.json` named at that moment. */
  defined: number | null;
  /** Non-test files in the graph: the denominator the count below is out of. */
  files: number | null;
  /** Of those files, how many no flow claims. */
  unclaimed: number | null;
}

/**
 * Counted per file rather than per node, because a file is the unit a human moves into a flow and a
 * language that puts two classes in one file would otherwise report it twice.
 *
 * A file counts as claimed when any node of it is, which today can only be all of them or none:
 * engine/flows.ts matches a prefix against `node.file`, so every node of one file wins the same
 * flows. Written as the weaker question anyway, so the count stays true of the file if that ever
 * stops being true of the nodes.
 */
/**
 * The name-resolution tally the graph recorded, or null where no run recorded one.
 *
 * A fact in doctor's block and never a HealthFinding, on the argument `FlowHealth` above makes in
 * full: an ambiguous component name is the normal shape of a React tree with feature directories,
 * `TextInput` under two namespaces is the normal shape of a Blade component library, and a warning
 * that fires forever on a deliberate state is a warning somebody turns off. The number is the whole
 * of the answer and whether it is the right number is the human's judgement.
 *
 * `readGraph` casts without checking a key, so a graph written before schema 5 has no `names` at
 * all and anything that is not an array is treated as no record. Null and not the empty list: the
 * empty list is a real answer this field can carry, "these packs resolve no names", and handing it
 * back for a graph nobody counted would be the invented reassurance the whole report refuses.
 *
 * The array is checked entry by entry and not only as a container, because the cast is the only
 * thing standing between the file and every reader of this field: `nameLines` adds four numbers off
 * each record, so one `null` in a hand-edited or half-written graph is a TypeError out of `empo
 * doctor` rather than the shrug the non-array case already gets. One bad record refuses the whole
 * tally, on the same argument the container check makes — a partial tally read as a complete one is
 * a denominator that is quietly wrong, which is worse than no denominator at all.
 */
export function nameHealth(graph: Graph | null): NameResolution[] | null {
  if (graph === null || !Array.isArray(graph.names)) return null;
  return graph.names.every(isNameResolution) ? graph.names : null;
}

/** Every field `nameLines` and doctor's `--json` read, and nothing beyond them. */
function isNameResolution(value: unknown): value is NameResolution {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  return (
    typeof report.family === "string" &&
    isCount(report.resolved) &&
    isCount(report.unknown) &&
    isCount(report.ambiguous) &&
    isCount(report.wrongKind) &&
    isCount(report.local) &&
    isCount(report.vendor) &&
    Array.isArray(report.ambiguousNames) &&
    report.ambiguousNames.every(isAmbiguousName)
  );
}

function isAmbiguousName(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const name = value as Record<string, unknown>;
  return typeof name.name === "string" && isCount(name.nodes) && isCount(name.references);
}

/**
 * Finite rather than merely a number, because `NaN` and `Infinity` both survive `typeof` and both
 * reach the reader as a total that arithmetic cannot repair.
 */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function flowHealth(graph: Graph | null): FlowHealth {
  if (graph === null) return { defined: null, files: null, unclaimed: null };

  const claimedIds = new Set(Object.values(graph.flows).flat());
  const files = new Set<string>();
  const claimedFiles = new Set<string>();

  for (const node of graph.nodes) {
    if (node.isTest) continue;
    files.add(node.file);
    if (claimedIds.has(node.id)) claimedFiles.add(node.file);
  }

  return {
    defined: Object.keys(graph.flows).length,
    files: files.size,
    unclaimed: files.size - claimedFiles.size,
  };
}

export interface DriftedSpine {
  name: string;
  path: string;
  soft: number;
  hard: number;
}

export interface SpineHealth {
  /** The configured spines path, as config states it. */
  dir: string;
  state: "none" | "unreadable" | "loaded";
  count: number;
  citations: number;
  soft: number;
  hard: number;
  /** One entry per spine with any drift, in load order. */
  drifted: DriftedSpine[];
}

/**
 * A CLI an adapter shells out to, and whether this machine has it.
 *
 * Null on a kind that needs none, rather than `{ present: true }` about a command nobody asked for.
 * `local` and `mcp` reach no binary at all, and inventing a satisfied requirement for them would
 * report a machine as ready for a fetch that is never going to happen.
 */
export interface RequiredCommand {
  command: string;
  present: boolean;
}

/** What the `origin` remote says the forge is, read by the same parser `empo init` seeds config from. */
export interface RemoteForge {
  kind: "github" | "mcp";
  /** The short host name, null for `github` where the kind already names it. */
  host: string | null;
  /** `OWNER/REPO`, or the bare repo where the remote had no segment above it. */
  slug: string;
  /**
   * Whether `host` is a name detection knows or a hostname it is only repeating back
   * (engine/detect.ts, `recognizedHost`). It decides whether a disagreement with the configured kind
   * is a finding or only a printed fact, and a `--json` reader needs the same distinction for the
   * same reason: `bitbucket` contradicts a `github` forge and `github.acme.com` does not.
   */
  recognized: boolean;
}

/**
 * The forge as config declares it, beside what this machine and this checkout say about it.
 *
 * `kind` is null when config declares no forge, and that is not the same fact as `"local"`: one is
 * a silence, which is also what a misspelled `adapters` section leaves behind, and the other is
 * somebody stating that there is no host. Both end in a review of the local diff, and only one of
 * them was chosen. The same split runs through `TrackerHealth.kind`.
 */
export interface ForgeHealth {
  kind: ForgeKind | null;
  /** The free-text host, null on a kind that names its own or where config omits it. */
  host: string | null;
  /** `OWNER/REPO` exactly as `forgeSlug` builds it for the adapter. Null when config names none. */
  slug: string | null;
  cli: RequiredCommand | null;
  /**
   * Null when there is no configured forge for a remote to disagree with, when the forge is `local`
   * (a statement that there is no host, so origin is not its business), or when git could not
   * answer. An unread remote is never reported as agreement.
   */
  remote: RemoteForge | null;
}

export interface TrackerHealth {
  kind: TrackerKind | null;
  host: string | null;
  project: string | null;
  cli: RequiredCommand | null;
}

export interface AdapterHealth {
  forge: ForgeHealth;
  tracker: TrackerHealth;
}

/**
 * The two questions about adapters this module cannot answer from files alone: is the CLI a kind
 * needs on PATH, and what does `origin` say. They are parameters for the reason `version` above is
 * one: both answers are the machine's rather than the repository's, so a test that could not
 * substitute them would assert whatever the machine running it happens to have installed.
 */
export interface HealthProbes {
  commandExists: (command: string) => boolean;
  detectForge: (repoRoot: string) => DetectedForge | null;
  /** Runs one wired hook the way the host does, or null to leave them unexecuted. */
  runHook: ((repoRoot: string, hook: WiredHook) => ShellResult) | null;
}

/** The probes that ask this machine. Every caller in the product leaves them alone. */
export const systemProbes: HealthProbes = {
  commandExists,
  detectForge,
  /**
   * The host's own invocation, reproduced field for field, because a probe that runs the command
   * differently proves nothing about the run that matters.
   *
   * `CLAUDE_PROJECT_DIR` is the variable the host expands in the command string (the generated
   * settings.json spells `--repo "${CLAUDE_PROJECT_DIR}"`), so a probe that left it unset would run
   * a different command line than the host does, and getting it wrong is the whole bug: an empty
   * expansion is a `--repo ""` that resolves somewhere else, or a quoting error that reports a
   * working hook as broken.
   *
   * The timeout is the hook's own configured budget and it is stated in **seconds**, so it is
   * multiplied here (docs/10-distribution.md). The host kills the hook at exactly that, so a run
   * that exceeds it is a run the host would have killed too, which is the fact worth reporting.
   * Ten seconds is the host's default where the entry sets none.
   */
  runHook: (repoRoot, hook) =>
    runShell(repoRoot, hook.command, { CLAUDE_PROJECT_DIR: repoRoot }, (hook.timeout ?? 10) * 1000),
};

/**
 * The same probes with the hooks left alone, for the caller that is itself a hook.
 *
 * `commands/hook.ts` builds a health report on SessionStart, so executing the wired hooks from
 * inside one is `empo hook session-start` spawning `empo hook session-start`, and three subprocesses
 * do not fit the 10 second budget the host kills that event at either. The rest of the report is
 * unchanged, because everything else about it is a file read.
 */
export const quietProbes: HealthProbes = { ...systemProbes, runHook: null };

/**
 * What happened when the wired hook was run the way the host runs it.
 *
 * `"unprobed"` is a state of the entry and not only of the block, and that is the point of it. A
 * hook that was never executed has no result, and the only wrong answer here is one a reader can
 * mistake for a verified one: `"ok"` on an entry nobody ran would say the command resolves and exits
 * clean, which is exactly the claim the block exists to stop anybody from assuming. So `"ok"` means
 * an observed zero exit and nothing else, `HookHealth.state` carries the same fact for the block,
 * and the two cannot disagree because one is computed from the other.
 */
export type HookRunState = "ok" | "unprobed" | "not-found" | "failed" | "timeout";

export interface HookReport {
  event: string;
  matcher: string | null;
  command: string;
  state: HookRunState;
  /** The exit code observed, or null when the run timed out or no process started. */
  exitCode: number | null;
}

export interface HookHealth {
  /** "none": no EmPo hook is wired. "unprobed": hooks are wired but were not executed. "probed": every wired hook was run. */
  state: "none" | "unprobed" | "probed";
  hooks: HookReport[];
}

/**
 * The wired hooks, executed. Doctor had no hook line at all until this landed, and its only
 * executable probe was `commandExists("gh")`: nothing anywhere checked that the command the host is
 * wired to run actually runs.
 *
 * That gap is invisible by construction, which is why it is worth a subprocess. A hook fails open on
 * purpose (src/commands/hook.ts, invariant 3: never a non-zero exit, not even to deny), so a hook
 * whose binary is not on PATH exits 127 and the host treats it as nothing to say. A repository with
 * three broken hooks and a repository with three passing ones print the same thing, forever, and the
 * first person to find out is whoever expected a denial that never came.
 *
 * So the failure is named rather than counted, because the three repairs are different: a command
 * that could not be found is an install that is missing or a path that moved, a non-zero run is a
 * command that resolved and then broke, and a timeout is a hook the host kills before it can answer.
 * "The hook is broken" would send every one of them to the wrong place.
 *
 * **No hook wired is not a finding.** A Codex-only repository wires none of these, and neither does
 * one where `empo init` has not run, and both of those are facts about a choice rather than faults.
 */
export function hookHealth(
  repoRoot: string,
  probes: HealthProbes = systemProbes,
): { health: HookHealth; findings: HealthFinding[] } {
  const wired = wiredHooks(repoRoot);
  if (wired.length === 0) return { health: { state: "none", hooks: [] }, findings: [] };

  const run = probes.runHook;
  // Listed but not run, and said so entry by entry. The list is still worth printing: which hooks
  // are wired is a fact a file read answers, and it is the half of the block that costs nothing.
  if (run === null) {
    return {
      health: {
        state: "unprobed",
        hooks: wired.map((hook) => ({ ...listed(hook), state: "unprobed", exitCode: null })),
      },
      findings: [],
    };
  }

  const hooks: HookReport[] = [];
  const findings: HealthFinding[] = [];

  for (const hook of wired) {
    const result = run(repoRoot, hook);
    const report: HookReport = {
      ...listed(hook),
      state: hookRunState(result),
      // Null on a timeout whatever the platform reported, because a process the host killed did not
      // choose its exit code and printing one would read as a verdict the command never gave.
      exitCode: result.timedOut ? null : result.exitCode,
    };
    hooks.push(report);

    const finding = brokenHook(hook, report);
    if (finding !== null) findings.push(finding);
  }

  return { health: { state: "probed", hooks }, findings };
}

/** The three fields that come straight off the wiring, shared by the probed and unprobed paths. */
function listed(hook: WiredHook): Pick<HookReport, "event" | "matcher" | "command"> {
  return { event: hook.event, matcher: hook.matcher, command: hook.command };
}

/**
 * Timeout first, because a killed run is the one case where the exit code is not the command's
 * answer. After that the number decides: 127 is the shell saying it could not find the command
 * (engine/git.ts on `runShell` says why that survives as a number), and everything else non-zero is
 * a command that resolved and failed. A null exit code with no timeout is a process that never
 * started, which is a failure the same way, and reported as one rather than as its own state: there
 * is nothing a reader would do differently about it.
 */
function hookRunState(result: ShellResult): HookRunState {
  if (result.timedOut) return "timeout";
  if (result.exitCode === 0) return "ok";
  if (result.exitCode === 127) return "not-found";
  return "failed";
}

/**
 * One broken hook as a finding, or null where it ran clean.
 *
 * Warn and not error, which is the one place `unloadablePackFinding` below argues the other way. The
 * silence was the bug here and never the exit code: a hook fails open, so a repository enforcing
 * nothing printed exactly what a repository enforcing everything printed, and doctor naming the
 * event, the command and which of the three failures it hit is the whole of the repair. Exiting
 * non-zero on top of that would break every environment where hooks are irrelevant and doctor is
 * legitimately run. CI runs the built binary's `doctor` on a machine that deliberately has no `empo`
 * on PATH, because this repository's own settings.json wires the bare spelling, and the stripped-PATH
 * run that proves the binary needs no Node can never satisfy that command by construction. No agent
 * session runs there at all, so "this hook cannot run" is a true statement about a machine where it
 * does not matter, and a check that is permanently red in those places is the same false gate this
 * probe exists to remove, only inverted.
 *
 * The precedent is `gh` a few blocks up: an adapter CLI that is not on PATH is a warning, and a hook
 * command PATH cannot find is the same kind of fact about this machine. Every one of these sentences
 * names the event, because a settings.json holds several entries and "a hook is broken" is not a
 * thing anybody can go and fix.
 */
function brokenHook(hook: WiredHook, report: HookReport): HealthFinding | null {
  const runs = `hook ${report.event} runs "${report.command}"`;

  if (report.state === "not-found") {
    return {
      level: "warn",
      message:
        `${runs}, and that command could not be found, so this hook fails open on every ` +
        `${report.event} and enforces nothing. Install empo where the command names it ` +
        "(npm run install:local) or fix the command in .claude/settings.json.",
    };
  }

  if (report.state === "failed") {
    // The number, because it is the one thing the run said and the first thing anybody reproducing
    // this will compare against. A process that never started has no number, and saying so is
    // better than picking one.
    const exit =
      report.exitCode === null ? "and no process started" : `and exited ${report.exitCode}`;
    return {
      level: "warn",
      message:
        `${runs}, ${exit}, so this hook fails open on every ${report.event} and enforces nothing. ` +
        "Run the command by hand to see what it printed.",
    };
  }

  if (report.state === "timeout") {
    return {
      level: "warn",
      message:
        `${runs}, which did not finish inside its ${hook.timeout ?? 10} second timeout, so the ` +
        `host kills it and every ${report.event} passes unenforced. Find out what the command is ` +
        "waiting on, or raise the timeout in .claude/settings.json.",
    };
  }

  return null;
}

export interface Health {
  configPath: string;
  roots: { path: string; lang: string }[];
  packs: string[];
  /**
   * How many bridges config declares, which is not `bridges.length`: that array is empty without a
   * readable graph, and a reader must be able to tell "this repository couples nothing" from "the
   * graph could not be read to say".
   */
  bridgeCount: number;
  /** Per-bridge match rate, from bridgeRoots(). Empty when there are no bridges or no readable graph. */
  bridges: BridgeReport[];
  /** The host hooks this repository wires, and what each one did when it was run. */
  hooks: HookHealth;
  adapters: AdapterHealth;
  graph: GraphHealth;
  /** The flow map against the files it could claim, all null without a readable graph. */
  flows: FlowHealth;
  /**
   * What the name-resolving rules did with the names they read, per edge family. Null without a
   * readable graph, and null again where the graph is readable and predates the count, which are
   * both "nobody counted" and neither of which is the empty list.
   */
  names: NameResolution[] | null;
  spines: SpineHealth;
  findings: HealthFinding[];
  /** No finding of level "error". */
  ok: boolean;
}

/**
 * Throws a EmpoError when the config is missing or invalid, exactly as `loadConfig` does. Doctor
 * already behaves that way and a health report over a config nobody could read would have to
 * invent every field in it. A caller that wants silence catches it.
 *
 * `version` is where the installed pack versions come from, and it is a parameter only because
 * packs resolve out of the empo installation rather than out of the repository under report
 * (engine/graph.ts says the whole of it). Every caller in the product leaves it alone.
 */
export function healthReport(
  repoRoot: string,
  version: PackVersionReader = installedPackVersion,
  probes: HealthProbes = systemProbes,
): Health {
  const { config, path } = loadConfig(repoRoot);
  const adapters = adapterHealth(config, repoRoot, probes);
  const spines = spineHealth(repoRoot, config);
  const graph = graphHealth(repoRoot, version);
  const hooks = hookHealth(repoRoot, probes);

  // Config findings first, then the graph's own, then the spine ones. The graph's sit in the middle
  // because a pack that will not load is a broken installation like a missing root is, and the last
  // block has always been the spine warnings. The adapter findings join the first block, because
  // every one of them is a statement about the config being wrong about this machine or this
  // checkout, which is what the block above them already says.
  //
  // The hook findings go last, after the spine warnings that have always closed the list. They are
  // the only block that is not about this repository at all: every other finding is a statement
  // about the config, the packs, the graph or the spines, while these are about the wiring in the
  // host's settings.json and the empo installation the host reaches. That is also the order somebody
  // repairs them in, because a hook runs the very commands the blocks above report on, and a report
  // read top to bottom should say what is wrong with the tool before what is wrong with running it.
  const findings = [
    ...checkConfig(config, repoRoot),
    ...adapters.findings,
    ...graph.findings,
    ...spines.findings,
    ...hooks.findings,
  ];

  return {
    configPath: path,
    // In config order, not sorted: this is the list as its author wrote it.
    roots: config.roots.map((root) => ({ path: root.path, lang: root.lang })),
    packs: Object.keys(config.packs).sort(compareStrings),
    bridgeCount: config.bridges.length,
    // Computed from the graph on disk, so this describes the graph as built, at the age the graph
    // section states. It reads nodes only, so no rebuild is needed (engine/bridger.ts).
    bridges: graph.graph === null ? [] : bridgeRoots(graph.graph.nodes, config.bridges).reports,
    hooks: hooks.health,
    adapters: adapters.health,
    graph: graph.health,
    // Read off the same graph the bridge rates are, so the two describe one build rather than two.
    flows: flowHealth(graph.graph),
    names: nameHealth(graph.graph),
    spines: spines.health,
    findings,
    ok: !findings.some((finding) => finding.level === "error"),
  };
}

/** Directories that are never expected to be under a root, so they are not worth reporting. */
const UNINTERESTING = new Set(["node_modules", "vendor", "dist", "build", "coverage"]);

export function checkConfig(config: EmpoConfig, repoRoot: string): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const rootPaths = new Set(config.roots.map((root) => root.path));

  for (const root of config.roots) {
    if (!existsSync(join(repoRoot, root.path))) {
      findings.push({
        level: "error",
        message: `root "${root.path}" points at a directory that does not exist`,
      });
    }
    if (!Object.hasOwn(config.packs, root.lang)) {
      findings.push({
        level: "error",
        message: `root "${root.path}" has lang "${root.lang}", which is not in packs`,
      });
    }
    findings.push(...aliasTargets(root, repoRoot));
  }

  for (const lang of Object.keys(config.packs)) {
    if (!packAvailable(lang)) {
      findings.push({ level: "error", message: `pack "${lang}" is not installed` });
    }
  }

  // No finding on a bridge whose two sides name the same root, deliberately. It looks like a config
  // nobody meant, and it is the framework feature-test case: a test that calls its own HTTP route
  // rather than importing the controller is coupled to it and to nothing else that an import graph
  // can see, which is the whole reason bridges exist. engine/bridger.ts drops the self-pair and
  // keeps the rest, and test/engine/bridger.ts pins it. A finding here fires on a working config,
  // in every session forever through the hook block, and gets the whole report turned off.
  for (const bridge of config.bridges) {
    for (const side of ["produces", "consumes"] as const) {
      for (const path of [bridge[side]].flat()) {
        if (!rootPaths.has(path)) {
          findings.push({
            level: "error",
            message: `bridge "${bridge.kind}" ${side} root "${path}", which is not a configured root`,
          });
        }
      }
    }
  }

  for (const directory of unmappedDirectories(config, repoRoot)) {
    findings.push({
      level: "warn",
      message: `directory "${directory}" is under no root, nothing in it is indexed`,
    });
  }

  findings.push(...commitRecord(config, repoRoot));

  return findings;
}

/**
 * An alias whose targets point at a directory this checkout does not have.
 *
 * The whole cost of a wrong alias is silence: nothing fails, the import simply resolves to no node,
 * and the file it named comes out at a fan-in that counts only its relative importers. That is the
 * failure this repository builds against, so it is worth one line of a report. It is also the
 * likeliest way the field goes wrong, because the map is seeded once from a toolchain config and a
 * later move of the directory it points at leaves the alias behind.
 *
 * **Only the literal directory above the wildcard is checked**, never the whole target, because a
 * target names a module rather than a file: `packages/shared/money` is resolved through the pack's
 * extensions and index names, so `existsSync` on it is false for a target that resolves perfectly.
 * Under-reporting on purpose, on the rule the rest of this module follows: a finding that fires on a
 * working config is a finding somebody turns off.
 *
 * `warn` and not `error`, because an alias that points nowhere is a narrower graph rather than an
 * unusable one, and `empo index` still builds.
 */
function aliasTargets(root: EmpoConfig["roots"][number], repoRoot: string): HealthFinding[] {
  const findings: HealthFinding[] = [];

  for (const [pattern, targets] of Object.entries(root.aliases ?? {})) {
    for (const target of targets) {
      const star = target.indexOf("*");
      // The wildcard stands for at least one character, so a literal segment holding it is the
      // parent that has to exist rather than the path itself.
      const literal = dirname(star === -1 ? target : `${target.slice(0, star)}x`);
      if (literal === "." || existsSync(join(repoRoot, literal))) continue;

      findings.push({
        level: "warn",
        message:
          `root "${root.path}" aliases "${pattern}" to "${target}", and "${literal}" ` +
          "does not exist, so every import written through it resolves to nothing",
      });
    }
  }

  return findings;
}

/** The directory the `commit` list is a record about, and the file that is its other half. */
const GENERATED_DIR = ".empo/generated";
const EMPO_GITIGNORE = ".empo/.gitignore";

/**
 * The `commit` list against what git really does with `.empo/generated`. `empo init` writes both
 * halves of that decision from one flag and nothing derives either from the other afterwards, so
 * this is the only thing in EmPo that reads `commit` at all. It changes no behaviour: it reports a
 * record that has stopped describing the repository, which is what the field is for
 * (docs/02-on-disk-layout.md, docs/03-config-schema.md).
 *
 * git is asked rather than `.empo/.gitignore` parsed, because git is what the record claims to
 * describe. A root `.gitignore` with a recursive rule for the generated directory defeats a `commit`
 * list that says the output is committed, and no reading of the one file EmPo wrote would ever find
 * that; it is also how this repository ignores its own fixtures.
 *
 * Silence is the default and three states earn it, because every finding here reaches the
 * SessionStart hook (src/commands/hook.ts) and a warning that fires on a repository which has not
 * drifted is one nobody keeps installed. There is no `.empo/.gitignore`, so the pair this compares
 * was never written and the rules git obeys are someone else's to keep in step. There is no
 * `generated/` on disk, so a directory rule has nothing to match and git would answer "not ignored"
 * about a repository whose only fault is that it has never been indexed. Or there is no checkout,
 * where nothing is ignored or committed in the first place.
 */
function commitRecord(config: EmpoConfig, repoRoot: string): HealthFinding[] {
  if (!existsSync(join(repoRoot, EMPO_GITIGNORE))) return [];
  if (!existsSync(join(repoRoot, GENERATED_DIR))) return [];

  const ignored = ignoresPath(repoRoot, GENERATED_DIR);
  if (ignored === null) return [];

  const recorded = config.commit.some((entry) => entry.trim().replace(/\/+$/, "") === "generated");
  // The two agree when they are opposites: git ignoring the directory is git keeping it out of
  // version control, which is exactly what a record that does not list it says. So equal booleans
  // are the drift, and that is the whole comparison.
  if (ignored !== recorded) return [];

  const repair = "Edit .empo/.gitignore or the commit list so the two agree.";
  return [
    {
      level: "warn",
      message: recorded
        ? `config commit records "generated" as committed but git ignores ${GENERATED_DIR}. ${repair}`
        : `git does not ignore ${GENERATED_DIR} but config commit records nothing as committed. ${repair}`,
    },
  ];
}

/** Top-level directories no root covers. Deeper unmapped paths need the scanner, not this. */
export function unmappedDirectories(config: EmpoConfig, repoRoot: string): string[] {
  if (config.roots.some((root) => root.path === "." || root.path === "")) return [];

  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !UNINTERESTING.has(name))
    .filter(
      (name) =>
        !config.roots.some((root) => root.path === name || root.path.startsWith(`${name}/`)),
    )
    .sort(compareStrings);
}

/**
 * The adapters, which doctor read nothing about until this landed. Three
 * symptoms were reported from three directions and every one of them was invisible until a review
 * ran: a config with no tracker grades ticket-fit never, a forge that disagrees with the origin
 * remote is nobody's finding, and a `github` forge on a machine with no `gh` is discovered at the
 * moment somebody wanted a review.
 *
 * The split between a fact and a finding is the whole design here, and it is the SessionStart hook
 * that forces it: `commands/hook.ts` prints every finding this module produces, on every session, so
 * a finding raised on a steady state is a line a team reads once and then uninstalls the hook over.
 *
 * So a finding is raised only where config asks for something this machine or this checkout cannot
 * give it: a CLI that is not on PATH, or an `origin` on a host detection recognizes that is a
 * different kind from the one configured. Everything else is reported as a fact in doctor's block
 * and nowhere else. In particular **no adapter at all is not a finding**: a repository with no forge
 * and no tracker is reviewing the local diff and grading no ticket, which is a legitimate and common
 * configuration, and doctor states it in one line for the reader who came asking why ticket-fit
 * never ran.
 *
 * A slug that disagrees with `origin` is a fact and not a finding either, and that one is a
 * judgement rather than a rule: a fork workflow has origin pointing at the fork and config naming
 * the upstream, which is normal and would nag forever. So both slugs are printed side by side and
 * the human decides. A disagreement of **kind** against a host detection knows by name is different,
 * because no workflow makes a bitbucket.org checkout want a `gh` fetch.
 *
 * Against a host it does not know, the same disagreement is a fact and nothing more, and that line
 * was drawn by running this code rather than by reasoning about it. `empo doctor` in a container
 * whose origin had been rewritten to a local proxy reported the configured `github` forge as
 * contradicted, and every GitHub Enterprise checkout says exactly the same thing: `github.acme.com`
 * is deliberately not `github.com` to detection (engine/detect.ts), so `gh` with `GH_HOST` set is a
 * working setup this can only be wrong about. Hence `recognizedHost`, and hence a warning that
 * cannot fire on a host nobody taught it.
 *
 * `host` is never compared, though config and detection often hold the same short name. It is free
 * text the engine may not branch on (docs/03-config-schema.md), and a warning is a branch: "Bitbucket
 * Cloud" against a detected "bitbucket" is a config that works perfectly and a finding that is wrong.
 */
export function adapterHealth(
  config: EmpoConfig,
  repoRoot: string,
  probes: HealthProbes = systemProbes,
): { health: AdapterHealth; findings: HealthFinding[] } {
  const forge = config.adapters?.forge;
  const tracker = config.adapters?.tracker;
  const findings: HealthFinding[] = [];

  // Asked at most once however many adapters want it, because the forge and the tracker can both be
  // github's and the answer cannot differ between two calls in one report.
  let gh: boolean | null = null;
  const ghOnPath = (): RequiredCommand => {
    if (gh === null) gh = probes.commandExists("gh");
    return { command: "gh", present: gh };
  };

  const forgeCli = forge?.kind === "github" ? ghOnPath() : null;
  const trackerCli = tracker?.kind === "github-issues" ? ghOnPath() : null;

  // Not asked at all where there is nothing to compare it against, so a repository with no forge and
  // a repository configured `local` both spawn no git here.
  const detected =
    forge === undefined || forge.kind === "local" ? null : probes.detectForge(repoRoot);
  const remote: RemoteForge | null =
    detected === null
      ? null
      : {
          kind: detected.kind,
          host: detected.host ?? null,
          slug: forgeSlug(detected) ?? detected.repo,
          recognized: recognizedHost(detected),
        };

  if (forge !== undefined && forgeCli !== null && !forgeCli.present) {
    findings.push({
      level: "warn",
      message: `forge "${forge.kind}" needs the ${forgeCli.command} CLI, which is not on PATH, so empo review reads the local diff instead of the pull request`,
    });
  }

  if (trackerCli !== null && !trackerCli.present) {
    findings.push({
      level: "warn",
      message: `tracker "github-issues" needs the ${trackerCli.command} CLI, which is not on PATH, so empo review grades no ticket-fit`,
    });
  }

  if (forge !== undefined && remote?.recognized === true && remote.kind !== forge.kind) {
    findings.push({
      level: "warn",
      message: `forge is ${kindLabel(forge.kind, forge.host ?? null)} but the origin remote is ${remoteLabel(remote)}, so empo review would look for the pull request on the wrong host`,
    });
  }

  return {
    health: {
      forge: {
        kind: forge?.kind ?? null,
        host: forge?.host ?? null,
        slug: forge === undefined ? null : (forgeSlug(forge) ?? null),
        cli: forgeCli,
        remote,
      },
      tracker: {
        kind: tracker?.kind ?? null,
        host: tracker?.host ?? null,
        project: tracker?.project ?? null,
        cli: trackerCli,
      },
    },
    findings,
  };
}

/** `"mcp" (bitbucket)` where config names a host, `"github"` where the kind is the whole answer. */
function kindLabel(kind: string, host: string | null): string {
  return host === null ? `"${kind}"` : `"${kind}" (${host})`;
}

/**
 * The remote as a reader recognizes it, which is its host and never its kind: `bitbucket
 * acme/platform`. Calling it `"mcp"` here would answer with EmPo's own word for "a host empo cannot
 * reach" to somebody who asked what their git remote is.
 */
export function remoteLabel(remote: RemoteForge): string {
  return `${remote.host ?? remote.kind} ${remote.slug}`;
}

/**
 * The spine half of the session-start warning (docs/10-distribution.md): a drifted spine announces
 * itself instead of silently misleading the next change. Reported, never thrown: a malformed spine
 * is a finding here, the same as a bad root, because doctor is the command you run when something
 * else already went wrong.
 */
function spineHealth(
  repoRoot: string,
  config: EmpoConfig,
): { health: SpineHealth; findings: HealthFinding[] } {
  const empty = { dir: config.spines, count: 0, citations: 0, soft: 0, hard: 0, drifted: [] };

  let reports: SpineReport[];
  try {
    reports = verifySpines(repoRoot, loadSpines(repoRoot, config));
  } catch (error) {
    const details = error instanceof EmpoError ? error.details : [];
    return {
      health: { ...empty, state: "unreadable" },
      findings: [{ level: "error", message: [(error as Error).message, ...details].join(" ") }],
    };
  }

  if (reports.length === 0) return { health: { ...empty, state: "none" }, findings: [] };

  const drift = reports.filter((report) => report.soft + report.hard > 0);

  return {
    health: {
      dir: config.spines,
      state: "loaded",
      count: reports.length,
      citations: reports.reduce((count, report) => count + report.citations.length, 0),
      soft: reports.reduce((count, report) => count + report.soft, 0),
      hard: reports.reduce((count, report) => count + report.hard, 0),
      drifted: drift.map((report) => ({
        name: report.name,
        path: report.path,
        soft: report.soft,
        hard: report.hard,
      })),
    },
    // A warning even when the drift is hard. Drift is what `empo verify` exits 1 on (docs/06's exit
    // table); doctor reports health and only fails on a config that cannot be trusted to answer,
    // and a rotted spine still answers, loudly and in one place.
    findings: drift.map((report) => ({
      level: "warn" as const,
      message: `spine "${report.name}" has drifted: ${report.soft} soft, ${report.hard} hard. Run empo verify.`,
    })),
  };
}

/**
 * A doctor that cannot read the graph still reports on the config, so a broken or absent graph is
 * one state here rather than a failed command. The graph itself comes back beside the facts because
 * the bridge match rates are computed from its nodes, and so do its findings, because a pack the
 * graph names and this installation cannot load is only visible from here.
 */
function graphHealth(
  repoRoot: string,
  version: PackVersionReader,
): { graph: Graph | null; health: GraphHealth; findings: HealthFinding[] } {
  const unread: GraphHealth = {
    state: "missing",
    builtAgainst: null,
    commitsBehind: null,
    nodes: null,
    edges: null,
    stale: false,
    packDrift: [],
    schemaDrift: null,
  };

  if (!existsSync(graphPath(repoRoot))) return { graph: null, health: unread, findings: [] };

  // Every field read off the graph stays inside the try, not only the parse. `readGraph` casts the
  // parsed JSON to a Graph without checking its shape, so a graph.json that is valid JSON and not a
  // graph (`[]`, `{}`) parses and then throws on the first field. Unreadable is the honest answer to
  // both, and pulling the reads out here would turn one of them into a stack trace.
  try {
    const graph = readGraph(repoRoot);
    const age = staleness(repoRoot, graph);
    const drift = graphDrift(graph, version);
    return {
      graph,
      health: {
        state: "built",
        builtAgainst: age.builtAgainst,
        commitsBehind: age.commitsBehind,
        nodes: graph.stats.nodes,
        edges: graph.stats.edges,
        // Strictly greater than zero, and never on a null. See the module comment: an unknown
        // distance is not staleness. A drifted pack and a schema this binary does not write are both
        // certain rather than unknown, so unlike git distance each stands on its own.
        stale:
          (age.commitsBehind !== null && age.commitsBehind > 0) ||
          drift.packs.length > 0 ||
          drift.schema !== null,
        packDrift: drift.packs,
        schemaDrift: drift.schema,
      },
      findings: drift.unloadable.map(unloadablePackFinding),
    };
  } catch {
    return { graph: null, health: { ...unread, state: "unreadable" }, findings: [] };
  }
}

/**
 * A pack the graph was built with that is installed and will not load, as a finding.
 *
 * An error rather than a warning, and this is the one place in the report where that is worth
 * arguing. Nothing downstream can work: `empo query --orphans` loads the pack to ask which kinds the
 * framework resolves, and `empo index` loads it to build anything at all, so a doctor that called
 * this a warning and closed with "OK  config is valid" would be promising a repository that answers.
 * `checkConfig` above cannot reach it: its only pack check is `packAvailable`, which answers the
 * moment a pack.json exists (engine/pack-loader.ts) without reading a byte of it.
 *
 * The reason is the loader's own, because there is no shorter true version of it. "will not load"
 * alone leaves the reader to guess between a file that is not JSON, a file that fails the schema and
 * a pack whose declared name disagrees with its directory, and those are three different repairs.
 */
function unloadablePackFinding(pack: UnloadablePack): HealthFinding {
  return {
    level: "error",
    message: `pack "${pack.lang}" is named by the graph and will not load: ${pack.reason}`,
  };
}
