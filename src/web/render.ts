import type { ChangedHunk } from "../engine/diff";

/**
 * The pieces of the page that are real logic rather than string concatenation, kept here so the
 * suite can run them. They are serialised into the page with `Function.prototype.toString` (see
 * `src/web/page.ts`), so each one has to be self-contained: no import, no shared constant, nothing
 * from module scope. What runs in the browser is exactly what the tests below this file run.
 */

export interface DiffRow {
  kind: "add" | "del" | "context";
  /** The line's number on that side, or null on the side where it does not exist. */
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

/**
 * Text on its way into the DOM. Every value out of the snapshot goes through this, because a
 * snapshot carries a diff and a diff carries whatever somebody wrote in the branch, a closing script
 * tag included. `&` has to be replaced first: doing it after `<` would turn the `&lt;` just written
 * back into `&amp;lt;` and show the reader an escape instead of a bracket.
 *
 * It does NOT escape `'`, and that is deliberate rather than an oversight: every attribute the page
 * builds is double-quoted, so an apostrophe cannot close one. Whoever writes a single-quoted
 * attribute into `page.ts` has to add `'` here in the same change.
 *
 * Null and undefined become the empty string rather than the words "null" and "undefined", because
 * a field the snapshot left out should render as nothing at all.
 */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A hunk back in the order git wrote it. The parser keeps the three kinds of line in three arrays,
 * and rendering them in that shape gives a block of removals above a block of additions with the
 * unchanged code missing between them — which is not a diff, it is two lists.
 *
 * The context lines carry both numbers, so they are the spine: everything removed before the next
 * context line's old number comes first, then everything added before its new number, then the
 * context line itself. Removals before additions is git's own order inside a change block.
 */
export function hunkRows(hunk: ChangedHunk): DiffRow[] {
  const rows: DiffRow[] = [];
  let nextRemoved = 0;
  let nextAdded = 0;
  const removed = hunk.removed;
  const added = hunk.added;

  const flush = (untilOld: number, untilNew: number): void => {
    for (let line = removed[nextRemoved]; line !== undefined && line.line < untilOld; ) {
      rows.push({ kind: "del", oldLine: line.line, newLine: null, text: line.text });
      nextRemoved += 1;
      line = removed[nextRemoved];
    }
    for (let line = added[nextAdded]; line !== undefined && line.line < untilNew; ) {
      rows.push({ kind: "add", oldLine: null, newLine: line.line, text: line.text });
      nextAdded += 1;
      line = added[nextAdded];
    }
  };

  for (const line of hunk.context) {
    flush(line.oldLine, line.newLine);
    rows.push({ kind: "context", oldLine: line.oldLine, newLine: line.newLine, text: line.text });
  }
  flush(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  return rows;
}

/**
 * Colour for a line of code, as spans wrapped around an ALREADY ESCAPED string. The order matters
 * and is the whole safety argument: the page escapes every value out of the snapshot and only then
 * calls this, so the input holds no `<` and this adds the only markup in it. Tokenising first and
 * escaping after would escape the spans and leave a `</script>` in a diff live.
 *
 * One line at a time and one pass, which is why a block comment only colours the part of it on this
 * line and why an unterminated string colours nothing: there is no state between rows, and a diff
 * hands you the middle of a file anyway. Deliberately small — this is a viewer, not an editor.
 */
export function highlight(escaped: string, path: string): string {
  // Prose is not code. Colouring "for" and "while" inside a sentence turns a documentation diff into
  // confetti, so a file this does not recognise is shown as it is.
  if (
    !/\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|py|go|rs|rb|java|c|h|cc|cpp|sh|zsh)$/.test(path)
  ) {
    return escaped;
  }
  // `&quot;` is what escaping left of a double quote. Strings come first so a `//` inside one is not
  // read as a comment, and comments come before the rest so code inside one is not coloured twice.
  const token =
    /(&quot;.*?&quot;|'[^']*'|`[^`]*`)|(\/\/.*|\/\*.*?(?:\*\/|$)|^\s*\*.*)|(\b\d[\w.]*)|(\b(?:as|async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|finally|for|from|function|if|implements|import|in|instanceof|interface|let|new|of|private|protected|public|readonly|return|static|super|switch|this|throw|try|type|typeof|var|void|while|yield|null|undefined|true|false)\b)/g;
  return escaped.replace(token, (match, str, comment, num) => {
    const kind =
      str !== undefined ? "s" : comment !== undefined ? "c" : num !== undefined ? "n" : "k";
    return `<span class="${kind}">${match}</span>`;
  });
}
