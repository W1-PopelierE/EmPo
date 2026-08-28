import { compareStrings } from "./order";

/**
 * The unified diff parser: text in, structure out. No file system, no subprocess, no git.
 *
 * `empo review` needs exactly two things from a diff: which files changed, and which line numbers
 * inside them. Step 2 of the review discipline (docs/07-review-discipline.md) maps every changed
 * file onto a graph node and asks `empo query` for its blast radius, and a finding cited on a line
 * the diff never touched is a finding about somebody else's code. The commit gate `empo check`
 * reads the staged diff through this same function, which is why this is an engine module and not
 * part of a forge adapter: the diff comes from git, never from a forge's API.
 *
 * Nothing here throws and nothing exits. A diff EmPo cannot parse yields fewer files, never a
 * crash: refusing to review because one hunk header is malformed is worse than reviewing the rest
 * of the branch. Every skip is local, so one unreadable file costs one file.
 */

export interface DiffLine {
  line: number;
  text: string;
}

export interface ChangedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Line numbers are in the NEW file, which is what a citation points at. */
  added: DiffLine[];
  /** Line numbers are in the OLD file. */
  removed: DiffLine[];
}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  /** Repo-relative, `a/` and `b/` prefixes stripped. The new path for a rename. */
  path: string;
  /** The pre-rename path, else null. */
  oldPath: string | null;
  status: ChangeStatus;
  hunks: ChangedHunk[];
  addedCount: number;
  removedCount: number;
  isBinary: boolean;
}

/** The line that opens every file in a git diff. Nothing outside one is parsed. */
const FILE_HEADER = "diff --git ";

/**
 * A count omitted means 1 (`@@ -0,0 +1 @@`), which is why both are optional. The trailing text
 * after the closing `@@` is git's guess at the enclosing function and is ignored, not required.
 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(text: string): ChangedFile[] {
  const lines = splitLines(text);
  const files: ChangedFile[] = [];

  let index = 0;
  while (index < lines.length) {
    if (!(lines[index] ?? "").startsWith(FILE_HEADER)) {
      index += 1;
      continue;
    }
    const parsed = parseFile(lines, index);
    if (parsed.file !== null) files.push(parsed.file);
    // parseFile consumes the header line at the very least, but the cursor is forced forward
    // anyway: a parser that fails to advance on malformed input hangs instead of degrading.
    index = parsed.next > index ? parsed.next : index + 1;
  }

  return files.sort((a, b) => compareStrings(a.path, b.path));
}

/**
 * The new path of every changed file, deduplicated. A rename's old path is deliberately absent:
 * these are the files as they now exist, which is what a reviewer reads and what a citation names.
 * The old path is still on the file, for a caller that needs the node the graph knew before.
 */
export function changedPaths(files: ChangedFile[]): string[] {
  const paths = new Set<string>();
  for (const file of files) paths.add(file.path);
  return [...paths].sort(compareStrings);
}

/** Every new-file line number this file added or changed, ascending. */
export function changedLines(file: ChangedFile): number[] {
  const lines = new Set<number>();
  for (const hunk of file.hunks) {
    for (const added of hunk.added) lines.add(added.line);
  }
  return [...lines].sort((a, b) => a - b);
}

interface FileParse {
  file: ChangedFile | null;
  next: number;
}

/**
 * One `diff --git` block. Every line between this header and the next one is either a hunk, a
 * piece of file metadata, or something git added that this parser has no use for (`index`,
 * `similarity index`, `old mode`), which is skipped rather than treated as an error.
 */
function parseFile(lines: string[], start: number): FileParse {
  const headerPaths = splitHeaderPaths((lines[start] ?? "").slice(FILE_HEADER.length));
  let oldPath = headerPaths === null ? null : stripPrefix(headerPaths[0], "a/");
  let newPath = headerPaths === null ? null : stripPrefix(headerPaths[1], "b/");

  let isAdded = false;
  let isDeleted = false;
  let isRenamed = false;
  let isBinary = false;
  const hunks: ChangedHunk[] = [];

  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith(FILE_HEADER)) break;

    if (line.startsWith("@@ ")) {
      const parsed = parseHunk(lines, index);
      if (parsed === null) {
        index += 1;
        continue;
      }
      hunks.push(parsed.hunk);
      index = parsed.next > index ? parsed.next : index + 1;
      continue;
    }

    // `--- ` and `+++ ` hold one path each, so they are unambiguous where the `diff --git` line is
    // not, and they overwrite what it guessed. `/dev/null` on a side is what marks an add or a
    // delete in a diff that carries no `new file mode` line.
    const oldSide = after(line, "--- ");
    if (oldSide !== null) {
      const path = sidePath(oldSide, "a/");
      if (path === null) isAdded = true;
      else oldPath = path;
      index += 1;
      continue;
    }

    const newSide = after(line, "+++ ");
    if (newSide !== null) {
      const path = sidePath(newSide, "b/");
      if (path === null) isDeleted = true;
      else newPath = path;
      index += 1;
      continue;
    }

    const renameFrom = after(line, "rename from ");
    if (renameFrom !== null) {
      oldPath = unquotePath(renameFrom);
      isRenamed = true;
      index += 1;
      continue;
    }

    const renameTo = after(line, "rename to ");
    if (renameTo !== null) {
      newPath = unquotePath(renameTo);
      isRenamed = true;
      index += 1;
      continue;
    }

    // A copy is a new file that happens to have a source. It gets `added`, because that is what it
    // is to a reviewer: nothing at the old path changed, so there is no pre-rename path to report.
    const copyTo = after(line, "copy to ");
    if (copyTo !== null) {
      newPath = unquotePath(copyTo);
      isAdded = true;
      index += 1;
      continue;
    }

    if (line.startsWith("new file mode ") || line.startsWith("copy from ")) isAdded = true;
    else if (line.startsWith("deleted file mode ")) isDeleted = true;
    else if (isBinaryMarker(line)) isBinary = true;

    index += 1;
  }

  // A deleted file has `+++ /dev/null`, so its name survives only on the `diff --git` line.
  const path = newPath ?? oldPath;
  if (path === null) return { file: null, next: index };

  return {
    file: {
      path,
      oldPath: isRenamed ? oldPath : null,
      status: isRenamed ? "renamed" : isAdded ? "added" : isDeleted ? "deleted" : "modified",
      hunks,
      addedCount: hunks.reduce((total, hunk) => total + hunk.added.length, 0),
      removedCount: hunks.reduce((total, hunk) => total + hunk.removed.length, 0),
      isBinary,
    },
    next: index,
  };
}

interface HunkParse {
  hunk: ChangedHunk;
  next: number;
}

/**
 * One hunk, bounded by the counts in its own header rather than by what its lines look like.
 * That is the whole trick: a removed line whose content begins with `-- ` is written `--- ` and is
 * indistinguishable from a file header, and an added line can begin with `@@`. Consuming exactly
 * the declared number of old-side and new-side lines means content never gets read as structure.
 * A line with a prefix that belongs to neither side ends the hunk, which is how a truncated diff
 * degrades into a short hunk instead of swallowing the next file.
 */
function parseHunk(lines: string[], start: number): HunkParse | null {
  const match = HUNK_HEADER.exec(lines[start] ?? "");
  if (match === null) return null;

  const oldStart = toCount(match[1]);
  const oldLines = match[2] === undefined ? 1 : toCount(match[2]);
  const newStart = toCount(match[3]);
  const newLines = match[4] === undefined ? 1 : toCount(match[4]);

  const added: DiffLine[] = [];
  const removed: DiffLine[] = [];
  let oldLine = oldStart;
  let newLine = newStart;
  let oldLeft = oldLines;
  let newLeft = newLines;

  let index = start + 1;
  while (index < lines.length && (oldLeft > 0 || newLeft > 0)) {
    const line = lines[index] ?? "";
    const marker = line.charAt(0);

    if (marker === "\\") {
      // `\ No newline at end of file` annotates the line above it and is not a line of its own.
      index += 1;
      continue;
    }
    if (marker === "+") {
      added.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
      newLeft -= 1;
    } else if (marker === "-") {
      removed.push({ line: oldLine, text: line.slice(1) });
      oldLine += 1;
      oldLeft -= 1;
    } else if (marker === " " || marker === "") {
      // A zero-length line is blank context. Git writes a single space, but plenty of diffs that
      // reach EmPo have been through an editor or a mailer that stripped the trailing space, and
      // dropping the line there would shift every line number after it.
      oldLine += 1;
      newLine += 1;
      oldLeft -= 1;
      newLeft -= 1;
    } else break;

    index += 1;
  }

  return { hunk: { oldStart, oldLines, newStart, newLines, added, removed }, next: index };
}

/**
 * The two paths on a `diff --git` line. Genuinely ambiguous, because git separates them with a
 * space and only quotes a path holding a control character, a quote, a backslash or a non-ASCII
 * byte: a space alone is written bare. Three rules, in order:
 *
 * 1. A quoted path is unambiguous, so read to its closing quote.
 * 2. Otherwise the same path is on both sides in every case but a rename, so when a space sits
 *    exactly in the middle and the halves match, that space is the separator whatever the path
 *    holds. This is what makes `a/dir with space/x.ts b/dir with space/x.ts` parse.
 * 3. Otherwise it is a rename or a copy, where ` b/` is the best guess available. `rename from`
 *    and `rename to` follow within two lines and hold one path each, and they overwrite it.
 */
function splitHeaderPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest, 0);
    if (end === -1) return null;
    const second = rest.slice(end + 1).replace(/^ +/, "");
    if (second === "") return null;
    return [unquotePath(rest.slice(0, end + 1)), unquotePath(second)];
  }

  if (rest.endsWith('"')) {
    const opening = rest.lastIndexOf(' "');
    if (opening > 0) return [rest.slice(0, opening), unquotePath(rest.slice(opening + 1))];
  }

  const middle = (rest.length - 1) / 2;
  if (Number.isInteger(middle) && rest.charAt(middle) === " ") {
    const first = rest.slice(0, middle);
    const second = rest.slice(middle + 1);
    if (stripPrefix(first, "a/") === stripPrefix(second, "b/")) return [first, second];
  }

  const renameSeparator = rest.indexOf(" b/");
  if (renameSeparator > 0) {
    return [rest.slice(0, renameSeparator), rest.slice(renameSeparator + 1)];
  }

  const space = rest.indexOf(" ");
  if (space > 0) return [rest.slice(0, space), rest.slice(space + 1)];
  return null;
}

/** The path on one side of a `---`/`+++` header, or null for `/dev/null`. */
function sidePath(rest: string, prefix: string): string | null {
  // A non-git unified diff writes a tab and a timestamp after the path. Git quotes any path that
  // could contain a real tab, so cutting at the first one cannot cut a path in half.
  const path = unquotePath(rest.split("\t")[0] ?? "");
  return path === "/dev/null" ? null : stripPrefix(path, prefix);
}

/**
 * `a/` and `b/` are git's default prefixes, not part of the path. A repository that really does
 * have a top-level `a` directory still parses: `diff --git a/a/x.ts b/a/x.ts` keeps one `a/`.
 */
function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function after(line: string, prefix: string): string | null {
  return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

function isBinaryMarker(line: string): boolean {
  // The first is a plain diff, the second is `git diff --binary`. Neither is ever translated,
  // because a patch that only applies in one locale is not a patch.
  return (
    (line.startsWith("Binary files ") && line.endsWith(" differ")) || line === "GIT binary patch"
  );
}

const ESCAPES: Record<string, string> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "\\": "\\",
};

const OCTAL_ESCAPE = /^\\([0-7]{1,3})/;

const utf8 = new TextDecoder();

/**
 * Undoes git's C-style path quoting. Anything not quoted is returned untouched, so this is safe to
 * call on every path.
 *
 * The octal escapes are the reason this exists at all: with the default `core.quotePath`, git
 * writes every byte above ASCII as `\303\251`, and those are the two UTF-8 bytes of one character.
 * Decoding each escape on its own would turn `café/x.ts` into mojibake and then into a path no
 * node in the graph has, so a whole file would silently drop out of the review. A run of them is
 * collected as bytes and decoded once.
 */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const end = closingQuote(raw, 0);
  const body = raw.slice(1, end === -1 ? raw.length : end);

  let out = "";
  let index = 0;
  while (index < body.length) {
    const octal = readOctalRun(body, index);
    if (octal !== null) {
      out += utf8.decode(Uint8Array.from(octal.bytes));
      index = octal.next;
      continue;
    }
    if (body.charAt(index) === "\\") {
      const escaped = ESCAPES[body.charAt(index + 1)];
      // A backslash git did not write as an escape stays a backslash. Eating it would rename the
      // file, and a path that matches nothing is worse than a path that looks odd.
      out += escaped ?? "\\";
      index += escaped === undefined ? 1 : 2;
      continue;
    }
    out += body.charAt(index);
    index += 1;
  }
  return out;
}

function readOctalRun(body: string, start: number): { bytes: number[]; next: number } | null {
  const bytes: number[] = [];
  let index = start;
  while (index < body.length) {
    const match = OCTAL_ESCAPE.exec(body.slice(index, index + 4));
    const digits = match === null ? null : (match[1] ?? null);
    if (digits === null) break;
    bytes.push(Number.parseInt(digits, 8) & 0xff);
    index += 1 + digits.length;
  }
  return bytes.length === 0 ? null : { bytes, next: index };
}

/** The index of the quote that closes the one at `start`, or -1 if the string never closes. */
function closingQuote(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') return index;
    index += 1;
  }
  return -1;
}

function toCount(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Splits on newlines and drops a carriage return at the end of each line, so a diff written on
 * Windows or covering a CRLF file parses like any other and no citation carries a stray `\r`.
 *
 * The empty element a trailing newline leaves behind is dropped as well, otherwise a hunk whose
 * declared counts are not yet satisfied would count it as one more blank context line. An empty
 * element anywhere else is kept, because inside a hunk it is real blank context.
 */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Is this `file:line` inside a hunk of this diff? The whole new-side span of the hunk counts, not
 * only the added lines, because a pull request breaks things by deleting as often as by adding and
 * a deletion leaves nothing to cite but the context around it.
 *
 * This is what the findings gate stands on: a finding whose `introducedBy` lands outside every
 * hunk is a defect the branch inherited, and reporting it as this pull request's is how a review
 * turns into an audit nobody asked for.
 */
export function isChangedLine(files: ChangedFile[], path: string, line: number): boolean {
  return files.some(
    (file) =>
      file.path === path &&
      // A pure rename has no hunks and still breaks every importer, so the whole file counts as
      // changed there. Anywhere else, the hunks are the change.
      (file.hunks.length === 0
        ? file.status === "renamed" || file.status === "added"
        : file.hunks.some(
            // A pure deletion hunk (`@@ -5 +4,0 @@`) spans no new lines, so its range would be
            // empty and nothing a deletion broke could ever be attributed to it. The surviving
            // boundary line is what a citation has left to point at, so it counts as changed.
            (hunk) => line >= hunk.newStart && line < hunk.newStart + Math.max(hunk.newLines, 1),
          )),
  );
}
