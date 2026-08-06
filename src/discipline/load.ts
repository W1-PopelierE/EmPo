import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_DISCIPLINE, isEmbeddedBuild } from "../embedded";
import { configError } from "../errors";

/**
 * The discipline ships as data, not as a prompt buried in TypeScript (docs/07-review-discipline.md).
 * `empo review` reads it at runtime and hands it to whoever executes the review, which is what lets
 * a team read the workflow, diff it between versions, and see exactly what their agent was told.
 */

let roots: string[] | null = null;

/**
 * Resolved from src/discipline when running from source (vitest, tsx) and from dist/empo.js when
 * running the published package, where package.json ships src/discipline beside dist. Same two-root
 * trick as engine/pack-loader.ts, for the same reason, and computed on first use for the same
 * reason again: `import.meta.url` is empty in the CommonJS bundle the standalone binary is built
 * from, so an eager call here threw before any EmPo code ran (docs/10-distribution.md).
 */
function disciplineRoots(): string[] {
  if (!roots) {
    const here = dirname(fileURLToPath(import.meta.url));
    roots = [join(here, "..", "discipline"), join(here, "..", "src", "discipline")];
  }
  return roots;
}

/**
 * Where a discipline file is on disk. Disk-only, like `packDir`: a binary compiles the text in and
 * has no path to offer, so callers that want the text call `read` below and callers that genuinely
 * want a path (a test copying the file into a fake package layout) stay on the source tree.
 */
export function disciplinePath(name: string): string {
  for (const root of disciplineRoots()) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  throw configError(`The shipped discipline file "${name}" is missing`, [
    `Looked in ${disciplineRoots().join(" and ")}`,
    "This is a packaging fault, not a fault in the repository being reviewed.",
  ]);
}

function read(name: string): string {
  const embedded = EMBEDDED_DISCIPLINE[name];
  if (isEmbeddedBuild()) {
    if (embedded === undefined) {
      throw configError(`The shipped discipline file "${name}" is missing`, [
        "It was not compiled into this build.",
        "This is a packaging fault, not a fault in the repository being reviewed.",
      ]);
    }
    return embedded;
  }

  return readFileSync(disciplinePath(name), "utf8");
}

export function reviewWorkflow(): string {
  return read("review.md");
}

/** The map discipline `empo init` prints at its proposal step (docs/06-cli.md, docs/08-spines.md). */
export function mapWorkflow(): string {
  return read("map.md");
}
