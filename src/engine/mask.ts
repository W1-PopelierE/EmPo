import type { CommentSyntax } from "../schema/types";

/**
 * Blanks out comments before any pack rule sees the source.
 *
 * Regex-over-source cannot tell code from a comment quoting code, and a real codebase is full of
 * commented-out routes and "the old code called \Acme\Models\Payment::create() here" notes. Left
 * in, those become phantom edges and phantom produced symbols, which is worse than a missing edge:
 * a phantom route becomes a phantom bridge edge in phase 2, so `empo query` would report a screen
 * coupled to a route that does not exist.
 *
 * Comments are replaced by spaces rather than removed, so the string keeps its length and its
 * newlines and every line number computed downstream stays correct. String literals are tracked
 * but never masked: the `string` edge family and every route path live inside them.
 */
export function maskComments(source: string, syntax: CommentSyntax | undefined): string {
  if (syntax === undefined) return source;

  const line = syntax.line ?? [];
  const block = syntax.block ?? [];
  const quotes = syntax.stringQuotes ?? [];
  const escapeChar = syntax.stringEscape;
  const multiline = syntax.multilineQuotes;
  if (line.length === 0 && block.length === 0) return source;

  const out = [...source];
  let index = 0;

  while (index < source.length) {
    const quote = quotes.find((candidate) => source.startsWith(candidate, index));
    if (quote !== undefined) {
      // A quote whose closer never arrives was never an opener: an unterminated string literal is
      // a syntax error in every language a pack can describe, so the character was punctuation in
      // something this masker does not model. Skipping to the end of the file on it is the worst
      // outcome available, because from there nothing is masked at all and every commented-out
      // import in the rest of the file becomes an edge. Stepping over the one character instead
      // costs nothing when the guess was wrong and saves the whole file when it was right.
      const end = skipString(source, index, quote, escapeChar, spansLines(multiline, quote));
      index = end ?? index + quote.length;
      continue;
    }

    const blockPair = block.find(([open]) => source.startsWith(open, index));
    if (blockPair !== undefined) {
      const [open, close] = blockPair;
      const end = source.indexOf(close, index + open.length);
      const stop = end === -1 ? source.length : end + close.length;
      blank(out, source, index, stop);
      index = stop;
      continue;
    }

    if (line.some((marker) => source.startsWith(marker, index))) {
      const newline = source.indexOf("\n", index);
      const stop = newline === -1 ? source.length : newline;
      blank(out, source, index, stop);
      index = stop;
      continue;
    }

    index += 1;
  }

  return out.join("");
}

/**
 * Which quotes may hold a raw newline. A pack that declares nothing says every one of them may,
 * which is what PHP means and what this masker has always assumed.
 *
 * It is declared rather than assumed because the two answers are both real and the engine cannot
 * pick one: PHP's `'...'` spans lines legally, while JavaScript's `'...'` and `"..."` may not and
 * only its backtick may. That difference is a language's, so it belongs in the pack
 * (docs/04-language-packs.md), the same argument that made `indexNames` a declaration.
 *
 * It matters most in a file whose language is not the only one in it. A Vue SFC's `<template>` is
 * HTML, where an apostrophe in "the customer's currency" is prose and not a quote, and reading it
 * as one desynchronizes every string boundary after it: the next real `'./money'` closes the
 * apostrophe instead of opening a string, and from there the `<!-- -->` around a commented-out
 * import is inside a "string" and is never blanked. That is a false edge citing a comment, which is
 * the failure the mask exists to prevent.
 */
function spansLines(multiline: string[] | undefined, quote: string): boolean {
  return multiline === undefined || multiline.includes(quote);
}

/**
 * Returns the index just past the closing quote, or null when the quote never closes: before the
 * end of the file, or before the end of the line when this quote may not span one. Null means the
 * caller should treat the character as ordinary rather than as a string it must skip over.
 */
function skipString(
  source: string,
  start: number,
  quote: string,
  escapeChar: string | undefined,
  mayHoldNewline: boolean,
): number | null {
  let index = start + quote.length;
  while (index < source.length) {
    if (!mayHoldNewline && source.charCodeAt(index) === 10) return null;
    if (escapeChar !== undefined && source.startsWith(escapeChar, index)) {
      index += escapeChar.length + 1;
      continue;
    }
    if (source.startsWith(quote, index)) return index + quote.length;
    index += 1;
  }
  return null;
}

/** Overwrite a range with spaces, keeping newlines so line numbers do not shift. */
function blank(out: string[], source: string, start: number, stop: number): void {
  for (let i = start; i < stop; i += 1) {
    if (source[i] !== "\n") out[i] = " ";
  }
}
