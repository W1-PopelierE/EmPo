import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { configError } from "../errors";
import type { EmpoConfig } from "../schema/config.schema";
import { parseSpineFile, type SpineFile } from "../schema/spine.schema";
import { type Citation, type CitationCheck, checkCitation } from "./citations";
import { compareStrings } from "./order";

/**
 * Layer 2's curated half: the spines (docs/08-spines.md). The graph says what connects to what; a
 * spine says what must still be true after one of those connections changes, which is a statement
 * about invariants and about what is *not* asserted, and absence is exactly what a generated graph
 * cannot represent.
 *
 * That makes a spine a hand-written artifact inside a tool whose first principle is that a claim is
 * worth nothing until something checked it. The reconciliation is this module: every `file:line` a
 * spine states carries an anchor, and every anchor is resolved against current source by the same
 * checker the review gate uses (engine/citations.ts). A spine is trusted not because it never rots,
 * but because its rot is detected.
 */

export interface LoadedSpine {
  spine: SpineFile;
  /** Repo-relative path of the file it was read from, so every message can name it. */
  path: string;
}

export function spinesDir(repoRoot: string, config: EmpoConfig): string {
  return join(repoRoot, config.spines);
}

/**
 * Every spine under the configured directory, in filename order. A repository with no spines is the
 * common case (docs/08: "most repos have zero or one"), so a missing directory is not an error: it
 * yields no spines, and every command over them reports having nothing to do.
 */
export function loadSpines(repoRoot: string, config: EmpoConfig): LoadedSpine[] {
  const dir = spinesDir(repoRoot, config);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];

  const files = readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort(compareStrings);

  return files.map((entry) => {
    const path = repoRelative(repoRoot, join(dir, entry));
    const spine = parseSpineFile(readJson(join(dir, entry), path), path);

    // The same rule a pack lives under (engine/pack-loader.ts): the name in the file is the name
    // every report, every gate message and every hook prints, so a file whose name says something
    // else leaves a human hunting for a spine that does not exist under that name.
    const expected = basename(entry, ".json");
    if (spine.name !== expected) {
      throw configError(
        `${path} declares name "${spine.name}" but the file is named "${expected}"`,
        [`Rename the file to ${spine.name}.json, or change "name" to "${expected}".`],
      );
    }

    return { spine, path };
  });
}

/**
 * Derived from the file that was really opened, never from the configured string. Echoing the config
 * back reports a `spines` of `./tools/spines` as `./tools/spines/money.json`, which is not the
 * repo-relative form every other path EmPo prints takes, and this one is printed by verify, by the
 * gate's failure, and by doctor: it is the path a human is told to open. Separators are forced to
 * `/` for the same reason engine/resolver.ts does its path arithmetic in posix.
 */
function repoRelative(repoRoot: string, absolute: string): string {
  return relative(repoRoot, absolute).split(sep).join("/");
}

function readJson(absolute: string, path: string): unknown {
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw configError(`${path} is not valid JSON`, [(error as Error).message]);
  }
}

export interface SpineCitation {
  /** Where in the spine it came from, e.g. `hop 1 "contract -> claim"`. Printed with every result. */
  where: string;
  citation: Citation;
}

/**
 * Every citation one spine states, in reading order: the chain first, then what must stay true, then
 * the gotchas. An invariant with no citation contributes nothing here, which is deliberate: a prose
 * invariant is a statement a human vouches for, and inventing an anchor for it would be the fiction
 * this module exists to prevent.
 */
export function spineCitations(spine: SpineFile): SpineCitation[] {
  const citations: SpineCitation[] = [];

  for (const hop of spine.hops) {
    citations.push({
      where: `hop ${hop.n} "${hop.title}"`,
      citation: { file: hop.file, line: hop.line, anchor: hop.anchor },
    });
  }

  for (const invariant of spine.invariants) {
    if (invariant.citation === undefined) continue;
    citations.push({ where: `invariant ${invariant.id}`, citation: invariant.citation });
  }

  for (const trap of spine.traps) {
    citations.push({
      where: `trap "${trap.what}"`,
      citation: { file: trap.file, line: trap.line, anchor: trap.anchor },
    });
  }

  return citations;
}

/**
 * Soft drift is a coordinate that slipped: the quoted source is still there, a few lines away, and
 * the fix is one number. Hard drift is a coordinate that now points at nothing, so every claim
 * resting on it is suspect until a human looks. Both fail `empo verify`, because a map that is
 * quietly five lines wrong misleads every reader who trusts it, and the two are reported apart
 * because the work they ask for is different (docs/08-spines.md).
 */
export type DriftLevel = "verified" | "soft" | "hard";

export interface CitationDrift extends SpineCitation {
  check: CitationCheck;
  level: DriftLevel;
}

export interface SpineReport {
  name: string;
  /** Repo-relative path of the spine file. */
  path: string;
  citations: CitationDrift[];
  verified: number;
  soft: number;
  hard: number;
}

export function verifySpine(repoRoot: string, loaded: LoadedSpine): SpineReport {
  const citations = spineCitations(loaded.spine).map((entry) => {
    const check = checkCitation(repoRoot, entry.citation);
    return { ...entry, check, level: levelOf(check) };
  });

  return {
    name: loaded.spine.name,
    path: loaded.path,
    citations,
    verified: citations.filter((entry) => entry.level === "verified").length,
    soft: citations.filter((entry) => entry.level === "soft").length,
    hard: citations.filter((entry) => entry.level === "hard").length,
  };
}

export function verifySpines(repoRoot: string, spines: LoadedSpine[]): SpineReport[] {
  return spines.map((loaded) => verifySpine(repoRoot, loaded));
}

export function drifted(reports: SpineReport[]): number {
  return reports.reduce((total, report) => total + report.soft + report.hard, 0);
}

function levelOf(check: CitationCheck): DriftLevel {
  if (check.status === "verified") return "verified";
  if (check.status === "moved") return "soft";
  return "hard";
}
