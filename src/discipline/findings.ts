import {
  type Citation,
  type CitationCheck,
  type CitationStatus,
  checkCitation,
} from "../engine/citations";
import { type ChangedFile, isChangedLine, removedLine } from "../engine/diff";
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
  /**
   * The diff line that introduced or broke this. For a `diff` finding it is usually the citation
   * itself; for an `impact` or `coverage` one it is the hunk whose change reaches that far.
   */
  introducedBy: Citation;
  supporting?: Citation[];
  suggestion?: string;
}

export interface VerifiedFinding {
  finding: ReviewFinding;
  /** The citation as it survived: corrected to the line the anchor is really on, when it moved. */
  citation: Citation;
  corrected: boolean;
  /** The attribution as it was verified: the line containment was actually measured on. */
  introducedBy: Citation;
  /**
   * True when that line was verified against the diff's removed side, because the branch deleted
   * it. The coordinate is then in the base and not in the branch, and every report of it says so.
   */
  introducedByDeleted: boolean;
  supporting: SupportingCitation[];
}

export interface SupportingCitation {
  citation: Citation;
  corrected: boolean;
  /** Carried so a supporting citation that did not resolve is reported rather than swallowed. */
  status: CitationStatus;
  note: string;
}

export type DropReason =
  | "citation-unverified"
  | "cited-outside-diff"
  | "cited-inside-diff"
  | "not-introduced"
  | "forbidden-phrasing"
  | "duplicate";

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

/**
 * @param changed The pull request's diff, or null when it could not be read. Null skips the
 * containment check alone: `introducedBy` is still resolved against source, because a citation
 * nobody checked is the failure this gate exists to prevent whether or not a diff is at hand.
 */
export function gateFindings(
  readRoot: string,
  findings: ReviewFinding[],
  changed: ChangedFile[] | null = null,
): GateResult {
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

    // `introducedBy` alone was not enough. It says what caused the defect, and an agent that wants
    // to report an inherited one only has to name any hunk in the same file to launder it past the
    // gate. So the citation, the line the finding actually stands on, is scoped too, and the kind
    // says which way: a `diff` finding is by definition visible in the diff, and a `coverage` one
    // stands either on the changed behaviour that has no test or on the test hunk that loosened an
    // assertion, so both are inside it. Only `impact` reaches outside, and it has to: it is a
    // breakage in a line the diff did not touch, reached through the blast radius. A finding
    // labelled `impact` that cites a changed line is a `diff` finding wearing the one label that
    // is allowed out of the diff, so it is dropped rather than quietly counted.
    //
    // The removed side is not consulted here, unlike for `introducedBy`. A citation that got this
    // far resolved against the branch, so the line is still there and the question is only which
    // side of a hunk it is on. Asking `removedLine` as well would let a generic line ("return
    // null;") that the diff happens to have deleted elsewhere in the file pull an inherited one
    // into scope, which is the gate's own failure mode wearing the fix's clothes.
    //
    // A drifted citation is scoped on the line its anchor really sits on, which makes the drift
    // repair load-bearing where it used to be cosmetic: an anchor that occurs twice in one file
    // resolves to whichever occurrence is nearer the cited line, and a wrong line number can now
    // land it outside the diff and drop the finding. The drop names the line it measured, so the
    // remedy is the coordinate the finding should have carried in the first place.
    const citedLine = check.actualLine ?? finding.citation.line;
    const citedInDiff =
      changed !== null && isChangedLine(changed, finding.citation.file, citedLine);

    if (changed !== null && finding.kind !== "impact" && !citedInDiff) {
      dropped.push({
        finding,
        reason: "cited-outside-diff",
        detail: [
          `${finding.citation.file}:${citedLine} is outside every hunk of this diff.`,
          `A ${finding.kind} finding stands on a line this pull request changed. This one the branch inherited, so it belongs in the maintenance line, not the findings.`,
        ],
      });
      continue;
    }

    if (changed !== null && finding.kind === "impact" && citedInDiff) {
      dropped.push({
        finding,
        reason: "cited-inside-diff",
        detail: [
          `${finding.citation.file}:${citedLine} is inside a hunk of this diff.`,
          'An impact finding is a breakage in a line the diff does not touch. Report this one as kind "diff".',
        ],
      });
      continue;
    }

    // The pull request is the subject of the review, so a finding has to name the line in it that
    // caused the defect. Everything else is a defect the branch inherited: real, sometimes worse
    // than anything in the diff, and not this author's to fix. A review that reports them anyway
    // never converges, because the backlog it is really reviewing is the whole repository.
    const origin = checkCitation(readRoot, finding.introducedBy);
    const readable = origin.status !== "missing-file" && origin.status !== "anchor-absent";
    const originLine = origin.actualLine ?? finding.introducedBy.line;
    const contained =
      readable &&
      (changed === null || isChangedLine(changed, finding.introducedBy.file, originLine));

    // A deletion is how a pull request breaks a consumer without leaving anything in the new file
    // to cite: delete the file and `introducedBy` is unreadable, delete the method and its anchor
    // is nowhere. The diff still carries the removed text, so it is the source of record for a line
    // the branch took away, and being in a hunk at all is what proves the branch took it. Asked of
    // every line that failed containment and not only of the unreadable ones, because a deleted
    // line whose text recurs elsewhere in the file resolves perfectly well, somewhere it was never
    // cited, and would otherwise be reported as inherited.
    const deletedAt =
      contained || changed === null ? null : removedLine(changed, finding.introducedBy);

    if (!contained && deletedAt === null) {
      dropped.push({
        finding,
        reason: "not-introduced",
        detail: readable
          ? [
              `introducedBy ${finding.introducedBy.file}:${originLine} is outside every hunk of this diff, and is not among the lines it removed.`,
              "The pull request did not cause this, so it is not a finding against it.",
            ]
          : [
              `introducedBy: ${origin.note}`,
              // Without the diff the removed side was never looked at, and saying it was would be
              // the gate claiming a check it skipped.
              changed === null
                ? "The line said to have introduced this does not exist, so nothing ties it to the diff."
                : "The line said to have introduced this is neither in the branch nor among the " +
                  "lines this diff removed, so nothing ties it to the pull request.",
            ],
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
      introducedBy:
        deletedAt === null
          ? correctedCitation(finding.introducedBy, origin)
          : { ...finding.introducedBy, ...deletedAt },
      introducedByDeleted: deletedAt !== null,
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
