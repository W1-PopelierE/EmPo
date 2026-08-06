import { loadConfig } from "../engine/config";
import { type CitationDrift, loadSpines, type SpineReport, verifySpines } from "../engine/spines";
import { gateFailure } from "../errors";

/**
 * `empo verify`: resolve every citation anchor in every spine against current source and report
 * drift (docs/06-cli.md, docs/08-spines.md). Exits 1 on any drift, so a session-start hook or a CI
 * step turns a rotted map into a message instead of into confident fiction.
 *
 * Soft and hard drift both fail. A coordinate that slipped five lines misleads every reader who
 * trusts it exactly as surely as one that points nowhere; what differs is the repair, which is why
 * they are printed apart and the suggested line is printed with the soft ones.
 */

export interface VerifyOptions {
  json?: boolean;
}

export function verifyCommand(repoRoot: string, options: VerifyOptions = {}): void {
  const { config } = loadConfig(repoRoot);
  const spines = loadSpines(repoRoot, config);
  const reports = verifySpines(repoRoot, spines);

  const soft = total(reports, "soft");
  const hard = total(reports, "hard");

  if (options.json === true) {
    console.log(JSON.stringify({ spines: reports, soft, hard }, null, 2));
  } else {
    print(config.spines, reports, soft, hard);
  }

  if (soft + hard === 0) return;

  throw gateFailure(
    `${plural(soft + hard, "citation")} in ${plural(reports.filter(hasDrift).length, "spine")} drifted`,
    [
      hard > 0
        ? `${plural(hard, "anchor")} resolved nowhere: the file:line is now fiction, and every claim resting on it is suspect until a human looks.`
        : "Every anchor was found; only line numbers slipped.",
      "Fix the spine, or fix the code the spine describes, then rerun empo verify.",
    ],
  );
}

function print(dir: string, reports: SpineReport[], soft: number, hard: number): void {
  console.log("");

  if (reports.length === 0) {
    console.log(`spines     none under ${dir}`);
    console.log("");
    console.log("Most repositories have zero or one spine. Do not create one speculatively.");
    return;
  }

  const citations = reports.reduce((count, report) => count + report.citations.length, 0);
  console.log(
    `spines     ${plural(reports.length, "spine")} under ${dir}, ${plural(citations, "citation")}`,
  );
  console.log("");

  for (const report of reports) {
    console.log(`${report.name}  ${report.path}`);
    if (report.citations.length === 0) {
      console.log(
        "  no citations: this spine states no file:line, so nothing about it is checkable",
      );
    }
    for (const entry of report.citations) printCitation(entry);
    console.log("");
  }

  if (soft + hard === 0) {
    console.log(`OK  every anchor resolved (${plural(citations, "citation")})`);
    return;
  }
  console.log(`DRIFT  ${soft} soft, ${hard} hard`);
}

function printCitation(entry: CitationDrift): void {
  const { citation, check } = entry;
  const at = `${citation.file}:${citation.line}`;
  const where = label(entry.where);

  if (entry.level === "verified") {
    console.log(`  ok     ${where}  ${at}`);
    return;
  }

  if (entry.level === "soft") {
    console.log(`  SOFT   ${where}  ${at} -> ${check.actualLine}`);
    console.log(`         the anchor moved: set line to ${check.actualLine}`);
    return;
  }

  console.log(`  HARD   ${where}  ${at}`);
  console.log(`         ${check.note}`);
}

/**
 * A trap states its hazard in a sentence, which is right in the file and too long for a report line.
 * The label is cut, never the note beneath it: what a drifted citation says about itself is the part
 * a reader acts on, so that is the part that is never abbreviated.
 */
function label(where: string): string {
  if (where.length <= 64) return where;
  return `${where.slice(0, 61)}...${where.endsWith('"') ? '"' : ""}`;
}

function hasDrift(report: SpineReport): boolean {
  return report.soft + report.hard > 0;
}

function total(reports: SpineReport[], field: "soft" | "hard"): number {
  return reports.reduce((count, report) => count + report[field], 0);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
