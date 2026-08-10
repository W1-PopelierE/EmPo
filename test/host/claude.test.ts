import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mapWorkflow, reviewWorkflow } from "../../src/discipline/load";
import { parseConfig } from "../../src/engine/config";
import { EmpoError } from "../../src/errors";
import {
  empoHooks,
  HOOK_COMMAND_PREFIX,
  type HookEntries,
  hookCommandPrefix,
  isEmpoHook,
  LOCAL_BIN_PATH,
  mergeSettings,
  type RemovedHook,
  renderSkill,
  SETTINGS_PATH,
  SKILL_NAMES,
  skillPath,
  wiredHooks,
  writeClaude,
} from "../../src/host/claude";
import type { EmpoConfig } from "../../src/schema/config.schema";

/**
 * The second host target: standalone `.claude/` configuration (docs/10-distribution.md). The skill
 * files are EmPo's own and are generated whole, so they are pinned the way the AGENTS.md block is:
 * they name *this* repository, they are byte-stable, and they do not carry a second copy of a
 * discipline that lives somewhere else.
 *
 * `settings.json` is the dangerous half and most of this file is about it. It belongs to the
 * repository, it is where a team keeps its permissions and its own hooks, and EmPo merges into it.
 * Every case below is a way that merge could destroy somebody's configuration.
 */

/** Taken from the shipped disciplines themselves, so neither pin can rot silently. */
const REVIEW_LINE = "Read the ticket, its description and every comment, before you open the diff.";
const MAP_LINE = "**propose nothing you have not read.**";

function make(raw: Record<string, unknown>): EmpoConfig {
  return parseConfig({ version: 1, packs: { php: { version: "^1" } }, ...raw }, "a test config");
}

const TWO_ROOTS = make({
  roots: [
    { path: "apps/api", lang: "php" },
    { path: "apps/mobile", lang: "typescript" },
  ],
  packs: { php: { version: "^1" }, typescript: { version: "^1" } },
  adapters: { forge: { kind: "github", repo: "acme/platform" } },
});

const BARE = make({ roots: [{ path: ".", lang: "php" }] });

/**
 * An `mcp` forge and an `mcp` tracker, which is what a Bitbucket and Jira repository configures now
 * that there is no `bitbucket` kind and no `jira` kind. `host` is the free string naming them, and
 * text like these skills is the only thing in the tool that reads it: nothing branches on it, so a
 * case that stops printing it costs nothing anywhere a type-checker looks.
 */
const FULL = make({
  roots: [{ path: "apps/api", lang: "php", framework: "laravel" }],
  adapters: {
    forge: { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "platform" },
    tracker: { kind: "mcp", host: "jira", keyPattern: "[A-Z]{2,}-\\d+", project: "PLAT" },
  },
});

/**
 * The entries a target with no repo-local binary gets: the bare `empo hook ` spelling, which is
 * what every case below that is not about the wiring itself wants. Built from a directory that does
 * not exist, so it cannot pick up a `node_modules/.bin/empo` from whatever machine runs the suite.
 */
const BARE_HOOKS = empoHooks(join(tmpdir(), "empo-no-such-repo-at-all"));

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "empo-claude-"));
});

/** A target that has EmPo as a dependency, which is what `npm install` leaves behind. */
function seedLocalBin(): void {
  seed(LOCAL_BIN_PATH, '#!/bin/sh\nexec empo "$@"\n');
}

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function read(path: string): string {
  return readFileSync(join(repo, path), "utf8");
}

function seed(path: string, content: string): void {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

/** Every hook command in a merged document, wherever it sits. */
function commands(text: string): string[] {
  const document = JSON.parse(text) as { hooks?: Record<string, { hooks?: unknown[] }[]> };
  const found: string[] = [];
  for (const groups of Object.values(document.hooks ?? {})) {
    for (const group of groups) {
      for (const entry of group.hooks ?? []) {
        found.push((entry as { command: string }).command);
      }
    }
  }
  return found;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The merged text. Every case but the removal report below cares only about this half. */
function text(existing: string | null, entries: HookEntries): string {
  return mergeSettings(existing, entries).text;
}

/** What the merge took out and did not put back. Empty on every ordinary run. */
function removed(existing: string | null, entries: HookEntries = BARE_HOOKS): RemovedHook[] {
  return mergeSettings(existing, entries).removed;
}

function expectRefusal(body: () => unknown): EmpoError {
  try {
    body();
    return expect.unreachable("expected a EmpoError");
  } catch (error) {
    expect(error).toBeInstanceOf(EmpoError);
    // A config error, exit 2: the repository is in a state a human has to resolve, and nothing was
    // written while it is.
    expect((error as EmpoError).exitCode).toBe(2);
    return error as EmpoError;
  }
}

describe("the ownership rule", () => {
  // There is no marker comment available in JSON, so ownership is by content and this predicate is
  // the whole of it. Everything the merge removes, it removes because of this function.
  test("owns a command entry whose command starts with the prefix", () => {
    expect(HOOK_COMMAND_PREFIX).toBe("empo hook ");
    expect(isEmpoHook({ type: "command", command: `${HOOK_COMMAND_PREFIX}pre-edit` })).toBe(true);
  });

  test("owns both spellings, which is what keeps an upgrade from doubling the hooks", () => {
    // The regression pin. EmPo writes a bare `empo hook` in a target with no local binary and a
    // repo-local path in one that has it, so a predicate that knew only the prefix would fail to
    // recognize an entry a previous release wrote, leave it in place, and append the new one beside
    // it. Two hooks would fire on every edit from then on.
    for (const command of [
      `empo hook pre-edit --repo "\${CLAUDE_PROJECT_DIR}"`,
      `\${CLAUDE_PROJECT_DIR}/node_modules/.bin/empo hook pre-edit --repo "\${CLAUDE_PROJECT_DIR}"`,
      "/usr/local/bin/empo hook session-start",
      // A Windows path separator, which is the other thing a path can be spelled with.
      "C:\\tools\\empo hook pre-commit",
      // Somebody's own wrapper, which is the cost of the widening: the same string shape as the
      // repo-local form and therefore indistinguishable from it. The merge reports the removal.
      "./scripts/empo hook pre-edit",
    ]) {
      expect(isEmpoHook({ type: "command", command })).toBe(true);
    }
  });

  test("owns every entry it writes, by construction", () => {
    // The writer and the predicate cannot drift apart: whatever `empoHooks` produces for a target,
    // the predicate recognizes. If this ever fails, a regenerate would double EmPo's own entries
    // instead of replacing them.
    seedLocalBin();
    for (const entries of [BARE_HOOKS, empoHooks(repo)]) {
      const written = Object.values(entries).flatMap((groups) =>
        groups.flatMap((group) => group.hooks),
      );

      expect(written.length).toBeGreaterThan(0);
      for (const entry of written) expect(isEmpoHook(entry)).toBe(true);
    }
  });

  test("owns nothing else, however much it looks like EmPo's", () => {
    for (const entry of [
      // A team that wired the gate in by hand. Theirs, and it survives every regenerate.
      { type: "command", command: "empo check --json" },
      { type: "command", command: "empo hooks --repo ." },
      // The word is in there, but not as the command: neither at the start nor after a separator.
      { type: "command", command: "echo empo hook pre-edit" },
      { type: "command", command: "npx empo hook pre-edit" },
      { type: "command", command: "empoy/empo-hook pre-edit" },
      // A future entry type that is not a command is not something EmPo can identify as its own.
      { type: "prompt", command: "empo hook pre-edit" },
      { command: "empo hook pre-edit" },
      "empo hook pre-edit",
      null,
      ["empo hook pre-edit"],
    ]) {
      expect(isEmpoHook(entry)).toBe(false);
    }
  });
});

describe("which binary the hooks reach for", () => {
  test("wires the bare command in a target with no repo-local binary", () => {
    expect(hookCommandPrefix(repo)).toBe("empo hook ");
    expect(commands(text(null, empoHooks(repo)))).toEqual([
      `empo hook session-start --repo "\${CLAUDE_PROJECT_DIR}"`,
      `empo hook pre-edit --repo "\${CLAUDE_PROJECT_DIR}"`,
      `empo hook pre-commit --repo "\${CLAUDE_PROJECT_DIR}"`,
    ]);
  });

  test("wires the repo-local binary when the target has one", () => {
    // A fixed in-repo path, identical for every teammate and safe to commit, and it resolves no
    // interpreter. A bare `empo` is a global install, which is per interpreter and vanishes on a
    // Node version switch, after which the hooks fail open in silence.
    seedLocalBin();

    const local = `\${CLAUDE_PROJECT_DIR}/node_modules/.bin/empo hook `;
    expect(hookCommandPrefix(repo)).toBe(local);
    expect(commands(text(null, empoHooks(repo)))).toEqual([
      `${local}session-start --repo "\${CLAUDE_PROJECT_DIR}"`,
      `${local}pre-edit --repo "\${CLAUDE_PROJECT_DIR}"`,
      `${local}pre-commit --repo "\${CLAUDE_PROJECT_DIR}"`,
    ]);
  });

  test("rewires a settings.json wired the old way to exactly one hook per event", () => {
    // `empo update` finds its own previous entries through `isEmpoHook` and replaces them. A
    // repository wired before the binary existed, that has since installed EmPo, must come out of
    // the update with three hooks and not six.
    seedLocalBin();
    seed(SETTINGS_PATH, text(null, BARE_HOOKS));

    writeClaude(repo, BARE);

    const written = commands(read(SETTINGS_PATH));
    expect(written).toHaveLength(3);
    expect(written.every((one) => one.startsWith(`\${CLAUDE_PROJECT_DIR}/`))).toBe(true);
    // And the bare entries are gone rather than sitting beside the new ones.
    expect(written.some((one) => one.startsWith("empo hook "))).toBe(false);
  });

  test("runs twice over a repo-local wiring without doubling a single hook", () => {
    // THE case, and the direction the old prefix-only predicate got wrong: it did not recognize
    // the path-prefixed entry as EmPo's, so a second `empo update` left the first run's three hooks
    // in place and appended three more. Six hooks, two of every gate, on every session from then on.
    seedLocalBin();
    writeClaude(repo, BARE);
    const once = read(SETTINGS_PATH);

    const again = writeClaude(repo, BARE);

    expect(commands(read(SETTINGS_PATH))).toHaveLength(3);
    expect(read(SETTINGS_PATH)).toBe(once);
    expect(again[3]).toEqual({ path: SETTINGS_PATH, state: "unchanged" });
  });

  test("says it removed the old entries, because it did not put them back", () => {
    // The noisy edge of the ownership rule, and correct: the command string really changed, so a
    // human who had hand-wired the bare form hears about it once.
    seedLocalBin();

    expect(removed(text(null, BARE_HOOKS), empoHooks(repo)).map((one) => one.command)).toEqual([
      `empo hook session-start --repo "\${CLAUDE_PROJECT_DIR}"`,
      `empo hook pre-edit --repo "\${CLAUDE_PROJECT_DIR}"`,
      `empo hook pre-commit --repo "\${CLAUDE_PROJECT_DIR}"`,
    ]);
  });

  test("is still idempotent over its own repo-local output", () => {
    seedLocalBin();
    const once = text(null, empoHooks(repo));

    expect(text(once, empoHooks(repo))).toBe(once);
    expect(commands(text(once, empoHooks(repo)))).toHaveLength(3);
    expect(removed(once, empoHooks(repo))).toEqual([]);
  });
});

describe("the generated skills", () => {
  test("are the three slash commands, each at its own path", () => {
    expect([...SKILL_NAMES]).toEqual(["empo-query", "empo-review", "empo-map"]);
    // A directory under .claude/skills is the command's name, with no namespace a generator gets to
    // choose. Hence the hyphen: `/empo-query`, not `/empo:query`, which would need a plugin.
    expect(skillPath("empo-query")).toBe(".claude/skills/empo-query/SKILL.md");
  });

  test("open with frontmatter and say they are generated", () => {
    for (const name of SKILL_NAMES) {
      const skill = renderSkill(name, FULL);

      expect(skill.startsWith("---\n")).toBe(true);
      expect(skill).toContain(`name: ${name}`);
      expect(skill).toContain("description: ");
      expect(skill).toContain("empo update");
      expect(skill).toContain("lost");
      expect(skill.endsWith("\n")).toBe(true);
      expect(skill.endsWith("\n\n")).toBe(false);
    }
  });

  test("let the model reach for a query and nothing else", () => {
    // Asking the graph before guessing at consumers is the one worth firing automatically. A review
    // and a mapping pass are deliberate acts, and one that starts itself is one nobody asked for.
    expect(renderSkill("empo-query", FULL)).not.toContain("disable-model-invocation");
    expect(renderSkill("empo-review", FULL)).toContain("disable-model-invocation: true");
    expect(renderSkill("empo-map", FULL)).toContain("disable-model-invocation: true");
  });

  test("name this repository's roots and their languages", () => {
    for (const name of SKILL_NAMES) {
      const skill = renderSkill(name, TWO_ROOTS);

      expect(skill).toContain("apps/api");
      expect(skill).toContain("php");
      expect(skill).toContain("apps/mobile");
      expect(skill).toContain("typescript");
    }
  });

  test("name the framework a root declares, because it decides which extractors run", () => {
    expect(renderSkill("empo-query", FULL)).toContain("laravel");
  });

  test("name the configured forge and tracker", () => {
    const skill = renderSkill("empo-review", FULL);

    // The kind is what the engine acts on, the host is what the agent acts on. Both are printed:
    // "Forge: `mcp`" alone does not tell an agent which of its connectors to reach for.
    expect(skill).toContain("Forge: `mcp`");
    expect(skill).toContain("bitbucket");
    expect(skill).toContain("Tracker: `mcp`");
    expect(skill).toContain("jira");
    expect(skill).toContain("PLAT");
  });

  test("say what degrades when there is no forge and no tracker", () => {
    // An agent that is not told an adapter is missing reads the review's silence as "the ticket was
    // fine" and "there was no pull request to read", which are both fabrications.
    const skill = renderSkill("empo-review", BARE);

    expect(skill).toContain("Forge: none configured");
    expect(skill).toContain("local diff");
    expect(skill).toContain("Tracker: none configured");
    expect(skill).toContain("ticket-fit");
  });

  test("degrade the same way for an adapter deliberately set to local or none", () => {
    const chosen = make({
      roots: [{ path: ".", lang: "php" }],
      adapters: { forge: { kind: "local" }, tracker: { kind: "none" } },
    });
    const skill = renderSkill("empo-review", chosen);

    expect(skill).toContain("Forge: `local`");
    expect(skill).toContain("Tracker: `none`");
    expect(skill).not.toContain("none configured");
  });

  test("name the missing bridge, because its absence reads as an answer", () => {
    // Two roots and no bridge means cross-language reach reads as zero, which is exactly what a
    // repository with no coupling at all reports. Left unsaid, the headline feature looks like it
    // was tried and found nothing.
    expect(renderSkill("empo-query", TWO_ROOTS)).toContain("No bridge is configured");
    // One root cannot have a bridge, so there is no gap to report.
    expect(renderSkill("empo-query", BARE)).not.toContain("No bridge is configured");
  });

  test("name the bridges a two-root repository does have", () => {
    const bridged = make({
      roots: [
        { path: "apps/api", lang: "php" },
        { path: "apps/mobile", lang: "typescript" },
      ],
      packs: { php: { version: "^1" }, typescript: { version: "^1" } },
      bridges: [{ kind: "http-route", produces: "apps/api", consumes: "apps/mobile" }],
    });
    const skill = renderSkill("empo-query", bridged);

    expect(skill).toContain("http-route");
    expect(skill).not.toContain("No bridge is configured");
  });

  test("point at the discipline each command prints instead of copying it", () => {
    // The copy `empo review` and `empo init` hand over is the one the verification gate is built
    // around. A second copy in a generated file drifts from it and teaches a workflow the gate does
    // not implement, which is why this rule is not stylistic.
    const review = renderSkill("empo-review", TWO_ROOTS);
    const map = renderSkill("empo-map", TWO_ROOTS);

    expect(reviewWorkflow()).toContain(REVIEW_LINE);
    expect(mapWorkflow()).toContain(MAP_LINE);
    expect(review).not.toContain(REVIEW_LINE);
    expect(map).not.toContain(MAP_LINE);
    expect(review).toContain("empo review");
    expect(map).toContain("empo init");
  });

  test("are byte-identical for the same config, twice", () => {
    // A generated file that changes between runs produces a diff on every run, which trains a team
    // to stop reading the diff.
    for (const name of SKILL_NAMES) {
      expect(renderSkill(name, FULL)).toBe(renderSkill(name, FULL));
      expect(renderSkill(name, FULL)).not.toBe(renderSkill(name, TWO_ROOTS));
    }
  });
});

/**
 * `/empo-review` is where an agent meets an `mcp` forge, so it is the file that has to carry the
 * payload protocol. EmPo cannot reach the host: the pull request arrives only because these lines
 * asked for it, and if they are wrong every review quietly degrades to a local diff.
 *
 * The protocol itself is written once, in src/host/agents.ts, and shared with the AGENTS.md block.
 * These cases pin that it arrives here, and that it does not arrive where it is only noise.
 */
describe("the mcp payload protocol in the skills", () => {
  test("empo-review names the host and says the review stops to ask for a payload", () => {
    const skill = renderSkill("empo-review", FULL);

    expect(skill).toContain("backed by bitbucket");
    expect(skill).toContain("your bitbucket tool");
    expect(skill).toContain("request block");
    expect(skill).toContain("normal path and not an error");
  });

  test("empo-review says the first run reviews nothing, before it says anything else", () => {
    // The skill's own body, not the shared adapter text: an agent reads the command it is about to
    // run before it reads the repository facts under it, and phase 0 is what that run will do.
    const skill = renderSkill("empo-review", FULL);

    expect(skill).toContain("The first run against a pull request id reviews nothing");
    expect(skill.indexOf("reviews nothing")).toBeLessThan(skill.indexOf("Run what it prints"));
  });

  test("sends the agent to the request block for the fields, and copies no table", () => {
    // The skill used to point down at a mapping table in its own repository-facts section, which
    // only a Bitbucket host ever got. Now it points at the request block, which prints the mapping
    // from the code that reads the payload back and is therefore the copy that cannot be stale.
    const gitlab = make({
      roots: [{ path: ".", lang: "php" }],
      adapters: { forge: { kind: "mcp", host: "gitlab" } },
    });

    for (const config of [FULL, gitlab]) {
      const skill = renderSkill("empo-review", config);

      expect(skill).toContain("phase 0");
      expect(skill).toContain(
        "The request block itself carries the path, the exact JSON and the fields",
      );
      expect(skill).not.toContain("author.display_name");
    }
  });

  test("counts the phases one way, so phase 0 and 'two phases' cannot contradict", () => {
    // Found by reading the rendered file rather than by a failing case: it said "that run is phase
    // 0" near the top and "a review is two phases" further down, leaving an agent to work out
    // whether it had missed a step. Two numberings of one procedure is two instructions.
    expect(renderSkill("empo-review", FULL)).toContain("two more phases after the fetch above");
    expect(renderSkill("empo-review", TWO_ROOTS)).toContain("a review is two phases");
    expect(renderSkill("empo-review", TWO_ROOTS)).not.toContain("phase 0");
  });

  test("empo-review carries the four traps, which are the part no request block repeats early", () => {
    // The traps stay here rather than moving to the request block with the field names. They are
    // habits to break before the agent starts, not fields to copy while it writes the payload, and
    // an agent that has already fetched the diff has already paid for it.
    const skill = renderSkill("empo-review", FULL);

    expect(skill).toContain("Do not fetch the diff");
    expect(skill).toContain('Write `""` for an empty description');
    expect(skill).toContain("Omit `ci`");
    expect(skill).toContain("Nothing can be posted back");
    expect(skill).toContain("Echo the key EmPo asked for back, verbatim, in `key`");
  });

  test("empo-query and empo-map name the forge without the whole protocol", () => {
    // They will never meet the request block, and a mapping table between a `empo query` and the
    // answer somebody came for is thirty lines to skim past. A file that trains an agent to skim
    // gets skimmed on the day it matters. What they keep is the sentence that says the stop exists.
    for (const name of ["empo-query", "empo-map"] as const) {
      const skill = renderSkill(name, FULL);

      expect(skill).toContain("backed by bitbucket");
      expect(skill).toContain("request block");
      expect(skill).not.toContain("author.display_name");
      expect(skill).not.toContain("Do not fetch the diff");
    }
  });

  test("promises none of it for a forge that is not mcp", () => {
    // The defect this case exists for. The skills used to special-case `local` and tell an agent of
    // every other kind that the review reads the pull request from there, which under `mcp` with no
    // payload was a sentence about a fetch that was not happening.
    const github = make({
      roots: [{ path: ".", lang: "php" }],
      adapters: { forge: { kind: "github", repo: "acme/platform" }, tracker: { kind: "none" } },
    });

    for (const config of [github, BARE]) {
      for (const name of SKILL_NAMES) {
        const skill = renderSkill(name, config);

        expect(skill).not.toContain("request block");
        expect(skill).not.toContain("Do not fetch the diff");
        expect(skill).not.toContain("reviews nothing");
      }
    }
    expect(renderSkill("empo-review", github)).toContain("reads the pull request");
  });
});

describe("mergeSettings", () => {
  test("writes EmPo's hooks when there is no file", () => {
    const merged = text(null, BARE_HOOKS);

    expect(JSON.parse(merged)).toEqual({ hooks: BARE_HOOKS });
    // Two spaces and a trailing newline, the shape of every other JSON artifact EmPo writes.
    expect(merged.endsWith("}\n")).toBe(true);
    expect(merged).toContain('\n  "hooks"');
    expect(merged).toBe(text(null, BARE_HOOKS));
  });

  test("expands the project directory in the command, and counts the timeout in seconds", () => {
    const written = commands(text(null, BARE_HOOKS));

    // The host expands ${CLAUDE_PROJECT_DIR} before the command runs, so a hook resolves the
    // repository it was configured for and not whatever directory the session happens to sit in.
    expect(written).toEqual([
      `empo hook session-start --repo "\${CLAUDE_PROJECT_DIR}"`,
      `empo hook pre-edit --repo "\${CLAUDE_PROJECT_DIR}"`,
      `empo hook pre-commit --repo "\${CLAUDE_PROJECT_DIR}"`,
    ]);
    expect(BARE_HOOKS.PreToolUse?.map((group) => group.matcher)).toEqual(["Edit|Write", "Bash"]);
    // Seconds. A timeout written in milliseconds would be a tenth of a second in practice.
    expect(BARE_HOOKS.SessionStart?.[0]?.hooks[0]?.timeout).toBe(10);
  });

  test("fills an empty document the same way", () => {
    expect(text("{}", BARE_HOOKS)).toBe(text(null, BARE_HOOKS));
    expect(text("", BARE_HOOKS)).toBe(text(null, BARE_HOOKS));
  });

  test("leaves every unrelated key exactly as it found it", () => {
    // The whole reason settings.json is merged and not generated: this is where a team keeps its
    // permissions, its environment and its model choice, and none of it is reproducible.
    const theirs = {
      model: "opus",
      permissions: { allow: ["Bash(npm run test:*)"], deny: ["Read(./.env)"] },
      env: { NODE_ENV: "development" },
    };

    const merged = JSON.parse(text(json(theirs), BARE_HOOKS)) as Record<string, unknown>;

    expect(merged.model).toEqual(theirs.model);
    expect(merged.permissions).toEqual(theirs.permissions);
    expect(merged.env).toEqual(theirs.env);
    expect(merged.hooks).toEqual(BARE_HOOKS);
  });

  test("keeps a team's own hooks on the same events, and does not dedupe them away", () => {
    // A hook a human wrote on the same event with the same matcher is theirs. EmPo appends its own
    // group rather than joining one that looks similar, so their group is never edited.
    const theirs = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "./scripts/greet.sh" }] }],
        PreToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: "./scripts/lint-staged.sh", timeout: 5 }],
          },
          { matcher: "Bash", hooks: [{ type: "command", command: "empo check --json" }] },
        ],
      },
    };

    const merged = JSON.parse(text(json(theirs), BARE_HOOKS)) as {
      hooks: Record<string, { matcher?: string; hooks: unknown[] }[]>;
    };

    // Theirs first, untouched, and then EmPo's own groups.
    expect(merged.hooks.SessionStart?.[0]).toEqual(theirs.hooks.SessionStart[0]);
    expect(merged.hooks.PreToolUse?.[0]).toEqual(theirs.hooks.PreToolUse[0]);
    expect(merged.hooks.PreToolUse?.[1]).toEqual(theirs.hooks.PreToolUse[1]);
    expect(merged.hooks.PreToolUse?.slice(2)).toEqual(BARE_HOOKS.PreToolUse);
    expect(commands(text(json(theirs), BARE_HOOKS))).toContain("empo check --json");
  });

  test("is idempotent over its own output", () => {
    // The pin behind running `empo update` from a hook or a CI step: a second run changes nothing.
    const once = text(null, BARE_HOOKS);

    expect(text(once, BARE_HOOKS)).toBe(once);
    expect(commands(text(once, BARE_HOOKS))).toHaveLength(3);
  });

  test("replaces an entry an older version wrote instead of doubling it", () => {
    // The entry is identified by its prefix, not by its exact text, so a command string that
    // changed between releases (or that somebody edited by hand) is still recognized as EmPo's.
    const stale = {
      hooks: {
        PreToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command: "empo hook pre-edit" }] },
        ],
      },
    };

    const written = commands(text(json(stale), BARE_HOOKS));

    expect(written).toEqual(commands(text(null, BARE_HOOKS)));
    expect(written).not.toContain("empo hook pre-edit");
  });

  test("drops a group EmPo emptied rather than leaving an empty hooks array", () => {
    const going: HookEntries = { PreToolUse: [{ matcher: "Edit|Write", hooks: [] }] };
    const existing = json({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "empo hook pre-commit" }] },
          { matcher: "Edit|Write", hooks: [{ type: "command", command: "./scripts/lint.sh" }] },
        ],
      },
    });

    const merged = JSON.parse(text(existing, going)) as {
      hooks: { PreToolUse: unknown[] };
    };

    // The Bash group held one EmPo entry and nothing else, so the group goes with it. A leftover
    // { "matcher": "Bash", "hooks": [] } is dead configuration nobody would know to delete.
    expect(merged.hooks.PreToolUse).toEqual([
      { matcher: "Edit|Write", hooks: [{ type: "command", command: "./scripts/lint.sh" }] },
      { matcher: "Edit|Write", hooks: [] },
    ]);
  });

  test("drops an event, and the hooks key, that EmPo emptied", () => {
    const onlyEmpo = json({
      model: "opus",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "empo hook session-start" }] }],
      },
    });

    const merged = JSON.parse(text(onlyEmpo, {})) as Record<string, unknown>;

    expect(merged).toEqual({ model: "opus" });
  });

  test("leaves an empty group, event or hooks key that arrived that way", () => {
    // EmPo removes what it can prove is its own, and an empty array proves nothing. The asymmetry
    // with the test above is the point: a group EmPo emptied goes, one that was already empty
    // stays. Preserving it is also what keeps this reporting `unchanged` on every run, not once.
    for (const theirs of [
      json({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } }),
      json({ hooks: { PreToolUse: [] } }),
      json({ hooks: {} }),
    ]) {
      expect(text(theirs, {})).toBe(theirs);
    }
  });

  test("decides unchanged on the parsed document, not the printed text", () => {
    // The subtle one, and the reason the rule is written this way. Serializing is lossy for
    // formatting, so a text comparison would reformat a file EmPo has no change to make, on every
    // single run, and blame the diff on `empo update`.
    const fourSpaces = JSON.stringify({ hooks: BARE_HOOKS }, null, 4);

    expect(text(fourSpaces, BARE_HOOKS)).toBe(fourSpaces);
  });

  test("does not reorder a document whose keys sit in another order", () => {
    const reordered = json({
      hooks: {
        PreToolUse: [...(BARE_HOOKS.PreToolUse ?? [])],
        SessionStart: [...(BARE_HOOKS.SessionStart ?? [])],
      },
      permissions: { allow: [] },
      model: "opus",
    });

    expect(text(reordered, BARE_HOOKS)).toBe(reordered);
  });

  test("refuses a file that is not valid JSON", () => {
    // Never rewrite a file you could not read. The alternative is starting from {} and silently
    // deleting a team's permissions because their editor allowed a trailing comma.
    const error = expectRefusal(() =>
      text('{\n  // our settings\n  "model": "opus",\n}\n', BARE_HOOKS),
    );

    expect(error.message).toContain(SETTINGS_PATH);
    expect(error.message).toContain("nothing was written");
    expect([error.message, ...error.details].join("\n")).toContain("JSON");
  });

  test("names a byte order mark, which is the syntax error a human cannot see", () => {
    // Still refused, because silently stripping bytes is the thing this whole function does not do.
    // But an editor that writes a BOM does not show it, so "not valid JSON" sends someone hunting
    // for a comma that is not there.
    const withBom = `﻿${json({ model: "opus" })}`;

    const said = [...expectRefusal(() => text(withBom, BARE_HOOKS)).details].join("\n");

    expect(said).toContain("byte order mark");
    // And not a word about it when there is none, so the ordinary message stays uncluttered.
    const ordinary = expectRefusal(() => text('{ "model": }', BARE_HOOKS));
    expect([...ordinary.details].join("\n")).not.toContain("byte order mark");
  });

  test("refuses a document that is not a JSON object", () => {
    expectRefusal(() => text("[]", BARE_HOOKS));
    expectRefusal(() => text('"settings"', BARE_HOOKS));
    expectRefusal(() => text("null", BARE_HOOKS));
  });

  test("refuses a hooks key that is not an object", () => {
    for (const hooks of ['"all of them"', "[]", "7", "null"]) {
      const error = expectRefusal(() => text(`{ "hooks": ${hooks} }`, BARE_HOOKS));
      expect(error.message).toContain(SETTINGS_PATH);
    }
  });

  test("refuses an event whose value is not an array", () => {
    const error = expectRefusal(() =>
      text(json({ hooks: { PreToolUse: { matcher: "Bash" } } }), BARE_HOOKS),
    );

    expect(error.message).toContain("PreToolUse");
  });

  test("passes through a group it cannot read rather than deleting it", () => {
    // It holds no entry EmPo can identify, so there is nothing to remove. Refusing would lock a
    // repository out of `empo update` over a shape that costs nothing to leave alone.
    const odd = json({ hooks: { PreToolUse: ["a string", { matcher: "Bash" }] } });

    const merged = JSON.parse(text(odd, BARE_HOOKS)) as {
      hooks: { PreToolUse: unknown[] };
    };

    expect(merged.hooks.PreToolUse.slice(0, 2)).toEqual(["a string", { matcher: "Bash" }]);
  });
});

describe("what the merge reports removing", () => {
  /**
   * The one failure here a user cannot debug. Ownership is by content, so a `empo hook` entry a
   * human wired by hand is indistinguishable from one EmPo wrote, and it disappears inside a diff
   * that looks like a routine regenerate. The rule cannot be fixed without breaking the upgrade
   * case, so the silence is what gets fixed: anything taken out and not put back in the same place
   * is named, with enough to restore it by hand.
   */
  test("says nothing on an ordinary run, or on a repository with no settings at all", () => {
    // The half that matters most. A report that fires on every run is a report nobody reads, and
    // this one has to still be worth reading on the day it fires for real.
    expect(removed(null)).toEqual([]);
    expect(removed(json({ permissions: { allow: [] } }))).toEqual([]);
    expect(removed(text(null, BARE_HOOKS))).toEqual([]);
    expect(removed(JSON.stringify({ hooks: BARE_HOOKS }, null, 4))).toEqual([]);
  });

  test("names an entry a human wired onto an event EmPo does not use", () => {
    // Identical to one EmPo puts back, but on another event, so it is gone. Comparing the entry
    // alone would call this replaced and stay quiet, which is the exact silence being closed.
    const theirs = json({
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              {
                type: "command",
                command: `empo hook pre-edit --repo "\${CLAUDE_PROJECT_DIR}"`,
                timeout: 10,
              },
            ],
          },
        ],
      },
    });

    expect(removed(theirs)).toEqual([
      {
        event: "PostToolUse",
        matcher: "Edit|Write",
        command: `empo hook pre-edit --repo "\${CLAUDE_PROJECT_DIR}"`,
      },
    ]);
  });

  test("names an entry behind a narrower matcher on an event EmPo does use", () => {
    // `Write` is not `Edit|Write`: a matcher is an exact-match alternation, so the entry EmPo puts
    // back fires on a different set of tools than the one it took away.
    const theirs = json({
      hooks: {
        PreToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: "empo hook pre-edit --repo ." }],
          },
        ],
      },
    });

    expect(removed(theirs)).toEqual([
      { event: "PreToolUse", matcher: "Write", command: "empo hook pre-edit --repo ." },
    ]);
  });

  test("names an entry that differs only in its timeout", () => {
    const theirs = json({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `empo hook pre-commit --repo "\${CLAUDE_PROJECT_DIR}"`,
                timeout: 120,
              },
            ],
          },
        ],
      },
    });

    expect(removed(theirs)).toEqual([
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: `empo hook pre-commit --repo "\${CLAUDE_PROJECT_DIR}"`,
      },
    ]);
  });

  test("omits the matcher when the group carried none, the way the file spells it", () => {
    const theirs = json({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "empo hook session-start" }] }] },
    });

    expect(removed(theirs)).toEqual([{ event: "SessionEnd", command: "empo hook session-start" }]);
  });

  test("says nothing when the entry only moved out of somebody else's group", () => {
    // Same event, same matcher, same entry: it was inside their group and now sits in EmPo's own
    // beside it, so it fires exactly as before and nothing was taken away.
    const theirs = json({
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: "./scripts/lint.sh" },
              {
                type: "command",
                command: `empo hook pre-edit --repo "\${CLAUDE_PROJECT_DIR}"`,
                timeout: 10,
              },
            ],
          },
        ],
      },
    });

    expect(removed(theirs)).toEqual([]);
  });

  test("names a stale command string, which is what an upgrade looks like", () => {
    // Deliberate, and the noisy edge of the rule: a release that changes the command string makes
    // every repository report its own hooks once. EmPo really did remove an entry it did not put
    // back, and a human who hand-wired that exact string deserves to hear it.
    expect(
      removed(
        json({
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "empo hook pre-commit" }] },
            ],
          },
        }),
      ),
    ).toEqual([{ event: "PreToolUse", matcher: "Bash", command: "empo hook pre-commit" }]);
  });

  test("reports in document order", () => {
    const theirs = json({
      hooks: {
        SessionEnd: [{ hooks: [{ type: "command", command: "empo hook a" }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "empo hook b" }] }],
      },
    });

    expect(removed(theirs).map((one) => one.command)).toEqual(["empo hook a", "empo hook b"]);
  });
});

describe("writeClaude", () => {
  test("writes four files in a deterministic order", () => {
    const written = writeClaude(repo, TWO_ROOTS);

    expect(written).toEqual([
      { path: ".claude/skills/empo-query/SKILL.md", state: "created" },
      { path: ".claude/skills/empo-review/SKILL.md", state: "created" },
      { path: ".claude/skills/empo-map/SKILL.md", state: "created" },
      { path: SETTINGS_PATH, state: "created" },
    ]);
    for (const name of SKILL_NAMES) {
      expect(read(skillPath(name))).toBe(renderSkill(name, TWO_ROOTS));
    }
    expect(read(SETTINGS_PATH)).toBe(text(null, BARE_HOOKS));
  });

  test("is idempotent: a second run changes nothing and says so", () => {
    writeClaude(repo, TWO_ROOTS);
    const before = SKILL_NAMES.map((name) => read(skillPath(name)));

    const again = writeClaude(repo, TWO_ROOTS);

    expect(again.map((file) => file.state)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
    expect(SKILL_NAMES.map((name) => read(skillPath(name)))).toEqual(before);
  });

  test("regenerates a skill file that was edited by hand, because EmPo owns it", () => {
    writeClaude(repo, TWO_ROOTS);
    seed(skillPath("empo-query"), "---\nname: empo-query\n---\n\nmine now\n");

    const again = writeClaude(repo, TWO_ROOTS);

    expect(again[0]).toEqual({ path: skillPath("empo-query"), state: "updated" });
    expect(read(skillPath("empo-query"))).toBe(renderSkill("empo-query", TWO_ROOTS));
    expect(again[1]?.state).toBe("unchanged");
  });

  test("updates the skills when the config changed", () => {
    writeClaude(repo, TWO_ROOTS);

    const again = writeClaude(repo, FULL);

    expect(again.map((file) => file.state)).toEqual(["updated", "updated", "updated", "unchanged"]);
    expect(read(skillPath("empo-review"))).toContain("bitbucket");
    expect(read(skillPath("empo-review"))).not.toContain("apps/mobile");
  });

  test("merges into a settings.json a team already had", () => {
    const theirs = json({ permissions: { allow: ["Bash(npm run test:*)"] } });
    seed(SETTINGS_PATH, theirs);

    const written = writeClaude(repo, BARE);

    expect(written[3]).toEqual({ path: SETTINGS_PATH, state: "updated" });
    const merged = JSON.parse(read(SETTINGS_PATH)) as Record<string, unknown>;
    expect(merged.permissions).toEqual({ allow: ["Bash(npm run test:*)"] });
    expect(merged.hooks).toEqual(BARE_HOOKS);
  });

  test("hands back the hooks it removed and did not put back, on the settings file only", () => {
    seed(
      SETTINGS_PATH,
      json({
        hooks: {
          PostToolUse: [{ hooks: [{ type: "command", command: 'empo hook pre-edit --repo "."' }] }],
        },
      }),
    );

    const written = writeClaude(repo, BARE);

    expect(written[3]?.removed).toEqual([
      { event: "PostToolUse", command: 'empo hook pre-edit --repo "."' },
    ]);
    // Absent everywhere else, and absent entirely on a run with nothing to say: the four results of
    // the ordinary run above are compared with toEqual against { path, state } and nothing more.
    expect(written.slice(0, 3).every((file) => file.removed === undefined)).toBe(true);
  });

  test("writes nothing at all when settings.json cannot be read", () => {
    // The merge runs before the first file is written, because it is the only step that can refuse.
    // A refusal that had already rewritten three skill files would leave the repository half
    // configured, and a generator that fails dirty is worse than one that does not run.
    const broken = '{\n  "permissions": { "allow": [] },\n}\n';
    seed(SETTINGS_PATH, broken);

    expectRefusal(() => writeClaude(repo, BARE));

    expect(read(SETTINGS_PATH)).toBe(broken);
    expect(existsSync(join(repo, ".claude", "skills"))).toBe(false);
  });

  test("does not touch a settings.json that already says what EmPo wants", () => {
    // Formatted by somebody else's tool, and semantically identical. `empo update` has nothing to
    // do here, so it does not dirty the checkout by reprinting the file in its own style.
    const theirs = `${JSON.stringify({ model: "opus", hooks: BARE_HOOKS }, null, 4)}\n`;
    seed(SETTINGS_PATH, theirs);

    const written = writeClaude(repo, BARE);

    expect(written[3]).toEqual({ path: SETTINGS_PATH, state: "unchanged" });
    expect(read(SETTINGS_PATH)).toBe(theirs);
  });
});

/**
 * The read-only half, which `empo doctor` executes one by one to prove each hook resolves and runs.
 * Its whole contract is that it is quiet: every state a merge would refuse over is a fact doctor
 * renders as "nothing is wired", because a doctor that dies on a stray comma reports on none of the
 * checks after it.
 */
describe("wiredHooks", () => {
  test("says nothing about a repository with no .claude directory at all", () => {
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(wiredHooks(repo)).toEqual([]);
  });

  test("says nothing, rather than throwing, over a settings.json it cannot parse", () => {
    // The same file `mergeSettings` refuses over, and correctly: that one is about to rewrite the
    // bytes. This one only reports, and the malformed file is already named by `empo update`.
    seed(SETTINGS_PATH, '{\n  // our settings\n  "model": "opus",\n}\n');

    expect(() => wiredHooks(repo)).not.toThrow();
    expect(wiredHooks(repo)).toEqual([]);
  });

  test("says nothing about a settings.json with no hooks at all", () => {
    seed(SETTINGS_PATH, json({ permissions: { allow: ["Bash(npm run test:*)"] } }));

    expect(wiredHooks(repo)).toEqual([]);
  });

  test("says nothing about a repository whose only hook is somebody else's", () => {
    // Ownership is `isEmpoHook` and nothing else, so what this returns and what a regenerate would
    // remove cannot disagree. A team's own gate is not EmPo's to report on.
    seed(
      SETTINGS_PATH,
      json({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "empo check --json" }] },
          ],
        },
      }),
    );

    expect(wiredHooks(repo)).toEqual([]);
  });

  test("reads back the three hooks a real writeClaude wired, in file order", () => {
    // Built by the writer rather than by hand, so this case tracks `empoHooks` instead of pinning a
    // second copy of it that goes stale the day a hook changes.
    writeClaude(repo, BARE);

    const found = wiredHooks(repo);

    expect(found.map((one) => [one.event, one.matcher, one.timeout])).toEqual([
      // SessionStart takes no matcher: all of startup|resume|clear|compact|fork want the answer.
      ["SessionStart", null, 10],
      ["PreToolUse", "Edit|Write", 10],
      // The longer timeout, because pre-commit computes the gate `empo check` does over a diff.
      ["PreToolUse", "Bash", 20],
    ]);
    const written = Object.values(empoHooks(repo)).flatMap((groups) =>
      groups.flatMap((group) => group.hooks),
    );
    expect(found.map((one) => one.command)).toEqual(written.map((one) => one.command));
    // Unexpanded, exactly as the file spells it: doctor is what expands it, and a hook that fails
    // because the variable never expanded is precisely what the section exists to catch.
    expect(found[0]?.command).toContain(`--repo "\${CLAUDE_PROJECT_DIR}"`);
  });

  test("takes only EmPo's entries out of a group that holds both", () => {
    // A team's own entry sitting beside EmPo's in one group, which the merge leaves exactly there.
    seed(
      SETTINGS_PATH,
      json({
        hooks: {
          PreToolUse: [
            {
              matcher: "Edit|Write",
              hooks: [
                { type: "command", command: "./scripts/lint-staged.sh", timeout: 5 },
                { type: "command", command: "empo hook pre-edit --repo .", timeout: 10 },
                { type: "command", command: "npx empo hook pre-edit" },
              ],
            },
          ],
        },
      }),
    );

    expect(wiredHooks(repo)).toEqual([
      {
        event: "PreToolUse",
        matcher: "Edit|Write",
        command: "empo hook pre-edit --repo .",
        timeout: 10,
      },
    ]);
  });

  test("reports a missing timeout as null rather than inventing the default", () => {
    // The host's own default is not EmPo's to state, and doctor prints what the file says.
    seed(
      SETTINGS_PATH,
      json({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "empo hook session-start" }] }],
        },
      }),
    );

    expect(wiredHooks(repo)).toEqual([
      { event: "SessionStart", matcher: null, command: "empo hook session-start", timeout: null },
    ]);
  });

  test("steps over the shapes a hand-edited file really holds", () => {
    // Every one of these is a group or an event EmPo cannot read, and the merge passes each through
    // untouched rather than deleting it. Reading is the same bargain: skip it, do not throw.
    seed(
      SETTINGS_PATH,
      json({
        hooks: {
          PostToolUse: "all of them",
          SessionEnd: [
            "a string",
            { matcher: "Bash" },
            { hooks: "not an array" },
            {
              matcher: 7,
              hooks: [{ type: "command", command: "empo hook session-start", timeout: "10" }],
            },
          ],
        },
      }),
    );

    expect(wiredHooks(repo)).toEqual([
      { event: "SessionEnd", matcher: null, command: "empo hook session-start", timeout: null },
    ]);
  });
});
