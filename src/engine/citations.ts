import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The citation checker: docs/07-review-discipline.md step 5, standing on principle 2 of
 * docs/00-overview.md, "an assertion is true only when something checked it". This is the code that
 * turns a `file:line` in a finding from a claim into a fact, so it is deliberately dumb: no LLM, no
 * fuzzy matching beyond whitespace, the same answer on every machine and every run. `empo verify`
 * resolves a spine's anchors by the same three-way rule (docs/08-spines.md), so a finding's citation
 * and a spine's citation rot in exactly the same, visible way.
 */

export interface Citation {
  /** Repo-relative, always. An author reads it in their own checkout (docs/07 step 7). */
  file: string;
  line: number;
  /** A distinctive substring expected at that line. This is what makes the line checkable. */
  anchor: string;
}

export type CitationStatus = "verified" | "moved" | "missing-file" | "anchor-absent";

export interface CitationCheck {
  citation: Citation;
  status: CitationStatus;
  /** Where the anchor really is, when it moved. Null otherwise. */
  actualLine: number | null;
  /**
   * The line the check settled on, as it really reads: the cited line normally, the line at
   * `actualLine` when the anchor moved, so a report never prints a corrected line number beside the
   * text of the line it corrected away from. Null when the file could not be read, and null when
   * the cited line is out of range and there is nothing to quote.
   */
  sourceLine: string | null;
  note: string;
}

export function checkCitation(readRoot: string, citation: Citation): CitationCheck {
  const located = locate(readRoot, citation.file);
  if ("rejected" in located) {
    return unreadable(citation, located.rejected);
  }

  let lines: string[];
  try {
    lines = splitLines(readFileSync(located.path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    return unreadable(citation, `${citation.file} could not be read (${code})`);
  }

  const inRange = citation.line >= 1 && citation.line <= lines.length;
  const citedLine = inRange ? (lines[citation.line - 1] ?? "") : null;

  // An anchor is the whole point: it is the quoted source the claim stands on. Nothing to check
  // means nothing was checked, which is the failure this module exists to prevent.
  const anchor = collapse(citation.anchor);
  if (anchor === "") {
    return {
      citation,
      status: "anchor-absent",
      actualLine: null,
      sourceLine: citedLine,
      note: `${citation.file}:${citation.line} cites no anchor: a finding must quote the source it stands on`,
    };
  }

  if (citedLine !== null && collapse(citedLine).includes(anchor)) {
    return {
      citation,
      status: "verified",
      actualLine: null,
      sourceLine: citedLine,
      note: `anchor found at ${citation.file}:${citation.line}`,
    };
  }

  const actualLine = nearest(matchingLines(lines, anchor), citation.line);
  const rangeNote = inRange
    ? ""
    : ` (line ${citation.line} does not exist, the file has ${lines.length} line${lines.length === 1 ? "" : "s"})`;

  if (actualLine === null) {
    // The two mistakes are different and the author fixes them differently: a line that exists but
    // says something else is a misread, a line past the end of the file is a fabricated coordinate.
    return {
      citation,
      status: "anchor-absent",
      actualLine: null,
      sourceLine: citedLine,
      note:
        citedLine === null
          ? `anchor is nowhere in ${citation.file}${rangeNote}`
          : `anchor is nowhere in ${citation.file}; line ${citation.line} reads "${excerpt(citedLine)}"`,
    };
  }

  return {
    citation,
    status: "moved",
    actualLine,
    sourceLine: lines[actualLine - 1] ?? "",
    note: `anchor is at ${citation.file}:${actualLine}, not the cited line ${citation.line}${rangeNote}`,
  };
}

export function checkCitations(readRoot: string, citations: Citation[]): CitationCheck[] {
  return citations.map((citation) => checkCitation(readRoot, citation));
}

/**
 * A review runs against a detached worktree and is given exactly that tree to read. A citation that
 * is absolute, or that climbs out with `..`, points at a file the review was never handed, so it is
 * refused before any read happens rather than after. Resolve and compare instead of pattern
 * matching, so `app/../../etc/passwd` is caught as surely as `../etc/passwd`.
 */
function locate(readRoot: string, file: string): { path: string } | { rejected: string } {
  if (isAbsolute(file)) {
    return {
      rejected: `${file} is an absolute path; a citation must be repo-relative, and nothing outside the read root is read`,
    };
  }

  const root = resolve(readRoot);
  const path = resolve(root, file);
  const rel = relative(root, path);
  if (rel === "") {
    return { rejected: `${file} points at the read root itself, not at a file` };
  }
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    return {
      rejected: `${file} escapes the read root; a citation must be repo-relative, and nothing outside the read root is read`,
    };
  }

  return { path };
}

/** Every unreadable case reports the same way: no line to quote, and no line to correct to. */
function unreadable(citation: Citation, note: string): CitationCheck {
  return { citation, status: "missing-file", actualLine: null, sourceLine: null, note };
}

/**
 * Whitespace is not evidence. An anchor has to survive a reindent, a tab converted to spaces, and a
 * claim quoted with single spaces from source that is aligned, or the checker would reject true
 * citations and teach agents to stop quoting source at all.
 */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A trailing newline is a terminator, not an empty last line: the file has as many lines as it reads. */
function splitLines(contents: string): string[] {
  const lines = contents.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Ascending by construction, which is what lets `nearest` break its ties without sorting. */
function matchingLines(lines: string[], anchor: string): number[] {
  const matches: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (collapse(lines[index] ?? "").includes(anchor)) matches.push(index + 1);
  }
  return matches;
}

/**
 * The match closest to the cited line, ties going to the lower line number. Replacing only on a
 * strictly smaller distance over an ascending list is what makes the tie deterministic: the answer
 * can never depend on the order the file was scanned in.
 */
function nearest(matches: number[], line: number): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const match of matches) {
    const distance = Math.abs(match - line);
    if (distance < bestDistance) {
      best = match;
      bestDistance = distance;
    }
  }
  return best;
}

/** Notes are read in a terminal, so a 400-character minified line does not get quoted whole. */
function excerpt(line: string): string {
  const text = collapse(line);
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}
