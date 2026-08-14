import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { globSync } from "tinyglobby";
import type { PackPackageSource } from "../schema/pack.schema";

/**
 * What one pass over a repository's manifests says: the package names it depends on and is not
 * itself, and where each package it **is** lives.
 *
 * The two answers come out of the same read because they are the same subtraction seen from either
 * side, and because the glob is the expensive half: a second entry point would walk a monorepo twice
 * per root to compute a set the first walk already had in hand.
 */
export interface RepoPackages {
  /** Names that name something outside this repository. See below for why the subtraction. */
  vendor: Set<string>;
  /**
   * Package name to the repo-relative directory of the manifest declaring it, for the packages this
   * repository **is**. The repository-root manifest maps to `""`, which is the whole tree and so
   * bounds nothing, which is the honest answer for a name that covers everything.
   *
   * A name two manifests declare is in neither: nothing here can say which directory was meant, and
   * a guess would redirect an edge at a file chosen by glob order. Dropping it leaves the name
   * resolving exactly as it did before this map existed.
   */
  internal: Map<string, string>;
}

/**
 * The package names a repository depends on and is not itself, read out of its own manifests.
 *
 * This is the only fact that separates `import Button from "@mui/material/Button"` from
 * `import { Button } from "@calcom/ui/components/button"`. Both are bare specifiers that resolve to
 * no file here — the first because the file is in `node_modules` and the second because a workspace
 * barrel is not on any alias map — and a name-resolving strategy handed either one asks the root's
 * index who carries `Button` and gets the same answer. One of those answers is a coupling and the
 * other is a basename collision, and only the manifests say which.
 *
 * **Dependencies minus own names**, in that order and never dependencies alone: a monorepo lists its
 * own workspaces as dependencies of each other, so `@calcom/ui` appears in both sets and has to come
 * out. What survives is the set of names that name something outside this repository.
 *
 * Nothing here reads an installed tree, and that is enforced here rather than left to the config's
 * `ignore`. An installed tree is a build artifact that a fresh checkout does not have and CI may
 * prune, so a graph whose refusals depended on it would answer differently on two machines with the
 * same commit — and the failure is silent and backwards: every installed package's manifest declares
 * its own `name`, so reading them subtracts `@mui/material` from the very set it belongs in and the
 * `vendor` verdict quietly stops firing on the repositories that have run an install.
 */
const INSTALLED_TREES = ["**/node_modules/**", "**/vendor/**", "**/bower_components/**"];
export function readPackages(
  repoRoot: string,
  source: PackPackageSource | undefined,
  ignore: string[] | undefined,
): RepoPackages {
  if (source === undefined) return { vendor: new Set(), internal: new Map() };

  const own = new Set<string>();
  const internal = new Map<string, string>();
  const duplicated = new Set<string>();
  const dependencies = new Set<string>();

  for (const relPath of globSync([`**/${source.file}`], {
    cwd: repoRoot,
    ignore: [...INSTALLED_TREES, ...(ignore ?? [])],
    onlyFiles: true,
    dot: false,
  })) {
    // A manifest that will not parse is not a claim about anything. Refusing to build over it would
    // stop a repository holding one broken fixture from being indexed at all, and defaulting it to
    // "no dependencies" would silently widen what the strategies resolve; skipping it leaves the
    // sets exactly as the manifests that do parse left them.
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(join(repoRoot, relPath), "utf8"));
    } catch {
      continue;
    }

    const name = manifest[source.name];
    if (typeof name === "string" && name !== "") {
      own.add(name);
      // tinyglobby yields forward slashes on every platform, which is what makes this comparable to
      // a node id: both are repo-relative and posix, and `engine/scanner.ts` says why that matters.
      const dir = posix.dirname(relPath);
      if (internal.has(name)) duplicated.add(name);
      internal.set(name, dir === "." ? "" : dir);
    }

    for (const field of source.dependencies) {
      const held = manifest[field];
      if (typeof held !== "object" || held === null) continue;
      for (const dependency of Object.keys(held)) dependencies.add(dependency);
    }
  }

  for (const name of own) dependencies.delete(name);
  for (const name of duplicated) internal.delete(name);
  return { vendor: dependencies, internal };
}

/**
 * The package a specifier names, or null where it names none.
 *
 * A scoped name is two segments and everything else is one, which is npm's own rule and the reason
 * `@mui/material/Button` and `@mui/material` both answer `@mui/material`. A relative or absolute
 * specifier names a path in this repository and no package at all.
 */
export function packageOf(specifier: string): string | null {
  if (specifier === "" || specifier.startsWith(".") || specifier.startsWith("/")) return null;

  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    const [scope, name] = segments;
    return scope !== undefined && name !== undefined ? `${scope}/${name}` : null;
  }
  return segments[0] ?? null;
}
