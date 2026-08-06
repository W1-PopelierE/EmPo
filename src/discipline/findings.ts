import {
  type Citation,
  type CitationCheck,
  type CitationStatus,
  checkCitation,
} from "../engine/citations";
import { compareStrings } from "../engine/order";
import { forbiddenPhrasings } from "./phrasing";

/**
 * The verification gate: docs/07-review-discipline.md step 5, "keep only survivors". Every finding
 * an agent produces passes through here before a human sees it, and a finding leaves it only if its
 * `file:line` was resolved against real source and its own text asserts rather than guesses. This is
 * the mechanism behind principle 2 of docs/00-overview.md; a plausible finding with a citation
 * nobody checked is the exact failure EmPo exists to prevent, so the gate drops rather than warns.
 */

export type FindingKind = "diff" | "impact" | "coverage";
export type Severity = "blocker" | "major" | "minor" | "question";

export interface ReviewFinding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  claim: string;
  /** The line the finding stands on. Without it there is no finding (docs/05-graph-model.md). */
  citation: Citation;
  supporting?: Citation[];
  suggestion?: string;
}

export interface VerifiedFinding {
  finding: ReviewFinding;
  /** The citation as it survived: corrected to the line the anchor is really on, when it moved. */
  citation: Citation;
  corrected: boolean;
  supporting: SupportingCitation[];
}

export interface SupportingCitation {
  citation: Citation;
  corrected: boolean;
  /** Carried so a supporting citation that did not resolve is reported rather than swallowed. */
  status: CitationStatus;
  note: string;
}

export type DropReason = "citation-unverified" | "forbidden-phrasing" | "duplicate";

export interface DroppedFinding {
  finding: ReviewFinding;
  reason: DropReason;
  detail: string[];
}

export interface GateResult {
  kept: VerifiedFinding[];
  dropped: DroppedFinding[];
}

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, question: 3 };

export function gateFindings(readRoot: string, findings: ReviewFinding[]): GateResult {
  const kept: VerifiedFinding[] = [];
  const dropped: DroppedFinding[] = [];

  // Dedupe against what survived, not against everything submitted. A finding claims its line only
  // once it has been verified, because a fabricated or hedged finding that sorts first must not take
  // a real one down with it as a "duplicate". That inverts the gate, which exists to drop claims
  // nobody checked and never to swallow one that was. A duplicate of a survivor is still caught
  // before its own citation is read, which is the saving docs/07 step 5 asks for.
  //
  // The kind is part of the identity. Two sources landing on one line is the duplicate that doc
  // means; a defect and a missing test citing the same line are two different claims about it.
  const survivors = new Map<string, ReviewFinding>();

  for (const finding of [...findings].sort(byIdentity)) {
    const key = `${finding.kind}\u0000${finding.citation.file}\u0000${finding.citation.line}`;
    const winner = survivors.get(key);
    if (winner !== undefined) {
      dropped.push({
        finding,
        reason: "duplicate",
        detail: [
          `Same suspect as ${winner.id}, both cite ${finding.citation.file}:${finding.citation.line}.`,
          `${winner.id} sorts first, so it is the one that was verified.`,
        ],
      });
      continue;
    }

    // The citation is checked before the text is linted, so a finding that is both hedged and
    // fabricated is reported as fabricated: the citation is the ground truth, and its note is the
    // more actionable of the two answers.
    const check = checkCitation(readRoot, finding.citation);
    if (check.status === "missing-file" || check.status === "anchor-absent") {
      dropped.push({
        finding,
        reason: "citation-unverified",
        detail: [check.note, "A claim standing on text that does not exist is not a finding."],
      });
      continue;
    }

    const hits = forbiddenPhrasings(`${finding.title} ${finding.claim}`);
    if (hits.length > 0) {
      // Only the title and the claim. A suggestion is allowed to be tentative, since proposing a
      // fix is not asserting a defect; the defect itself has to be stated as fact.
      // One line per distinct phrase, not per occurrence. A hedge used twice in one finding is one
      // thing to fix, and printing the same remedy twice reads as a fault in the gate.
      dropped.push({
        finding,
        reason: "forbidden-phrasing",
        detail: [...new Set(hits.map((hit) => `"${hit.matched}": ${hit.why}`))],
      });
      continue;
    }

    survivors.set(key, finding);

    kept.push({
      finding,
      citation: correctedCitation(finding.citation, check),
      corrected: check.status === "moved",
      // A supporting citation is context (the caller, the sibling, the test), not the ground the
      // claim stands on, so a bad one is reported beside the finding instead of killing it.
      // Killing the finding would teach agents to cite no context at all, which costs the author
      // the very thing that makes a verified finding quick to confirm.
      supporting: (finding.supporting ?? []).map((citation) => {
        const supportCheck = checkCitation(readRoot, citation);
        return {
          citation: correctedCitation(citation, supportCheck),
          corrected: supportCheck.status === "moved",
          status: supportCheck.status,
          note: supportCheck.note,
        };
      }),
    });
  }

  kept.sort(byReportOrder);
  dropped.sort((a, b) => byIdentity(a.finding, b.finding));
  return { kept, dropped };
}

/**
 * A moved anchor is a repairable off-by-one, not a lie: the quoted source is there, the coordinate
 * drifted. The finding survives pointing at the line the anchor is really on, because that is the
 * line the author has to open.
 */
function correctedCitation(citation: Citation, check: CitationCheck): Citation {
  if (check.status !== "moved" || check.actualLine === null) return citation;
  return { ...citation, line: check.actualLine };
}

/**
 * A total order that never consults input order. Two agents that emit the same findings in a
 * different sequence must get the same gate result, including which of two duplicates survives, so
 * the comparison keeps going until it separates two findings that are not identical.
 */
function byIdentity(a: ReviewFinding, b: ReviewFinding): number {
  return (
    compareStrings(a.id, b.id) ||
    compareStrings(a.citation.file, b.citation.file) ||
    a.citation.line - b.citation.line ||
    compareStrings(a.title, b.title) ||
    compareStrings(a.claim, b.claim)
  );
}

/** Worst first, then by location, which is the order a human reads a review in (docs/07 step 7). */
function byReportOrder(a: VerifiedFinding, b: VerifiedFinding): number {
  return (
    SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
    compareStrings(a.citation.file, b.citation.file) ||
    a.citation.line - b.citation.line ||
    compareStrings(a.finding.id, b.finding.id)
  );
}
