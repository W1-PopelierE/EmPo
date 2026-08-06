/**
 * Types for `scripts/embed.mjs`, which is plain JavaScript because it is build tooling and runs
 * before anything is compiled. The declarations exist so `test/embedded.test.ts` can import it under
 * `strict` without a `@ts-expect-error`, which suppressed the whole import and would have hidden a
 * real signature change along with the expected missing-declaration complaint.
 *
 * `scripts/` is outside `tsconfig.json`'s `include`, so this file is never checked as a source file.
 * It is found the way any declaration file is found, by resolving the import beside it.
 */

/** `name` -> the verbatim text of `src/packs/<name>/pack.json`. */
export function collectPacks(root?: string): Record<string, string>;

/** File name (`review.md`, `map.md`) -> the verbatim text of `src/discipline/<name>`. */
export function collectDiscipline(root?: string): Record<string, string>;

/** The generated source that replaces `src/embedded.ts` in the standalone binary's build. */
export function embeddedModule(
  version: string,
  packs: Record<string, string>,
  discipline: Record<string, string>,
): string;

/** The names the generated module declares, compared against the real module's exports. */
export function embeddedExports(): string[];
