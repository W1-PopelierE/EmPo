import type { AmbiguousName, NameOutcome, NameResolution } from "../schema/types";
import { compareStrings } from "./order";

/**
 * The name-resolution tally and the one sentence every surface says it in.
 *
 * `observer` and `short-name` are the two strategies whose entire input is a bare name, and the
 * refusal they share is per **name** rather than per reference: one duplicate basename anywhere in
 * a root removes every edge to that name, including the ones written in a file whose own import
 * says which one is meant. Measured on a synthetic 16-file React tree, adding a second
 * `OrderTable.tsx` under another feature directory took it from 12 template edges to 7, and on a
 * 640-file copy where every component name was 40-way ambiguous no template edge resolved at all.
 * None of that was reported: no warning, doctor OK.
 *
 * This module is what ends that silence. It does not narrow the refusal, which is a separate and
 * larger change: a family that resolves nothing still resolves nothing, and now says so, so a
 * reader can tell "found nothing" from "there was nothing to find". The rendering lives beside the
 * arithmetic for the reason `bridgeLines` and `driftLines` do: `empo index` and `empo doctor` both
 * print this, and two copies of the sentence would drift.
 */

/** How many ambiguous names a line names before it stops. Beyond this the list stops being read. */
const NAMED_LIMIT = 5;

/**
 * Every name one root read, folded into one record per family.
 *
 * Counted per reference and not per distinct name, because the question the count answers is what
 * this family's rules did with what they found, and a name written forty times that resolves is
 * forty couplings while a name written once that does not is one missing edge. `ambiguousNames`
 * carries the other cut for the names where it matters.
 */
export function tallyNames(outcomes: NameOutcome[]): NameResolution[] {
  const byFamily = new Map<NameResolution["family"], NameResolution>();
  const ambiguous = new Map<string, Map<string, AmbiguousName>>();

  for (const outcome of outcomes) {
    let report = byFamily.get(outcome.family);
    if (report === undefined) {
      report = {
        family: outcome.family,
        resolved: 0,
        unknown: 0,
        ambiguous: 0,
        wrongKind: 0,
        ambiguousNames: [],
      };
      byFamily.set(outcome.family, report);
    }

    if (outcome.outcome === "resolved") report.resolved += 1;
    else if (outcome.outcome === "unknown") report.unknown += 1;
    else if (outcome.outcome === "wrong-kind") report.wrongKind += 1;
    else {
      report.ambiguous += 1;
      const names = ambiguous.get(outcome.family) ?? new Map<string, AmbiguousName>();
      const existing = names.get(outcome.name);
      if (existing === undefined) {
        names.set(outcome.name, {
          name: outcome.name,
          nodes: outcome.candidates,
          references: 1,
        });
      } else {
        existing.references += 1;
        existing.nodes = Math.max(existing.nodes, outcome.candidates);
      }
      ambiguous.set(outcome.family, names);
    }
  }

  for (const [family, report] of byFamily) {
    report.ambiguousNames = sortNames([...(ambiguous.get(family)?.values() ?? [])]);
  }

  return [...byFamily.values()].sort((a, b) => compareStrings(a.family, b.family));
}

/**
 * The tallies of several roots as one record per family.
 *
 * Counts sum, because a reference read under one root and a reference read under another are two
 * references. Candidate counts do not: ambiguity is decided against one root's index, so a name
 * ambiguous under two roots takes the larger of the two rather than their sum, which is the number
 * a reader opening that index will actually find. Summing them would report more files than any
 * single refusal ever weighed.
 */
export function mergeNames(reports: NameResolution[]): NameResolution[] {
  const merged = new Map<NameResolution["family"], NameResolution>();
  const ambiguous = new Map<string, Map<string, AmbiguousName>>();

  for (const report of reports) {
    const existing = merged.get(report.family);
    if (existing === undefined) {
      merged.set(report.family, { ...report, ambiguousNames: [] });
    } else {
      existing.resolved += report.resolved;
      existing.unknown += report.unknown;
      existing.ambiguous += report.ambiguous;
      existing.wrongKind += report.wrongKind;
    }

    const names = ambiguous.get(report.family) ?? new Map<string, AmbiguousName>();
    for (const name of report.ambiguousNames) {
      const seen = names.get(name.name);
      if (seen === undefined) names.set(name.name, { ...name });
      else {
        seen.references += name.references;
        seen.nodes = Math.max(seen.nodes, name.nodes);
      }
    }
    ambiguous.set(report.family, names);
  }

  for (const [family, report] of merged) {
    report.ambiguousNames = sortNames([...(ambiguous.get(family)?.values() ?? [])]);
  }

  return [...merged.values()].sort((a, b) => compareStrings(a.family, b.family));
}

/**
 * The cost first, then the breadth, then the name, so the entry a reader can save the most edges by
 * repairing is the one they read first. The name is the final tiebreak and not a preference: two
 * names that cost the same must order the same on every machine or `graph.json` stops being
 * byte-comparable, which is what `empo index --check` is.
 */
function sortNames(names: AmbiguousName[]): AmbiguousName[] {
  return names.sort(
    (a, b) => b.references - a.references || b.nodes - a.nodes || compareStrings(a.name, b.name),
  );
}

/**
 * The `names` block, as the lines `empo index` and `empo doctor` both print.
 *
 * Null is "nobody counted" and the empty list is "counted, and nothing read a name", which are
 * different facts and get different sentences. That distinction is the whole reason the field
 * exists, so a renderer that collapsed them would undo the change it renders. It is the rule
 * `hazards` already follows (schema/types.ts).
 *
 * The empty sentence says no rule **read** a name rather than that no rule resolves by name, and
 * the difference is not pedantry: this repository is the case. Its one root is typescript, whose
 * pack declares two `short-name` template rules, and both carry `pathGlob: "**\/*.{tsx,jsx,vue}"`,
 * which matches no file here. So the rules exist, resolve by name, and read nothing, and the first
 * wording said out loud that the pack had no such rule. That is the same species of false
 * reassurance the whole block was added to end, arriving through the block itself. Which of the two
 * causes it is, is a question about the pack rather than about the graph, so the sentence states
 * the fact it has and claims neither.
 *
 * The null sentence says "no run has counted them" rather than "unknown until the graph is built",
 * which the flows line beside it can say and this one cannot. Two states reach null here and only
 * one of them is an absent graph: the other is a graph that was built, is readable, and predates
 * schema 5, and telling its reader to build the graph they are looking at is an instruction that
 * describes nothing they can see. The repair is the same for both, so the sentence names the repair
 * and leaves which state it is to the graph line above, which has already said.
 *
 * **The denominator prints on every run, including the run where nothing was refused.** A family
 * reporting `41 of 41 resolved` and a family reporting `0 of 53 resolved` are opposite results, and
 * the number that separates them is the total. It is the same argument `empo index` makes for
 * printing the reached-flow count beside the blind one: a denominator that appears only in the bad
 * case is one nobody learns to look for.
 */
export function nameLines(names: NameResolution[] | null): string[] {
  if (names === null) return ["names      unknown, no run has counted them (run empo index)"];
  if (names.length === 0) return ["names      no name-resolving rule read a name here"];

  const lines: string[] = [];
  for (const report of names) {
    const total = report.resolved + report.unknown + report.ambiguous + report.wrongKind;
    const clauses = [`${report.resolved} of ${total} resolved`];
    // Only the non-zero refusals get a clause. The zero is already stated by the denominator above,
    // and three "0 ..." clauses on every healthy family is the noise that gets a line skimmed.
    if (report.ambiguous > 0) clauses.push(`${report.ambiguous} ambiguous`);
    if (report.unknown > 0) clauses.push(`${report.unknown} in no node`);
    if (report.wrongKind > 0) clauses.push(`${report.wrongKind} of the wrong kind`);
    lines.push(`names      ${report.family.padEnd(9)}${clauses.join(", ")}`);

    if (report.ambiguousNames.length === 0) continue;
    // Indented under the family it belongs to, in the shape `empo index` already uses for the
    // second line of a duplicate-node warning. The names are what makes the count actionable: a
    // number alone says the family is losing edges, and this says which rename would give them back.
    const shown = report.ambiguousNames.slice(0, NAMED_LIMIT).map(describeName);
    const rest = report.ambiguousNames.length - shown.length;
    const tail = rest > 0 ? `, and ${rest} more` : "";
    lines.push(`           ${shown.join(", ")}${tail}`);
  }

  return lines;
}

/**
 * Both counts are pluralised, though `nodes` is documented as never fewer than two and so can only
 * ever read "files" here. It is written the same way as the other one because the documentation is
 * the only thing holding it: `tallyNames` records whatever `candidates` the resolver handed it, so
 * a strategy that ever reported an ambiguity over one node would print "1 files" and the reader
 * would be looking at a typo where they should be looking at the defect behind it.
 */
function describeName(name: AmbiguousName): string {
  const files = `${name.nodes} file${name.nodes === 1 ? "" : "s"}`;
  const references = `${name.references} reference${name.references === 1 ? "" : "s"}`;
  return `"${name.name}" (${files}, ${references})`;
}
