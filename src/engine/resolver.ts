import { posix } from "node:path";
import { configError } from "../errors";
import type { GraphEdge } from "../schema/types";
import type { ExtractedFile } from "./extractor";
import { compareStrings } from "./order";

/**
 * Turns raw captures into edges between known nodes. An edge whose target is not a node in the
 * graph is dropped: a vendor import is not a coupling this repository can break.
 */

export interface NodeIndex {
  ids: Set<string>;
  /** Short name to node ids. More than one id means the name is ambiguous and is not resolved. */
  byShortName: Map<string, string[]>;
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
  const kindById = new Map<string, string>();

  for (const file of files) {
    ids.add(file.id);
    kindById.set(file.id, file.kind);
    const bucket = byShortName.get(file.name);
    if (bucket) bucket.push(file.id);
    else byShortName.set(file.name, [file.id]);
  }

  return { ids, byShortName, kindById };
}

/** Strip a leading separator and collapse the doubled backslashes a quoted class name carries. */
export function normalizeFqcn(raw: string): string {
  return raw
    .replace(/\\{2,}/g, "\\")
    .replace(/^\\+/, "")
    .replace(/\\+$/, "");
}

export function resolveEdges(
  file: ExtractedFile,
  index: NodeIndex,
  context: ResolveContext,
): GraphEdge[] {
  const edges: GraphEdge[] = [];

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
        const from = uniqueId(index, capture.groups[1], capture.targetKinds);
        const to = uniqueId(index, capture.groups[2], capture.targetKinds);
        if (from !== null && to !== null && from !== to) {
          edges.push({ from, to, kind: capture.family, symbol: null, evidence });
        }
        break;
      }

      // A template names a class by its short name and by nothing else: a Blade `<x-price-badge>`
      // carries no namespace, and where its class lives is a property of the repository (a composer
      // autoload prefix, a package's own view namespace) rather than of the language. So the name
      // is looked up in the same index `observer` uses, and the same refusal applies: a name that
      // maps to no node or to several yields no edge. Sharing `uniqueId` is deliberate, because two
      // strategies that answer "is this name unambiguous" differently would be a defect nobody
      // could see from either pack.
      case "short-name": {
        const target = uniqueId(index, capture.groups[1], capture.targetKinds);
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

  return edges;
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
 */
function uniqueId(
  index: NodeIndex,
  shortName: string | undefined,
  targetKinds: string[] | undefined,
): string | null {
  if (shortName === undefined) return null;
  const candidates = index.byShortName.get(shortName);
  if (candidates === undefined || candidates.length !== 1) return null;

  const id = candidates[0];
  if (id === undefined) return null;
  if (targetKinds !== undefined && !targetKinds.includes(index.kindById.get(id) ?? "")) return null;
  return id;
}
