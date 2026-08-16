import { posix } from "node:path";
import picomatch from "picomatch";
import { configError } from "../errors";
import { normalizeRepoPath } from "../schema/config.schema";
import type {
  CommentSyntax,
  Normalizer,
  Pack,
  ResolveStrategy,
  ScopeRule,
  SymbolRule,
} from "../schema/pack.schema";
import type { EdgeKind, SymbolRef } from "../schema/types";
import {
  balancedEnd,
  type CompiledHazards,
  compileHazards,
  type DispatchSite,
  declaresDeferral,
  findEnclosedDispatches,
  findLoopedDispatches,
  type LoopedDispatch,
} from "./hazards";
import { maskComments } from "./mask";
import { compareStrings } from "./order";
import type { ScannedFile } from "./scanner";

/**
 * Applies one pack's rules to one file. Knows nothing about any language: everything specific
 * comes from the pack (docs/04-language-packs.md). Patterns are compiled once per pack.
 */

export type EdgeFamily = Exclude<EdgeKind, "bridge">;

const EDGE_FAMILIES: EdgeFamily[] = ["import", "fqcn", "string", "template", "hook"];

/** A raw regex hit, before it is resolved into a node id. */
export interface Capture {
  family: EdgeFamily;
  resolve: ResolveStrategy;
  /** Capture groups, 1-based as in the pattern. Index 0 is the whole match. */
  groups: (string | undefined)[];
  line: number;
  /** The rule's `targetKinds`, carried to the resolver, which is where a node's kind is known. */
  targetKinds?: string[];
  /**
   * The nodes this belongs to, for a pack whose file yields more than one. Absent where the file
   * yields a single node, which is every file of a `fqcn` or `module-path` pack: "all of them" and
   * "the only one" are the same answer there, and writing it out would put a node id in `graph.json`
   * for every capture of every pack that never asked for one.
   */
  owners?: string[];
}

/** One exported symbol of one file, and the lines a `symbol`-strategy pack reads as belonging to it. */
export interface ExtractedSymbol {
  /** The exported name, group 1 of the pack's symbolPattern. */
  name: string;
  /** `<repo-relative file>#<name>`. */
  id: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. Runs to the last line of the file for the final symbol. */
  endLine: number;
}

export interface ExtractedFile {
  file: string;
  root: string;
  lang: string;
  id: string;
  name: string;
  kind: string;
  isTest: boolean;
  assertsValue: boolean;
  produces: SymbolRef[];
  consumes: SymbolRef[];
  captures: Capture[];
  /**
   * The exports this file was partitioned into. Empty for every pack that declares no
   * `symbolPattern`, which is every pack whose strategy is not `symbol`, and empty too for a file
   * of such a pack in which the pattern found nothing: that file keeps the single node its path
   * already named.
   */
  symbols: ExtractedSymbol[];
  /**
   * Names this file declares itself, from the pack's `declares` patterns. Empty for a pack that
   * declares none, which is every pack before the field existed.
   *
   * It is a property of the file rather than of a capture because that is the question it answers:
   * a name-resolving strategy asks the root's index who carries a name, and the one place that never
   * gets asked is the file doing the asking. See resolveName in engine/resolver.ts.
   */
  declares: string[];
  /**
   * Jobs this file dispatches from inside a transaction, unresolved: the job is still the name as
   * written at the call site. Turning that name into a node id needs the whole root's index, which
   * one file's extraction does not have (engine/build.ts does it).
   */
  dispatches: DispatchSite[];
  /**
   * Jobs this file dispatches from inside a loop, unresolved for the reason `dispatches` is. The two
   * lists overlap freely: a dispatch inside a loop inside a transaction is on both, and it is two
   * facts about one line rather than one fact counted twice.
   */
  loopDispatches: LoopedDispatch[];
  /**
   * This file declares that dispatching it waits for the commit, so a dispatch of the job it
   * declares is not a hazard wherever it was written. Read here and applied in engine/build.ts,
   * because it is a fact about the dispatched file and the dispatching file is a different one.
   */
  defersCommit: boolean;
}

interface CompiledEdgeRule {
  family: EdgeFamily;
  resolve: ResolveStrategy;
  regex: RegExp;
  /** Applied to each capture group before the strategy reads it. Empty for most rules. */
  normalize: Normalizer[];
  /** Undefined where the rule declares no `pathGlob`, which means it runs over every file. */
  matchesPath?: (relPath: string) => boolean;
  targetKinds?: string[];
  /** True where the rule reads the view with string contents blanked. See src/engine/mask.ts. */
  maskStrings: boolean;
}

interface CompiledSymbolRule {
  rule: SymbolRule;
  regex: RegExp;
  parts: string[];
  /** True when the regex runs over the file's path rather than its source (a `pathPattern` rule). */
  overPath: boolean;
}

interface CompiledScopeRule {
  rule: ScopeRule;
  regex: RegExp;
}

interface CompiledKindRule {
  kind: string;
  matchesPath?: (path: string) => boolean;
  contentRegex?: RegExp;
  /** True where `contentRegex` reads the view with string contents blanked. See src/engine/mask.ts. */
  maskStrings: boolean;
}

export interface CompiledPack {
  pack: Pack;
  namespaceRegex?: RegExp;
  nameRegex?: RegExp;
  /** Undefined for every pack declaring no `symbolPattern`, which is every non-`symbol` strategy. */
  symbolRegex?: RegExp;
  kindRules: CompiledKindRule[];
  edgeRules: CompiledEdgeRule[];
  produces: CompiledSymbolRule[];
  consumes: CompiledSymbolRule[];
  /** Empty where the pack declares no scopes block, which is what every pack said before it existed. */
  scopes: CompiledScopeRule[];
  /** The pack's `declares` patterns. Empty where the pack declares none. */
  declares: RegExp[];
  testPaths: ((relPath: string) => boolean)[];
  /** null when the pack declares no hazards block at all, which is not the same as declaring none. */
  hazards: CompiledHazards | null;
}

export function compilePack(pack: Pack): CompiledPack {
  refuseIncompleteIdStrategy(pack);

  const edgeRules: CompiledEdgeRule[] = [];
  for (const family of EDGE_FAMILIES) {
    for (const rule of pack.edges[family] ?? []) {
      edgeRules.push({
        family,
        resolve: rule.resolve,
        regex: new RegExp(rule.pattern, "gm"),
        normalize: rule.normalize ?? [],
        matchesPath: rule.pathGlob ? picomatch(rule.pathGlob) : undefined,
        targetKinds: rule.targetKinds,
        maskStrings: rule.maskStrings === true,
      });
    }
  }

  return {
    pack,
    namespaceRegex: optionalRegex(pack.node.id.namespacePattern),
    nameRegex: optionalRegex(pack.node.id.namePattern),
    // Global, unlike the two above: those find the one class a file declares, this one finds every
    // export in it, and a pattern without `g` would find the first and stop.
    symbolRegex: optionalRegex(pack.node.id.symbolPattern, "gm"),
    kindRules: pack.node.kindRules.map((rule) => ({
      kind: rule.kind,
      matchesPath: rule.pathGlob ? picomatch(rule.pathGlob) : undefined,
      contentRegex: optionalRegex(rule.contentPattern),
      maskStrings: rule.maskStrings === true,
    })),
    edgeRules,
    produces: pack.produces.map(compileSymbolRule),
    consumes: pack.consumes.map(compileSymbolRule),
    // Global and multiline for the same reason every other source pattern here is: a file holds
    // many groups, and a pattern without `g` would find the first and stop.
    scopes: (pack.scopes ?? []).map((rule) => ({ rule, regex: new RegExp(rule.pattern, "gm") })),
    declares: (pack.declares ?? []).map((pattern) => new RegExp(pattern, "gm")),
    testPaths: pack.tests.paths.map(compileTestPath),
    hazards: compileHazards(pack),
  };
}

/**
 * A pack naming `symbol` must also say how a symbol is found, because that strategy is the only one
 * whose ids are not derivable from what the engine already reads: `fqcn` reads one class declaration
 * and `module-path` reads the path. Without a pattern the pack has named a granularity and handed
 * the engine no way to reach it, and the honest answer is to refuse the pack rather than to fall back
 * to the file-level node the other two strategies produce, which would answer every later question
 * about that root with ids the pack did not ask for.
 *
 * What the refusal owes a pack author is the truth on time. It is raised at compile time, once,
 * before a single file is read, and it names the pack that asked. Raising it per scanned file
 * instead, as an earlier refusal here did, made it a fact about a file rather than about the pack:
 * the message named no pack, so a monorepo with four roots reported a strategy nobody could tell
 * which pack had declared, and a pack whose extensions matched no file at all was compiled, indexed
 * and reported as a success while its id strategy was never reached.
 */
function refuseIncompleteIdStrategy(pack: Pack): void {
  if (pack.node.id.strategy !== "symbol") return;
  if (pack.node.id.symbolPattern !== undefined) return;
  throw configError(`node id strategy "symbol" needs a symbolPattern`, [
    `The "${pack.name}" pack declares the strategy and no pattern to find a symbol by.`,
    "symbolPattern is a regex over the file's source whose group 1 is the exported name.",
    "See docs/04-language-packs.md, section 2.",
  ]);
}

/**
 * A `tests.paths` entry is a directory prefix ("tests/") or a glob ("**\/*.test.ts"), because the
 * two conventions are both real: PHP puts its tests in one tree, TypeScript colocates them next to
 * the file under test. Anything holding a glob character is a glob, everything else is a prefix,
 * which leaves a pack that only listed directories behaving exactly as before.
 */
export function compileTestPath(entry: string): (relPath: string) => boolean {
  if (/[*?[\]{}!]/.test(entry)) {
    const matches = picomatch(entry);
    return (relPath) => matches(relPath);
  }
  const prefix = entry.endsWith("/") ? entry : `${entry}/`;
  return (relPath) => relPath.startsWith(prefix);
}

/**
 * Returns null when the file yields no node, in which case its captures are dropped too.
 *
 * `fileScopes` is what some *other* file said about this one (`collectFileScopes`), scope name to
 * the values it contributes, outermost first. Absent is the ordinary case and means the same as
 * empty: nothing outside this file claims to enclose it.
 */
export function extractFile(
  compiled: CompiledPack,
  scanned: ScannedFile,
  fileScopes: ReadonlyMap<string, string[]> = new Map(),
): ExtractedFile | null {
  // Every rule reads the masked source, never the raw one. A commented-out route is not a route,
  // and a class name inside a block comment is not a coupling (engine/mask.ts). The syntax is
  // chosen by extension, because a pack of one language can hold two: a Vue SFC's html template
  // and its TypeScript script comment differently, and the `.ts` files must not carry the html
  // pair (docs/04-language-packs.md).
  const syntax = commentSyntaxFor(compiled.pack, scanned.relPath);
  const source = maskComments(scanned.source, syntax);

  const identity = identify(compiled, source, scanned);
  if (identity === null) return null;

  // The second view, for rules that declared `maskStrings`: the same source with string contents
  // blanked too. Built once per file and only where a rule asked, because most packs have no such
  // rule and would pay a second pass over every file for a view nothing reads.
  //
  // Blanking preserves length and newlines exactly as comment masking does, so the two views share
  // one `lineStarts` and a capture from either cites the same line a reader will find in the file.
  const codeOnly = wantsCodeOnly(compiled) ? maskComments(scanned.source, syntax, true) : source;

  const starts = lineStarts(source);
  // The string-blanked view, never the one that still holds string contents. A template literal in
  // a code generator or a test fixture writes whole declarations inside quotes, and read from the
  // other view each of those opens an extent and takes a node id in `graph.json` off text that
  // declares nothing. The export whose body wrote the string then ends at the quote, so every import
  // its real body needs is attributed to the string instead of to it, which is the under-attribution
  // this partition exists to avoid.
  const symbols = extractSymbolExtents(compiled.symbolRegex, codeOnly, scanned.file, starts);
  const isTest = compiled.testPaths.some((matches) => matches(scanned.relPath));
  // Built once, over the same masked view every rule below reads, so a name written inside a
  // commented-out line is not evidence that an export needs an import.
  const ownersAt = ownerAttributor(symbols, source);
  // The same masked view every rule below reads: a route group inside a commented-out block encloses
  // nothing, and neither does the route inside it.
  const scopesAt = scopeAttributor(compiled.scopes, source, codeOnly, fileScopes);

  return {
    file: scanned.file,
    root: scanned.root,
    lang: scanned.lang,
    id: identity.id,
    name: identity.name,
    kind: kindOf(compiled, source, codeOnly, scanned.relPath),
    isTest,
    assertsValue: isTest && assertsValue(compiled.pack, source),
    produces: extractSymbols(
      compiled.produces,
      source,
      scanned.relPath,
      starts,
      ownersAt,
      scopesAt,
    ),
    consumes: extractSymbols(
      compiled.consumes,
      source,
      scanned.relPath,
      starts,
      ownersAt,
      scopesAt,
    ),
    captures: extractCaptures(
      compiled.edgeRules,
      source,
      codeOnly,
      scanned.relPath,
      starts,
      ownersAt,
    ),
    symbols,
    // Read from the string-blanked view where the pack asked any rule for one, on the same argument
    // the tag rules make: a name inside a quoted example is prose about a declaration, not one.
    declares: declaredNames(compiled.declares, codeOnly),
    // The masked source, like every other rule: a dispatch inside a commented-out block is not a
    // dispatch, and a pack whose rules read the raw text would report hazards nobody can run.
    dispatches: compiled.hazards === null ? [] : findEnclosedDispatches(compiled.hazards, source),
    loopDispatches: compiled.hazards === null ? [] : findLoopedDispatches(compiled.hazards, source),
    defersCommit: compiled.hazards !== null && declaresDeferral(compiled.hazards, source),
  };
}

/**
 * The comment syntax for one file: the per-extension override when the pack declares one this
 * file's name ends in, otherwise the pack default. Read from the basename of `relPath` so the
 * suffix is the file's own and not something a directory above it happened to end in.
 *
 * The match is the **longest declared dotted suffix**, not `posix.extname`. A compound extension is
 * a real thing (`card.blade.php`, `main.d.ts`, `styles.module.css`), and `extname` answers `.php`
 * for the first of them, so a `".blade.php"` key could never be selected and a pack declaring one
 * would be masked as plain PHP: every `{{-- --}}` unrecognized, and the first rule that fires
 * inside commented-out template text becomes an edge citing a comment. Longest wins so a pack may
 * declare `.php` and `.blade.php` side by side and the more specific one takes the file.
 *
 * Comparing suffixes rather than parsing them is what keeps this language-agnostic, and the leading
 * dot in each key is what makes it safe: `foo.mts` does not end in `".ts"`, and `x.notblade.php`
 * does not end in `".blade.php"`, so a key can never claim a file whose extension merely ends in
 * the same letters.
 */
function commentSyntaxFor(pack: Pack, relPath: string): CommentSyntax | undefined {
  const byExtension = pack.commentsByExtension;
  if (byExtension !== undefined) {
    const base = posix.basename(relPath);
    let best: string | undefined;
    for (const suffix of Object.keys(byExtension)) {
      if (suffix.length >= base.length || !base.endsWith(suffix)) continue;
      if (best === undefined || suffix.length > best.length) best = suffix;
    }
    if (best !== undefined) return byExtension[best];
  }
  return pack.comments;
}

function identify(
  compiled: CompiledPack,
  source: string,
  scanned: ScannedFile,
): { id: string; name: string } | null {
  const { strategy, fallback } = compiled.pack.node.id;

  // Repo-relative, not root-relative. Root-relative ids collide the moment a monorepo holds two
  // roots of one language (both have a src/index.ts), and an import that crosses a root
  // ("../../packages/ui/src/Button") only resolves against repo-relative ids. See docs/05.
  // `symbol` answers the same way, and it is not a placeholder: this is the file's own identity,
  // which is what a file the pack's pattern found no export in keeps, and it is the path every
  // symbol id of the file is built on. The per-symbol ids live in `symbols` rather than here,
  // because a file yields a list of them and this function answers with one node.
  if (strategy === "module-path" || strategy === "symbol") {
    return { id: scanned.file, name: baseName(scanned.relPath) };
  }

  // Only `fqcn` is left, the two arms above having taken the path-shaped strategies.
  const name = firstCapture(compiled.nameRegex, source);
  if (name !== null) {
    const namespace = firstCapture(compiled.namespaceRegex, source);
    return { id: namespace ? `${namespace}\\${name}` : name, name };
  }

  // A file with no class declaration (a route file, a script) is still a node when the pack
  // asks for it, identified by its path. Repo-relative for the same reason as above: one rule for
  // every path-shaped id, so two roots can never claim one.
  if (fallback === "path") {
    return { id: scanned.file, name: baseName(scanned.relPath) };
  }
  return null;
}

/**
 * First rule whose path glob and content pattern both pass. `codeOnly` is the view with string
 * contents blanked, read by a rule that declared `maskStrings` and by no other, so a `.tsx` holding
 * `"<div />"` and nothing rendered is not labelled a component off its own prose. Both views are the
 * same length, so which one a rule read never reaches a citation.
 */
function kindOf(compiled: CompiledPack, source: string, codeOnly: string, relPath: string): string {
  for (const rule of compiled.kindRules) {
    if (rule.matchesPath && !rule.matchesPath(relPath)) continue;
    if (rule.contentRegex && !rule.contentRegex.test(rule.maskStrings ? codeOnly : source))
      continue;
    return rule.kind;
  }
  return "unknown";
}

/**
 * Whether this pack needs the second, string-blanked view built at all. Most packs have no rule that
 * asks, and they must not pay a second pass over every file for a view nothing reads.
 */
function wantsCodeOnly(compiled: CompiledPack): boolean {
  return (
    compiled.edgeRules.some((rule) => rule.maskStrings) ||
    compiled.kindRules.some((rule) => rule.maskStrings) ||
    // `declares` reads this view unconditionally, so a pack declaring it and no `maskStrings` rule
    // would otherwise read the raw source: `"const Badge = ..."` inside a string would declare
    // `Badge` locally and suppress a real edge the tag rules resolve.
    compiled.declares.length > 0 ||
    // The symbol partition reads it unconditionally too, and it makes the same mistake one level
    // worse: `declares` reading a string invents a local name that suppresses an edge, while the
    // partition reading one invents a node id and writes it into `graph.json`, then hands that
    // invented node the imports the export whose body held the string actually needed.
    compiled.symbolRegex !== undefined ||
    // A `balanced` scope counts its delimiters here rather than in the raw source, because a scope's
    // reach is the one thing a *typo inside an unrelated string* can silently shorten. Measured: a
    // Laravel route file wrote `Route::post('bookings/{booking}/print}', …)`, one stray brace in a
    // URL, and the group prefix stopped applying 60 routes early — every route below it came out
    // with a key that is short by a segment and looks exactly like a route. The value the scope
    // contributes is still captured from the view that has its strings, since `'prefix' => 'api'`
    // is a string literal; only the counting moves, and both views share every offset.
    compiled.scopes.some((rule) => rule.rule.extent === "balanced")
  );
}

/**
 * Does this test assert on a value, or does it only run the code? A plain substring match on the
 * masked source, because assertionTerms are tokens (`assertSame`, `->toBe(`), not patterns. This is
 * the input to the blind-flow computation in engine/coverage.ts.
 *
 * `assertionExcludes` is subtracted first, and it exists because one term can be both answers. A
 * substring cannot see the argument, and `assertTrue($order->isPaid())` and
 * `assertTrue(method_exists($c, 'confirm'))` differ only there. Dropping the term loses every real
 * value assertion written with it; keeping it unqualified re-admits the liveness family that
 * docs/04 defines this field to exclude, which is how `->assertStatus` scored 14 of 15 test files
 * as asserting. Naming the liveness spelling is the only form that keeps both
 * answers right.
 *
 * The exclusions are removed rather than matched around, so a term inside one cannot be reached by
 * any later term either. That is deliberate: `assertTrue(method_exists(...))` must not qualify
 * through some other term that happens to sit inside the same call.
 */
function assertsValue(pack: Pack, source: string): boolean {
  const readable = pack.tests.assertionExcludes.reduce(
    (text, exclusion) => (exclusion === "" ? text : text.split(exclusion).join("")),
    source,
  );
  return pack.tests.assertionTerms.some((term) => readable.includes(term));
}

/**
 * Every name the pack's `declares` patterns find in one file, sorted and without duplicates so two
 * runs over the same bytes write the same `graph.json`.
 *
 * A pattern that matches and captures nothing contributes nothing: a pack's own bug is not a
 * declaration, and admitting the empty string here would make every name-resolving strategy in that
 * pack refuse every name it read.
 */
function declaredNames(patterns: RegExp[], source: string): string[] {
  const names = new Set<string>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined && name !== "") names.add(name);
    }
  }
  return [...names].sort(compareStrings);
}

/**
 * The symbols one file exports, each holding the lines from its own declaration to the line before
 * the next one. A file is partitioned rather than parsed, which is the whole bargain of this engine:
 * every rule in it is a regex over masked text, and a real scope tree would need a parser per
 * language, which is the thing a language-agnostic pack contract exists to avoid.
 *
 * What makes the partition safe enough to answer with is the pack's pattern, not this function. A
 * pattern anchored at `^` matches only a declaration written at column 0, and every language this
 * strategy suits indents a nested declaration, so a function declared inside another function does
 * not open an extent of its own. That is a real ceiling and it is stated in docs/04-language-packs.md
 * rather than hidden here: text between two exports belongs to the earlier one, so a helper written
 * at column 0 between two exports is read as part of the export above it.
 *
 * Every match opens an extent, including a repeat of a name already seen, so one id can own several
 * disjoint runs of lines. That is what declaration merging is: TypeScript writes a type and a
 * function under one name, an interface beside a function, a `declare module` beside the value it
 * describes, and all of them are ordinary rather than exotic. Skipping the repeat opened no boundary
 * at that line, so everything the second declaration wrote fell inside the extent of whatever
 * happened to be declared above it, and every import that second body needed was credited to that
 * neighbour while the name itself got none. That is under-attribution, which the flow list being a
 * floor does not permit.
 *
 * The duplicate the partition now admits is handled where the nodes are made rather than here: a
 * file must still yield one node per unique id (`symbolNodes` below, read by engine/build.ts and
 * engine/resolver.ts). Partitioning text and naming nodes are two questions, and this one is only
 * asking which lines belong to which name.
 *
 * ponytail: line partition, no brace balancing. Upgrade to hazards.ts's enclosure walk if a pack
 * appears whose declarations are not written at column 0.
 */
function extractSymbolExtents(
  regex: RegExp | undefined,
  source: string,
  file: string,
  starts: number[],
): ExtractedSymbol[] {
  if (regex === undefined) return [];

  const found: { name: string; startLine: number }[] = [];
  for (const match of matchAll(regex, source)) {
    const name = match.groups[1];
    // A pattern that matches and captures nothing is the pack's own bug and not a declaration, the
    // same bargain `declaredNames` makes above.
    if (name === undefined || name === "") continue;
    found.push({ name, startLine: lineAt(starts, match.index) });
  }

  const lastLine = starts.length;
  return found.map((entry, position) => ({
    name: entry.name,
    id: `${file}#${entry.name}`,
    startLine: entry.startLine,
    endLine: (found[position + 1]?.startLine ?? lastLine + 1) - 1,
  }));
}

/**
 * The nodes one file's extents yield: one per unique id, in the order the file first declares each
 * name. A name declared twice owns two extents and is still one export, so it is one node.
 *
 * It lives here, beside the partition that can produce the repeat, and is read by both places that
 * turn extents into nodes: `toNodes` in engine/build.ts and `buildNodeIndex` in engine/resolver.ts.
 * Those two must agree, because one builds the graph and the other builds the index the edges are
 * resolved against, and a file yielding two nodes of one id in one of them and one in the other is a
 * disagreement nothing would report.
 */
export function symbolNodes(symbols: ExtractedSymbol[]): { id: string; name: string }[] {
  const byId = new Map<string, { id: string; name: string }>();
  for (const symbol of symbols) {
    if (!byId.has(symbol.id)) byId.set(symbol.id, { id: symbol.id, name: symbol.name });
  }
  return [...byId.values()];
}

/**
 * Whether a statement is a side-effect import, which binds no name at all.
 *
 * Its specifier is the whole statement, so anything read out of it is whatever the path happens to
 * spell: `import "@mui/material/Button/Button.css"` writes `Button` twice and means neither of them
 * as a binding. Both callers need exactly this and would otherwise each carry the regex and the
 * argument for it: extraction asks which exports a statement can be attributed to, and the
 * resolver's fold asks whether a statement corroborates one name (engine/resolver.ts). A dynamic
 * `import("@calcom/…/AlbyPriceComponent")` is deliberately not this shape, because it holds the
 * parens and the name in its specifier is the file the line means.
 */
export function isSideEffectImport(statement: string): boolean {
  return /^[ \t]*import\s*(['"`])[^'"`]*\1[ \t]*;?[ \t]*$/.test(statement);
}

/**
 * The names an import statement binds, read out of the clause and never out of the specifier. A
 * renamed binding binds the new name and not the old one, because the new name is what the rest of
 * the file writes.
 *
 * It is looser than it looks and can afford to be. Both readers intersect what it returns against
 * something the repository already knows to be real, the exports the target file declares or the
 * names the symbols of this file reference, so a word the clause happens to hold that binds nothing
 * matches nothing and drops out. What it must never do is miss a real binding, which is why the
 * keyword list subtracts rather than the pattern trying to describe every import shape a language
 * writes.
 */
export function boundNames(statement: string): string[] {
  if (isSideEffectImport(statement)) return [];
  const clause = statement.slice(0, statement.search(/\bfrom\b|$/));
  const names = new Set<string>();
  for (const match of clause.matchAll(
    /([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?/g,
  )) {
    const bound = match[2] ?? match[1];
    if (bound !== undefined && !RESERVED_CLAUSE_WORDS.has(bound)) names.add(bound);
  }
  return [...names].sort(compareStrings);
}

const RESERVED_CLAUSE_WORDS = new Set([
  "import",
  "export",
  "type",
  "as",
  "from",
  "require",
  "const",
]);

/**
 * Which symbols own a line, for one file, or undefined throughout where the file yields a single
 * node and the question does not arise.
 *
 * The enclosing extent answers it wherever there is one. An import has none: imports are written
 * above every declaration in the file, so no extent encloses them, and attributing them to the first
 * symbol or to all of them are both wrong in the direction that matters. The first invents a
 * dependency, and all of them is the file-level answer this strategy exists to stop giving. A
 * reference to a name the statement binds, inside an extent, is the evidence that that symbol needs
 * what the line brought in.
 *
 * Falling back to every symbol when nothing references the binding is deliberate. A side-effect
 * import binds no name at all, and a binding used by nothing is either dead or reached in a way this
 * engine cannot see, a re-export or a type position stripped before it is read. Both are cases where
 * the honest answer is that any export of the file may depend on it, and the closing line of every
 * report already says the flow list is a floor.
 *
 * Owners come back in the order the file declares its exports, not sorted. That is deterministic,
 * which is what `graph.json` needs, and it is the order a reader of the file already has.
 *
 * The extent texts are cut once per file rather than once per question, because the alternative is a
 * split of the whole source per capture per symbol per bound name, which is quadratic in the size of
 * the file for no answer that changes.
 */
function ownerAttributor(
  symbols: ExtractedSymbol[],
  source: string,
): (line: number, statement: string) => string[] | undefined {
  if (symbols.length === 0) return () => undefined;

  // Keyed by id and not by extent, because one name can own several of them (declaration merging,
  // see `extractSymbolExtents`). Its text is all of them joined, so a reference in any extent of a
  // name is a reference by that name: the alternative keeps only one extent per key and loses
  // whichever half of a merged declaration wrote the reference.
  const lines = source.split("\n");
  const extentText = new Map<string, string>();
  for (const symbol of symbols) {
    const text = lines.slice(symbol.startLine - 1, symbol.endLine).join("\n");
    const already = extentText.get(symbol.id);
    extentText.set(symbol.id, already === undefined ? text : `${already}\n${text}`);
  }
  const everyId = [...extentText.keys()];

  return (line, statement) => {
    const enclosing = symbols.find((symbol) => line >= symbol.startLine && line <= symbol.endLine);
    if (enclosing !== undefined) return [enclosing.id];

    const bound = boundNames(statement);
    if (bound.length === 0) return everyId;

    // Walked over the ids rather than over the extents, so a name whose two extents both reference
    // the binding is named once and not twice: an owners list is a set of nodes, and a repeated id
    // in it would be read downstream as two.
    const referencing = everyId.filter((id) =>
      bound.some((name) => referencedWithin(extentText.get(id) ?? "", name)),
    );
    return referencing.length > 0 ? referencing : everyId;
  };
}

/**
 * Does this text write `name` as an identifier of its own? The leading class excludes a dot as well,
 * so `order.total` does not count as a reference to an imported `total`: a property of something
 * else is not the binding, and reading it as one would hand an import to an export that never
 * touched it. The name is escaped before it is spliced in, because a strategy that one day reads a
 * name holding a regex metacharacter would otherwise turn a pack's capture into a pattern this
 * engine compiles.
 */
function referencedWithin(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_$.])${escaped}(?:[^A-Za-z0-9_$]|$)`).test(text);
}

function extractCaptures(
  rules: CompiledEdgeRule[],
  source: string,
  codeOnly: string,
  relPath: string,
  starts: number[],
  ownersAt: (line: number, statement: string) => string[] | undefined,
): Capture[] {
  const captures: Capture[] = [];
  for (const rule of rules) {
    // Root-relative, like every other pack-declared glob (`kindRules`, `tests.paths`). A rule the
    // path excludes never runs, so it can neither match nor cost anything.
    if (rule.matchesPath && !rule.matchesPath(relPath)) continue;
    // Which view of the file this rule reads is the rule's own declaration, because one family
    // holds both answers: a JSX tag is code and can only be code, while php's `@livewire('cart')`
    // names its component inside the quotes the other view blanks.
    for (const match of matchAll(rule.regex, rule.maskStrings ? codeOnly : source)) {
      const line = lineAt(starts, match.index);
      // The statement as written, which is what attribution reads: the clause that binds the names
      // and the specifier are both in it, unnormalized.
      const owners = ownersAt(line, match.groups[0] ?? "");
      captures.push({
        family: rule.family,
        resolve: rule.resolve,
        targetKinds: rule.targetKinds,
        // Group 0 is the whole match and no strategy reads it, so it is left as written: a
        // normalized group 0 would be a record of text no file contains.
        groups: match.groups.map((group, position) =>
          position === 0 || group === undefined ? group : applyNormalizers(group, rule.normalize),
        ),
        line,
        // Spread rather than assigned, so a pack that yields one node per file writes no key at all
        // instead of a key holding undefined.
        ...(owners === undefined ? {} : { owners }),
      });
    }
  }
  return captures;
}

function extractSymbols(
  rules: CompiledSymbolRule[],
  source: string,
  relPath: string,
  starts: number[],
  ownersAt: (line: number, statement: string) => string[] | undefined,
  scopesAt: ScopeAttributor,
): SymbolRef[] {
  const refs: SymbolRef[] = [];
  for (const compiled of rules) {
    if (compiled.overPath) {
      // The identity is the whole file, so the anchor is line 1. A produced symbol's line is never
      // surfaced (a bridge edge's evidence is the consumer's call site, engine/bridger.ts), so this
      // only has to be a stable, in-range number.
      //
      // Attributed from no line and no statement, which is how it reaches every symbol of the file:
      // a rule matching the path says the whole file is the thing, an Inertia page's identity being
      // the file it lives in, and there is no clause here to argue one export over another. Asking
      // from the anchor line instead would hand the page to whichever export happens to be declared
      // there, and handing over the matched path text would hand it to whichever export a directory
      // name happens to spell.
      const match = compiled.regex.exec(relPath);
      // Offset 0: a path rule matched the file, not a place in it, so the only scopes that can
      // reach it are the file's own. A `balanced` extent opening at offset 0 would enclose it too,
      // and honestly: it encloses the whole file.
      if (match !== null)
        refs.push(...refsFrom(compiled, [...match], 1, ownersAt(0, ""), scopesAt(0)));
      continue;
    }
    for (const match of matchAll(compiled.regex, source)) {
      const line = lineAt(starts, match.index);
      refs.push(
        ...refsFrom(
          compiled,
          match.groups,
          line,
          ownersAt(line, match.groups[0] ?? ""),
          scopesAt(match.index),
        ),
      );
    }
  }
  return refs.sort(
    (a, b) => compareStrings(a.symbol, b.symbol) || compareStrings(a.key, b.key) || a.line - b.line,
  );
}

/**
 * The refs one match yields: one per key template, or one from the default join where the rule
 * declares no template at all. They share a line and an owner set, because they are one line of
 * code: `Route::resource('orders', OrderController::class)` is eight keys registered at one place,
 * seven Laravel actions of which `update` answers both PUT and PATCH, and citing seven of them
 * somewhere else would be citing somewhere they are not written.
 */
function refsFrom(
  compiled: CompiledSymbolRule,
  groups: (string | undefined)[],
  line: number,
  owners: string[] | undefined,
  scopeValues: (name: string) => string[],
): SymbolRef[] {
  const parts: Record<string, string> = {};
  for (const part of compiled.parts) {
    const group = compiled.rule.map[part] ?? 0;
    parts[part] = applyNormalizers(groups[group] ?? "", compiled.rule.normalize?.[part] ?? []);
  }

  const scoped = compiled.rule.scopedBy;
  if (scoped !== undefined) {
    // The part's own normalizers run over every scope value too. A scope contributes to that part,
    // so it is the same kind of string and owes the same shape: a `strip-leading-slash` on `path`
    // that ran on the route and not on the prefix would leave `/api` joined to `orders` as
    // `/api/orders`, half-normalized, and never equal to the key the other side of the bridge
    // assembles from a leading-slash-stripped whole.
    const normalize = compiled.rule.normalize?.[scoped.part] ?? [];
    const pieces = [
      ...scopeValues(scoped.name).map((value) => applyNormalizers(value, normalize)),
      parts[scoped.part] ?? "",
    ];
    parts[scoped.part] = joinScoped(pieces, scoped.join);
  }

  return symbolKeys(compiled.rule, compiled.parts, parts).map((key) => ({
    symbol: compiled.rule.symbol,
    key,
    line,
    // Spread rather than assigned, for the same reason a capture's is: a pack yielding one node per
    // file writes no key at all rather than a key holding undefined.
    ...(owners === undefined ? {} : { owners }),
  }));
}

/**
 * Outermost scope value first, the symbol's own last, joined on the separator the pack named.
 *
 * The separator is trimmed off both ends of every piece before they are joined, so a pack does not
 * have to write a regex that anticipates whether the author of the code left a slash on. A Laravel
 * author writes `Route::prefix('api')` and `Route::prefix('/api/')` interchangeably and Laravel
 * reads them the same; a key that read them as `api/orders` and `/api//orders` would put two
 * spellings of one route in the bridge table and match neither against the one the frontend calls.
 *
 * An empty piece is dropped rather than joined. `Route::prefix('')` is a group that adds no segment,
 * and a piece kept would make it add a separator.
 */
function joinScoped(pieces: string[], join: string): string {
  const trimmed: string[] = [];
  for (const piece of pieces) {
    let value = piece;
    while (value.startsWith(join)) value = value.slice(join.length);
    while (value.endsWith(join)) value = value.slice(0, -join.length);
    if (value !== "") trimmed.push(value);
  }
  return trimmed.join(join);
}

/** The scope values in force at one offset in one file, by scope name, outermost first. */
type ScopeAttributor = (offset: number) => (name: string) => string[];

/** A `balanced` scope's reach in one file, with the value it contributes to anything inside it. */
interface ScopeExtent {
  name: string;
  value: string;
  start: number;
  end: number;
}

/**
 * Every `balanced` scope this file opens, and the answer for one offset inside it.
 *
 * Unlike `hazards.ts`'s `innermostEnclosing`, which wants the one transaction a dispatch sits in,
 * a scope wants **all** of them: `Route::prefix('admin')` around `Route::prefix('settings')` around
 * a route is the URL `/admin/settings/...`, and reporting only the tighter one would produce a key
 * that is wrong in a way that still looks like a route. Outermost first, which is prefix order:
 * a scope that opens earlier encloses one that opens later, and where two open at the same offset
 * the wider is the outer.
 *
 * The file scopes come first, ahead of every textual one, because they enclose the file that holds
 * them all. They arrive already resolved from `collectFileScopes`, since the construct that names
 * this file is written in a different one.
 */
function scopeAttributor(
  rules: CompiledScopeRule[],
  source: string,
  codeOnly: string,
  fileScopes: ReadonlyMap<string, string[]>,
): ScopeAttributor {
  const extents: ScopeExtent[] = [];
  for (const rule of rules) {
    if (rule.rule.extent !== "balanced") continue;
    for (const match of matchAll(rule.regex, source)) {
      const matchEnd = match.index + (match.groups[0]?.length ?? 0);
      extents.push({
        name: rule.rule.name,
        value: match.groups[rule.rule.value] ?? "",
        start: match.index,
        // Matched over `source`, which still holds the string the value is written in, and counted
        // over `codeOnly`, where a delimiter inside a string cannot end the extent early. Blanking
        // preserves length, so the offset the match gives is the same offset in both.
        end: balancedEnd(codeOnly, matchEnd, rule.rule.open ?? "", rule.rule.close ?? ""),
      });
    }
  }
  extents.sort((a, b) => a.start - b.start || b.end - a.end);

  return (offset) => (name) => [
    ...(fileScopes.get(name) ?? []),
    ...extents
      .filter((extent) => extent.name === name && offset >= extent.start && offset < extent.end)
      .map((extent) => extent.value),
  ];
}

/**
 * The `file` scopes a root declares: what each construct that names another file contributes to
 * everything that file produces.
 *
 * This is the one thing about a symbol that its own file cannot answer, so it is read before
 * extraction rather than during it. A Laravel `RouteServiceProvider` says `Route::prefix('api')
 * ->group(base_path('routes/api.php'))`, and read from inside `routes/api.php` there is nothing at
 * all to see: every path in that file is short by a segment and each one is a well-formed route.
 *
 * The pass reads only the scope patterns, over sources `scanRoot` has already read, so it costs a
 * regex sweep and no I/O. Sorted by the naming file and then by offset, so two constructs naming one
 * route file contribute in an order that does not depend on directory order.
 *
 * **The chain is followed, not just its last link.** A file that names another may itself have been
 * named, and the value it passes on is then the whole chain rather than its own segment: Laravel 11
 * mounts `routes/v2.php` under `v2` from `bootstrap/app.php`, and `routes/v2.php` mounts
 * `routes/v2_admin.php` under `admin`, so a route in the admin file answers `/v2/admin/…` and a
 * resolver stopping at one link would key it `admin/…`. That is the same defect the block exists to
 * fix, one level further out, and it looks just as much like a route. Resolved outermost first and
 * memoized; a file that reaches itself contributes nothing rather than looping, because a mounting
 * cycle is a repository defect and inventing an infinite prefix for it helps nobody.
 *
 * **One root.** A match names a file the way the language spells it, which is relative to the root,
 * so the naming file's own root is put back on to make the repo-relative key `build.ts` looks up
 * with. Only files this root scanned are ever looked up, so a provider in one root naming a route
 * file in another contributes nothing. That is a real ceiling and not a rounding error for a
 * repository that splits its backend across roots; see docs/04-language-packs.md.
 *
 * **A file named twice claims nothing**, on the same reasoning as the cycle below it. Two providers
 * mounting one route file register two families of URLs, `api/orders` and `admin/orders`, and this
 * pass has one value per scope name to give: concatenating them keys `api/admin/orders`, which is a
 * well-formed route nobody serves, and picking one silently drops the other. Declining is the only
 * reading that invents nothing.
 */
export function collectFileScopes(
  compiled: CompiledPack,
  files: readonly { file: string; relPath: string; source: string }[],
): Map<string, Map<string, string[]>> {
  const rules = compiled.scopes.filter((rule) => rule.rule.extent === "file");
  if (rules.length === 0) return new Map();

  /** Repo-relative path named -> what named it, in the order the naming files were read. */
  const declarations = new Map<string, { by: string; name: string; value: string }[]>();
  for (const scanned of [...files].sort((a, b) => compareStrings(a.file, b.file))) {
    const syntax = commentSyntaxFor(compiled.pack, scanned.relPath);
    const source = maskComments(scanned.source, syntax);
    // What a match names is spelled the way the language spells it, which is relative to the root:
    // Laravel's `base_path('routes/api.php')` is relative to the application, and the application is
    // the root. The lookup on the other side is `build.ts`'s `fileScopes.get(file.file)`, and a
    // `ScannedFile.file` is repo-relative (engine/scanner.ts), so the root has to go back on before
    // the two spellings can meet. A root of "." leaves this empty and the two coincide, which is why
    // every fixture, all of which run at ".", read the same before and after.
    const rootPrefix = scanned.file.slice(0, scanned.file.length - scanned.relPath.length);
    const found: { named: string; name: string; value: string; index: number }[] = [];
    for (const rule of rules) {
      for (const match of matchAll(rule.regex, source)) {
        const named = match.groups[rule.rule.file ?? 0];
        if (named === undefined || named === "") continue;
        found.push({
          named: rootPrefix + normalizeRepoPath(named),
          name: rule.rule.name,
          value: match.groups[rule.rule.value] ?? "",
          index: match.index,
        });
      }
    }
    for (const entry of found.sort((a, b) => a.index - b.index)) {
      const list = declarations.get(entry.named) ?? [];
      list.push({ by: scanned.file, name: entry.name, value: entry.value });
      declarations.set(entry.named, list);
    }
  }

  const resolved = new Map<string, Map<string, string[]> | null>();
  /** null where the chain reaches a cycle: this file's prefix cannot be said, so none is claimed. */
  const resolve = (file: string, walking: ReadonlySet<string>): Map<string, string[]> | null => {
    const memoized = resolved.get(file);
    if (memoized !== undefined) return memoized;
    if (walking.has(file)) return null;

    const mounts = declarations.get(file) ?? [];
    // Two constructs naming one file are two mounts of it, not two segments of one prefix: the
    // routes really answer under both, and this pass has one value per scope name to hand back. See
    // the docstring; the same "invent nothing" reading as the cycle below.
    if (mounts.length > 1) return remember(file, null);

    const scopes = new Map<string, string[]>();
    for (const declaration of mounts) {
      const inherited = resolve(declaration.by, new Set([...walking, file]));
      // Propagated rather than swallowed. A file that mounts a file that mounts it back has no
      // outermost segment to start from, and every finite answer for it is arbitrary: which segment
      // gets dropped depends on which file the resolver happened to reach first. Answering with
      // nothing is the one reading that does not invent a URL nobody serves.
      if (inherited === null) return remember(file, null);
      scopes.set(declaration.name, [
        ...(scopes.get(declaration.name) ?? []),
        ...(inherited.get(declaration.name) ?? []),
        declaration.value,
      ]);
    }
    // Safe to memoize whatever the walk depth, unlike a truncating guard: a chain that reached a
    // cycle returned null above, so anything arriving here is the file's whole answer and not this
    // walk's view of it.
    return remember(file, scopes);
  };
  const remember = (file: string, scopes: Map<string, string[]> | null) => {
    resolved.set(file, scopes);
    return scopes;
  };

  const answer = new Map<string, Map<string, string[]>>();
  for (const file of declarations.keys()) {
    const scopes = resolve(file, new Set());
    if (scopes !== null) answer.set(file, scopes);
  }
  return answer;
}

function symbolKeys(rule: SymbolRule, order: string[], parts: Record<string, string>): string[] {
  const templates = rule.keys ?? (rule.key === undefined ? [] : [rule.key]);
  if (templates.length === 0) return [order.map((part) => parts[part] ?? "").join(" ")];
  return templates.map((template) =>
    template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, part: string) => parts[part] ?? ""),
  );
}

/**
 * The pack-declared string vocabulary, applied in the order the pack listed them. Composition is
 * the whole design: `last-dot-segment` then `pascal-case` turns a Blade `forms.text-input` into the
 * class name `TextInput`, and neither step names Blade, PHP or Laravel. The engine holds the verbs
 * and the pack holds the sentence (docs/04-language-packs.md).
 */
function applyNormalizers(value: string, normalizers: Normalizer[]): string {
  let result = value;
  for (const normalizer of normalizers) {
    if (normalizer === "upper") result = result.toUpperCase();
    else if (normalizer === "lower") result = result.toLowerCase();
    else if (normalizer === "strip-leading-slash") result = result.replace(/^\/+/, "");
    else if (normalizer === "last-dot-segment") result = lastDotSegment(result);
    else if (normalizer === "pascal-case") result = pascalCase(result);
    else if (normalizer === "dot-to-slash") result = result.replace(/\./g, "/");
  }
  return result;
}

/**
 * Everything after the last dot: `forms.text-input` is the component `text-input` inside the
 * namespace segment `forms`, and only the last segment is the class's own name. A value with no dot
 * is returned whole, so a rule can declare this unconditionally rather than branching on shape.
 */
function lastDotSegment(value: string): string {
  return value.slice(value.lastIndexOf(".") + 1);
}

/**
 * `text-input` to `TextInput`. Each `-` or `_` separated segment is capitalized and the separators
 * are dropped; the rest of every segment is left exactly as written, so a name that already arrives
 * in PascalCase survives the trip unchanged rather than being lowercased and rebuilt on a guess
 * about where its word boundaries were.
 */
function pascalCase(value: string): string {
  return value
    .split(/[-_]+/)
    .filter((segment) => segment !== "")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

function compileSymbolRule(rule: SymbolRule): CompiledSymbolRule {
  // A source rule scans globally down the file (`gm`). A path rule matches the one path string once,
  // so it carries no `g`: a file has a single identity, not one per line.
  const overPath = rule.pathPattern !== undefined;
  const pattern = rule.pattern ?? rule.pathPattern ?? "";
  return {
    rule,
    regex: new RegExp(pattern, overPath ? "" : "gm"),
    parts: Object.keys(rule.map),
    overPath,
  };
}

function optionalRegex(pattern: string | undefined, flags = "m"): RegExp | undefined {
  return pattern === undefined ? undefined : new RegExp(pattern, flags);
}

function firstCapture(regex: RegExp | undefined, source: string): string | null {
  if (regex === undefined) return null;
  const match = regex.exec(source);
  return match?.[1] ?? null;
}

interface Match {
  groups: (string | undefined)[];
  index: number;
}

function* matchAll(regex: RegExp, source: string): Generator<Match> {
  regex.lastIndex = 0;
  let match = regex.exec(source);
  while (match !== null) {
    yield { groups: [...match], index: match.index };
    // A pattern that can match empty would spin forever otherwise.
    if (match[0].length === 0) regex.lastIndex += 1;
    match = regex.exec(source);
  }
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

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

function baseName(path: string): string {
  const segment = path.split("/").pop() ?? path;
  return segment.replace(/\.[^.]+$/, "");
}
