import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createForge, type HostPullRequestInput } from "../adapters/forge/create";
import { type ForgeAdapter, hasCapability, type PullRequest } from "../adapters/forge/types";
import { readHostPullRequest, readHostTicket, verifyPullRequest } from "../adapters/host-input";
import { createTracker } from "../adapters/tracker/create";
import { DEFAULT_KEY_PATTERN } from "../adapters/tracker/key";
import type { KeyMatch, Ticket, TrackerAdapter } from "../adapters/tracker/types";
import { type GateResult, gateFindings, type ReviewFinding } from "../discipline/findings";
import { reviewWorkflow } from "../discipline/load";
import { loadConfig } from "../engine/config";
import { type ChangedFile, changedLines, parseDiff } from "../engine/diff";
import {
  addWorktree,
  currentBranch,
  diffRange,
  fetchRef,
  removeWorktree,
  resolveRef,
} from "../engine/git";
import { readGraph, stalenessLines } from "../engine/graph";
import { type GuardedTouch, guardedTouches } from "../engine/guard";
import { compareStrings } from "../engine/order";
import {
  type CitationDrift,
  type LoadedSpine,
  loadSpines,
  type SpineReport,
  verifySpine,
} from "../engine/spines";
import { configError, type EmpoError, environmentError, readJson } from "../errors";
import type { EmpoConfig, EmpoForge } from "../schema/config.schema";
import { parseFindingsFile } from "../schema/findings.schema";
import type { HostTicket } from "../schema/host-payload.schema";
import type { Graph, GraphNode, PermanentFailure } from "../schema/types";
import { columnWidth } from "../term";
import { describeTouch, wantedPaths, wantedTerms } from "./check";
import { type BlastRadius, blastRadius, FLOOR_NOT_CEILING, radiusNode } from "./query";

/**
 * `empo review` (docs/06-cli.md, docs/07-review-discipline.md). The one command where the
 * discipline layer meets the graph, so the seam is kept sharp: this file orchestrates, and every
 * fact it prints came from a mechanical command underneath it. There is no model call here and
 * none anywhere below; the executing agent is the model, and it sits between the two phases.
 *
 * Two phases, because the verification gate is the product and it has to be impossible to skip:
 *
 *   empo review [<pr>]                 phase 1, the brief: the facts plus the shipped workflow.
 *   empo review [<pr>] --findings <f>  phase 2, the gate: every citation resolved against the real
 *                                      source, survivors only, then teardown.
 *
 * A finding whose anchor is not in the cited file never reaches the author. That is the whole
 * product (docs/00-overview.md principle 2).
 */

export interface ReviewOptions {
  base?: string;
  findings?: string;
  post?: boolean;
  readonly?: boolean;
  json?: boolean;
  /** Commander's --no-workflow sets this false. The brief prints the discipline by default. */
  workflow?: boolean;
  /**
   * `--pr-payload`: the pull request an mcp host fetched, as JSON, at the path the request block
   * named. Spelled out rather than `--pr` because the pull request id is already the positional
   * argument, and one line reading `empo review 412 --pr p.json` would spend one word on two
   * different things.
   */
  prPayload?: string;
  /** `--ticket-payload`. Absent means the pull request named no ticket, which is a real answer. */
  ticketPayload?: string;
  /**
   * Commander's `--no-ticket` sets this false, and it means "I went looking for the ticket this
   * pull request names and cannot get it: review without ticket-fit". It exists because the ticket
   * request below is a stop, and a stop needs a way out that is not a payload: a key empo extracted
   * from a real pull request may still name a ticket the agent cannot fetch, and without this the
   * agent is asked for it again on every re-run. Saying so is not the same as saying nothing, so
   * the brief reports it as the agent's answer rather than as an absence.
   */
  ticket?: boolean;
}

/** What phase 1 leaves behind so phase 2 can verify against the same code the review read. */
interface ReviewSession {
  id: string;
  repoRoot: string;
  /** Where citations are resolved: a detached worktree for a PR, the checkout for a local diff. */
  readRoot: string;
  worktree: string | null;
  base: string;
  sourceBranch: string | null;
  diffPath: string;
}

interface FileFacts {
  file: ChangedFile;
  /**
   * One radius for the whole file, or null where no node of the graph lives in it.
   *
   * One and not one per node, which is what this held while a node was always a file. Under a pack
   * that ids by symbol a changed twenty-export module is twenty nodes, and a brief printing a block
   * each would spend twenty screens saying what the reviewer asked about one file. The union over
   * the file's nodes is the answer they wanted from the start: what can changing this file reach.
   */
  radius: BlastRadius | null;
  /**
   * How many nodes the file yields in total, which is what makes the narrowing legible: a radius
   * over one node of a twenty-export module and a radius over the only node the file has print the
   * same row otherwise, and only one of them left nineteen exports out.
   */
  yielded: number;
}

/**
 * One curated chain this change is on, and the three separate reasons it can be on it. They are kept
 * apart rather than collapsed into a boolean because they ask the reviewer for different work: a
 * `guarded` hit is what `empo check` will gate on, a hop or trap file is the map the author should
 * have read first, and a flow overlap is the spine's own claim meeting the graph's.
 */
interface SpineFacts {
  loaded: LoadedSpine;
  /**
   * Changed files this spine's `guarded` globs claim, computed through the gate's own
   * `guardedTouches`. Exactly the gate's subject, renames included: a change that moves a guarded
   * file out of the guarded tree fires `empo check`, so the brief has to name that spine too.
   */
  guarded: GuardedTouch[];
  /** Changed files a hop or a trap cites. `guarded` need not cover these, and often does not. */
  onChain: string[];
  /** Flows the spine claims that the blast radius also reaches. */
  flows: string[];
  /** Every coordinate this section is about to print, resolved against the code under review. */
  report: SpineReport;
}

export function reviewCommand(
  repoRoot: string,
  pr: string | undefined,
  options: ReviewOptions = {},
): void {
  if (options.post === true && options.readonly === true) {
    throw configError("--post and --readonly contradict each other", [
      "--readonly suppresses every mutating action, which is what --post asks for.",
    ]);
  }

  if (options.findings !== undefined && options.findings !== "") {
    gatePhase(repoRoot, pr, options);
    return;
  }
  briefPhase(repoRoot, pr, options);
}

// ---------------------------------------------------------------------------------------------
// Phase 1: the brief
// ---------------------------------------------------------------------------------------------

function briefPhase(repoRoot: string, pr: string | undefined, options: ReviewOptions): void {
  const { config } = loadConfig(repoRoot);
  const graph = readGraph(repoRoot);
  const notes: string[] = [];

  const provisionalBase = options.base ?? defaultBase(repoRoot);
  const id = pr ?? "local";
  const paths = hostPayloadPaths(repoRoot, id);

  // Phase 0, and only for a host EmPo cannot call itself: state exactly what to fetch and stop.
  // The agent running this command holds the connector, so it is the one that can answer, and it
  // answers by re-running with --pr-payload. A local review never gets here, having no pull
  // request for anyone to fetch.
  if (pr !== undefined && awaitingHostFetch(config, options)) {
    printHostRequest(
      config,
      { id: pr, base: provisionalBase, paths, given: options },
      options.json === true,
    );
    return;
  }

  const host = readHostPayloads(repoRoot, config, pr, options);

  const forge = createForge(config, repoRoot, {
    base: provisionalBase,
    pr,
    pullRequest: host.pr,
    payloadPath: paths.pr,
  });
  if (forge.note !== null) notes.push(forge.note);

  // Before the worktree, before the ticket ask, before anything the reviewer would have to redo.
  // This is the earliest the question is answerable: it is a question about an adapter, and the
  // line above is where the first one exists. The gate builds its own from the same config later,
  // so the two are not always the same object, but neither gains a capability the other lacks.
  if (options.post === true) requirePostCapability(config, forge.adapter, forge.note);

  const tracker = createTracker(config, repoRoot, { payload: host.ticket });
  if (tracker.note !== null) notes.push(tracker.note);

  const prMeta = pr === undefined ? null : forge.adapter.getPr(pr);
  if (pr !== undefined && prMeta === null) {
    notes.push(
      `The configured forge cannot fetch pull request ${pr}, so the local diff against ` +
        `${provisionalBase} is under review instead. Findings will be about your working tree.`,
    );
  }

  // Phase 0 again, for the half the block above cannot reach. `awaitingHostFetch` fires on the
  // forge, so a `github` forge with an `mcp` tracker printed no request block and nobody ever asked
  // for the ticket: one real review ran with ticket-fit ungraded and said so, which is the tool
  // telling the truth about a question nothing had put.
  //
  // This one runs after the fetch rather than before it, and that is what makes it a better ask
  // than the one above. EmPo is holding the pull request, so it applies the key pattern itself and
  // names the ticket, where the mcp block can only print the pattern and ask the agent to match it.
  // It sits above `isolate` so that a stop costs no worktree.
  const wanted = prMeta === null ? null : ticketWanted(config, options, tracker.adapter, prMeta);
  if (wanted !== null) {
    printTicketFetchRequest(
      config,
      { id, key: wanted, base: provisionalBase, paths, given: options },
      options.json === true,
    );
    return;
  }
  // The PR's own base is the right one unless the human pinned another. Stacked PRs are why this
  // is explicit everywhere downstream rather than assumed to be the default branch.
  const base = options.base ?? prMeta?.baseBranch ?? provisionalBase;
  const session = isolate(repoRoot, id, base, prMeta, forge.adapter, options, notes);
  const changed = reviewableFiles(parseDiff(readFileSync(session.diffPath, "utf8")));
  if (changed.skipped.length > 0) {
    notes.push(
      `${changed.skipped.length} machine-owned file(s) left out of the review: ` +
        `${changed.skipped.join(", ")}. empo index writes them and nobody reviews them.`,
    );
  }

  const facts = changed.files
    .map((file) => {
      const nodes = nodesFor(graph, file.path);
      const touched = narrowToChangedLines(nodes, file);
      return {
        file,
        radius: touched.length === 0 ? null : blastRadius(graph, touched),
        yielded: nodes.length,
      };
    })
    .sort((a, b) => compareStrings(a.file.path, b.file.path));

  const ticket = lookupTicket(tracker.adapter, prMeta, session.sourceBranch);

  // The spines come off the reviewer's own checkout and their coordinates are resolved against the
  // read root, which are two different commits on a pull request and deliberately so. The map is the
  // one the team curates; the code it is checked against is the code this change proposes. So a
  // pull request that moves a hop's line reads as drift here, in the review, which is the earliest
  // place anyone can be told. Reading the spine out of the worktree instead would let a change edit
  // the map and the chain together and report itself as consistent.
  const curated = loadSpines(repoRoot, config);
  const spines = spinesTouched(session.readRoot, curated, changed.files, facts);

  if (options.json === true) {
    console.log(
      JSON.stringify(
        {
          id,
          forge: forge.adapter.kind,
          tracker: tracker.adapter.kind,
          base,
          sourceBranch: session.sourceBranch,
          readRoot: session.readRoot,
          diffPath: session.diffPath,
          pr: prMeta,
          // `ticket.comments` is null where nobody fetched them and `[]` where somebody did and
          // the ticket carries none. JSON holds that difference itself, so this surface needs no
          // sibling key the way `spinesCurated` sits beside `spines`: the distinction is in the
          // value, and it only survives because nothing on the way here defaulted the null away.
          ticket: ticket.ticket,
          ticketKey: ticket.key,
          ticketSkipped: tracker.adapter.skipReason,
          // A silence and a statement again. `ticketSkipped` says no ticket arrived, which is also
          // true when nobody was ever asked; this says the agent was asked, went looking, and came
          // back empty. Only one of the two is a reason to stop asking.
          ticketDeclined: options.ticket === false,
          ci: forge.adapter.getCiResult(id),
          notes,
          files: facts.map((entry) => ({
            path: entry.file.path,
            status: entry.file.status,
            added: entry.file.addedCount,
            removed: entry.file.removedCount,
            // Still a list, and now of at most one entry: one radius per changed file, whose own
            // `nodes` holds every node the diff's lines reached. A consumer reading the ids reads
            // them from there rather than from one radius per node.
            nodes: entry.radius === null ? [] : [entry.radius],
            // The denominator for that list: how many nodes the file yields in all. Fewer nodes in
            // the radius than this means the hunks narrowed it, and a consumer that wants the whole
            // file's radius back knows from these two numbers that it is not holding one.
            nodesInFile: entry.yielded,
          })),
          // The same fact the brief prints under `dispatches inside a loop`, restricted to the
          // changed files for the same reason: null and not [] on a graph built before the axis,
          // because a consumer defaulting the absence to "found none" would read a clean bill of
          // health off a field no run ever wrote.
          fanout:
            graph.fanout === undefined
              ? null
              : graph.fanout.filter((site) => facts.some((entry) => entry.file.path === site.file)),
          // The denominator rides alongside the list, so a reader can tell "no spine claims this
          // change" from "this repository curates no spine". Both answer `spines: []`, and only one
          // of them is reassuring (the same rule --hazards keeps for a graph older than the axis).
          spinesCurated: curated.length,
          spines: spines.map((entry) => ({
            name: entry.loaded.spine.name,
            path: entry.loaded.path,
            guarded: entry.guarded,
            onChain: entry.onChain,
            flows: entry.flows,
            spine: entry.loaded.spine,
            drift: entry.report,
          })),
          conventions: conventionsFacts(repoRoot),
          findingsPath: join(sessionDir(repoRoot, id), "findings.json"),
          workflow: options.workflow === false ? null : reviewWorkflow(),
          caveat: FLOOR_NOT_CEILING,
        },
        null,
        2,
      ),
    );
    return;
  }

  printBrief(repoRoot, graph, {
    id,
    base,
    session,
    forge: forge.adapter,
    tracker: tracker.adapter,
    prMeta,
    ticket,
    facts,
    spines,
    curated: curated.length,
    ticketDeclined: options.ticket === false,
    notes,
  });

  if (options.workflow !== false) {
    console.log("");
    console.log("=".repeat(96));
    console.log("");
    console.log(reviewWorkflow());
  }
}

// ---------------------------------------------------------------------------------------------
// Phase 0: what the agent host has to fetch
// ---------------------------------------------------------------------------------------------

/**
 * Where the agent host writes what it fetched. Derived from the review's own scratch directory and
 * deliberately not configurable (docs/09-adapters.md, "Where a review's scratch lives").
 *
 * That is a security decision rather than a convenience one. These files carry pull request
 * descriptions and ticket bodies out of private trackers, and `.empo/` is the directory a team
 * commits. A configurable path is a path somebody eventually points inside the repository, and then
 * the first team to configure a tracker commits a customer's ticket body into git. The temp
 * directory also hashes the canonical repo root into the name already, so two checkouts reviewing
 * the same pull request id cannot read each other's payload.
 */
function hostPayloadPaths(repoRoot: string, id: string): HostPayloadPaths {
  const dir = sessionDir(repoRoot, id);
  return { dir, pr: join(dir, "pull-request.json"), ticket: join(dir, "ticket.json") };
}

interface HostPayloadPaths {
  dir: string;
  pr: string;
  ticket: string;
}

/**
 * Whether this review has to stop and ask the host to fetch something first.
 *
 * A path that was passed and is not there counts as "not fetched" rather than as a bad flag,
 * because in practice they are one situation: the session directory is torn down with the review,
 * so the second run of a command that worked once finds its own payload gone. The request block is
 * the remedy either way, and it says far more than "no such file" does.
 */
function awaitingHostFetch(config: EmpoConfig, options: ReviewOptions): boolean {
  if (config.adapters?.forge?.kind !== "mcp") return false;
  if (options.prPayload === undefined || !existsSync(options.prPayload)) return true;
  return options.ticketPayload !== undefined && !existsSync(options.ticketPayload);
}

/**
 * The ticket this pull request names, when the tracker cannot fetch it and nobody has yet been
 * asked to. Null means no ask: either there is nothing to ask for, or asking is somebody else's
 * job, and the four ways that happens are each a different situation.
 *
 * An `mcp` **forge** is excluded because its own request block already carries a ticket section, so
 * asking again here would ask twice for one round trip. A supplied `--ticket-payload` is excluded
 * because the answer is already in hand; a stale path never reaches this line, since
 * `readHostPayloads` refuses one above. `--no-ticket` is excluded because the agent has answered.
 * And a pull request whose title, branch and description carry no key is excluded because there is
 * nothing to name: this asks for one ticket by key, and an ask for "whichever ticket, if any" is
 * exactly the vaguer thing the mcp block has to do and this one does not.
 */
function ticketWanted(
  config: EmpoConfig,
  options: ReviewOptions,
  tracker: TrackerAdapter,
  prMeta: PullRequest,
): KeyMatch | null {
  if (config.adapters?.tracker?.kind !== "mcp") return null;
  if (config.adapters?.forge?.kind === "mcp") return null;
  if (options.ticketPayload !== undefined) return null;
  if (options.ticket === false) return null;

  return tracker.extractKey({
    branch: prMeta.sourceBranch,
    title: prMeta.title,
    body: prMeta.description,
  });
}

/**
 * The narrow sibling of the request block above: one ticket, named, from a pull request empo has
 * already read. Everything the wide block has to explain about matching a pattern is gone, because
 * the match already happened here.
 *
 * It exits 0, like the other one, and for the same reason: nothing has failed, the next step is the
 * agent's. The way out that is not a payload is `--no-ticket`, and it is printed, because a stop
 * whose only exit is success is a loop for any agent whose tracker does not hold the key a branch
 * name promised.
 */
function printTicketFetchRequest(config: EmpoConfig, view: TicketRequestView, json: boolean): void {
  mkdirSync(view.paths.dir, { recursive: true });

  const named = config.adapters?.tracker?.host ?? "the tracker";
  const command = `empo review ${view.id} --ticket-payload ${view.paths.ticket}`;
  const lines = ticketFetchLines(view, named, command);

  if (json) {
    console.log(
      JSON.stringify(
        {
          awaiting: "ticket",
          id: view.id,
          host: config.adapters?.tracker?.host ?? null,
          key: view.key.key,
          keyFrom: view.key.from,
          payloadPath: view.paths.ticket,
          command,
          declineCommand: `empo review ${view.id} --no-ticket`,
          instructions: lines.join("\n"),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(lines.join("\n"));
}

function ticketFetchLines(view: TicketRequestView, named: string, command: string): string[] {
  const out: string[] = [];

  out.push("");
  out.push(`pull request ${view.id} names ticket ${view.key.key}, and empo cannot fetch it`);
  out.push("");
  out.push(`empo read the pull request itself and found ${view.key.key} in its ${view.key.from}.`);
  out.push(
    `This CLI holds no token for ${named}, so fetch that ticket with your ${named} tool, write`,
  );
  out.push("it as JSON to the path below, and run the command at the end.");
  out.push("");
  out.push(`  ${view.paths.ticket}`);
  // The one field that is a claim rather than a copy, so it is stated before the shape and not
  // inside it: this key is the lookup, and a payload carrying the host's own id is read as a
  // different ticket and silently reported as not found.
  out.push("");
  out.push(`Echo ${JSON.stringify(view.key.key)} back in "key", character for character, not the`);
  out.push("host's own identifier for the same ticket. EmPo matches that field against the key it");
  out.push("just extracted, so an id that does not match is read as the wrong ticket and the");
  out.push('review reports no ticket at all. Put the host id and the permalink in "url".');
  out.push("");
  out.push("  {");
  out.push(`    "key": ${JSON.stringify(view.key.key)},`);
  out.push('    "title": "...",');
  out.push('    "type": "bug" | "feature" | "chore" | "unknown",');
  out.push('    "body": "...",');
  out.push('    "url": "...",                 the permalink, and the host\'s own id if it has one');
  out.push('    "completed": true | false,');
  out.push('    "comments": [{ "author": "...", "body": "..." }]');
  out.push("  }");
  out.push("");
  out.push('  "criteria": ["..."] is optional and the omission means something. Leave it out and');
  out.push(
    "  empo reads the acceptance criteria out of the body itself. [] says the ticket states",
  );
  out.push("  none, which the review reports as its own finding. Do not write [] because you did");
  out.push("  not look.");
  out.push("");
  out.push('  "comments" is required. A comment is where a sub-item gets scoped out, and the');
  out.push("  review is told not to flag what a comment retracted, so an empty list because you");
  out.push("  did not look reads as nobody having withdrawn anything. [] because you looked and");
  out.push("  there were none is right and expected.");
  out.push("");
  out.push("then run");
  out.push("");
  out.push(`  ${command}`);
  out.push("");
  out.push(
    `If ${named} has no ${view.key.key}, or you cannot reach it, say so instead of guessing:`,
  );
  out.push("");
  out.push(`  empo review ${view.id} --no-ticket`);
  out.push("");
  out.push("That runs the whole review with ticket-fit ungraded and the reason on the record. Do");
  out.push("not invent a ticket to get past this: a diff graded against acceptance criteria");
  out.push("nobody wrote produces confident findings about work nobody asked for.");
  out.push("");
  out.push("Nothing has failed here. The review runs on that second call.");

  return out;
}

interface TicketRequestView {
  id: string;
  key: KeyMatch;
  base: string;
  paths: HostPayloadPaths;
  given: ReviewOptions;
}

interface HostPayloads {
  pr: HostPullRequestInput | null;
  ticket: HostTicket | null;
}

/**
 * The two payload flags, read and checked before any of the review runs. Same three steps the
 * findings file goes through in phase 2, in the same order and for the same reason: a file that is
 * absent, a file that is not JSON and a file of the wrong shape are three different mistakes, and
 * an agent that has to write the file again should be told which one it made.
 *
 * A payload that fails is a config error, exit 2, listing every problem at once. Exit 2 rather than
 * 3 because nothing about the environment is broken: the agent handed over something it can fix and
 * hand over again. Every problem at once because one problem per round trip is how a fetch that is
 * wrong in three ways costs three fetches.
 */
function readHostPayloads(
  repoRoot: string,
  config: EmpoConfig,
  pr: string | undefined,
  options: ReviewOptions,
): HostPayloads {
  // Refused rather than ignored. Only an mcp adapter reads a payload, so a github forge handed one
  // would review through gh and never mention that the file it was pointed at went unread, which
  // is the same false model a flag that does nothing teaches.
  refuseUnusedPayload("--pr-payload", options.prPayload, "forge", config.adapters?.forge?.kind);
  refuseUnusedPayload(
    "--ticket-payload",
    options.ticketPayload,
    "tracker",
    config.adapters?.tracker?.kind,
  );

  return {
    pr: readPrPayload(repoRoot, pr, options.prPayload),
    ticket: readTicketPayload(options.ticketPayload),
  };
}

function refuseUnusedPayload(
  flag: string,
  path: string | undefined,
  adapter: string,
  kind: string | undefined,
): void {
  if (path === undefined || kind === "mcp") return;
  throw configError(`${flag} needs adapters.${adapter}.kind to be "mcp"`, [
    `It is ${kind === undefined ? "not configured" : `"${kind}"`}, and only an mcp adapter reads a payload the host fetched.`,
    `Drop ${flag}, or set adapters.${adapter} to { "kind": "mcp", "host": "..." } in your EmPo config.`,
  ]);
}

function readPrPayload(
  repoRoot: string,
  pr: string | undefined,
  path: string | undefined,
): HostPullRequestInput | null {
  if (path === undefined) return null;

  if (pr === undefined) {
    throw configError("--pr-payload <file> needs the pull request it describes to be named too", [
      "Run empo review <pr> --pr-payload <file>.",
      "Without the id there is nothing to check the payload's own id against, and a payload for " +
        "the wrong pull request is the mistake that check exists to catch.",
    ]);
  }

  if (!existsSync(path)) {
    throw configError(`No pull request payload at ${path}`, [
      `Run empo review ${pr} to print what to fetch and where to write it.`,
    ]);
  }

  const read = readHostPullRequest(path);
  if (!read.ok)
    throw configError(`${path} is not a valid EmPo pull request payload`, read.problems);

  // The gate this whole design stands on: the payload's branch names are checked against real git,
  // which is the one thing the model that wrote them does not control. What comes back is the two
  // refs that resolved, because "main" and "origin/main" are not interchangeable and the diff has
  // to be taken against the spelling verification actually found.
  const verified = verifyPullRequest(repoRoot, read.value, pr);
  if (!verified.ok) {
    throw configError(
      `The pull request payload at ${path} does not check out against this repository`,
      verified.problems,
    );
  }
  return { payload: read.value, verified: verified.value };
}

function readTicketPayload(path: string | undefined): HostTicket | null {
  if (path === undefined) return null;

  if (!existsSync(path)) {
    throw configError(`No ticket payload at ${path}`, [
      "Write the ticket there, or drop --ticket-payload and the review will state that " +
        "ticket-fit was not graded rather than grading it against nothing.",
    ]);
  }

  const read = readHostTicket(path);
  if (!read.ok) throw configError(`${path} is not a valid EmPo ticket payload`, read.problems);
  return read.value;
}

interface HostRequestView {
  id: string;
  base: string;
  paths: HostPayloadPaths;
  given: ReviewOptions;
}

/**
 * The request block: what the agent running this command has to fetch, in the exact shape empo
 * will accept, and the exact command to run afterwards. Its reader is an agent and not a person,
 * so it is an interface rather than prose: every field is named, every optional field says what
 * omitting it means, and the last line is a command to copy.
 *
 * It exits 0. Nothing has failed: this is the same two-phase handoff `empo review` already makes
 * between the brief and the findings, and the exit table in docs/06-cli.md has no code for "the
 * next step is yours" because 1, 2 and 3 all mean something went wrong.
 *
 * Under --json it goes out as one field of a JSON document rather than as bare text on a stream
 * that promised JSON. The instructions themselves stay prose in that field: they are written to be
 * read, and a caller that wants the two paths and the command has them as their own keys.
 */
function printHostRequest(config: EmpoConfig, view: HostRequestView, json: boolean): void {
  // The directory the agent is about to write into has to exist, and nothing else has made it yet:
  // isolate() creates it, and isolate() is downstream of this return.
  mkdirSync(view.paths.dir, { recursive: true });

  const lines = hostRequestLines(config, view);
  const ticket = config.adapters?.tracker?.kind === "mcp" ? view.paths.ticket : null;

  if (json) {
    console.log(
      JSON.stringify(
        {
          awaiting: "pull-request",
          id: view.id,
          host: config.adapters?.forge?.host ?? null,
          payloadPath: view.paths.pr,
          ticketPath: ticket,
          command: `empo review ${view.id} --pr-payload ${view.paths.pr}${ticketFlag(config, view)}`,
          instructions: lines.join("\n"),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(lines.join("\n"));
}

/**
 * The ticket is asked for in the same block, conditionally, rather than in a block of its own. The
 * ticket key is extracted from the pull request, so asking for it separately would need three
 * invocations to review one pull request: fetch the pull request, learn the key, fetch the ticket.
 * The agent can read the title it just fetched and apply the pattern itself, which makes it one.
 */
function hostRequestLines(config: EmpoConfig, view: HostRequestView): string[] {
  const out: string[] = [];
  const forge = config.adapters?.forge;
  const host = forge?.host ?? null;
  const tool = host === null ? "your pull request tool" : `your ${host} tool`;

  out.push("");
  out.push(`empo cannot fetch pull request ${view.id}, and you can`);
  out.push("");
  out.push("This CLI holds no token and makes no network call. The MCP connector that reaches");
  out.push(
    `${host ?? "the host"} belongs to the agent running this command. So: fetch the pull request with`,
  );
  out.push(`${tool}, write it as JSON to the path below, and run the command at the end.`);
  out.push("");
  out.push(`  ${view.paths.pr}`);

  printStaleFlags(out, view);

  out.push("");
  out.push('Every field below is required. Write "" for an empty string rather than leaving the');
  out.push('key out: "" is a statement and a missing key is a silence, and they are read');
  out.push("differently. An unrecognized key is refused with its name.");
  out.push("");
  out.push("  {");
  out.push(`    "id": ${JSON.stringify(view.id)},`);
  out.push('    "title": "...",');
  out.push('    "author": "...",              the display name of whoever opened it');
  out.push('    "sourceBranch": "...",        the branch under review, name only, no refs/heads/');
  out.push('    "baseBranch": "...",          what it merges into');
  out.push('    "description": "...",         the body of the pull request');
  out.push('    "url": "..."');
  out.push("  }");
  out.push("");
  out.push(
    `The id must be exactly ${JSON.stringify(view.id)}. It is checked, and a payload describing a`,
  );
  out.push("different pull request is refused: fetching one id and being asked for another is a");
  out.push("one-keystroke mistake that nothing downstream would notice.");
  out.push("");
  out.push("Both branch names are checked against this repository's git. A branch that does not");
  out.push("resolve here fails the review before it starts, which is what makes a fetched pull");
  out.push("request worth believing.");

  printOptionalFields(out);
  printNoDiff(out);
  if (host === "bitbucket") printBitbucketMapping(out, forge, view.id);
  printTicketRequest(out, config, view);

  out.push("");
  out.push("then run");
  out.push("");
  out.push(`  empo review ${view.id} --pr-payload ${view.paths.pr}`);
  // On its own line and unbracketed. A [--ticket-payload ...] appended to the command above reads as part
  // of it, and the flag would go to the shell with its brackets on the first time an agent copies
  // the line it was told to run.
  if (ticketFlag(config, view) !== "") {
    out.push("");
    out.push("and append this to that command if, and only if, you wrote the ticket file:");
    out.push("");
    out.push(` ${ticketFlag(config, view)}`);
  }
  out.push("");
  out.push(`Nothing has failed here. The review runs on that second call, against ${view.base}`);
  out.push("or whatever base the pull request declares.");

  return out;
}

function printStaleFlags(out: string[], view: HostRequestView): void {
  if (view.given.prPayload !== undefined && !existsSync(view.given.prPayload)) {
    out.push("");
    out.push(
      `  (--pr-payload ${view.given.prPayload} names no file. A review takes its payload down with it`,
    );
    out.push(
      "  when it finishes, so fetch the pull request again rather than going looking for it.)",
    );
  }
  if (view.given.ticketPayload !== undefined && !existsSync(view.given.ticketPayload)) {
    out.push("");
    out.push(`  (--ticket-payload ${view.given.ticketPayload} names no file either.)`);
  }
}

function printOptionalFields(out: string[]): void {
  out.push("");
  out.push(
    "Three optional fields. Leaving one out is itself a fact the review reports, so leave it",
  );
  out.push("out when you did not fetch it and never fill it in with a guess.");
  out.push("");
  out.push('  "headSha": "..."');
  out.push("      The commit the host says sourceBranch is at. Omitted, nothing checks whether");
  out.push("      this checkout is at the same commit the pull request is, and a payload written");
  out.push("      against an older push produces a confident review of code that was replaced.");
  out.push("      An abbreviated hash is fine: it is compared by prefix, not by equality.");
  out.push("");
  out.push('  "comments": [{ "author": "...", "body": "...", "file": null, "line": null }]');
  out.push("      Omitted, the review states that existing comments were not read. [] states that");
  out.push("      you read them and there are none. file and line are the repo-relative path and");
  out.push("      line of an inline comment, and null for a top-level one.");
  out.push("");
  out.push('  "ci": { "state": "passed" | "failed" | "pending" | "unknown", "detail": "..." }');
  out.push("      Omitted, the review states that the pipeline was not checked. Never write");
  out.push('      "passed" for a pipeline you did not read: a review that invents a green build');
  out.push("      is worse than one that says it could not see the build.");
}

function printNoDiff(out: string[]): void {
  out.push("");
  out.push("Do not fetch the diff. EmPo computes it locally with git from sourceBranch and");
  out.push("baseBranch, which is what makes the one artefact this review reads line by line the");
  out.push("one artefact no model has touched. A fetched diff is also redirected, truncated at");
  out.push("the host's file and line caps, and slower.");
}

/**
 * The one place in the tool that reads `host` as anything but a name to print, and it is still only
 * printing: this is a table of field names for the agent, not a branch in the engine. Every field
 * was confirmed against a real Bitbucket pull request rather than read off the REST swagger, which
 * described a surface the agent does not see: it says there is no top-level `description` and that
 * the body lives at rendered.description.raw, and against the real response both `description` and
 * `summary.raw` carry it.
 */
function printBitbucketMapping(out: string[], forge: EmpoForge | undefined, id: string): void {
  out.push("");
  out.push(
    "Bitbucket field mapping, confirmed against a real pull request. One bitbucketPullRequest",
  );
  out.push(
    `call with action "get", workspaceId ${JSON.stringify(forge?.workspace ?? "<your workspace slug>")}, ` +
      `repoId ${JSON.stringify(forge?.repo ?? "<your repo slug>")}, prId ${JSON.stringify(id)}:`,
  );
  out.push("");
  out.push("  id            <- id, which is a number: write it as a string");
  out.push("  title         <- title");
  out.push("  author        <- author.display_name");
  out.push("  sourceBranch  <- source.branch.name");
  out.push("  baseBranch    <- destination.branch.name");
  out.push("  description   <- description, falling back to summary.raw");
  out.push("  url           <- links.html.href");
  out.push("");
  out.push('  An empty description is real and common, so write "" and do not go hunting for the');
  out.push("  text elsewhere.");
  out.push("");
  out.push('  "headSha" is not in that table because no field for it was confirmed. If the same');
  out.push("  response carries the source branch's commit hash, write it: Bitbucket abbreviates");
  out.push("  it to 12 characters, which is compared by prefix and matches. Do not compose one");
  out.push("  from another call to make the field present.");
  out.push("");
  out.push('  Omit "ci". The pull request carries a links.statuses.href, but no action on any');
  out.push(
    "  Bitbucket MCP tool exposes it. Do not substitute a Pipelines call: it sees Bitbucket",
  );
  out.push("  Pipelines only and misses third-party CI, which is a weak signal that would read as");
  out.push("  a strong one.");
}

function printTicketRequest(out: string[], config: EmpoConfig, view: HostRequestView): void {
  const tracker = config.adapters?.tracker;
  if (tracker?.kind !== "mcp") return;

  const pattern = tracker.keyPattern ?? DEFAULT_KEY_PATTERN;
  const named = tracker.host ?? "the tracker";

  out.push("");
  out.push(`If the pull request names a ticket, fetch that in the same round trip`);
  out.push("");
  out.push(`Match this pattern against the title first, then the source branch, then the`);
  out.push(`description:  ${pattern}`);
  out.push("");
  out.push(`If any of them matches, fetch that ticket from ${named} and write it to`);
  out.push("");
  out.push(`  ${view.paths.ticket}`);
  out.push("");
  out.push("  {");
  out.push('    "key": "...",                 the string you matched, echoed back verbatim');
  out.push('    "title": "...",');
  out.push('    "type": "bug" | "feature" | "chore" | "unknown",');
  out.push('    "body": "...",');
  out.push('    "url": "...",                 the permalink, and the host\'s own id if it has one');
  out.push('    "completed": true | false,');
  out.push('    "comments": [{ "author": "...", "body": "..." }]');
  out.push("  }");
  out.push("");
  // The failure this prevents is the quietest one in the whole design, so it goes first and it is
  // stated as a rule with its reason attached, not mentioned in passing.
  out.push(`  Echo the matched key back in "key", character for character. Not the host's own`);
  out.push("  identifier for the same ticket, even when that is what you fetched it by, and even");
  out.push("  when it looks more correct. An Asana task, for instance, is fetched by a 16-digit");
  out.push("  gid and has no other native identifier, so an agent that has just called the API");
  out.push(
    "  naturally writes the gid here. EmPo matches this field against the key it pulled out",
  );
  out.push(
    `  of the pull request with the pattern above (${pattern}), so a gid never matches, and`,
  );
  out.push(
    "  the mismatch is silent: the review reports the ticket as not found, which reads as a",
  );
  out.push("  ticket that does not exist rather than as a payload that was filled in wrong. Put");
  out.push('  the gid and the permalink in "url", where nothing is matched against them.');
  out.push("");
  out.push('  "criteria": ["..."] is optional and the omission means something. Leave it out and');
  out.push("  empo reads the acceptance criteria out of the body itself, the way every other");
  out.push("  tracker does. [] says the ticket states none, which the review reports as its own");
  out.push("  finding. Do not write [] because you did not look.");
  out.push("");
  // Required, and the pull request's `comments` is not. Said plainly here because the two shapes
  // sit a screen apart in this same block and would otherwise read as one rule.
  out.push('  "comments" is required, and this is the one field where that differs from the pull');
  out.push("  request above: fetch the ticket's comments even though it costs a second call on");
  out.push("  some hosts. A comment is where a sub-item gets scoped out, and the review is told");
  out.push("  not to flag what a comment retracted. An empty list because you did not look reads");
  out.push("  as nobody having withdrawn anything, and the review then confidently raises a");
  out.push("  finding the ticket had already dropped. Writing [] because you looked and there");
  out.push("  were none is right and expected.");
  out.push("");
  out.push("  If none of the three carries a key there is no ticket: write no file and leave");
  out.push("  --ticket-payload off. The review then states that ticket-fit was not graded, which");
  out.push("  is the truth and is not the same as saying the ticket had no criteria.");
}

function ticketFlag(config: EmpoConfig, view: HostRequestView): string {
  return config.adapters?.tracker?.kind === "mcp" ? ` --ticket-payload ${view.paths.ticket}` : "";
}

/**
 * Step 1 of the discipline: isolate. A PR is read in a detached worktree so the human's checkout is
 * untouched and two reviews can run at once (invariant 2). A local review has nothing to isolate:
 * the working tree is the thing under review.
 */
function isolate(
  repoRoot: string,
  id: string,
  base: string,
  prMeta: PullRequest | null,
  forge: ForgeAdapter,
  options: ReviewOptions,
  notes: string[],
): ReviewSession {
  const dir = sessionDir(repoRoot, id);
  rmSession(repoRoot, dir);
  mkdirSync(dir, { recursive: true });

  let readRoot = repoRoot;
  let worktree: string | null = null;

  if (prMeta !== null) {
    const path = join(dir, "worktree");
    // Fetch first: the PR branch usually does not exist locally. Both spellings are tried because
    // a fork PR is reachable by ref while a same-repo one is reachable by branch name.
    const fetched =
      fetchRef(repoRoot, "origin", prMeta.sourceBranch) ||
      fetchRef(repoRoot, "origin", `pull/${prMeta.id}/head`);
    const result = addWorktree(repoRoot, fetched ? "FETCH_HEAD" : prMeta.sourceBranch, path);
    if (result.ok) {
      readRoot = path;
      worktree = path;
    } else {
      notes.push(
        `Could not create a worktree for ${prMeta.sourceBranch} (${result.message}), so citations ` +
          "will be resolved against your working tree, which may be at a different revision.",
      );
    }
  }

  // A pinned base means the diff has to be recomputed, because a forge serves the diff against the
  // base the PR declares and nothing else.
  const diff =
    worktree !== null && options.base !== undefined
      ? (diffRange(worktree, base, "HEAD") ?? forge.getDiff(id))
      : forge.getDiff(id);

  const diffPath = join(dir, `pr-${slug(id)}.diff`);
  writeFileSync(diffPath, diff.endsWith("\n") ? diff : `${diff}\n`, "utf8");

  const session: ReviewSession = {
    id,
    repoRoot,
    readRoot,
    worktree,
    base,
    sourceBranch: prMeta?.sourceBranch ?? currentBranch(repoRoot),
    diffPath,
  };
  writeFileSync(join(dir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  return session;
}

function lookupTicket(
  tracker: TrackerAdapter,
  prMeta: PullRequest | null,
  branch: string | null,
): { key: KeyMatch | null; ticket: Ticket | null } {
  const key = tracker.extractKey({
    branch: branch ?? "",
    title: prMeta?.title ?? "",
    body: prMeta?.description ?? "",
  });
  if (key === null) return { key: null, ticket: null };
  return { key, ticket: tracker.getTicket(key.key) };
}

interface BriefView {
  id: string;
  base: string;
  session: ReviewSession;
  forge: ForgeAdapter;
  tracker: TrackerAdapter;
  prMeta: PullRequest | null;
  ticket: { key: KeyMatch | null; ticket: Ticket | null };
  facts: FileFacts[];
  spines: SpineFacts[];
  /** How many spines exist at all, so an empty list can say which kind of empty it is. */
  curated: number;
  /** `--no-ticket`: the agent was asked for a named ticket and answered that it cannot get it. */
  ticketDeclined: boolean;
  notes: string[];
}

function printBrief(repoRoot: string, graph: Graph, view: BriefView): void {
  const { session, facts } = view;

  console.log("");
  console.log(view.prMeta === null ? `local diff against ${view.base}` : `pull request ${view.id}`);
  console.log("");
  console.log(
    `forge      ${view.forge.kind}  (${[...view.forge.capabilities].sort(compareStrings).join(", ")})`,
  );
  console.log(`tracker    ${view.tracker.kind}`);
  console.log(
    `base       ${view.base}${resolveRef(repoRoot, view.base) === null ? "  (does not resolve)" : ""}`,
  );
  console.log(`branch     ${session.sourceBranch ?? "detached"}`);
  console.log(
    `read root  ${session.readRoot}${session.worktree === null ? "  (your checkout)" : "  (detached worktree, removed when the findings are gated)"}`,
  );
  console.log(`diff       ${session.diffPath}`);

  if (view.notes.length > 0) {
    console.log("");
    console.log("notes");
    for (const note of view.notes) console.log(`  ${note}`);
  }

  printTicket(view);
  printCi(view);
  printChangedFiles(facts);
  printBlastRadius(facts);
  printFanout(graph, facts);
  printFlows(facts);
  printSpines(view.spines, view.curated);
  printTests(graph, facts);
  printConventions(repoRoot);

  console.log("");
  // The same block `empo query` prints, and for the same reason: every fact above this line came out
  // of the graph, so every reason the graph is out of date belongs under them. Git distance alone
  // would report a pack-drifted or old-schema graph as current with HEAD (engine/graph.ts).
  for (const line of stalenessLines(repoRoot, graph)) console.log(line);
  console.log("");
  console.log(FLOOR_NOT_CEILING);
  console.log("");
  console.log("next");
  console.log("  1. Work the discipline below, in order. Ticket before diff.");
  console.log(`  2. Read every file from ${session.readRoot}, and cite paths repo-relative.`);
  const findingsPath = join(sessionDir(repoRoot, view.id), "findings.json");
  console.log(`  3. Write your suspected findings to ${findingsPath}`);
  console.log(
    `  4. Run: empo review${view.id === "local" ? "" : ` ${view.id}`} --findings ${findingsPath}`,
  );
  console.log(
    "     A finding whose anchor is not in the cited file is dropped there, not reported,",
  );
  console.log(
    "     and so is one whose introducedBy is outside this diff: the pull request is the subject.",
  );
}

function printTicket(view: BriefView): void {
  console.log("");
  const skip = view.tracker.skipReason;
  const { key, ticket } = view.ticket;

  if (ticket === null) {
    console.log("ticket");
    // Ahead of `skip`, because it is the more specific of two true sentences. The tracker's own
    // reason is "no ticket was supplied", which is equally true of a review nobody ever asked, and
    // this one says the ask happened and came back empty. A reader deciding whether to go and fetch
    // it needs that difference; the JSON carries it as `ticketDeclined` for the same reason.
    if (view.ticketDeclined) {
      console.log(
        `  ticket-fit not graded: --no-ticket, so ${key === null ? "the ticket" : key.key} was ` +
          "reported unfetchable rather than absent. Nobody has read it, including this review.",
      );
    } else if (skip !== null) console.log(`  ticket-fit not graded: ${skip}`);
    else if (key === null) console.log("  no ticket key found in the branch, title or description");
    else console.log(`  ${key.key} was not found by the tracker, so ticket-fit was not graded`);
    return;
  }

  console.log(`ticket     ${ticket.key}  ${ticket.title}`);
  console.log(`           ${ticket.type}, ${ticket.completed ? "closed" : "open"}, ${ticket.url}`);
  if (key?.disagrees === true) {
    console.log(
      `  ! the branch names ${key.branchKey} but the title names ${ticket.key}. The title was used ` +
        "for the lookup, the branch for the checkout.",
    );
  }
  if (ticket.criteria.length === 0) {
    console.log(
      "  the ticket states no acceptance criteria. Grade against its description, and do",
    );
    console.log("  not invent criteria it does not state.");
  }
  for (const [index, criterion] of ticket.criteria.entries()) {
    console.log(`  ${index + 1}. ${criterion}`);
  }
  // Three answers, not two, and the third is the one this prints for. An unfetched comment list is
  // not an empty one: step 6 is told not to report as missing what a comment retracted, so silence
  // here would read as "nothing was retracted" and license precisely that finding. The empty case
  // prints too, for the same reason the null case does: it is the only way a reader can tell that
  // somebody looked (types.ts, and the rule --hazards keeps for a graph older than the axis).
  if (ticket.comments === null) {
    console.log("  comments not fetched: nobody read them, so a deferred sub-item would not show");
    console.log("  here. Do not report a criterion as missing on the strength of that silence.");
  } else if (ticket.comments.length === 0) {
    console.log("  no comments: they were read and the ticket carries none, so nothing was");
    console.log("  scoped out after it was written");
  } else {
    console.log(
      `  ${ticket.comments.length} comment(s): read them, a sub-item may have been deferred`,
    );
  }
}

function printCi(view: BriefView): void {
  const ci = view.forge.getCiResult(view.id);
  console.log("");
  console.log(`ci         ${ci.state}  ${ci.detail}`);
  console.log("           The review never runs tests. This line is what it may say about them.");

  const comments = view.forge.listComments(view.id);
  if (comments.length > 0) {
    console.log("");
    console.log(`existing comments  ${comments.length}, do not repeat them`);
    for (const comment of comments.slice(0, 10)) {
      const where = comment.file === null ? "" : `${comment.file}:${comment.line ?? 0}  `;
      console.log(`  ${comment.author}  ${where}${firstLine(comment.body)}`);
    }
  }
}

function printChangedFiles(facts: FileFacts[]): void {
  console.log("");
  console.log(`changed files  ${facts.length}`);
  if (facts.length === 0) {
    console.log("  none: the diff is empty. Check the base ref.");
    return;
  }
  const width = columnWidth(facts, (entry) => entry.file.path);
  for (const entry of facts) {
    const counts = `+${entry.file.addedCount} -${entry.file.removedCount}`;
    const mapped =
      entry.radius !== null
        ? narrowing(entry) + namesOf(entry.radius)
        : entry.file.isBinary
          ? "binary"
          : "not in the graph (under no root, unindexed language, or a stale graph)";
    console.log(
      `  ${entry.file.status.padEnd(8)} ${entry.file.path.padEnd(width)}  ${counts.padStart(9)}  ${mapped}`,
    );
  }
}

/**
 * What the graph calls the changed file, in one column.
 *
 * The export names where the nodes carry them and the node ids where they do not, because those are
 * the two things a reader can look up. Under a pack that ids by class the id is the class name and
 * naming it is the whole answer; under one that ids by symbol the ids all begin with the path that
 * is already printed two columns to the left, so repeating it twenty times would push the only new
 * information off the line.
 *
 * Capped at five for the reason every other list in this brief is capped: a row that runs to the
 * width of the terminal reads as noise, and the count says what was held back rather than letting
 * the truncation pass for the whole of it.
 */
/**
 * The prefix that says the row is a part of the file rather than the whole of it, printed only when
 * the diff's lines narrowed the file's nodes down. Silence means every node the file yields is in
 * the radius, which is both the unnarrowed answer and the answer for a file that yields one node,
 * and those two need no telling apart: either way nothing was left out.
 */
function narrowing(entry: FileFacts): string {
  const reached = entry.radius === null ? 0 : entry.radius.nodes.length;
  return reached < entry.yielded ? `${reached} of ${entry.yielded} exports: ` : "";
}

function namesOf(radius: BlastRadius): string {
  const symbols = radius.nodes.flatMap((node) => (node.symbol === undefined ? [] : [node.symbol]));
  const names = symbols.length > 0 ? symbols : radius.nodes.map((node) => node.id);
  if (names.length <= 5) return names.join(", ");
  return `${names.slice(0, 5).join(", ")}, +${names.length - 5} more`;
}

/** Every changed file that is in the graph, one radius each. */
function radiiOf(facts: FileFacts[]): BlastRadius[] {
  return facts.flatMap((entry) => (entry.radius === null ? [] : [entry.radius]));
}

function printBlastRadius(facts: FileFacts[]): void {
  console.log("");
  console.log("blast radius  (step 2: every flow the change can reach, not only the ticket's)");
  const radii = radiiOf(facts);
  if (radii.length === 0) {
    console.log("  none of the changed files is a node in the graph");
    return;
  }
  for (const radius of radii) {
    console.log("");
    console.log(`  ${namesOf(radius)}  ${radiusNode(radius).file}`);
    console.log(`    fan-in ${radius.faninDirect} direct, ${radius.faninTransitive} transitive`);
    for (const flow of radius.flows) {
      const state = flow.blind
        ? "BLIND"
        : flow.reaches
          ? "covered"
          : "no test reaches this flow at all";
      console.log(`    flow ${flow.flow}  ${state}  via ${flow.evidence}`);
    }
    for (const consumer of radius.consumers.slice(0, 5)) {
      // The two kinds, for the reason `empo query` prints them: a changed Laravel layout is
      // consumed both by the controller that renders it and by the sibling blades that extend it,
      // and the rows are ranked by the consumer's own fan-in, so the templates can fill all five
      // while the controller falls into the count below. A reviewer reading five identical-looking
      // rows cannot tell that happened; a reviewer reading `view template` five times can.
      console.log(
        `    consumer ${consumer.id}  ${consumer.kind} ${consumer.edge}  ${consumer.evidence}`,
      );
    }
    // Both lists say what they held back. A brief is read by an agent that quotes it, and five
    // consumers of five hundred printed as a bare list is the same "reads as all of it" failure the
    // rest of this command exists to avoid. Five and not `empo query`'s ten: every row here is one
    // line inside a block that already carries the node, its fan-in and its flows.
    if (radius.consumers.length > 5) {
      console.log(`    ... and ${radius.consumers.length - 5} more consumers`);
    }
    for (const bridge of radius.bridges.slice(0, 5)) {
      // Both ends, for the reason `empo query` prints both: the changed file is as often the
      // consuming side as the producing one, and a row naming only the near end tells a reviewer
      // reading a php diff that the php file is on the far side of one, which is not a fact about
      // anything. The symbol is the row's label rather than "cross-language", because a pack can
      // join a symbol inside one root: a scheduled command is joined to the entry that schedules it
      // and both halves are php, so the two ends are a language apart only sometimes.
      console.log(
        `    join ${bridge.symbol ?? "?"}  ${bridge.from}` +
          ` consumes ${bridge.to}  named at ${bridge.evidence}`,
      );
    }
    if (radius.bridges.length > 5) {
      console.log(`    ... and ${radius.bridges.length - 5} more symbol joins`);
    }
  }
}

/**
 * Every dispatch a changed file makes from inside a loop, and nothing about how often it runs.
 *
 * This is a fact and not a finding, and the line between them is the whole point of the section. A
 * dispatch in a loop is how a batch is written; it is wrong only when the loop is unbounded, and
 * whether it is depends on how many rows a query returns, which is not in the source. EmPo cannot
 * decide it, a rule that guessed would fabricate, and the reviewing model is the one that can go and
 * read the query. So the coordinate goes in the brief, at the moment the diff is being read, and the
 * finding — if there is one — comes out through the same gate as every other finding.
 *
 * A graph written before the axis existed carries no `fanout` key at all, and that is printed as the
 * unknown it is rather than as an empty list: the rule `--hazards` follows (commands/query.ts).
 */
function printFanout(graph: Graph, facts: FileFacts[]): void {
  const all = graph.fanout ?? null;

  console.log("");
  console.log("dispatches inside a loop  (step 2: what changed files can put on the queue)");

  if (all === null) {
    console.log("  unknown: this graph was built before the axis existed. Run empo index.");
    return;
  }

  const changed = new Set(facts.map((entry) => entry.file.path));
  const rows = all.filter((site) => changed.has(site.file));
  if (rows.length === 0) {
    console.log("  none: no changed file dispatches from inside a loop");
    return;
  }

  // A schema 9 graph has `fanout` but no `permanentFailures`: the same absence one axis later, and
  // one the header above cannot carry, because the rows it guards are there. Said once and not per
  // row, since it is a property of the graph and not of any dispatch in it.
  if (graph.permanentFailures === undefined) {
    console.log("  on failure: unknown, this graph predates the axis. Run empo index.");
  }

  const width = columnWidth(rows, (site) => `${site.file}:${site.line}`);
  for (const site of rows) {
    console.log(
      `  ${`${site.file}:${site.line}`.padEnd(width)}  dispatches ${site.job}` +
        `  loop opened at line ${site.loopLine}`,
    );
    if (site.target === null) continue;
    // The job as a coordinate and not as a bare word. `job` is the spelling at the dispatch site and
    // `target` is the node the resolver matched it to, and printing only the first stops the reader
    // exactly one hop short of the code that will run: what a dispatch does with a failure is
    // written in the handler, never at the call.
    const handler = graph.nodes.find((node) => node.id === site.target);
    console.log(`    target ${site.target}${handler === undefined ? "" : `  ${handler.file}`}`);
    for (const other of scheduledSiblings(graph, site)) {
      console.log(`    reached from ${other.id}  scheduled at ${other.evidence}`);
    }
    // The one place the brief reaches a fact about a file the diff never touched. What the handler
    // does with a failure decides whether a widened loop is a bigger batch or a growing pile, and it
    // is written where the author of this diff had no reason to look. One hop past the target as
    // well as the target itself, because a job's `handle` is as often inherited as written: the
    // subclass holds the work and the base class holds the error handling.
    for (const found of handlerFailures(graph, site.target)) {
      console.log(
        `    on failure  ${found.file}:${found.line}  ${found.call}()` +
          `  inside a catch at line ${found.transientLine}`,
      );
    }
  }
  // Said every time the list is non-empty, because a coordinate with no sentence under it reads as
  // an accusation, and this axis has nothing to accuse anybody of.
  console.log("  How often the loop runs is a property of the data, not of the source, so this");
  console.log("  says nothing about volume. If this diff widened what the loop iterates, that is");
  console.log("  the question to ask out loud.");
}

/**
 * What the dispatched job's own code does with a failure it was told would pass: the target's file
 * and the files the target inherits from, one hop.
 *
 * One hop and not the whole closure. A job's outgoing edges are its imports, and the transitive
 * closure of those is most of the application, so every extra hop trades the one file that runs
 * this work for a hundred that do not. The base class is the hop that pays: `handle` on a queued job
 * is routinely inherited, so the subclass the dispatch names holds the work and its parent holds the
 * error handling, and stopping at the target would print nothing for exactly the shape this is for.
 *
 * The hop is an `inherit` edge and no other kind, for the same reason it is only one. An `import`,
 * `fqcn`, `template` or `hook` edge names a file the job mentions; only inheritance names a file
 * whose code runs as the job's own, and a failure recorded in an imported helper printed under this
 * job's name would be attributed to work that never executes it.
 *
 * A graph built before the axis existed carries no list and yields nothing here, which reads as "no
 * failure handling found". `printFanout` prints that absence as the unknown it is before it gets
 * here: it is one absence with one remedy, `empo index`.
 */
function handlerFailures(graph: Graph, target: string): PermanentFailure[] {
  const all = graph.permanentFailures ?? [];
  if (all.length === 0) return [];

  const files = new Set<string>();
  for (const node of graph.nodes) if (node.id === target) files.add(node.file);
  for (const edge of graph.edges) {
    if (edge.from !== target || edge.kind !== "inherit") continue;
    for (const node of graph.nodes) if (node.id === edge.to) files.add(node.file);
  }
  return all.filter((found) => files.has(found.file));
}

/**
 * The other consumers of a dispatched job that a scheduler entry reaches, and the scheduled line.
 *
 * This is the fan-out axis meeting the join axis, and neither half is new: the graph already holds
 * every consumer of the job, and a scheduled command is already joined to the entry that schedules
 * it. Printed apart they are two facts a reader has to think to combine. Printed together they are
 * the sentence "the queue you just widened is also fed on a timer", which is the question that turns
 * a volume change into a loop and cannot be asked of the dispatch site alone.
 *
 * Only scheduled consumers, and not every consumer of the job: a widely used job has thirty, and a
 * controller that dispatches one on a click has no cadence to compare against. The whole value of
 * the row is the cadence at the far end, so a consumer nothing schedules has nothing to say here.
 *
 * The dispatching file itself is not excluded. The commonest shape this axis is for is a scheduled
 * command that dispatches in a loop, and dropping the edge written at the fanout site would drop the
 * one cadence the reader most needs: the one on the file in front of them.
 */
function scheduledSiblings(
  graph: Graph,
  site: { target: string | null },
): { id: string; evidence: string }[] {
  const joins = graph.edges.filter((edge) => edge.kind === "bridge");
  const seen = new Set<string>();
  return graph.edges
    .filter((edge) => edge.to === site.target && edge.kind !== "bridge")
    .flatMap((edge) =>
      joins
        .filter((join) => join.to === edge.from)
        .map((join) => ({
          id: edge.from,
          evidence: `${join.evidence.file}:${join.evidence.line}`,
        })),
    )
    .filter((row) => {
      const key = `${row.id} ${row.evidence}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => compareStrings(a.id, b.id) || compareStrings(a.evidence, b.evidence));
}

/**
 * The flows this change touches, and which of them nothing checks. Blind is not the only bad answer
 * here and used to be treated as though it were: a flow no test reaches at all is neither blind nor
 * covered, because blindness is a property of a flow some test exercises, so counting it as "not
 * blind" turned the worst state into the reassuring one. A change touching only such a flow was
 * summarized `flows touched 1, blind 0` under `every touched flow has at least one test that
 * asserts a value`, three lines below this same command printing `no test reaches this flow at all`
 * about that flow. The brief contradicted itself, and the false line was the summary a reader
 * carries forward.
 *
 * Same rule as `empo query --blind`'s denominator and `--hazards`' four answers: an empty list of
 * bad news is several different results, and only one of them is the good one.
 */
function printFlows(facts: FileFacts[]): void {
  const touched = new Map<string, { blind: boolean; reaches: boolean }>();
  for (const radius of radiiOf(facts)) {
    for (const flow of radius.flows) {
      touched.set(flow.flow, { blind: flow.blind, reaches: flow.reaches });
    }
  }
  const named = (pick: (state: { blind: boolean; reaches: boolean }) => boolean): string[] =>
    [...touched.entries()]
      .filter(([, state]) => pick(state))
      .map(([flow]) => flow)
      .sort(compareStrings);

  const blind = named((state) => state.blind);
  const unreached = named((state) => !state.reaches);

  console.log("");
  console.log(
    `flows touched  ${touched.size}, blind ${blind.length}, reached by no test ${unreached.length}`,
  );
  for (const flow of blind) {
    console.log(`  BLIND ${flow}  a wrong result ships silently here, say so in the review`);
  }
  for (const flow of unreached) {
    console.log(`  NO TEST ${flow}  no test reaches this flow at all, so nothing here is checked`);
  }
  // Only when both counts are zero. Either one alone leaves a touched flow nothing asserts about,
  // which is what this sentence would be denying.
  if (touched.size > 0 && blind.length === 0 && unreached.length === 0) {
    console.log("  every touched flow has at least one test that asserts a value");
  }
}

/**
 * The spines this change is on. Wider than `empo check`'s question on purpose: the gate asks only
 * whether a `guarded` glob matched, because it has to fail a commit and may only fail on a rule its
 * author wrote down, while a review is read by somebody who can weigh three weaker signals. A hop
 * file outside `guarded` is the commonest of them, since `guarded` is curated to be gateable and a
 * chain runs through files nobody wants gated.
 *
 * Only touched spines are verified. Resolving every coordinate of every spine on a repository that
 * curates several would spend the reader's time on a map this change is not on.
 */
function spinesTouched(
  readRoot: string,
  spines: LoadedSpine[],
  files: ChangedFile[],
  facts: FileFacts[],
): SpineFacts[] {
  const paths = [...new Set(files.map((file) => file.path))].sort(compareStrings);
  const reached = new Set(
    radiiOf(facts).flatMap((radius) => radius.flows.map((flow) => flow.flow)),
  );

  return spines
    .map((loaded) => {
      const cited = new Set([
        ...loaded.spine.hops.map((hop) => hop.file),
        ...loaded.spine.traps.map((trap) => trap.file),
      ]);
      return {
        loaded,
        guarded: guardedTouches(loaded.spine, files),
        onChain: paths.filter((path) => cited.has(path)),
        flows: loaded.spine.flows.filter((flow) => reached.has(flow)).sort(compareStrings),
      };
    })
    .filter((entry) => entry.guarded.length + entry.onChain.length + entry.flows.length > 0)
    .map((entry) => ({ ...entry, report: verifySpine(readRoot, entry.loaded) }));
}

/**
 * The curated half of layer 2, printed beside the generated half above it. The graph says what this
 * change reaches; a spine says what must still be true once it gets there, which is a statement
 * about invariants and about absence, and absence is what a generated graph cannot hold
 * (docs/08-spines.md).
 *
 * Every coordinate carries its own drift verdict rather than a count at the top, because the reader
 * opens these one at a time and a summary tells them the wrong thing about the one in their hand.
 * The asymmetry is the same one the findings gate runs on: a moved anchor is corrected and still
 * worth reading, an anchor that is nowhere is not a coordinate at all.
 */
function printSpines(spines: SpineFacts[], curated: number): void {
  console.log("");
  console.log(
    `spines touched  ${spines.length} of ${curated}  (step 2: the curated chain, and what must still hold)`,
  );

  if (curated === 0) {
    console.log("  this repository curates no spine, so nothing here is claimed either way");
    return;
  }
  if (spines.length === 0) {
    console.log("  no spine claims a file or a flow this change touches");
    return;
  }

  for (const entry of spines) {
    const { spine } = entry.loaded;
    const where = new Map(entry.report.citations.map((drift) => [drift.where, drift]));
    const changed = new Set([...entry.guarded.map((touch) => touch.path), ...entry.onChain]);

    console.log("");
    console.log(`  ${spine.name}  ${entry.loaded.path}`);
    if (spine.principle !== undefined) console.log(`    principle  ${spine.principle}`);

    for (const touch of entry.guarded) {
      console.log(`    guarded  ${describeTouch(touch)}`);
    }
    if (entry.guarded.length > 0) {
      console.log(
        `             empo check wants an added test line using ${wantedTerms(spine.assertionTerms)}${wantedPaths(spine.assertionPaths)}`,
      );
    }

    for (const hop of spine.hops) {
      const mark = changed.has(hop.file) ? "  CHANGED BY THIS DIFF" : "";
      console.log(
        `    hop ${hop.n}  ${hop.title}  ${coordinate(where, `hop ${hop.n} "${hop.title}"`, hop.file, hop.line)}${mark}`,
      );
    }

    for (const flow of entry.flows) {
      const unguarded = spine.unguardedFlows.includes(flow)
        ? "  UNGUARDED: this spine records that no test asserts a value on it"
        : "";
      console.log(`    flow ${flow}${unguarded}`);
    }

    for (const invariant of spine.invariants) {
      console.log(`    invariant ${invariant.id}  ${invariant.statement}`);
      console.log(
        invariant.citation === undefined
          ? "      PROSE ONLY: nothing asserts this, so only reading catches a break"
          : `      asserted at ${coordinate(where, `invariant ${invariant.id}`, invariant.citation.file, invariant.citation.line)}`,
      );
    }

    for (const trap of spine.traps) {
      console.log(`    trap  ${trap.what}`);
      console.log(`      ${coordinate(where, `trap "${trap.what}"`, trap.file, trap.line)}`);
    }
  }
}

/**
 * One `file:line` with its drift verdict attached. A soft-drifted coordinate is printed at the line
 * the anchor is really on and says where the spine still thinks it is, because the reader wants the
 * line they can open first and the repair second. A hard-drifted one is printed as the spine wrote
 * it and labelled, since there is no better line to offer and quietly printing it would be the one
 * thing this tool exists not to do.
 */
function coordinate(
  drifts: Map<string, CitationDrift>,
  key: string,
  file: string,
  line: number,
): string {
  const drift = drifts.get(key);
  if (drift === undefined || drift.level === "verified") return `${file}:${line}`;
  if (drift.level === "soft" && drift.check.actualLine !== null) {
    return `${file}:${drift.check.actualLine}  (the spine says :${line}; the anchor moved, empo verify has the rest)`;
  }
  return `${file}:${line}  ANCHOR NOWHERE: do not trust this coordinate, run empo verify`;
}

function printTests(graph: Graph, facts: FileFacts[]): void {
  const flows = new Set(radiiOf(facts).flatMap((radius) => radius.flows.map((flow) => flow.flow)));
  // The files and not the nodes. This block prints one line per test, and a test is something a
  // reviewer opens, which is a file: a suite exporting three cases under a pack that ids by symbol
  // is three `testNodes` in one file, and looking each id up printed that one file three times as
  // though three separate tests reached the change. `testFiles` is deduplicated where it is built,
  // so the count a reader takes away is the number of files they would have to read.
  const files = new Set<string>();
  for (const flow of flows) {
    for (const file of graph.coverage[flow]?.testFiles ?? []) files.add(file);
  }

  console.log("");
  console.log(
    "tests that reach the changed code  (step 4 judges these by reading, never by running)",
  );
  if (files.size === 0) {
    console.log("  none. Every behavioural change here is unasserted.");
    return;
  }
  for (const file of [...files].sort(compareStrings)) {
    // Any node of the file asserting a value makes the file one that does. The grade is read off
    // the nodes because it is a fact about the code and only the nodes carry it, and folding it
    // with `some` is the same rule coverage.ts applies to a flow: one assertion in a file is what
    // stops that file being the reassuring line beside an unchecked change.
    const asserts = graph.nodes.some((node) => node.file === file && node.assertsValue);
    console.log(`  ${file}  ${asserts ? "asserts a value" : "ASSERTS NO VALUE"}`);
  }
}

function conventionsFacts(repoRoot: string): { path: string; entries: number } {
  const path = join(repoRoot, ".empo/conventions.md");
  if (!existsSync(path)) return { path: ".empo/conventions.md", entries: 0 };
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("- ") || line.startsWith("## ")).length;
  return { path: ".empo/conventions.md", entries };
}

function printConventions(repoRoot: string): void {
  const facts = conventionsFacts(repoRoot);
  console.log("");
  console.log("false-positive register");
  if (facts.entries === 0) {
    console.log(`  ${facts.path} is empty or absent. Append each confirmed false positive to it.`);
    return;
  }
  console.log(`  ${facts.path}  ${facts.entries} entries. Read them before flagging anything.`);
}

// ---------------------------------------------------------------------------------------------
// Phase 2: the gate
// ---------------------------------------------------------------------------------------------

function gatePhase(repoRoot: string, pr: string | undefined, options: ReviewOptions): void {
  const path = options.findings as string;
  if (!existsSync(path)) {
    throw configError(`No findings file at ${path}`, [
      "Run empo review first, work the discipline, then write the findings file it names.",
    ]);
  }

  const findings = parseFindingsFile(readJson(path, path), path);
  const id = pr ?? "local";
  const session = readSession(repoRoot, id);
  const readRoot = session?.readRoot ?? repoRoot;
  const notes: string[] = [];

  if (session === null) {
    notes.push(
      `No review session for ${id}, so citations were resolved against ${repoRoot}. If the review ` +
        "read a different revision, rerun empo review before gating.",
    );
  } else if (!existsSync(readRoot)) {
    notes.push(
      `The recorded read root ${readRoot} is gone, so citations could not be resolved there.`,
    );
  }

  // The diff phase 1 saved, so the gate can hold every finding to a line this pull request
  // actually touched. Missing, it is skipped rather than guessed at, and said out loud: a gate
  // that silently stops checking reads exactly like one that checked and found nothing wrong.
  let changed: ChangedFile[] | null = null;
  if (session !== null && existsSync(session.diffPath)) {
    changed = parseDiff(readFileSync(session.diffPath, "utf8"));
  } else {
    notes.push(
      "The diff for this review is gone, so findings were not checked against the changed lines. " +
        "A finding about code this branch inherited would have survived.",
    );
  }

  // Teardown is the last action of a review including when it ends early or fails, which is what
  // src/discipline/review.md tells the agent and therefore what this command has to do itself. A
  // worktree left behind because posting failed would be the review disturbing the checkout it
  // promised not to touch (docs/07-review-discipline.md invariant 2 and step 8).
  try {
    reportAndPost(repoRoot, pr, id, readRoot, notes, findings, changed, options);
  } finally {
    teardown(repoRoot, id, session);
  }
}

function reportAndPost(
  repoRoot: string,
  /** The pull request, or undefined for a local review. Kept apart from `id`, which is neither. */
  pr: string | undefined,
  id: string,
  readRoot: string,
  notes: string[],
  findings: ReviewFinding[],
  changed: ChangedFile[] | null,
  options: ReviewOptions,
): void {
  const result = gateFindings(existsSync(readRoot) ? readRoot : repoRoot, findings, changed);

  if (options.json === true) {
    console.log(
      JSON.stringify({ id, readRoot, notes, ...result, caveat: FLOOR_NOT_CEILING }, null, 2),
    );
  } else {
    printGate(id, readRoot, notes, result, findings.length);
  }

  if (options.post === true) {
    postFindings(repoRoot, pr, result);
  }
}

function printGate(
  id: string,
  readRoot: string,
  notes: string[],
  result: GateResult,
  submitted: number,
): void {
  console.log("");
  console.log(`verified findings for ${id}`);
  console.log(`  ${result.kept.length} of ${submitted} survived verification against ${readRoot}`);
  for (const note of notes) console.log(`  note: ${note}`);

  for (const kind of ["diff", "impact", "coverage"] as const) {
    const rows = result.kept.filter((item) => item.finding.kind === kind);
    console.log("");
    console.log(`${kind} findings  ${rows.length}`);
    if (rows.length === 0) console.log("  none survived verification");
    for (const row of rows) {
      console.log("");
      console.log(`  [${row.finding.severity}] ${row.finding.title}`);
      console.log(
        `  ${row.citation.file}:${row.citation.line}${row.corrected ? "  (citation corrected: the anchor had moved)" : ""}`,
      );
      console.log(`  ${row.finding.claim}`);
      console.log(`  introduced by: ${row.introducedBy.file}:${row.introducedBy.line}`);
      if (row.finding.suggestion !== undefined)
        console.log(`  suggestion: ${row.finding.suggestion}`);
      for (const support of row.supporting) {
        console.log(
          `  supporting: ${support.citation.file}:${support.citation.line}${support.corrected ? " (corrected)" : ""}`,
        );
      }
    }
  }

  console.log("");
  console.log(`dropped  ${result.dropped.length}`);
  if (result.dropped.length === 0) console.log("  none");
  for (const row of result.dropped) {
    console.log(`  ${row.finding.id}  ${row.reason}  ${row.finding.title}`);
    for (const detail of row.detail) console.log(`      ${detail}`);
  }
  if (result.dropped.length > 0) {
    console.log("");
    console.log("A dropped finding is not a bug in EmPo. It is a claim that stood on nothing, and");
    console.log("reporting it would have cost the author time and burned trust.");
  }

  console.log("");
  console.log("Findings never gate: this command exits 0 whatever it found (docs/06-cli.md).");
}

/**
 * Posting is outward-facing, so it is opt-in per call and never a default (docs/09-adapters.md).
 * The body reads as a normal human review: it names no tooling, and the stylistic scrub runs last.
 */
function postFindings(repoRoot: string, pr: string | undefined, result: GateResult): void {
  const { config } = loadConfig(repoRoot);
  // `pr` and not the session id: the id is "local" for a local review, and handing a forge a
  // pull-request-shaped "local" is the mistake this command was fixed for elsewhere. Undefined
  // here means there is no pull request to post to, which createForge answers with the local
  // forge, whose refusal names the real reason rather than a gh error about a pull request
  // called "local".
  const forge = createForge(config, repoRoot, { base: "HEAD", pr });
  // Asked again here, and not because phase 1 might have missed it. This loop posts one comment per
  // finding and nothing undoes a posted one, so a refusal raised from inside it is a review
  // half-posted: some findings up, the rest not, and no record of which. Asking before the first
  // `comment` is what keeps this refusal out of that state, and it is also the only guard on the
  // path of a gate run on its own. It does not make posting itself atomic: a `post`-capable adapter
  // that fails on the fourth `comment` leaves the first three up, and that is not handled anywhere.
  //
  // No note. This forge was built with no payload, for the capability question alone, so its note
  // would describe a review reading the local diff, which is not the review being refused.
  requirePostCapability(config, forge.adapter, null);
  const id = pr ?? "local";
  for (const row of result.kept) {
    const lines = [row.finding.title, "", row.finding.claim];
    // Only where the finding is not on a changed line itself: an impact or coverage comment lands
    // on a file this pull request never opened, and the first question its author asks is what in
    // the diff made it theirs to answer.
    if (row.finding.kind !== "diff") {
      const origin = row.introducedBy;
      lines.push("", `Introduced by ${origin.file}:${origin.line}.`);
    }
    if (row.finding.suggestion !== undefined) lines.push("", row.finding.suggestion);
    forge.adapter.comment(id, scrubTells(lines.join("\n")), {
      file: row.citation.file,
      line: row.citation.line,
    });
  }
  console.log("");
  console.log(`posted ${result.kept.length} finding(s) to ${id}`);
}

/**
 * The capability check `--post` never had (docs/09-adapters.md). A forge declares what it can
 * answer, and `post` is absent wherever the review cannot write back, so whether `--post` can be
 * honoured is knowable the moment the adapter is built and long before the review is spent.
 *
 * What was wrong was the order, not the outcome. `--post` on a forge that cannot post used to run
 * the whole discipline, print every verified finding, and only then die inside the posting loop,
 * one call into an adapter whose three mutating methods throw. The findings were never lost, but
 * the refusal arrived after the reviewer had paid for it, and it named a capability the adapter had
 * been declaring absent since it was constructed.
 *
 * The adapters' own throws stay exactly as they are. They are now what their comment in
 * `adapters/forge/mcp.ts` already calls them, the backstop for a caller that forgot this check,
 * rather than the refusal a user meets.
 *
 * It refuses whether or not any finding survived verification. A run with nothing to post used to
 * reach the end of the loop without calling the adapter once and print "posted 0 finding(s)", which
 * was a sentence about a write that never happened and could not have happened. The capability is a
 * fact about the forge and not about the findings, so it is answered the same way either way.
 *
 * The exit code is taken from the adapter that refuses, which is what keeps it the same code the
 * adapter's own throw would have produced: `local` has nowhere to post and says so as a config
 * error (2), `mcp` reached a host it cannot write back to and says so as an environment error (3).
 * Reading it off `adapters.forge` instead would have moved every degraded run to 3, including a
 * forge configured `local`, whose author fixes it in `.empo/config.json` and not in their machine.
 */
function requirePostCapability(
  config: EmpoConfig,
  adapter: ForgeAdapter,
  note: string | null,
): void {
  if (hasCapability(adapter, "post")) return;
  throw cannotPost(config, adapter, note);
}

function cannotPost(config: EmpoConfig, adapter: ForgeAdapter, note: string | null): EmpoError {
  // The note first where there is one, because it is the only line that can say the adapter under
  // discussion is not the forge that was configured, and a reader told "the local forge cannot post"
  // by a repository configured for github is owed the sentence explaining how it got there. Only the
  // brief passes one. The gate builds its forge with no payload to answer a question about posting
  // alone, so its note describes a degradation that did not happen to the review it is refusing.
  const details = note === null ? [] : [note];
  details.push(
    `It declares: ${[...adapter.capabilities].sort(compareStrings).join(", ")}.`,
    "Drop --post. The verified findings are printed either way, so nothing is lost by posting them by hand.",
  );
  if (adapter.kind === "local" && config.adapters?.forge === undefined) {
    details.push(
      "Or configure adapters.forge in .empo/config.json, so there is a host to post to.",
    );
  }

  const message = `The ${adapter.kind} forge cannot post, so --post cannot be honoured`;
  return adapter.kind === "local"
    ? configError(message, details)
    : environmentError(message, details);
}

/** The one shipped stylistic tell. Teams configure more; EmPo ships no opinion beyond this. */
function scrubTells(body: string): string {
  return body.replace(/—/g, ", ");
}

function teardown(repoRoot: string, id: string, session: ReviewSession | null): void {
  if (session === null) return;
  if (session.worktree !== null) removeWorktree(session.repoRoot, session.worktree);
  rmSession(repoRoot, sessionDir(repoRoot, id));
}

// ---------------------------------------------------------------------------------------------
// Session plumbing
// ---------------------------------------------------------------------------------------------

/**
 * Scratch lives in the OS temp directory, never under .empo/. `generated/` is machine-owned by
 * empo index alone (docs/02-on-disk-layout.md), and a review must disturb nothing in the repository
 * it is reviewing.
 *
 * The repository is half the key because the id alone does not identify a review: a local one is
 * always "local", so every checkout on one machine would share one directory and each review would
 * tear down the one already running. That is not merely lost scratch. Phase 2 recovers its read root
 * from session.json, so a shared directory hands one repository's findings the other repository's
 * source to verify against, and a claim that stands on nothing comes back verified. The readable id
 * stays in the name so a human can still find the directory a brief just named.
 */
function sessionDir(repoRoot: string, id: string): string {
  const digest = createHash("sha256").update(canonicalRoot(repoRoot)).digest("hex").slice(0, 8);
  return join(tmpdir(), "empo-review", `${slug(id)}-${digest}`);
}

/**
 * Both phases have to land on the same directory, so the key is the root git and the OS agree on:
 * /var and /private/var are one checkout on macOS, and a relative path is one too.
 */
function canonicalRoot(repoRoot: string): string {
  try {
    return realpathSync(repoRoot);
  } catch {
    return resolve(repoRoot);
  }
}

function readSession(repoRoot: string, id: string): ReviewSession | null {
  const file = join(sessionDir(repoRoot, id), "session.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ReviewSession;
  } catch {
    return null;
  }
}

/** Remove a previous session's worktree before its directory, or git keeps a dangling entry. */
function rmSession(repoRoot: string, dir: string): void {
  const file = join(dir, "session.json");
  if (existsSync(file)) {
    try {
      const previous = JSON.parse(readFileSync(file, "utf8")) as ReviewSession;
      if (previous.worktree !== null)
        removeWorktree(previous.repoRoot ?? repoRoot, previous.worktree);
    } catch {
      // A session file we cannot read is scratch, not state. Removing the directory is enough.
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

function slug(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * `.empo/generated/` is machine-owned: empo index writes it and nobody reviews it
 * (docs/02-on-disk-layout.md). A team that commits the graph would otherwise find graph.json in
 * every diff, burying the files a human actually changed under a machine's output.
 */
export function reviewableFiles(files: ChangedFile[]): {
  files: ChangedFile[];
  skipped: string[];
} {
  const generated = (file: ChangedFile): boolean => file.path.startsWith(".empo/generated/");
  return {
    files: files.filter((file) => !generated(file)),
    skipped: files.filter(generated).map((file) => file.path),
  };
}

function nodesFor(graph: Graph, path: string): GraphNode[] {
  return graph.nodes.filter((node) => node.file === path);
}

/**
 * The nodes a changed file yields, narrowed to the ones whose lines the diff actually touched.
 *
 * A file was a node until the symbol strategy shipped, and a changed twenty-export module then
 * reported the blast radius of all twenty exports for an edit to one. `nodes[].extents` says which
 * lines each export spans and the hunks say which lines moved, so the two answer it together.
 *
 * The narrowing is refused for the whole file the moment any changed line cannot be attributed,
 * which is the decision docs/14-implementation-notes.md asked whoever built this to make first:
 *
 * - a line no extent encloses, which is every edit to an import block: imports are written above
 *   every declaration, so no extent covers them, and handing them to the first export below would
 *   invent an attribution the partition cannot support;
 * - a node with no `extents` at all: a `fqcn` or `module-path` pack, a symbol pack's file that
 *   exports nothing, or a graph written before schema 8.
 *
 * Both fall back to every node of the file, which is what this reported before narrowing existed.
 * The extents are a line partition and not a parse, so narrowing can over-attribute a helper
 * written between two exports to the export above it; it must never under-attribute. A review that
 * quietly drops the symbol a change really touched is worse than one naming too many.
 *
 * A removed line is read against the same extents as an added one, which is the same over-attributing
 * direction rather than a second rule. Deleting a whole export writes no new line to attribute it
 * by, and dropping the removals would answer a deletion with the blast radius of whatever survived
 * around it. The coordinates are the old file's and the extents are the indexed one's, so where the
 * graph is behind the branch the two disagree: a stale graph is reported as staleness, above, and
 * the disagreement is bounded by naming a neighbouring export rather than by naming none.
 */
export function narrowToChangedLines(nodes: GraphNode[], file: ChangedFile): GraphNode[] {
  if (nodes.length < 2) return nodes;
  if (nodes.some((node) => node.extents === undefined)) return nodes;

  const touched = new Set<GraphNode>();
  for (const line of touchedLines(file)) {
    const owner = nodes.find((node) =>
      (node.extents ?? []).some((extent) => line >= extent.start && line <= extent.end),
    );
    if (owner === undefined) return nodes;
    touched.add(owner);
  }
  // An empty diff for this file touches no line and so narrows to nothing, which would read as "not
  // in the graph". It has no hunks to have missed, but the file is still what changed.
  return touched.size === 0 ? nodes : nodes.filter((node) => touched.has(node));
}

/** Every line this file writes or cuts. Added ones are the new file's, removed ones the old file's. */
function touchedLines(file: ChangedFile): number[] {
  return [
    ...changedLines(file),
    ...file.hunks.flatMap((hunk) => hunk.removed.map((line) => line.line)),
  ];
}

/** The first base ref that resolves. A repository with none has to be told one. */
function defaultBase(repoRoot: string): string {
  for (const candidate of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    if (resolveRef(repoRoot, candidate) !== null) return candidate;
  }
  throw configError("Could not work out a base ref to compare against", [
    "Tried origin/HEAD, origin/main, origin/master, main and master.",
    "Pass one explicitly: empo review --base <ref>.",
  ]);
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}
