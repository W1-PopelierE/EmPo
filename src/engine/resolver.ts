import { posix } from "node:path";
import { configError } from "../errors";
import type { GraphEdge, NameOutcome, NameVerdict } from "../schema/types";
import type { Capture, ExtractedFile } from "./extractor";
import { compareStrings } from "./order";

/**
 * Turns raw captures into edges between known nodes. An edge whose target is not a node in the
 * graph is dropped: a vendor import is not a coupling this repository can break.
 *
 * Dropped and **counted**, for the two strategies that read a bare name. Everything else this file
 * refuses is a refusal about a vendor tree, and nobody can act on those; a short name carried by
 * two nodes is a refusal about this repository, and it takes every edge to that name with it,
 * including the ones written in a file whose own import says which one is meant. It fails safe,
 * which is the right direction, but a strategy whose yield can be zero without saying so is not one
 * anybody can call proven, so `resolveEdges` returns what it declined alongside what it emitted.
 */

export interface NodeIndex {
  ids: Set<string>;
  /** Short name to node ids. More than one id means the name is ambiguous and is not resolved. */
  byShortName: Map<string, string[]>;
  /**
   * The same index keyed by the lower-cased name, consulted only when the exact spelling is in no
   * node. A file naming convention is not a language: `<Badge />` is written `Badge.tsx` in one
   * React repository and `badge.tsx` in the next, and both are a component the graph holds.
   *
   * It is a fallback and not the primary index, so a repository that spells its files exactly as it
   * spells its tags resolves through the exact map and can never be answered by a fold. What it
   * yields is corroborated before it resolves; `foldedCandidates` below is where that is argued.
   */
  byFoldedName: Map<string, string[]>;
  /**
   * Node id to the kind its pack's `kindRules` gave it, for the rules that declare `targetKinds`.
   * The kind is on the node either way; this is the lookup a name-resolving strategy needs and the
   * node list cannot give it without a scan per capture.
   */
  kindById: Map<string, string>;
}

/** What the `module-path` strategy needs from the pack to turn a specifier into a file. */
export interface ResolveContext {
  /** The pack's extensions, tried in declared order when a specifier names none. */
  extensions: string[];
  /** The pack's `node.id.indexNames`: basenames that stand for their own directory. */
  indexNames: string[];
  /**
   * The root's `aliases`, compiled by `compileAliases`. Absent where the root declares none, which
   * is every root before somebody writes the field and every `empo pack test` run: a pack corpus has
   * no config, so an alias rule can never be smuggled into a pack's snapshot.
   */
  aliases?: AliasRule[];
}

/** One config alias pattern, split at its `*` once so resolution does no parsing per capture. */
export interface AliasRule {
  /** What the pattern holds before its `*`, or the whole pattern where it has none. */
  prefix: string;
  /** What the pattern holds after its `*`. Empty for an exact pattern. */
  suffix: string;
  /** False for an exact pattern, which matches one specifier and substitutes nothing. */
  wildcard: boolean;
  /** Repo-relative targets, tried in declared order, first hit wins. */
  targets: string[];
}

/**
 * The config's alias map compiled into the order it is matched in, which is tsconfig's order,
 * because the map is copied from a tsconfig and an order of our own would resolve an import to a
 * different file than the build compiles.
 *
 * Exact patterns first, then wildcards by the length of the text before the `*`, longest first. So
 * `@/lib/*` beats `@/*` for `@/lib/money`, and `@/config` beats both for that one specifier. The
 * final tiebreak is `compareStrings`, so two patterns of equal specificity resolve the same way on
 * every machine: JSON preserves key order and nothing else here relies on it, which makes this the
 * one place a config's key order could have leaked into `graph.json`.
 */
export function compileAliases(aliases: Record<string, string[]> | undefined): AliasRule[] {
  if (aliases === undefined) return [];

  const rules: AliasRule[] = [];
  for (const [pattern, targets] of Object.entries(aliases)) {
    const star = pattern.indexOf("*");
    rules.push(
      star === -1
        ? { prefix: pattern, suffix: "", wildcard: false, targets }
        : {
            prefix: pattern.slice(0, star),
            suffix: pattern.slice(star + 1),
            wildcard: true,
            targets,
          },
    );
  }

  return rules.sort(
    (a, b) =>
      Number(a.wildcard) - Number(b.wildcard) ||
      b.prefix.length - a.prefix.length ||
      compareStrings(a.prefix, b.prefix) ||
      compareStrings(a.suffix, b.suffix),
  );
}

export function buildNodeIndex(files: ExtractedFile[]): NodeIndex {
  const ids = new Set<string>();
  const byShortName = new Map<string, string[]>();
  const byFoldedName = new Map<string, string[]>();
  const kindById = new Map<string, string>();

  for (const file of files) {
    ids.add(file.id);
    kindById.set(file.id, file.kind);
    const bucket = byShortName.get(file.name);
    if (bucket) bucket.push(file.id);
    else byShortName.set(file.name, [file.id]);
    const folded = file.name.toLowerCase();
    const foldedBucket = byFoldedName.get(folded);
    if (foldedBucket) foldedBucket.push(file.id);
    else byFoldedName.set(folded, [file.id]);
  }

  return { ids, byShortName, byFoldedName, kindById };
}

/** Strip a leading separator and collapse the doubled backslashes a quoted class name carries. */
export function normalizeFqcn(raw: string): string {
  return raw
    .replace(/\\{2,}/g, "\\")
    .replace(/^\\+/, "")
    .replace(/\\+$/, "");
}

/**
 * What one file's captures came to: the edges, and every bare name a name-resolving strategy read
 * with the verdict the index gave it.
 *
 * The two travel together rather than through a second pass, because a second pass would be a second
 * place that decides whether a name is ambiguous, and two answers to that question would be a defect
 * invisible from either one. It is the same argument that makes `observer` and `short-name` share
 * `resolveName` below.
 */
export interface ResolvedFile {
  edges: GraphEdge[];
  /** One entry per reference read, not per distinct name: the denominator is the point. */
  names: NameOutcome[];
}

export function resolveEdges(
  file: ExtractedFile,
  index: NodeIndex,
  context: ResolveContext,
): ResolvedFile {
  const edges: GraphEdge[] = [];
  const names: NameOutcome[] = [];

  const declared = new Set(file.declares);

  /**
   * Does this file import `name` from the module that is `id`? Asked of a folded candidate only,
   * and answered out of the captures the file already produced rather than out of a new pack rule:
   * an `import` capture's group 0 is the statement as written, so the clause that binds the name and
   * the specifier that says where it came from are both already here.
   *
   * Only a `module-path` capture can witness anything, which is what keeps this a TypeScript-shaped
   * answer without a TypeScript-shaped rule in the engine: php's imports resolve by `fqcn`, so no
   * php fold is ever corroborated and that pack behaves exactly as it did before the fold existed.
   *
   * The name is escaped before it is spliced into a pattern. Every name that reaches here today is
   * an identifier, and a strategy that one day reads a name holding a regex metacharacter would
   * otherwise turn a pack's capture into a pattern this engine compiles.
   */
  const importsNameFrom = (name: string, id: string): boolean => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const binds = new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?:[^A-Za-z0-9_$]|$)`);
    return file.captures.some(
      (capture) =>
        capture.resolve === "module-path" &&
        binds.test(capture.groups[0] ?? "") &&
        resolveModulePath(file.file, capture.groups[1] ?? "", index, context) === id,
    );
  };

  /** Look one name up, record the verdict, and hand back the id for the caller to use or not. */
  const read = (raw: string | undefined, capture: Capture): string | null => {
    const found = resolveName(index, raw, capture.targetKinds, declared, importsNameFrom);
    // A capture whose group did not participate has no name to record. It is not a refusal about a
    // name, it is a rule that matched without capturing one, and counting it as `unknown` would put
    // a pack's own bug into a number that is read as a fact about the repository.
    if (raw !== undefined) {
      names.push({
        family: capture.family,
        name: raw,
        outcome: found.outcome,
        candidates: found.candidates,
      });
    }
    return found.id;
  };

  for (const capture of file.captures) {
    const evidence = { file: file.file, line: capture.line };

    switch (capture.resolve) {
      case "fqcn":
      case "fqcn-string": {
        const target = normalizeFqcn(capture.groups[1] ?? "");
        if (target !== "" && target !== file.id && index.ids.has(target)) {
          edges.push({ from: file.id, to: target, kind: capture.family, symbol: null, evidence });
        }
        break;
      }

      case "module-path": {
        const target = resolveModulePath(file.file, capture.groups[1] ?? "", index, context);
        if (target !== null && target !== file.id) {
          edges.push({ from: file.id, to: target, kind: capture.family, symbol: null, evidence });
        }
        break;
      }

      // The registration site coupled two other files: the edge runs from the observed node to
      // its listener, and the evidence stays on the file that registered it.
      case "observer": {
        // Both names are read, and both unconditionally: `&&` would stop at the first refusal and
        // the second name would go uncounted, so a registration whose observed class is ambiguous
        // would hide the listener's verdict behind it.
        const from = read(capture.groups[1], capture);
        const to = read(capture.groups[2], capture);
        if (from !== null && to !== null && from !== to) {
          edges.push({ from, to, kind: capture.family, symbol: null, evidence });
        }
        break;
      }

      // A template names a class by its short name and by nothing else: a Blade `<x-price-badge>`
      // carries no namespace, and where its class lives is a property of the repository (a composer
      // autoload prefix, a package's own view namespace) rather than of the language. So the name
      // is looked up in the same index `observer` uses, and the same refusal applies: a name that
      // maps to no node or to several yields no edge. Sharing `resolveName` is deliberate, because two
      // strategies that answer "is this name unambiguous" differently would be a defect nobody
      // could see from either pack.
      case "short-name": {
        const target = read(capture.groups[1], capture);
        if (target !== null && target !== file.id) {
          edges.push({ from: file.id, to: target, kind: capture.family, symbol: null, evidence });
        }
        break;
      }

      default:
        throw configError(`resolve strategy "${capture.resolve}" is not implemented yet`, [
          "view lands with a pack that has templates, see docs/14-implementation-notes.md.",
        ]);
    }
  }

  return { edges, names };
}

/**
 * A relative specifier resolved against the file that wrote it, then tried against the pack's
 * extensions and index names, in that order, first hit wins.
 *
 * A bare specifier ("react", "@acme/ui") names a package rather than a file in this repository, so
 * it resolves to nothing. That is the same rule as everywhere else: a vendor import is not a
 * coupling this repository can break.
 *
 * An **alias** is the one bare-looking specifier that does name a file here, and the root's config
 * is the only thing that can say which: `@/lib/money` is a package name to every rule in this file
 * and a path to the toolchain that compiles it. So a specifier that is not relative is matched
 * against the root's compiled `aliases` before it is given up on, and a root that declares none
 * behaves exactly as this function did before the field existed. Nothing is guessed: an alias
 * empo was not told about still resolves to nothing.
 *
 * Resolution runs against repo-relative ids, so an import that climbs out of one root into another
 * ("../../packages/ui/src/Button") resolves, which is the whole point of a monorepo-native graph.
 * An alias target is repo-relative for the same reason and can point out of its own root too.
 */
export function resolveModulePath(
  fromFile: string,
  specifier: string,
  index: NodeIndex,
  context: ResolveContext,
): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return resolveAlias(specifier, index, context);
  }

  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const base = joined.replace(/\/+$/, "");

  // A specifier that climbs above the repository root names nothing this graph holds.
  if (base === "" || base === ".." || base.startsWith("../")) return null;

  for (const candidate of candidatePaths(base, context)) {
    if (index.ids.has(candidate)) return candidate;
  }
  return null;
}

/**
 * A non-relative specifier against the root's alias map, resolved the way the toolchain the map was
 * copied from resolves it.
 *
 * **The best-matching pattern is the only one tried**, which is tsconfig's rule rather than a
 * convenience. Falling through to a less specific pattern when the best one's targets name no node
 * would produce an edge to a file the compiler would never have loaded, and a plausible wrong edge
 * is worse here than a missing one: a blast radius is read as a floor, and a floor made of invented
 * couplings is not one. Within that pattern the targets are tried in declared order, first hit
 * wins, which is what a tsconfig `paths` list means.
 *
 * A target that resolves above the repository root, or to the root itself, names nothing this graph
 * holds, on the same rule the relative path above follows.
 */
function resolveAlias(specifier: string, index: NodeIndex, context: ResolveContext): string | null {
  const rule = (context.aliases ?? []).find((candidate) => matches(candidate, specifier));
  if (rule === undefined) return null;

  const matched = rule.wildcard
    ? specifier.slice(rule.prefix.length, specifier.length - rule.suffix.length)
    : "";

  for (const target of rule.targets) {
    const base = posix.normalize(target.replace("*", matched)).replace(/\/+$/, "");
    if (base === "" || base === "." || base === ".." || base.startsWith("../")) continue;

    for (const candidate of candidatePaths(base, context)) {
      if (index.ids.has(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * An exact pattern matches one specifier. A wildcard matches a specifier long enough to hold both
 * of its literal halves, so `@/*` does not claim the bare specifier `@/`, which substitutes an empty
 * path and could only name a directory.
 */
function matches(rule: AliasRule, specifier: string): boolean {
  if (!rule.wildcard) return specifier === rule.prefix;
  return (
    specifier.length > rule.prefix.length + rule.suffix.length &&
    specifier.startsWith(rule.prefix) &&
    specifier.endsWith(rule.suffix)
  );
}

function* candidatePaths(base: string, context: ResolveContext): Generator<string> {
  yield base; // the specifier already named the file, extension included
  for (const extension of context.extensions) yield `${base}${extension}`;
  for (const name of context.indexNames) {
    for (const extension of context.extensions) yield `${base}/${name}${extension}`;
  }
}

/**
 * One node id for a short name, or null where the name is in no node, in several, or in one of the
 * wrong kind.
 *
 * **The uniqueness question is asked first and `targetKinds` filters the survivor**, which is the
 * order that only ever refuses. Filtering first reads like the more useful one, since two files
 * named `Badge` of which one is a component and one is a type module would leave a single candidate
 * and resolve. It also turns a refusal into a confident wrong answer, and that direction was
 * measured rather than reasoned: a `<Link />` from react-router, in a repository holding both
 * `components/Link.tsx` and `util/Link.ts`, resolved to the component under the filter-first order
 * and to nothing under this one, while the tag names neither. A name shared by two files is a name
 * this strategy cannot read, whatever the kinds are, and narrowing the field of candidates does not
 * change that: it only hides it behind a plausible pick.
 *
 * **The verdict comes back with the id**, so the three ways to answer null stay three answers. They
 * are not one fact: a name in no node is a vendor component and costs this repository nothing, a
 * name of the wrong kind is a rule's own `targetKinds` doing what it was declared for, and a name in
 * several nodes is a coupling that exists and is not in the graph. Returned as a bare null they were
 * indistinguishable downstream, which is how a family whose yield had gone to zero went on reporting
 * the same silence as a family with nothing to find.
 */
function resolveName(
  index: NodeIndex,
  shortName: string | undefined,
  targetKinds: string[] | undefined,
  declared: Set<string>,
  importsNameFrom: (name: string, id: string) => boolean,
): { id: string | null; outcome: NameVerdict; candidates: number } {
  if (shortName === undefined) return { id: null, outcome: "unknown", candidates: 0 };

  // Asked before the index is, because the index cannot answer it: a name the reading file declares
  // itself is answered inside that file, and every node the root holds under that name is some other
  // file's. Resolving it would be the confident wrong answer the ordering below already refuses in
  // its other form.
  if (declared.has(shortName)) return { id: null, outcome: "local", candidates: 0 };

  const candidates =
    index.byShortName.get(shortName) ??
    foldedCandidates(index, shortName).filter((id) => importsNameFrom(shortName, id));
  if (candidates.length === 0) return { id: null, outcome: "unknown", candidates: 0 };
  if (candidates.length > 1) {
    return { id: null, outcome: "ambiguous", candidates: candidates.length };
  }

  const id = candidates[0];
  if (id === undefined) return { id: null, outcome: "unknown", candidates: 0 };
  if (targetKinds !== undefined && !targetKinds.includes(index.kindById.get(id) ?? "")) {
    return { id: null, outcome: "wrong-kind", candidates: 1 };
  }
  return { id, outcome: "resolved", candidates: 1 };
}

/**
 * The nodes carrying a name once case is set aside, and only worth asking for when the exact
 * spelling carried none.
 *
 * The whole yield of `short-name` on a repository can turn on this. Measured on a real 186-file
 * React Native application, whose components live in `src/components/badge.tsx` and are rendered
 * as `<Badge />`: 3 of 1531 tag references resolved before this fallback, and none of the 1528
 * misses was an ambiguity anybody could have repaired by renaming a file. A pack that reads tags and
 * yields nothing on the commonest file-naming convention in the language is not one anybody can call
 * proven, whatever it does on a corpus written to be read.
 *
 * **A fold is corroborated before it resolves, and an exact match is not.** A tag spelled exactly as
 * a file is the language's own convention answering; a fold is this engine guessing that a naming
 * style is in play, and a guess needs a witness. The witness is the rendering file's own imports:
 * the fold stands only where that file imports this name from this module. Measured on cal.com,
 * which names its shadcn-style files `toaster.tsx` and `collapsible.tsx`, the uncorroborated fold
 * produced 53 edges of which a sampled 5 in 6 were wrong — `<Toaster />` from the `sonner` package
 * landing on a local file that merely folds onto its name. Every one of those refuses here, and on
 * the React Native application, where the tags really do name those files, 12 of 12 sampled edges
 * survive.
 *
 * The corroboration is asked per candidate and before the uniqueness test, so a name two files carry
 * once case is set aside resolves when the reading file imports exactly one of them. That is not the
 * ambiguity the exact map refuses: there, nothing in the file says which is meant, and here the file
 * has said.
 */
function foldedCandidates(index: NodeIndex, shortName: string): string[] {
  return index.byFoldedName.get(shortName.toLowerCase()) ?? [];
}
