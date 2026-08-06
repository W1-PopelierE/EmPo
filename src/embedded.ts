/**
 * The assets that ship inside the tool: the pack rules, the review discipline, and the version
 * string. Everywhere EmPo has a directory to read from, it reads from disk, and this module is
 * empty. The standalone binary (docs/10-distribution.md) has no such directory, so its build
 * replaces this module wholesale with the same three maps, populated.
 *
 * Empty is therefore the source, test and npm-package behaviour, and the whole of it: a reader
 * checking what `empo` does from a checkout gets the disk path unchanged, and nothing here costs
 * the published bundle a byte, because esbuild eliminates a branch guarded by an empty literal.
 *
 * **Populated wins wholesale.** When a map here has any entry at all, the disk roots are never
 * computed and never probed, rather than being consulted as a fallback. A binary installs to a
 * prefix like `/opt/homebrew/bin`, where `<here>/../packs` is a directory that may well exist and
 * belong to something else, so "embedded first, disk second" would let a stranger's file answer a
 * question the binary already carries the answer to. It also keeps the two states separable when
 * something goes wrong: an artifact either has its assets compiled in or reads them off disk, and
 * never half of each.
 */

/** `name` -> the verbatim text of `src/packs/<name>/pack.json`. */
export const EMBEDDED_PACKS: Readonly<Record<string, string>> = {};

/** File name (`review.md`, `map.md`) -> the verbatim text of `src/discipline/<name>`. */
export const EMBEDDED_DISCIPLINE: Readonly<Record<string, string>> = {};

/**
 * `package.json`'s `version`, compiled in. `src/program.ts` reads the file at runtime otherwise,
 * and a binary has no `package.json` beside it to read.
 */
export const EMBEDDED_VERSION: string | null = null;

/**
 * Whether this build carries its own assets, which is the same question as "is this the standalone
 * binary". Read off the packs map rather than tracked as a fourth flag, so the two cannot disagree.
 */
export function isEmbeddedBuild(): boolean {
  return Object.keys(EMBEDDED_PACKS).length > 0;
}
