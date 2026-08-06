import { bridgeLines } from "../engine/bridger";
import { driftLines, stalenessLineFrom } from "../engine/graph";
import {
  type FlowHealth,
  type ForgeHealth,
  type GraphHealth,
  type Health,
  healthReport,
  type RequiredCommand,
  remoteLabel,
  type SpineHealth,
  type TrackerHealth,
} from "../engine/health";
import { nameLines } from "../engine/names";
import { configError } from "../errors";

/**
 * `empo doctor`: health check, no changes (docs/06-cli.md). Config validity, graph staleness, and
 * the per-bridge match rate that tells a mis-tuned `normalize` from an absent coupling.
 *
 * This module computes nothing. Every fact comes from engine/health.ts and doctor only chooses a
 * surface for it: prose for a human, or one JSON document for the SessionStart hook in
 * docs/10-distribution.md.
 *
 * The one rule the two surfaces share: under `--json` nothing but the document reaches stdout.
 * `empo check` once printed a valid document and then three lines of plain text after it, so the
 * whole thing parsed as nothing at all at exactly the moment a machine reader most needed the
 * answer. So there is exactly one `console.log` on the JSON path and every other line lives inside
 * `renderProse`, which only ever runs on the other one. The error that follows both is thrown
 * rather than printed, so empo.ts puts it on stderr and stdout keeps one complete document.
 */

export interface DoctorOptions {
  json?: boolean;
}

export function doctorCommand(repoRoot: string, options: DoctorOptions = {}): void {
  const health = healthReport(repoRoot);
  const json = options.json === true;

  if (json) console.log(JSON.stringify(health, null, 2));
  else renderProse(health);

  // Thrown after printing on both surfaces, so the exit code is 2 whichever one was asked for and
  // the JSON document above it stays the last and only thing on stdout.
  const errors = health.findings.filter((finding) => finding.level === "error");
  if (errors.length > 0) {
    throw configError(`${errors.length} config error(s)`, ["Fix the errors above and rerun."]);
  }

  if (!json) {
    console.log(health.findings.length > 0 ? "\nOK  config is valid" : "OK  config is valid");
  }
}

function renderProse(health: Health): void {
  const roots = health.roots.map((root) => `${root.path} (${root.lang})`).join(", ");

  console.log("");
  console.log(`config     ${health.configPath}`);
  console.log(`roots      ${roots}`);
  console.log(`packs      ${health.packs.join(", ")}`);
  console.log(`bridges    ${health.bridgeCount}`);
  // Both adapter lines always print, including the two states nothing used to say out loud: a forge
  // nobody configured and a tracker nobody configured are what "ticket-fit was never graded" looks
  // like from the config side, and neither raises a finding (engine/health.ts argues why). If they
  // are not stated here they are stated nowhere, which is the gap this closed.
  console.log(forgeLine(health.adapters.forge));
  console.log(trackerLine(health.adapters.tracker));
  console.log(spineLine(health.spines));
  console.log(graphLine(health.graph));
  // Directly under the age it contradicts, because that line can say "current with HEAD" and be
  // right. The renderer lives in engine/graph.ts so `empo query` and `empo review` print the same
  // sentence for the same state; engine/graph.ts argues why it is there and not here.
  for (const line of driftLines(health.graph.packDrift, health.graph.schemaDrift)) {
    console.log(line);
  }
  // Under the graph line rather than beside the spine one, though both are layer 2, because this
  // count is read off the graph and says so by falling to "unknown" exactly where that line has
  // already named the state and the remedy. Above it, the unknown would arrive before its reason.
  console.log(flowLine(health.flows));
  // Under the flow line, which is the other count read off the graph and the other one that falls
  // to "unknown" when there is none. The renderer lives in engine/names.ts so `empo index` prints
  // the same sentence over the same numbers, which is the rule `driftLines` above already follows.
  for (const line of nameLines(health.names)) console.log(line);
  console.log("");

  // Empty unless there are bridges and a readable graph to measure them against, which is the
  // condition this block has always had.
  if (health.bridges.length > 0) {
    for (const line of bridgeLines(health.bridges)) console.log(line);
    console.log("");
  }

  for (const finding of health.findings) {
    console.log(`${finding.level === "error" ? "ERROR" : "warn "}  ${finding.message}`);
  }
}

/**
 * The forge, and what this machine and this checkout say about it. "not configured" and "local" are
 * printed apart on purpose: both review the local diff, and only one of them was somebody's choice.
 *
 * The origin clause is silent where git could not answer, because "origin agrees" about a remote
 * nothing read is the kind of invented reassurance the whole module refuses.
 *
 * Exported for the same reason `bridgeLines` and `stalenessLineFrom` are: it is a pure renderer, and
 * pinning it directly is the only way to pin the states behind it. Two of its clauses are answers
 * about the machine the suite is running on, so a spec that could only reach them through
 * `doctorCommand` would assert whether the developer happens to have `gh` installed.
 */
export function forgeLine(forge: ForgeHealth): string {
  if (forge.kind === null) return "forge      not configured, so empo review reads the local diff";
  if (forge.kind === "local") return "forge      local, so empo review reads the local diff";

  const named = forge.host === null ? forge.kind : `${forge.kind} (${forge.host})`;
  const clauses = [forge.slug === null ? named : `${named} ${forge.slug}`];
  if (forge.cli !== null) clauses.push(cliClause(forge.cli));
  if (forge.remote !== null) {
    const agrees = forge.remote.kind === forge.kind && forge.remote.slug === forge.slug;
    clauses.push(agrees ? "origin agrees" : `origin is ${remoteLabel(forge.remote)}`);
  }
  return `forge      ${clauses.join(", ")}`;
}

/** The tracker, exported beside `forgeLine` and for the same reason. */
export function trackerLine(tracker: TrackerHealth): string {
  const graded = "so empo review grades no ticket-fit";
  if (tracker.kind === null) return `tracker    not configured, ${graded}`;
  if (tracker.kind === "none") return `tracker    none, ${graded}`;

  const named = tracker.host === null ? tracker.kind : `${tracker.kind} (${tracker.host})`;
  const clauses = [named];
  if (tracker.project !== null) clauses.push(`project ${tracker.project}`);
  if (tracker.cli !== null) clauses.push(cliClause(tracker.cli));
  return `tracker    ${clauses.join(", ")}`;
}

function cliClause(cli: RequiredCommand): string {
  return cli.present ? `${cli.command} on PATH` : `${cli.command} not on PATH`;
}

function spineLine(spines: SpineHealth): string {
  if (spines.state === "unreadable") return `spines     unreadable under ${spines.dir}`;
  if (spines.state === "none") return `spines     none under ${spines.dir}`;

  const drift = spines.soft + spines.hard;
  const state = drift === 0 ? "every anchor resolves" : `${drift} drifted (run empo verify)`;
  return `spines     ${spines.count}, ${spines.citations} citations, ${state}`;
}

/**
 * How much of the repository the flow map covers, as a fact and not a warning (engine/health.ts
 * argues the whole of why). Exported beside `forgeLine` and for the same reason: it is a pure
 * renderer, and the unknown state below is one a spec should be able to read directly.
 *
 * Nothing here prints a zero it does not know. A missing or unreadable graph leaves every count
 * null, and "0 claimed by none" over a repository nobody counted is the invented reassurance the
 * whole report refuses; it would read as the best possible answer while standing on no data at all.
 */
export function flowLine(flows: FlowHealth): string {
  const { defined, files, unclaimed } = flows;
  // All three are null together, and each is tested rather than one standing in for the others,
  // because the type is what a `--json` reader parses and it permits them to differ.
  if (defined === null || files === null || unclaimed === null) {
    return "flows      unknown until the graph is built";
  }
  const counted = `${unclaimed} of ${plural(files, "non-test file")} claimed by none`;
  return `flows      ${defined} defined, ${counted}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function graphLine(graph: GraphHealth): string {
  if (graph.state === "missing") return "graph      not built yet (run empo index)";
  if (graph.state === "unreadable") return "graph      unreadable (run empo index to rebuild it)";

  const age = stalenessLineFrom({
    builtAgainst: graph.builtAgainst,
    commitsBehind: graph.commitsBehind,
  });
  return `${age}, ${graph.nodes} nodes, ${graph.edges} edges`;
}
