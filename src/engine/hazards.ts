import type { HazardExtent, HazardTransactionRule, Pack } from "../schema/pack.schema";
import { compareStrings } from "./order";

/**
 * Transaction-hazard detection: which queued dispatches sit lexically inside a database
 * transaction (docs/13-glossary.md). The queue does not roll back with the database, so a worker
 * can run the job before the rows it needs are committed.
 *
 * Nothing here knows a language. Every marker (what opens a transaction, what closes it, what a
 * dispatch looks like, what defers one) comes from the pack's `hazards` block, and this module only
 * counts delimiters and compares offsets, which is the same split engine/mask.ts already makes for
 * comment syntax.
 *
 * **Known blind spot: string literals.** The source arriving here is already comment-masked by the
 * caller, and engine/mask.ts deliberately never masks string contents (mask.ts:12-14), because the
 * `string` edge family and every route path live inside them. So a transaction opener written
 * inside a string literal opens an extent that no database ever opened, and a closing delimiter
 * inside a string can balance a real block early. Both are matters of where a regex hits, which
 * nothing short of a lexer could rule out, so this module reports what the text says and the
 * direction of each failure is recorded on the function it affects.
 *
 * The one face of it that is *not* left standing is the statement boundary: `statementEnd` steps
 * over string literals using the pack's own quote declarations, because a `;` inside an argument
 * would otherwise cut a dispatch's statement short, drop its chained defer marker and report a
 * hazard against code that already waits for the commit. Under-reporting here is a gap and
 * over-reporting is a fabricated finding, and the two are not equally acceptable.
 */

interface CompiledTransactionRule {
  regex: RegExp;
  extent: HazardExtent;
  /** `balanced` only, both set together or the rule was dropped at compile. */
  open: string;
  close: string;
  /** `span` only, null on a `balanced` rule. */
  endRegex: RegExp | null;
}

interface CompiledDispatchRule {
  regex: RegExp;
  job: number;
}

/**
 * The pack's string syntax, carried so a scan can step over a literal instead of reading what is
 * inside it as code. The same three markers engine/mask.ts walks, and empty when the pack declares
 * no comment block at all, which turns every skip below into a no-op.
 */
interface CompiledStrings {
  quotes: string[];
  escape: string | undefined;
  /** The quotes that may hold a raw newline. Undefined means every one of them may. */
  multiline: string[] | undefined;
}

export interface CompiledHazards {
  transactions: CompiledTransactionRule[];
  loops: CompiledTransactionRule[];
  dispatches: CompiledDispatchRule[];
  deferAtSite: RegExp[];
  deferAtDeclaration: RegExp[];
  strings: CompiledStrings;
}

/** One transaction's lexical reach, `[start, end)` in character offsets. */
interface Extent {
  start: number;
  end: number;
}

export interface DispatchSite {
  /** The job as written at the dispatch site, from the rule's `job` group. */
  job: string;
  /** 1-based line of the dispatch. */
  line: number;
  /** 1-based line of the opener of the transaction enclosing it. */
  transactionLine: number;
  /** A deferAtSite pattern matched on this dispatch's own statement. */
  deferredAtSite: boolean;
}

/**
 * A dispatch that sits inside something the pack calls a loop. Deliberately not a `DispatchSite`
 * with a second line on it: a hazard asks whether this dispatch waits for a commit, and a deferral
 * has no meaning here, so carrying `deferredAtSite` would put a field in `graph.json` that no reader
 * of this axis can act on.
 */
export interface LoopedDispatch {
  /** The job as written at the dispatch site, from the rule's `job` group. */
  job: string;
  /** 1-based line of the dispatch. */
  line: number;
  /** 1-based line of the opener of the innermost loop enclosing it. */
  loopLine: number;
}

/**
 * Compiles one pack's hazard rules once. Every regex is built here and never per call, the same
 * contract engine/extractor.ts `compilePack` keeps.
 *
 * Returns null when the pack declares no `hazards` block, meaning this language makes no claim. A
 * present but empty block is not the same answer: it compiles to an object that finds nothing, so a
 * caller can say "this pack looks for them and found none" (schema/types.ts, `Graph.hazards`).
 *
 * A rule missing the companion its `extent` requires is dropped rather than half-applied.
 * src/schema/pack.schema.ts rejects both shapes at load, so this is unreachable through `loadPack`
 * and only guards a hand-built pack in a unit test. Dropping is the safe direction: a `balanced`
 * rule with no delimiter pair would count nothing and enclose the rest of the file, and a `span`
 * rule with no end pattern would run every transaction to the end of the file. Both invent hazards,
 * which is the worse failure here.
 */
export function compileHazards(pack: Pack): CompiledHazards | null {
  const hazards = pack.hazards;
  if (hazards === undefined) return null;

  return {
    transactions: compileExtentRules(hazards.transactions),
    loops: compileExtentRules(hazards.loops),
    dispatches: hazards.dispatches.map((rule) => ({
      regex: new RegExp(rule.pattern, "gm"),
      job: rule.job,
    })),
    // Not global: these are tested against one slice of source, and a `g` regex carries `lastIndex`
    // between calls, so the second identical question would get a different answer.
    deferAtSite: hazards.deferAtSite.map((pattern) => new RegExp(pattern, "m")),
    deferAtDeclaration: hazards.deferAtDeclaration.map((pattern) => new RegExp(pattern, "m")),
    // The pack default, never `commentsByExtension`: this compiles once per pack and the file's
    // path is not in scope by the time a statement is measured. It costs nothing today, because an
    // override exists to change how a file *comments*, and the quote set has been the same in both
    // halves of every pack that declares one. A pack whose two syntaxes really disagree about
    // quotes would need the extension here, which is a signature change and not a silent one.
    strings: {
      quotes: pack.comments?.stringQuotes ?? [],
      escape: pack.comments?.stringEscape,
      multiline: pack.comments?.multilineQuotes,
    },
  };
}

/** The rules that compiled, in order. A rule missing its companion is dropped, see the docstring. */
function compileExtentRules(rules: HazardTransactionRule[]): CompiledTransactionRule[] {
  const compiled: CompiledTransactionRule[] = [];
  for (const rule of rules) {
    const one = compileTransactionRule(rule);
    if (one !== null) compiled.push(one);
  }
  return compiled;
}

function compileTransactionRule(rule: HazardTransactionRule): CompiledTransactionRule | null {
  if (rule.extent === "balanced") {
    if (rule.open === undefined || rule.close === undefined) return null;
    return {
      regex: new RegExp(rule.pattern, "gm"),
      extent: "balanced",
      open: rule.open,
      close: rule.close,
      endRegex: null,
    };
  }
  if (rule.endPattern === undefined) return null;
  return {
    regex: new RegExp(rule.pattern, "gm"),
    extent: "span",
    open: "",
    close: "",
    endRegex: new RegExp(rule.endPattern, "gm"),
  };
}

/**
 * Every dispatch that sits inside a transaction extent. Callers filter on `deferredAtSite`: a
 * deferred dispatch is not a hazard, but it is still a dispatch inside a transaction and the
 * decision of what to report belongs to the caller.
 *
 * `source` must already be comment-masked (see the module docstring). Nothing is masked here.
 *
 * Extents nest and overlap freely, and a dispatch inside any of them is enclosed. When several
 * enclose it, `transactionLine` names the innermost, the one whose opener sits closest above the
 * dispatch, because that is the transaction a reader has to move the dispatch out of.
 *
 * The order is total and deterministic: ascending line, then job through `compareStrings`, then the
 * dispatch's character offset to separate two dispatches of one job on one line. `localeCompare` is
 * banned repo-wide (engine/order.ts).
 */
export function findEnclosedDispatches(compiled: CompiledHazards, source: string): DispatchSite[] {
  return enclosedBy(compiled, source, compiled.transactions).map((found) => ({
    job: found.job,
    line: found.line,
    transactionLine: found.enclosingLine,
    deferredAtSite: deferredAt(compiled, source, found.offset),
  }));
}

/**
 * Every dispatch that sits inside a loop extent: the same walk over a different set of openers.
 *
 * Empty for a pack that declares no `loops`, and empty in exactly the same way for a file whose
 * dispatches all sit outside every loop it holds. Those two are told apart one layer up, by whether
 * the pack declared the block at all, for the reason the hazards axis tells them apart
 * (schema/types.ts, `Graph.hazardsScanned`).
 */
export function findLoopedDispatches(compiled: CompiledHazards, source: string): LoopedDispatch[] {
  return enclosedBy(compiled, source, compiled.loops).map((found) => ({
    job: found.job,
    line: found.line,
    loopLine: found.enclosingLine,
  }));
}

/** One dispatch inside one extent, before either caller names the extent it went looking for. */
interface EnclosedDispatch {
  job: string;
  line: number;
  /** 1-based line of the opener of the innermost extent enclosing the dispatch. */
  enclosingLine: number;
  /** Character offset of the dispatch, which is what a defer marker is measured from. */
  offset: number;
}

function enclosedBy(
  compiled: CompiledHazards,
  source: string,
  rules: CompiledTransactionRule[],
): EnclosedDispatch[] {
  const extents = extentsOf(rules, source);
  if (extents.length === 0) return [];

  const starts = lineStarts(source);
  const seen = new Set<string>();
  const found: EnclosedDispatch[] = [];

  for (const rule of compiled.dispatches) {
    for (const match of matchAll(rule.regex, source)) {
      const enclosing = innermostEnclosing(extents, match.index);
      if (enclosing === null) continue;

      // An optional capture group that did not participate leaves the job unnamed. The site is
      // still reported, because the enclosure is what makes it a hazard and the resolution of a
      // job to a node is the caller's problem (schema/types.ts, `Hazard.target`).
      const job = match.groups[rule.job] ?? "";

      // Two dispatch rules can describe one call site. Joined on a NUL byte, written as an escape
      // and never typed raw, because a job name can hold a space (CLAUDE.md).
      const key = `${match.index}\u0000${job}`;
      if (seen.has(key)) continue;
      seen.add(key);

      found.push({
        job,
        line: lineAt(starts, match.index),
        enclosingLine: lineAt(starts, enclosing.start),
        offset: match.index,
      });
    }
  }

  found.sort((a, b) => a.line - b.line || compareStrings(a.job, b.job) || a.offset - b.offset);
  return found;
}

/**
 * True when this file declares that dispatches of the job it defines wait for the commit, which is
 * the declaration-side half of the deferral question: one marker in the job's own class defers
 * every dispatch of it anywhere.
 *
 * `source` must already be comment-masked, exactly as for `findEnclosedDispatches`.
 */
export function declaresDeferral(compiled: CompiledHazards, source: string): boolean {
  return compiled.deferAtDeclaration.some((regex) => regex.test(source));
}

/**
 * Every extent these rules open in this file, in no particular order because callers ask "does any
 * extent contain this offset" and never read the list.
 */
function extentsOf(rules: CompiledTransactionRule[], source: string): Extent[] {
  const extents: Extent[] = [];
  for (const rule of rules) {
    for (const match of matchAll(rule.regex, source)) {
      const matchEnd = match.index + match.length;
      const end =
        rule.extent === "balanced"
          ? balancedEnd(source, matchEnd, rule.open, rule.close)
          : spanEnd(source, matchEnd, rule.endRegex);
      extents.push({ start: match.index, end });
    }
  }
  return extents;
}

/**
 * The callback form, whether it balances braces around a closure body or parens around an arrow
 * function's call. Exported because a scope's `balanced` extent (engine/extractor.ts) is the same
 * question asked about a different opener: what does this construct enclose. The walk knows nothing
 * of transactions, so the two callers share it rather than each keeping a copy that can drift.
 *
 * From the end of the opener match, find the first `open` delimiter, then walk
 * counting `open` and `close` until the depth returns to zero. The offset just past that balancing
 * `close` ends the extent, so the closing delimiter itself is inside it, which costs nothing: no
 * dispatch pattern starts at a bare delimiter.
 *
 * An extent that never balances, and one whose opener is followed by no `open` delimiter at all,
 * runs to the end of the file. An unclosed transaction is the worse hazard, not a reason to report
 * nothing.
 *
 * Delimiters are counted in the raw text, so one inside a string literal is counted too (see the
 * module docstring). A stray closing delimiter in a string ends the extent early and hides a real
 * hazard; a stray opening one extends it and can invent one.
 */
export function balancedEnd(source: string, from: number, open: string, close: string): number {
  const opened = source.indexOf(open, from);
  if (opened === -1) return source.length;

  let depth = 0;
  let index = opened;
  while (index < source.length) {
    if (source.startsWith(open, index)) {
      depth += 1;
      index += open.length;
      continue;
    }
    if (source.startsWith(close, index)) {
      depth -= 1;
      index += close.length;
      if (depth <= 0) return index;
      continue;
    }
    index += 1;
  }
  return source.length;
}

/**
 * The manual form. The extent runs to the start of the next end-pattern match after the opener, or
 * to the end of the file when none arrives, for the same reason `balancedEnd` runs to the end of
 * the file: an unclosed transaction is the worse hazard.
 */
function spanEnd(source: string, from: number, endRegex: RegExp | null): number {
  if (endRegex === null) return source.length;
  endRegex.lastIndex = from;
  const match = endRegex.exec(source);
  return match === null ? source.length : match.index;
}

/**
 * The enclosing extent whose opener sits closest above `offset`, or null when none contains it.
 * Ties on the opener go to the tighter extent, so the answer is a single deterministic one even
 * when two rules describe the same transaction.
 */
function innermostEnclosing(extents: Extent[], offset: number): Extent | null {
  let best: Extent | null = null;
  for (const extent of extents) {
    if (offset < extent.start || offset >= extent.end) continue;
    if (best === null || extent.start > best.start) {
      best = extent;
      continue;
    }
    if (extent.start === best.start && extent.end < best.end) best = extent;
  }
  return best;
}

/**
 * Did a deferAtSite pattern match on this dispatch's own statement?
 *
 * **The statement is the text from the start of the dispatch match to the first `;` after it that
 * is not inside a string literal, inclusive, or to the end of the dispatch's own line when the rest
 * of the file holds no such `;`.** The terminator is the one piece of punctuation this module
 * assumes, and it is what makes the chained multi-line form work: `dispatch(new Foo)` on one line
 * and `->afterCommit();` on the next are one statement and one dispatch, and a rule that stopped at
 * the end of the line would call that dispatch undeferred and report a hazard that the code already
 * handles. Reading forward to the terminator is also what keeps a defer marker on the *following*
 * statement from counting: it is past the `;` and outside the slice.
 *
 * The end-of-line fallback bounds the damage in a language with no statement terminator, where
 * scanning to the end of the file would let one defer marker anywhere silence every dispatch above
 * it. Such a language should carry its deferral in `deferAtDeclaration` instead, which asks a
 * whole-file question and needs no statement boundary.
 */
function deferredAt(compiled: CompiledHazards, source: string, dispatchStart: number): boolean {
  if (compiled.deferAtSite.length === 0) return false;
  const end = statementEnd(source, dispatchStart, compiled.strings);
  return compiled.deferAtSite.some((regex) => regex.test(source.slice(dispatchStart, end)));
}

/**
 * The first terminator after the dispatch that is really a terminator, skipping over string
 * literals on the way.
 *
 * The skip is what stops `dispatch(new SendMail("hello; world"))->afterCommit();` from ending its
 * statement inside the argument, which would drop the chained defer marker and report a hazard on
 * code that already waits for the commit. That direction is the one this tool may not take:
 * under-reporting is a gap, over-reporting is a fabricated finding, and a fabricated answer is the
 * worst kind there is.
 *
 * The quotes, the escape character and the which-quotes-may-span-a-newline question are all
 * pack-declared (`comments.stringQuotes`, `stringEscape`, `multilineQuotes`), so this stays a walk
 * over markers the engine was handed rather than a language it knows. A pack that declares no
 * comment block, or no quotes, has no string syntax to skip and gets exactly the raw scan it got
 * before: the loop simply never finds a quote to step over.
 */
function statementEnd(source: string, dispatchStart: number, strings: CompiledStrings): number {
  let index = dispatchStart;
  while (index < source.length) {
    if (source.charCodeAt(index) === 59) return index + 1;

    const quote = strings.quotes.find((candidate) => source.startsWith(candidate, index));
    if (quote !== undefined) {
      const past = skipString(source, index, quote, strings);
      index = past ?? index + quote.length;
      continue;
    }
    index += 1;
  }

  const newline = source.indexOf("\n", dispatchStart);
  return newline === -1 ? source.length : newline;
}

/**
 * The index just past the closing quote, or null when the quote never closes: before the end of the
 * file, or before the end of the line when this quote may not span one.
 *
 * Repeated from engine/mask.ts rather than imported, because `skipString` is private there and this
 * module owns neither that file nor the decision to widen its surface. The semantics are copied
 * deliberately, including the null: a quote whose closer never arrives was never an opener, so the
 * caller steps over one character instead of treating the rest of the file as a string. Any change
 * to the masker's rule should be mirrored here, and the tests below pin the shared behaviour.
 */
function skipString(
  source: string,
  start: number,
  quote: string,
  strings: CompiledStrings,
): number | null {
  const mayHoldNewline = strings.multiline === undefined || strings.multiline.includes(quote);
  const escapeChar = strings.escape;
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

interface Match {
  groups: (string | undefined)[];
  index: number;
  /** The whole match's length, so a caller can find where it ended. */
  length: number;
}

/**
 * The same generator engine/extractor.ts uses, repeated rather than imported because it is private
 * there. `lastIndex` is reset on entry: a compiled regex is reused across files and a leftover
 * index would make the second file's answer depend on the first one's, which determinism forbids.
 */
function* matchAll(regex: RegExp, source: string): Generator<Match> {
  regex.lastIndex = 0;
  let match = regex.exec(source);
  while (match !== null) {
    yield { groups: [...match], index: match.index, length: match[0].length };
    // A pattern that can match empty would spin forever otherwise.
    if (match[0].length === 0) regex.lastIndex += 1;
    match = regex.exec(source);
  }
}

/**
 * Offsets of the first character of every line. Written out rather than imported because
 * engine/extractor.ts keeps its copy private; the semantics are identical, so a line number from
 * either module means the same thing.
 */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line holding `index`. */
function lineAt(starts: number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}
