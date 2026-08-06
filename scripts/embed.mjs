/**
 * The pure half of the standalone binary build: what gets compiled into the artifact, and the
 * source text that carries it. Separated from `build-binary.mjs` so a spec can reach it without
 * building a 110MB executable, because the one thing a test can genuinely pin about a build
 * artifact is whether the module it generates still matches the module it replaces.
 *
 * That is not a hypothetical failure. `src/embedded.ts` is imported by name from three places, so
 * a fourth export added there and not added here would leave the binary importing `undefined` while
 * every one of the four verifications stayed green, which is exactly how a pack field the schema
 * does not declare gets silently stripped (CLAUDE.md, "Language packs").
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every shipped pack's `pack.json`, verbatim, keyed by pack name. */
export function collectPacks(root = repoRoot) {
  const packsDir = join(root, "src", "packs");
  const packs = {};

  for (const name of readdirSync(packsDir).sort()) {
    try {
      packs[name] = readFileSync(join(packsDir, name, "pack.json"), "utf8");
    } catch {
      // Not a pack directory. Nothing under src/packs/ is required to be one.
    }
  }

  if (Object.keys(packs).length === 0) {
    throw new Error(`No packs found under ${packsDir}. A binary with no packs indexes nothing.`);
  }

  return packs;
}

/**
 * Every shipped discipline markdown file, verbatim, keyed by file name.
 *
 * `review.md` and `map.md` are named rather than counted, because a binary missing one of them
 * fails at the moment somebody runs a review rather than at the moment it is built, and a review is
 * the worst place to discover a packaging fault.
 */
export function collectDiscipline(root = repoRoot) {
  const disciplineDir = join(root, "src", "discipline");
  const files = {};

  for (const name of readdirSync(disciplineDir).sort()) {
    if (name.endsWith(".md")) files[name] = readFileSync(join(disciplineDir, name), "utf8");
  }

  for (const required of ["review.md", "map.md"]) {
    if (!(required in files)) throw new Error(`${required} is missing from ${disciplineDir}`);
  }

  return files;
}

/**
 * The generated replacement for `src/embedded.ts`. It must export exactly what the real module
 * exports, because every consumer imports from the real module and only the binary build swaps what
 * stands behind it.
 *
 * `JSON.stringify` on every value, so no pack's contents can terminate the literal holding it.
 */
export function embeddedModule(version, packs, discipline) {
  return [
    `export const EMBEDDED_PACKS = ${JSON.stringify(packs)};`,
    `export const EMBEDDED_DISCIPLINE = ${JSON.stringify(discipline)};`,
    `export const EMBEDDED_VERSION = ${JSON.stringify(version)};`,
    "export function isEmbeddedBuild() { return Object.keys(EMBEDDED_PACKS).length > 0; }",
  ].join("\n");
}

/** The names the generated module declares, which is what a spec compares against the real one. */
export function embeddedExports() {
  return ["EMBEDDED_PACKS", "EMBEDDED_DISCIPLINE", "EMBEDDED_VERSION", "isEmbeddedBuild"];
}
