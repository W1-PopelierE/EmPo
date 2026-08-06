import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "tinyglobby";
import { normalizeRepoPath } from "../schema/config.schema";

/** One source file, with both path forms the rest of the engine needs. */
export interface ScannedFile {
  /**
   * The root's configured path, e.g. "apps/api" or "." for a single-root repo, flattened by the same
   * rule as `file` below. This is the value engine/build.ts copies into every node's `root`, and the
   * one engine/bridger.ts probes a bridge's declared roots with, engine/coverage.ts compares two
   * nodes on with `===`, and engine/health.ts checks a bridge side against. All three are string
   * comparisons, so a raw spelling here is a comparison that fails with no diagnostic anywhere.
   */
  root: string;
  lang: string;
  /** Repo-relative path, what lands in a node's `file` and an edge's evidence. */
  file: string;
  /** Root-relative path, what pack rules (kindRules, tests.paths) match against. */
  relPath: string;
  source: string;
}

export interface ScanOptions {
  repoRoot: string;
  root: { path: string; lang: string };
  extensions: string[];
  ignore?: string[];
}

/** Walk one root and read every file the pack owns. Sorted, so the whole pipeline is stable. */
export function scanRoot(options: ScanOptions): ScannedFile[] {
  const cwd = join(options.repoRoot, options.root.path);
  const patterns = options.extensions.map((extension) => `**/*${extension}`);

  const matches = globSync(patterns, {
    cwd,
    ignore: options.ignore ?? [],
    onlyFiles: true,
    dot: false,
  });

  // The two path fields below are one configured path written two ways, so they are flattened by one
  // call rather than side by side. Building `file` through `repoRelative` and `root` out of the raw
  // option is how they come to disagree: a caller that builds a root by hand, which commands/pack.ts
  // already does and any future caller may, never passes through the config schema's transform, and
  // then the node carries a normalized `file` next to a `root` that still spells `apps/api/`.
  const root = normalizeRepoPath(options.root.path);

  return matches.sort().map((relPath) => ({
    root,
    lang: options.root.lang,
    file: repoRelative(root, relPath),
    relPath,
    source: readFileSync(join(cwd, relPath), "utf8"),
  }));
}

/**
 * The `file` every node carries, and so the left-hand side of every prefix match engine/flows.ts
 * makes. It is built through `normalizeRepoPath` rather than beside it: a config validated by
 * schema/config.schema.ts arrives flattened already, and routing through the same function is what
 * keeps this true for the callers that build a root by hand (commands/pack.ts runs a pack fixture
 * under a literal `.`). A root naming the repository itself contributes no segment at all, which is
 * why `.` returns the root-relative path unchanged rather than prefixing `./`.
 *
 * It keeps normalizing even though `scanRoot` now hands it an already flattened root. The rule is
 * idempotent, so the second pass costs a comparison and nothing else, and the alternative is a
 * function whose correctness depends on what its caller remembered to do. That is the assumption
 * this docstring exists to refuse, and the other exported callers (test/engine/flows.test.ts builds
 * a node's `file` with it) are outside `scanRoot` entirely.
 */
export function repoRelative(rootPath: string, relPath: string): string {
  const root = normalizeRepoPath(rootPath);
  if (root === ".") return relPath;
  return `${root}/${relPath}`;
}
