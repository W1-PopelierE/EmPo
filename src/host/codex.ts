import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { EmpoConfig } from "../schema/config.schema";
import { renderSkill, SKILL_NAMES, type SkillName } from "./claude";

/** The repo-local Codex target. EmPo owns these three files wholesale. */
export const CODEX_DIR = ".codex";

/** Repo-relative path of one generated Codex skill. */
export function codexSkillPath(name: SkillName): string {
  return `${CODEX_DIR}/skills/${name}/SKILL.md`;
}

export interface CodexFile {
  /** Repo-relative. */
  path: string;
  state: "created" | "updated" | "unchanged";
}

/**
 * Codex shares the workflow body with Claude, but accepts only `name` and `description` in skill
 * frontmatter. Keeping that host distinction here lets the discipline text stay one source.
 */
export function renderCodexSkill(name: SkillName, config: EmpoConfig): string {
  const lines = renderSkill(name, config).split("\n");
  const close = lines.indexOf("---", 1);
  if (close === -1) return renderSkill(name, config);

  return [
    "---",
    ...lines
      .slice(1, close)
      .filter((line) => line.startsWith("name:") || line.startsWith("description:")),
    "---",
    ...lines.slice(close + 1),
  ].join("\n");
}

/** Every Codex skill EmPo owns, written and reported in a deterministic order. */
export function writeCodex(repoRoot: string, config: EmpoConfig): CodexFile[] {
  return SKILL_NAMES.map((name) => {
    const path = codexSkillPath(name);
    const target = join(repoRoot, path);
    assertNoSymlinkComponent(repoRoot, target);
    const existing = read(target);
    const content = renderCodexSkill(name, config);
    if (existing === content) return { path, state: "unchanged" };

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return { path, state: existing === null ? "created" : "updated" };
  });
}

function read(target: string): string | null {
  try {
    return readFileSync(target, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Refuse a generated target that would make Node follow a repository-controlled symlink. */
function assertNoSymlinkComponent(repoRoot: string, target: string): void {
  let component = repoRoot;
  for (const segment of relative(repoRoot, target).split(sep)) {
    component = join(component, segment);
    try {
      if (lstatSync(component).isSymbolicLink()) {
        throw new Error(`Refusing to write Codex skill through symbolic link: ${component}`);
      }
    } catch (error: unknown) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
