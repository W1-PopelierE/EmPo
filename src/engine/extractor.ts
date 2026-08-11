import { posix } from "node:path";
import picomatch from "picomatch";
import { configError } from "../errors";
import type {
  CommentSyntax,
  EdgeKind,
  Normalizer,
  Pack,
  ResolveStrategy,
  SymbolRef,
  SymbolRule,
} from "../schema/types";
import {
  type CompiledHazards,
  compileHazards,
  type DispatchSite,
  declaresDeferral,
  findEnclosedDispatches,
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
  kindRules: CompiledKindRule[];
  edgeRules: CompiledEdgeRule[];
  produces: CompiledSymbolRule[];
  consumes: CompiledSymbolRule[];
  /** The pack's `declares` patterns. Empty where the pack declares none. */
  declares: RegExp[];
  testPaths: ((relPath: string) => boolean)[];
  /** null when the pack declares no hazards block at all, which is not the same as declaring none. */
  hazards: CompiledHazards | null;
}

export function compilePack(pack: Pack): CompiledPack {
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
    kindRules: pack.node.kindRules.map((rule) => ({
      kind: rule.kind,
      matchesPath: rule.pathGlob ? picomatch(rule.pathGlob) : undefined,
      contentRegex: optionalRegex(rule.contentPattern),
      maskStrings: rule.maskStrings === true,
    })),
    edgeRules,
    produces: pack.produces.map(compileSymbolRule),
    consumes: pack.consumes.map(compileSymbolRule),
    declares: (pack.declares ?? []).map((pattern) => new RegExp(pattern, "gm")),
    testPaths: pack.tests.paths.map(compileTestPath),
    hazards: compileHazards(pack),
  };
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

/** Returns null when the file yields no node, in which case its captures are dropped too. */
export function extractFile(compiled: CompiledPack, scanned: ScannedFile): ExtractedFile | null {
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
  const isTest = compiled.testPaths.some((matches) => matches(scanned.relPath));

  return {
    file: scanned.file,
    root: scanned.root,
    lang: scanned.lang,
    id: identity.id,
    name: identity.name,
    kind: kindOf(compiled, source, codeOnly, scanned.relPath),
    isTest,
    assertsValue: isTest && assertsValue(compiled.pack, source),
    produces: extractSymbols(compiled.produces, source, scanned.relPath, starts),
    consumes: extractSymbols(compiled.consumes, source, scanned.relPath, starts),
    captures: extractCaptures(compiled.edgeRules, source, codeOnly, scanned.relPath, starts),
    // Read from the string-blanked view where the pack asked any rule for one, on the same argument
    // the tag rules make: a name inside a quoted example is prose about a declaration, not one.
    declares: declaredNames(compiled.declares, codeOnly),
    // The masked source, like every other rule: a dispatch inside a commented-out block is not a
    // dispatch, and a pack whose rules read the raw text would report hazards nobody can run.
    dispatches: compiled.hazards === null ? [] : findEnclosedDispatches(compiled.hazards, source),
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
  if (strategy === "module-path") {
    return { id: scanned.file, name: baseName(scanned.relPath) };
  }

  if (strategy === "symbol") {
    throw configError('node id strategy "symbol" is not implemented yet');
  }

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
    compiled.declares.length > 0
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

function extractCaptures(
  rules: CompiledEdgeRule[],
  source: string,
  codeOnly: string,
  relPath: string,
  starts: number[],
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
      captures.push({
        family: rule.family,
        resolve: rule.resolve,
        targetKinds: rule.targetKinds,
        // Group 0 is the whole match and no strategy reads it, so it is left as written: a
        // normalized group 0 would be a record of text no file contains.
        groups: match.groups.map((group, position) =>
          position === 0 || group === undefined ? group : applyNormalizers(group, rule.normalize),
        ),
        line: lineAt(starts, match.index),
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
): SymbolRef[] {
  const refs: SymbolRef[] = [];
  for (const compiled of rules) {
    if (compiled.overPath) {
      // The identity is the whole file, so the anchor is line 1. A produced symbol's line is never
      // surfaced (a bridge edge's evidence is the consumer's call site, engine/bridger.ts), so this
      // only has to be a stable, in-range number.
      const match = compiled.regex.exec(relPath);
      if (match !== null) refs.push(refFrom(compiled, [...match], 1));
      continue;
    }
    for (const match of matchAll(compiled.regex, source)) {
      refs.push(refFrom(compiled, match.groups, lineAt(starts, match.index)));
    }
  }
  return refs.sort(
    (a, b) => compareStrings(a.symbol, b.symbol) || compareStrings(a.key, b.key) || a.line - b.line,
  );
}

function refFrom(
  compiled: CompiledSymbolRule,
  groups: (string | undefined)[],
  line: number,
): SymbolRef {
  const parts: Record<string, string> = {};
  for (const part of compiled.parts) {
    const group = compiled.rule.map[part] ?? 0;
    parts[part] = applyNormalizers(groups[group] ?? "", compiled.rule.normalize?.[part] ?? []);
  }
  return {
    symbol: compiled.rule.symbol,
    key: symbolKey(compiled.rule, compiled.parts, parts),
    line,
  };
}

function symbolKey(rule: SymbolRule, order: string[], parts: Record<string, string>): string {
  if (rule.key !== undefined) {
    return rule.key.replace(/\{([A-Za-z0-9_]+)\}/g, (_, part: string) => parts[part] ?? "");
  }
  return order.map((part) => parts[part] ?? "").join(" ");
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

function optionalRegex(pattern: string | undefined): RegExp | undefined {
  return pattern === undefined ? undefined : new RegExp(pattern, "m");
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
