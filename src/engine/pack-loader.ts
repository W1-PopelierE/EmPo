import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_PACKS, isEmbeddedBuild } from "../embedded";
import { configError } from "../errors";
import { packSchema } from "../schema/pack.schema";
import type { Pack } from "../schema/types";
import { compareStrings } from "./order";

let roots: string[] | null = null;

/**
 * Resolved from src/engine when running from source (vitest, tsx) and from dist/empo.js when
 * running the published package, where package.json ships src/packs/<name>/pack.json beside dist.
 *
 * Computed on first use rather than at module load, and that is load-bearing rather than a style
 * choice. `import.meta.url` is empty in the CommonJS bundle the standalone binary is built from
 * (docs/10-distribution.md), so evaluating this eagerly threw `ERR_INVALID_ARG_TYPE` out of
 * `fileURLToPath` before a single line of EmPo ran. A binary carries its packs in `src/embedded.ts`
 * and reaches this function never.
 */
function packRoots(): string[] {
  if (!roots) {
    const here = dirname(fileURLToPath(import.meta.url));
    roots = [join(here, "..", "packs"), join(here, "..", "src", "packs")];
  }
  return roots;
}

/**
 * Where a pack's files are on disk, which is a question only a build with a disk can answer. It
 * backs `empo pack test` and its fixture corpus, neither of which the binary ships, so it stays
 * disk-only and throws in a binary. `packAvailable` is the "is this pack installed" question, and
 * that one both builds answer.
 */
export function packDir(name: string): string {
  for (const root of packRoots()) {
    const candidate = join(root, name);
    if (existsSync(join(candidate, "pack.json"))) return candidate;
  }
  throw configError(`Unknown language pack "${name}"`, [
    `Looked in ${packRoots().join(" and ")}`,
    "Packs that ship with EmPo: php, typescript.",
  ]);
}

/**
 * Whether a pack is installed, without opening or parsing it. `engine/graph.ts` and
 * `engine/health.ts` both need to separate an absent pack from a present one that will not load,
 * and both used to ask by calling `packDir` inside a `try`. That reads as an exception standing in
 * for a boolean, and it stopped being correct once a build could carry a pack with no directory
 * behind it.
 */
export function packAvailable(name: string): boolean {
  if (isEmbeddedBuild()) return name in EMBEDDED_PACKS;

  return packRoots().some((root) => existsSync(join(root, name, "pack.json")));
}

/**
 * Every pack available, which is what detection has to work from before a config exists
 * (docs/06-cli.md, `empo init` step 1). A root that is not there is skipped rather than an error:
 * only one of the two ever exists at a time, source or bundle.
 */
export function installedPacks(): string[] {
  if (isEmbeddedBuild()) return Object.keys(EMBEDDED_PACKS).sort(compareStrings);

  const names = new Set<string>();

  for (const root of packRoots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (existsSync(join(root, entry, "pack.json"))) names.add(entry);
    }
  }

  return [...names].sort(compareStrings);
}

export function fixturesDir(name: string): string {
  return join(packDir(name), "fixtures");
}

export function loadPack(name: string): Pack {
  const embedded = isEmbeddedBuild() ? EMBEDDED_PACKS[name] : undefined;

  if (isEmbeddedBuild() && embedded === undefined) {
    throw configError(`Unknown language pack "${name}"`, [
      `Packs compiled into this build: ${Object.keys(EMBEDDED_PACKS).sort(compareStrings).join(", ")}`,
    ]);
  }

  // Named for the error messages below, which point a reader at a file to go and look at. An
  // embedded pack has no file, so it is named as what it is rather than as a path that is not there.
  const file = embedded === undefined ? join(packDir(name), "pack.json") : `pack "${name}"`;

  let raw: unknown;
  try {
    raw = JSON.parse(embedded ?? readFileSync(file, "utf8"));
  } catch (error) {
    throw configError(`${file} is not valid JSON`, [(error as Error).message]);
  }

  const result = packSchema.safeParse(raw);
  if (!result.success) {
    throw configError(
      `${file} is not a valid pack`,
      result.error.issues.map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      }),
    );
  }

  if (result.data.name !== name) {
    throw configError(`${file} declares name "${result.data.name}" but lives in packs/${name}`);
  }

  return result.data;
}
