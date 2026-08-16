import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Pack, PackAliasSource } from "../schema/pack.schema";
import { maskComments } from "./mask";
import { compareStrings } from "./order";

/**
 * Step 2 of `empo init` (docs/06-cli.md): the alias map a root's toolchain already has, translated
 * into the repo-relative form config `aliases` stores.
 *
 * **Why this is a seed and not a resolver.** `empo index` never opens one of these files. The graph
 * is a function of the config plus the files under the roots, which is what makes it reproducible
 * on a machine that has no toolchain installed and what keeps `graph.json` byte-identical for
 * identical input. So the alias map lands in the config once, where a human can read it, correct it
 * and keep it, and the build reads only what the human kept. The cost is stated rather than hidden:
 * a tsconfig edited after init drifts from the config until somebody reruns init or edits the
 * field, and `empo doctor` is where that is visible.
 *
 * **Why nothing here names TypeScript.** Which file to open and which field to read are declared by
 * the pack (`aliasSources`), so this module reads a JSON document at a dotted path and knows no
 * more about the language than `engine/mask.ts` knows about Vue. A python or go pack fills the same
 * three fields with its own answers and needs no line of this file changed.
 *
 * **Every gap is reported rather than dropped.** A seed that quietly skipped an `extends` it could
 * not follow, or a target shaped in a way it did not expect, would write a narrower map than the
 * repository is actually compiled with, and a narrower alias map is not a smaller answer: it is a
 * set of import edges that silently do not exist, which is a fan-in that reads as "almost nobody
 * uses this". So the notes travel back to `empo init` and get printed.
 */

export interface AliasSeed {
  /** Pattern to repo-relative targets, ready to be written into a root's `aliases`. */
  aliases: Record<string, string[]>;
  /** Repo-relative paths actually read, in the order they were read. */
  read: string[];
  /** What could not be seeded, in the words `empo init` prints. Empty when nothing was missed. */
  notes: string[];
}

/** How deep an `extends` chain is followed. Beyond this a config is describing a cycle. */
const MAX_EXTENDS = 8;

/**
 * The alias map for one root, or an empty one where the pack declares no sources, the file is
 * absent, or it holds no map. Those three are not the same fact, and **`read` is what tells them
 * apart, not `notes`**: none of the three is a gap the seeder hit, so none of them raises a note.
 * A pack with no `aliasSources` contributes nothing and never appears; a root whose file is absent
 * comes back with an empty `read`, and `empo init` prints "no toolchain config under it"; a file
 * that exists and declares no map is in `read`, and init prints "no aliases in <file>". `notes` is
 * reserved for what this could not read and a human might have expected it to.
 */
export function seedAliases(repoRoot: string, rootPath: string, pack: Pack): AliasSeed {
  const seed: AliasSeed = { aliases: {}, read: [], notes: [] };

  for (const source of pack.aliasSources ?? []) {
    readSource(repoRoot, rootPath, source, seed);
  }

  return seed;
}

/**
 * One declared source, and its `extends` chain, nearest first.
 *
 * A nearer file wins a pattern outright rather than merging its targets, because that is what the
 * toolchain does: a `paths` in the extending file replaces the inherited one whole. Merging would
 * produce a map that resolves imports the build does not.
 */
function readSource(
  repoRoot: string,
  rootPath: string,
  source: PackAliasSource,
  seed: AliasSeed,
): void {
  let relative = rootPath === "." ? source.file : posix.join(rootPath, source.file);

  for (let depth = 0; depth < MAX_EXTENDS; depth++) {
    const absolute = join(repoRoot, relative);
    if (!existsSync(absolute)) {
      // Only an extends can point at a file that is not there, and it is worth saying: the file
      // naming it is one the repository does control, so this is a broken reference rather than a
      // repository that never had aliases.
      if (depth > 0) seed.notes.push(`${relative} is named by an extends and does not exist`);
      return;
    }

    const document = parseDocument(absolute);
    if (document === null) {
      seed.notes.push(`${relative} could not be parsed, so its aliases were not read`);
      return;
    }
    seed.read.push(relative);

    collect(document, source, relative, seed);

    const inherited = fieldAt(document, source.extends);
    if (typeof inherited !== "string" || inherited === "") return;
    if (!inherited.startsWith("./") && !inherited.startsWith("../")) {
      seed.notes.push(
        `${relative} extends "${inherited}", which is a package rather than a path, so any ` +
          "aliases it declares were not read",
      );
      return;
    }

    relative = posix.normalize(posix.join(posix.dirname(relative), inherited));
    if (relative.startsWith("../")) {
      seed.notes.push(`${relative} is outside the repository, so its aliases were not read`);
      return;
    }
  }

  seed.notes.push(
    `${relative} extends more than ${MAX_EXTENDS} files, so the chain was not followed`,
  );
}

/**
 * The map in one parsed document, added to the seed under the patterns it does not already hold.
 *
 * Targets are resolved against the declared base if the file sets one and against the file's own
 * directory otherwise, which is TypeScript's rule for a `paths` written without a `baseUrl` and the
 * only rule that can be right for an inherited file: a base config's relative targets are relative
 * to the base config.
 */
function collect(
  document: unknown,
  source: PackAliasSource,
  relative: string,
  seed: AliasSeed,
): void {
  const map = fieldAt(document, source.paths);
  if (map === undefined || map === null) return;
  if (typeof map !== "object" || Array.isArray(map)) {
    seed.notes.push(`${relative} has a ${source.paths} that is not a map, so it was not read`);
    return;
  }

  const declaredBase = fieldAt(document, source.base);
  const base = posix.join(
    posix.dirname(relative),
    typeof declaredBase === "string" && declaredBase !== "" ? declaredBase : ".",
  );

  for (const [pattern, value] of Object.entries(map as Record<string, unknown>)) {
    // A nearer file already answered for this pattern. `hasOwn` and not `in`, because a pattern
    // spelled "constructor" or "toString" is on every object literal's prototype and would read as
    // answered by a file that never mentioned it.
    if (Object.hasOwn(seed.aliases, pattern)) continue;

    const targets = asTargets(value);
    if (targets === null) {
      seed.notes.push(
        `${relative} maps "${pattern}" to something that is not a path or a list of them, ` +
          "so it was not read",
      );
      continue;
    }

    const resolved = targets
      .map((target) => posix.normalize(posix.join(base, target)))
      .filter((target) => target !== "" && target !== "." && !target.startsWith("../"));

    if (resolved.length < targets.length) {
      seed.notes.push(
        `${relative} maps "${pattern}" outside the repository, and that target was dropped`,
      );
    }
    if (resolved.length > 0) seed.aliases[pattern] = resolved;
  }
}

/** A target is one path or a list of them. Anything else is a shape this cannot honestly read. */
function asTargets(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value as string[];
  }
  return null;
}

/**
 * A dotted field path into a parsed document, which is how a pack names a field without the engine
 * knowing what it means. Anything missing on the way answers undefined rather than throwing: a
 * config file is a human's and may hold any subset of what a pack expects.
 */
function fieldAt(document: unknown, path: string | undefined): unknown {
  if (path === undefined) return undefined;

  let current = document;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * These files are JSON with comments and trailing commas, which is what a toolchain that ships a
 * commented default template makes normal, so `JSON.parse` alone would fail on the majority of real
 * ones and the seed would report every such repository as having no aliases.
 *
 * Comments come out through `engine/mask.ts`, the same masker the extractor runs before any pack
 * rule, given the syntax JSON-with-comments has: it replaces a comment with spaces and it knows
 * that a `//` inside a string is not one. Trailing commas are then removed, and that is done after
 * masking rather than before so a comment holding a brace cannot change what a comma is trailing.
 * Strict JSON passes through both steps unchanged, so a repository that writes plain JSON is read
 * exactly as `JSON.parse` would read it.
 *
 * Returns null rather than throwing. A file this cannot read is one line in the init report, not a
 * failure of a command that has already written a config.
 */
function parseDocument(absolute: string): unknown {
  let source: string;
  try {
    source = readFileSync(absolute, "utf8");
  } catch {
    return null;
  }

  const masked = maskComments(source, {
    line: ["//"],
    block: [["/*", "*/"]],
    stringQuotes: ['"'],
    multilineQuotes: [],
    stringEscape: "\\",
  });

  try {
    return JSON.parse(masked.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

/**
 * The seed as a config field: patterns sorted, so two runs over one repository write the same file
 * whatever order the toolchain's own map happened to be in. `empo init` writes a file a human then
 * edits, and a generator that reorders a map between runs churns that file.
 */
export function sortedAliases(aliases: Record<string, string[]>): Record<string, string[]> {
  const sorted: Record<string, string[]> = {};
  for (const pattern of Object.keys(aliases).sort(compareStrings)) {
    const targets = aliases[pattern];
    if (targets !== undefined) sorted[pattern] = targets;
  }
  return sorted;
}
