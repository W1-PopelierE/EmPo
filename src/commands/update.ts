import { resolve } from "node:path";
import { loadConfig } from "../engine/config";
import { writeAgents } from "../host/agents";
import { type ClaudeFile, writeClaude } from "../host/claude";
import { writeCodex } from "../host/codex";

/**
 * `empo update`: regenerate the host instruction files from the shipped discipline plus this
 * project's config, so they name this repository's roots, forge and tracker (docs/06-cli.md,
 * docs/10-distribution.md). Run it after upgrading EmPo.
 *
 * Idempotent by construction, and it says so out loud: a generator whose output changes when its
 * inputs did not produces a diff on every run, and a file that appears in every diff is a file
 * nobody reads. `writeAgents` reports "unchanged" when the merge is byte-identical, which is what
 * this command exists to print.
 *
 * It rewrites only what EmPo owns, the block between its markers. Whatever a human wrote around
 * that block survives, because AGENTS.md belongs to the repository and EmPo is a guest in it.
 */

export function updateCommand(repoRoot: string): void {
  const { config, path } = loadConfig(repoRoot);

  // Claude first, because it is the one target that can refuse: an unreadable settings.json throws.
  // Do that before any generated file changes, then write the two skill targets and the shared
  // instruction block from the same config.
  const claude = writeClaude(repoRoot, config);
  const codex = writeCodex(repoRoot, config);
  const agents = writeAgents(repoRoot, config);
  const files = [{ path: agents.path, state: agents.state }, ...claude, ...codex];

  console.log("");
  console.log(`config     ${path}`);
  for (const file of files) {
    console.log(`host       ${file.state.padEnd(9)} ${relativeTo(repoRoot, file.path)}`);
  }
  console.log("");

  printRemoved(claude);

  if (files.every((file) => file.state === "unchanged")) {
    console.log("OK  host instructions already match this config");
    return;
  }

  console.log("OK  host instructions regenerated from this config");
  console.log("    In AGENTS.md only the block between the empo markers changed; settings.json");
  console.log("    keeps every non-EmPo entry; and the skill files are regenerated whole.");
}

/**
 * Hook entries this run removed and did not put back. Silent on an ordinary regenerate, because a
 * removed entry that is written straight back again is not news (host/claude.ts).
 *
 * It is printed rather than swallowed because it is the one loss here a human cannot debug: JSON has
 * no marker comments, so EmPo owns its hook entries by recognizing them, and an entry somebody wired
 * by hand looks exactly like one EmPo wrote. A EmPo release that changes a command string also lands
 * here once per repository, which is why this is worded as a note and not as an alarm.
 */
function printRemoved(files: ClaudeFile[]): void {
  const removed = files.flatMap((file) => file.removed ?? []);
  if (removed.length === 0) return;

  console.log(
    `note       ${removed.length === 1 ? "1 empo hook entry was" : `${removed.length} empo hook entries were`} removed and not written back.`,
  );
  for (const entry of removed) {
    const where = entry.matcher === undefined ? entry.event : `${entry.event} ${entry.matcher}`;
    console.log(`             ${where}: ${entry.command}`);
  }
  console.log("           If you wired any of those by hand, add them back under a command empo");
  console.log("           does not recognize, or expect this every run. After a empo upgrade that");
  console.log("           changed a command, this is the old spelling and needs nothing.");
  console.log("");
}

function relativeTo(repoRoot: string, path: string): string {
  const prefix = `${resolve(repoRoot)}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
