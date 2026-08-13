import { posix } from "node:path";
import { configError } from "../errors";
import type { GraphEdge, NameOutcome, NameVerdict, PackViews } from "../schema/types";
import { boundNames, type Capture, type ExtractedFile, isSideEffectImport } from "./extractor";
import { compareStrings } from "./order";
import { packageOf } from "./packages";

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
  /**
   * Repo-relative path to the node ids that file yields, sorted. One entry for a pack whose files
   * each yield a single node, one per export for a `symbol` pack.
   *
   * It is what module resolution walks, and that is not a convenience. Resolution turns a specifier
   * into a **file**: it tries the pack's extensions and index names against a path, and a path is
   * only a node id by the accident that two of the three strategies name a node after one. Under
   * `symbol` no path is an id at all, so a walk ending in `ids.has(candidate)` would answer null for
   * every import in every repository the moment a pack adopted the strategy, and it would do it
   * silently: an import that resolves to nothing is the same shape as a vendor import, which this
   * file drops by design. Keyed by file it asks the question it means, and the two path-shaped
   * strategies answer exactly as they did, `byFile` holding every path they ever put in `ids`.
   */
  byFile: Map<string, string[]>;
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
  /**
   * Template path to node ids, for the `view` strategy: `orders/show` for a node whose file is
   * `resources/views/orders/show.blade.php` under a pack-declared view root.
   *
   * A view name is not a short name and cannot be looked up like one. `@include('orders.row')` and
   * `view('orders.index')` name a **file** by its path below a root the framework knows and nothing
   * in the repository writes down, so the pack's `views` block says which directory that is and
   * which suffixes a template carries. Empty for a pack declaring no such block, which is every
   * pack that has no templates and every pack that had none before the field existed.
   */
  byViewName: Map<string, string[]>;
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
  /**
   * The package names this repository depends on and does not itself carry, from engine/packages.ts.
   * Absent where the pack declares no `packages` block, which leaves every name resolving exactly as
   * it did before the field existed.
   */
  vendorPackages?: Set<string>;
  /**
   * The packages this repository **is**, name to repo-relative directory, from engine/packages.ts.
   * Absent where the pack declares no `packages` block, on the same bargain as the field above.
   */
  internalPackages?: Map<string, string>;
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

export function buildNodeIndex(files: ExtractedFile[], views?: PackViews): NodeIndex {
  const ids = new Set<string>();
  const byFile = new Map<string, string[]>();
  const byShortName = new Map<string, string[]>();
  const byFoldedName = new Map<string, string[]>();
  const kindById = new Map<string, string>();
  const byViewName = new Map<string, string[]>();

  for (const file of files) {
    // The nodes this file yields, which is the same list `toNodes` in engine/build.ts builds and for
    // the same reason: a file the pack found exports in is those exports, and a file it found none in
    // is itself. The two are written apart because one produces nodes and this one indexes them, and
    // an index built from the nodes instead would need the graph before the edges that need the index.
    const entries =
      file.symbols.length === 0
        ? [{ id: file.id, name: file.name }]
        : file.symbols.map((symbol) => ({ id: symbol.id, name: symbol.name }));
    byFile.set(file.file, entries.map((entry) => entry.id).sort(compareStrings));

    const viewName = views === undefined ? null : viewNameOf(file.file, views);
    for (const entry of entries) {
      ids.add(entry.id);
      kindById.set(entry.id, file.kind);
      const bucket = byShortName.get(entry.name);
      if (bucket) bucket.push(entry.id);
      else byShortName.set(entry.name, [entry.id]);
      const folded = entry.name.toLowerCase();
      const foldedBucket = byFoldedName.get(folded);
      if (foldedBucket) foldedBucket.push(entry.id);
      else byFoldedName.set(folded, [entry.id]);
      if (viewName !== null) {
        const viewBucket = byViewName.get(viewName);
        if (viewBucket) viewBucket.push(entry.id);
        else byViewName.set(viewName, [entry.id]);
      }
    }
  }

  return { ids, byFile, byShortName, byFoldedName, kindById, byViewName };
}

/**
 * The name a framework would render this file by, or null where the file is not a template: the
 * path below the first declared view root it sits under, with the declared suffix taken off.
 *
 * The root is matched **anywhere in the path** rather than only at its start, because a node id is
 * repo-relative and a Laravel application is as often `apps/api/resources/views/` as it is
 * `resources/views/`. That is the same reason `resolveModulePath` resolves against repo-relative
 * ids: a monorepo is the normal case, not the odd one.
 *
 * ponytail: two applications in one repository each holding `orders/show` make that name ambiguous
 * and it resolves to neither. Narrowing candidates to the referencing file's own root is the repair
 * if a real monorepo shows the loss; refusing is the safe direction until one does.
 */
function viewNameOf(path: string, views: PackViews): string | null {
  for (const root of views.roots) {
    const marker = `${root}/`;
    const at = path.startsWith(marker)
      ? 0
      : path.includes(`/${marker}`)
        ? path.indexOf(`/${marker}`) + 1
        : -1;
    if (at === -1) continue;

    const tail = path.slice(at + marker.length);
    for (const extension of views.extensions) {
      if (tail.length > extension.length && tail.endsWith(extension)) {
        return tail.slice(0, -extension.length);
      }
    }
  }
  return null;
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
   * **A name the statement renames away is not bound by it.** `import { ThemeProvider as
   * MuiThemeProvider } from "@mui/material"` leaves the plain name free, and the file next to that
   * line imports the local `ThemeProvider` and renders it. Reading the statement for the bare name
   * refuses that real edge, which is the one thing this check must never do: it exists to stop a
   * wrong edge, and a wrong refusal costs the same coupling by the other route. Measured on
   * marmelab/react-admin, `AppBar.stories.tsx` is the case, twice.
   *
   * The name is escaped before it is spliced into a pattern. Every name that reaches here today is
   * an identifier, and a strategy that one day reads a name holding a regex metacharacter would
   * otherwise turn a pack's capture into a pattern this engine compiles.
   */
  const statementBinds = (statement: string, name: string): boolean => {
    // **A side-effect import binds no name, and its specifier is the whole statement.** Every other
    // shape read here carries a clause or call parens beside the path, so the name is matched in
    // text a file wrote about a symbol; `import "@mui/material/Button/Button.css"` writes `Button`
    // twice and means neither of them as a binding. Read whole it refuses the local `Button.tsx`
    // the file renders, which is the one thing this check must never do. The predicate lives in
    // engine/extractor.ts because attribution asks the same question of the same text.
    if (isSideEffectImport(statement)) return false;

    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?:[^A-Za-z0-9_$]|$)`).test(statement)) {
      return false;
    }
    // Renamed away, and every occurrence of it: a clause naming one symbol twice, once renamed and
    // once not, is not something a language lets a file write.
    return !new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}\\s+as\\s`).test(statement);
  };

  const importsNameFrom = (name: string, id: string): boolean =>
    file.captures.some(
      (capture) =>
        capture.resolve === "module-path" &&
        statementBinds(capture.groups[0] ?? "", name) &&
        resolveModulePath(file.file, capture.groups[1] ?? "", index, context) === id,
    );

  /**
   * Does this file import `name` from a package the repository installs? Asked last, of a name the
   * index has already answered, because that is the only case it can change: `<Button />` beside
   * `import Button from "@mui/material/Button"` is a MUI component in a file that also happens to
   * hold one local `Button.tsx`, and every question a name-resolving strategy asks — is the name
   * unique, is the kind right — answers yes.
   *
   * A specifier naming a package this repository **is** never reaches here: `vendorPackages` has
   * already subtracted the manifests' own names, so a workspace barrel goes on resolving and the
   * edges this family exists for survive.
   */
  const importsVendorName = (name: string): boolean => {
    const vendor = context.vendorPackages;
    if (vendor === undefined || vendor.size === 0) return false;

    return file.captures.some((capture) => {
      if (capture.resolve !== "module-path" || !statementBinds(capture.groups[0] ?? "", name)) {
        return false;
      }
      const named = packageOf(capture.groups[1] ?? "");
      return named !== null && vendor.has(named);
    });
  };

  /**
   * The directories of the internal packages this file binds `name` from, in the order the file
   * writes those imports.
   *
   * A workspace package is the one bare specifier that names neither a file here nor somebody
   * else's code: `vendorPackages` subtracts it precisely because the repository **is** it, so the
   * name goes on resolving against the whole tree and lands on whichever node happens to carry it.
   * Measured on cal.com, `apps/web/modules/webhooks/components/WebhookListItem.tsx:222` renders
   * `</Button>` under `import { Button } from "@coss/ui/components/button"`, and the edge landed on
   * `packages/ui/components/button/Button.tsx` because that is the one node named exactly `Button`,
   * while `@coss/ui` is `packages/coss-ui` and the component is its `src/components/button.tsx`.
   *
   * Read out of the same `module-path` captures `importsVendorName` reads, through the same
   * `statementBinds`, so a renamed-away name binds nothing here either and php, which resolves its
   * imports by `fqcn` and declares no `packages` block, is untouched twice over.
   */
  const internalDirs = (name: string): string[] => {
    const internal = context.internalPackages;
    if (internal === undefined || internal.size === 0) return [];

    const dirs: string[] = [];
    for (const capture of file.captures) {
      if (capture.resolve !== "module-path" || !statementBinds(capture.groups[0] ?? "", name)) {
        continue;
      }
      const named = packageOf(capture.groups[1] ?? "");
      const dir = named === null ? undefined : internal.get(named);
      if (dir !== undefined) dirs.push(dir);
    }
    return dirs;
  };

  /** Look one name up, record the verdict, and hand back the id for the caller to use or not. */
  const read = (raw: string | undefined, capture: Capture): string | null => {
    const found = resolveName(index, raw, capture.targetKinds, {
      declared,
      importsNameFrom,
      importsVendorName,
      internalDirs,
    });
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

  /**
   * Look one view name up in the index of template paths, record the verdict, and hand back the id.
   *
   * It does not go through `resolveName`, and that is the point of the strategy being a separate
   * one: a view name is a path below a root and never a class name, so none of the four questions
   * `resolveName` asks after uniqueness — the kind, the file's own declarations, its imports, its
   * workspace packages — can say anything about it. What the two do share is the refusal: a name in
   * no node and a name in several both yield nothing, and both are counted, because a strategy
   * whose yield can silently be zero is not one anybody can call proven.
   */
  const readView = (raw: string | undefined, capture: Capture): string | null => {
    if (raw === undefined) return null;
    const candidates = index.byViewName.get(raw) ?? [];
    const outcome: NameVerdict =
      candidates.length === 1 ? "resolved" : candidates.length === 0 ? "unknown" : "ambiguous";
    names.push({ family: capture.family, name: raw, outcome, candidates: candidates.length });
    return outcome === "resolved" ? (candidates[0] ?? null) : null;
  };

  for (const capture of file.captures) {
    const evidence = { file: file.file, line: capture.line };
    // Which of this file's nodes wrote the reference. One for every pack that yields a node per
    // file, and for a `symbol` pack the exports extraction attributed the line to: an edge out of
    // the whole file is the answer that strategy exists to stop giving.
    const sources = capture.owners ?? [file.id];

    switch (capture.resolve) {
      case "fqcn":
      case "fqcn-string": {
        const target = normalizeFqcn(capture.groups[1] ?? "");
        if (target !== "" && index.ids.has(target)) {
          for (const from of sources) {
            if (target !== from) {
              edges.push({ from, to: target, kind: capture.family, symbol: null, evidence });
            }
          }
        }
        break;
      }

      case "module-path": {
        const targetFile = resolveModuleFile(file.file, capture.groups[1] ?? "", index, context);
        if (targetFile === null || targetFile === file.file) break;
        const available = index.byFile.get(targetFile) ?? [];
        // The names the statement binds that the target file actually exports. Where it binds none
        // this engine can match to an export, the import reaches the whole module: a side-effect
        // import runs the file, a default or a namespace import can reach any of it, and a file
        // yielding one node has that node named by every import of it either way.
        const bound = boundNames(capture.groups[0] ?? "");
        const named = available.filter((id) => bound.includes(id.slice(id.indexOf("#") + 1)));
        const targets = named.length > 0 ? named : available;
        for (const from of sources) {
          for (const to of targets) {
            if (to === from) continue;
            edges.push({ from, to, kind: capture.family, symbol: null, evidence });
          }
        }
        break;
      }

      // The registration site coupled two other files: the edge runs from the observed node to
      // its listener, and the evidence stays on the file that registered it.
      // Neither end of this one is the file that wrote it, so `sources` says nothing about it: the
      // edge runs between the two classes the registration coupled, and this file is the witness.
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
        if (target !== null) {
          for (const from of sources) {
            if (target !== from) {
              edges.push({ from, to: target, kind: capture.family, symbol: null, evidence });
            }
          }
        }
        break;
      }

      // The one strategy whose target is a template rather than a class, and the only thing in the
      // graph that makes a template a sink: `@extends('layouts.app')` in a Blade file and
      // `view('orders.show')` in the controller that renders it both land here. Without it every
      // template edge ran out of a template and none ran into one, so a change to a controller
      // never named the view it renders — the direction a reviewer actually asks about.
      case "view": {
        const target = readView(capture.groups[1], capture);
        if (target !== null) {
          for (const from of sources) {
            if (target !== from) {
              edges.push({ from, to: target, kind: capture.family, symbol: null, evidence });
            }
          }
        }
        break;
      }

      default:
        throw configError(`resolve strategy "${capture.resolve}" is not implemented yet`);
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
export function resolveModuleFile(
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
    if (index.byFile.has(candidate)) return candidate;
  }
  return null;
}

/**
 * The same resolution answered as a node id, for the one caller that has an id in hand and needs to
 * know whether this specifier names it: `importsNameFrom` above, corroborating a folded short name.
 *
 * A file yielding one node answers with that node, which is every file of a `fqcn` or `module-path`
 * pack and a single-export file of a `symbol` one. A file yielding several has no single id to give,
 * so it answers with its path: the question the caller asks is an equality against a node id, and a
 * path is never one under that strategy, so the answer is honestly negative rather than one of the
 * exports picked out of several the statement may not have named.
 */
export function resolveModulePath(
  fromFile: string,
  specifier: string,
  index: NodeIndex,
  context: ResolveContext,
): string | null {
  const file = resolveModuleFile(fromFile, specifier, index, context);
  if (file === null) return null;
  const ids = index.byFile.get(file) ?? [];
  return ids.length === 1 ? (ids[0] ?? null) : file;
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
 *
 * It answers with a file and not a node id, because it is half of `resolveModuleFile` and an alias
 * is a spelling of a path rather than a second kind of target.
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
      if (index.byFile.has(candidate)) return candidate;
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
 * **The verdict comes back with the id**, so the five ways to answer null stay five answers. They
 * are not one fact: a name in no node is a vendor component and costs this repository nothing, a
 * name of the wrong kind is a rule's own `targetKinds` doing what it was declared for, a name in
 * several nodes is a coupling that exists and is not in the graph, and `local` and `vendor` are the
 * two where a node was found, was of the right kind, and is still not what the line renders.
 * Returned as a bare null they were indistinguishable downstream, which is how a family whose yield
 * had gone to zero went on reporting the same silence as a family with nothing to find.
 */
/** What one file says about a name, which is everything the root's index cannot say. */
interface ReadingFile {
  /** Names this file declares itself, from the pack's `declares` patterns. */
  declared: Set<string>;
  /** Whether this file imports the name from the module that is this node id. */
  importsNameFrom: (name: string, id: string) => boolean;
  /** Whether this file imports the name from a package the repository depends on. */
  importsVendorName: (name: string) => boolean;
  /** The repo-relative directories of the internal packages this file binds the name from. */
  internalDirs: (name: string) => string[];
}

function resolveName(
  index: NodeIndex,
  shortName: string | undefined,
  targetKinds: string[] | undefined,
  file: ReadingFile,
): { id: string | null; outcome: NameVerdict; candidates: number } {
  if (shortName === undefined) return { id: null, outcome: "unknown", candidates: 0 };

  // The named workspace package is searched before the tree is, and this is a redirect rather than
  // a refusal: the outcome stays `resolved`, and no verdict counts it, because the reference did
  // become an edge and only its target moved. A count would be a count of nothing a reader can act
  // on. Where the subtree answers with anything but one node of the right kind, the whole question
  // falls through to the index below and nothing about it changes — which is what keeps a re-export
  // barrel working, `packages/react-admin` holding no component file of its own and the search
  // inside it therefore finding nothing.
  const redirected = insidePackage(index, shortName, file.internalDirs(shortName));
  if (redirected.length === 1) {
    const only = redirected[0];
    if (only !== undefined && kindAllowed(index, only, targetKinds)) {
      return { id: only, outcome: "resolved", candidates: 1 };
    }
  }

  const candidates =
    index.byShortName.get(shortName) ??
    foldedCandidates(index, shortName).filter((id) => file.importsNameFrom(shortName, id));
  if (candidates.length === 0) return { id: null, outcome: "unknown", candidates: 0 };
  if (candidates.length > 1) {
    return { id: null, outcome: "ambiguous", candidates: candidates.length };
  }

  const id = candidates[0];
  if (id === undefined) return { id: null, outcome: "unknown", candidates: 0 };
  if (!kindAllowed(index, id, targetKinds)) {
    return { id: null, outcome: "wrong-kind", candidates: 1 };
  }

  // Asked last, of the one name that was about to become an edge, because that is the only case
  // either question can change. A name in no node was never at risk of a wrong edge and its honest
  // verdict is `unknown`, whatever the reading file declares or imports; asking these two first put
  // every vendor tag in the repository into a refusal count that reads as a repairable loss. What is
  // left here is the case both were added for: the index found exactly one node, of a kind the rule
  // allows, and the file that wrote the reference says it meant something else.
  if (file.declared.has(shortName)) return { id: null, outcome: "local", candidates: 1 };
  if (file.importsVendorName(shortName)) return { id: null, outcome: "vendor", candidates: 1 };

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

function kindAllowed(index: NodeIndex, id: string, targetKinds: string[] | undefined): boolean {
  return targetKinds === undefined || targetKinds.includes(index.kindById.get(id) ?? "");
}

/**
 * The nodes carrying a name inside the subtrees of the workspace packages the reading file binds it
 * from, exact spelling first and the case fold only where the exact spelling carried none there.
 *
 * **Containment is a preference here and never a requirement**, and that distinction is the whole
 * design. Requiring a resolved candidate to live under the named package's directory reads like the
 * same rule and deletes real edges: on marmelab/react-admin a file imports from `react-admin`, whose
 * `packages/react-admin/index.ts` re-exports `ra-ui-materialui` and `ra-core`, and the component it
 * names legitimately lives in another package's directory. Searching the named subtree first and
 * falling through leaves every one of those exactly as it was, because that subtree holds no node of
 * the name to find.
 *
 * The fold needs no separate witness the way `foldedCandidates` does. There, the fold is this engine
 * guessing that a naming style is in play and the file's own import is what corroborates it; here
 * that import is the reason the subtree is being searched at all, so the witness is already in hand.
 * `packages/coss-ui/src/components/button.tsx` is named `button` and the tag is `<Button />`, which
 * is the measured case and reachable no other way.
 *
 * A manifest at the repository root maps to `""`, which contains every node and so narrows nothing:
 * such a name answers whatever the index would have answered, one node or several.
 */
function insidePackage(index: NodeIndex, shortName: string, dirs: string[]): string[] {
  if (dirs.length === 0) return [];

  const under = (ids: string[]): string[] =>
    ids.filter((id) => dirs.some((dir) => dir === "" || id.startsWith(`${dir}/`)));

  const exact = under(index.byShortName.get(shortName) ?? []);
  return exact.length > 0 ? exact : under(foldedCandidates(index, shortName));
}
