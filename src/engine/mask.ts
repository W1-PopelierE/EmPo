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
 * newlines and every line number computed downstream stays correct.
 *
 * String literals are tracked always and blanked only when `maskStrings` asks for it, because the
 * two answers are both right and only the rule knows which it needs. Most rules must read string
 * contents: the `string` edge family is a class name inside quotes, php's `@livewire('cart')` is a
 * component name inside quotes, and every route path a `consumes` rule reads lives inside one. A
 * JSX tag rule needs the opposite, because `const tip = "<Button />"` in a `.tsx` file is prose
 * about a component and not a rendering of it, and nothing about the text tells the two apart
 * (docs/04-language-packs.md section 4). So the caller asks, per rule.
 *
 * Only the **contents** are blanked; the quote characters stay, so a rule reading `<Button
 * title="hi" />` still sees a tag with a well-formed attribute rather than a truncated one.
 */
export function maskComments(
  source: string,
  syntax: CommentSyntax | undefined,
  maskStrings = false,
): string {
  if (syntax === undefined) return source;

  const line = syntax.line ?? [];
  const block = syntax.block ?? [];
  const quotes = syntax.stringQuotes ?? [];
  const escapeChar = syntax.stringEscape;
  const multiline = syntax.multilineQuotes;
  // Nothing to blank and nothing asked for: the walk could only return the source it was given.
  // The `maskStrings` clause is why this is not just the comment test. An embedded template
  // language declares no comment pair of its own and still declares quotes (docs/04 section 3), and
  // a rule over such a file that asked not to read strings would otherwise be answered with the raw
  // source and no sign that its request had been dropped.
  if (line.length === 0 && block.length === 0 && !(maskStrings && quotes.length > 0)) return source;

  // Split, not spread. A spread iterates code points, so an astral character is one element for the
  // two UTF-16 units every offset in this file counts in, and `blank` writes with those offsets: the
  // emoji in a string literal would be overwritten as one space and the character after it eaten,
  // leaving the masked view a unit shorter than the source. Nothing here may change length, because
  // a caller reads the two views at one offset — engine/extractor.ts matches a scope over the view
  // that keeps its strings and counts the extent's delimiters over the view that does not.
  const out = source.split("");
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
      if (end === null) {
        index += quote.length;
        continue;
      }
      // The contents, not the quotes: `end` is past the closer and `index` is at the opener, so the
      // two delimiters are left standing and everything between them goes. A closer this masker
      // could not find means the character was never an opener, and blanking on that guess would
      // delete real code, so the branch above steps over it instead.
      if (maskStrings) blank(out, source, index + quote.length, end - quote.length);
      index = end;
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
