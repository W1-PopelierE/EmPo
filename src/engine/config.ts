import { existsSync } from "node:fs";
import { join } from "node:path";
import { configError, parseOrThrow, readJson } from "../errors";
import { configSchema, type EmpoConfig } from "../schema/config.schema";

/** Both locations are supported on purpose, see docs/02-on-disk-layout.md. First match wins. */
export const CONFIG_LOCATIONS = [".empo/config.json", "empo.config.json"] as const;

export interface LoadedConfig {
  config: EmpoConfig;
  /** Absolute path of the file the config was read from. */
  path: string;
}

export function findConfigPath(repoRoot: string): string | null {
  for (const location of CONFIG_LOCATIONS) {
    const candidate = join(repoRoot, location);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Validate an already-parsed config value. Throws a config error (exit 2) with every issue. */
export function parseConfig(raw: unknown, source: string): EmpoConfig {
  return parseOrThrow(configSchema, raw, source, "EmPo config");
}

export function loadConfig(repoRoot: string): LoadedConfig {
  const path = findConfigPath(repoRoot);
  if (path === null) {
    throw configError("No EmPo config found", [
      `Looked for ${CONFIG_LOCATIONS.join(" and ")} under ${repoRoot}`,
      "Run empo init to create one.",
    ]);
  }

  return { config: parseConfig(readJson(path, path), path), path };
}
