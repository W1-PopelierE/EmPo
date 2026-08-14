import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { configError, type EmpoError } from "../errors";
import type { EmpoConfig } from "../schema/config.schema";
import { adapterLines } from "./agents";

/**
 * The second host target: standalone `.claude/` configuration (docs/10-distribution.md's host
 * integration section, `empo update` in docs/06-cli.md). `AGENTS.md` is advice a host may read;
 * this is the wiring that makes the mechanical gates fire while an agent works, which is the one
 * thing an instruction file cannot do. An instruction is advice, a hook is a gate.
 *
 * **Why this is not a plugin.** docs/10 sketches a Claude Code plugin with `/empo:query` and
 * `/empo:review`. The colon is a plugin namespace, and a plugin needs a marketplace plus a per
 * developer install: a project's settings can prompt each team member to install one, but an
 * external-source plugin does not load until they do. That buys a prettier name and costs the only
 * thing worth having here, hooks that fire for everyone who clones the repository. So EmPo
 * generates plain `.claude/` configuration, where a directory named `empo-query` under
 * `.claude/skills/` is `/empo-query`, and takes the hyphen.
 *
 * **Who owns which bytes.** The three `empo-*` skill directories are EmPo's own, so those files are
 * generated whole and each opens saying so, exactly as the `AGENTS.md` block is replaced whole.
 * `settings.json` is the repository's: it is where a team keeps its permissions, its environment
 * and its own hooks, none of which is reproducible from a file listing. It is merged into, never
 * replaced, and EmPo removes only the entries it can prove are its own.
 *
 * **The hooks fail open.** A machine that cannot run the command exits 127, which the host treats
 * as "other", which is non-blocking for every event. So does a machine whose PATH holds no `empo`.
 * It is deliberate and the generated files say so: a gate that blocks every edit on a machine where
 * the tool is absent is a gate that gets deleted within a day.
 */

// ---------------------------------------------------------------------------------------------
// What gets written
// ---------------------------------------------------------------------------------------------

export const CLAUDE_DIR = ".claude";

/** Repo-relative. Merged into, never replaced. */
export const SETTINGS_PATH = `${CLAUDE_DIR}/settings.json`;

/**
 * The three skills, in the order they are written and reported. A directory under `.claude/skills/`
 * is the slash command's name, so these names are the commands: `/empo-query`, `/empo-review`,
 * `/empo-map`.
 */
export const SKILL_NAMES = ["empo-query", "empo-review", "empo-map"] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

/** Repo-relative path of one skill's file. */
export function skillPath(name: SkillName): string {
  return `${CLAUDE_DIR}/skills/${name}/SKILL.md`;
}

/**
 * A hook entry the merge took out and did not put back in the same place. Enough to restore it by
 * hand, which is the whole point of reporting it: see `mergeSettings` for why it exists.
 */
export interface RemovedHook {
  event: string;
  /** Absent when the group carried no matcher, the same way the settings file spells it. */
  matcher?: string;
  command: string;
}

export interface ClaudeFile {
  /** Repo-relative. */
  path: string;
  state: "created" | "updated" | "unchanged";
  /**
   * Present only on `settings.json`, and only when it is not empty. The skill files are EmPo's own
   * and losing bytes there costs nothing; this is the one file where a regenerate can take away
   * something a human wrote.
   */
  removed?: RemovedHook[];
}

// ---------------------------------------------------------------------------------------------
// The hook entries, and the rule that says which entries are EmPo's
// ---------------------------------------------------------------------------------------------

export interface HookCommand {
  type: "command";
  command: string;
  /** Seconds, not milliseconds. */
  timeout?: number;
}

export interface HookGroup {
  /** An exact-match alternation on the tool name. Absent means every occurrence of the event. */
  matcher?: string;
  hooks: HookCommand[];
}

/** Keyed by host event name, the shape `settings.json` gives its `hooks` value. */
export type HookEntries = Record<string, HookGroup[]>;

/** The one spelling EmPo writes: a bare `empo`, resolved from PATH. */
export const HOOK_COMMAND_PREFIX = "empo hook ";

/**
 * There is no marker-comment trick available in JSON, so ownership is by content:
 *
 * > An entry inside a `hooks` array is EmPo's if and only if its `type` is `"command"` and its
 * > `command` is `empo hook ` either at the very start of the string or immediately after a path
 * > separator.
 *
 * Everything else in the file, including a hook a human wrote on the same event with the same
 * matcher, is somebody else's and survives untouched.
 *
 * **Why this is a pattern and not the prefix the writer uses.** EmPo once wrote a second spelling,
 * `${CLAUDE_PROJECT_DIR}/node_modules/.bin/empo hook `, wherever npm had put a binary in the
 * checkout. npm is gone as a channel and so is that branch (`empoHooks` below writes the bare
 * command and nothing else), but the entries a previous release wrote are still in real
 * `settings.json` files. Narrowing the predicate to what the writer produces would leave those
 * unclaimed, so a regenerate would leave the old entry in place and append the new one beside it,
 * and two hooks would fire on every edit from then on. So the predicate stays a superset of the
 * writer, and `test/host/claude.test.ts` pins both halves: every entry EmPo writes is recognized,
 * and so is every entry it used to write. Deleting a spelling from the writer is safe; deleting one
 * from here is not, and is never the same change.
 *
 * The cost is that `./scripts/empo hook pre-edit`, a wrapper somebody wrote by hand, is now
 * indistinguishable from the repo-local form and is taken as EmPo's. That is unfixable here: it is
 * the same string shape. What is fixable is the silence, and `mergeSettings` already reports every
 * entry it removed and did not put back in the same place.
 */
const HOOK_COMMAND_PATTERN = /(^|[\\/])empo hook /;

export function isEmpoHook(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  return (
    entry.type === "command" &&
    typeof entry.command === "string" &&
    HOOK_COMMAND_PATTERN.test(entry.command)
  );
}

/**
 * `${CLAUDE_PROJECT_DIR}` is expanded by the host before the command runs, so a hook resolves the
 * repository it was configured for rather than whatever directory the session happens to sit in,
 * which is the whole reason a hook can be committed and still work for a teammate.
 */
function command(event: string, timeout: number): HookCommand {
  return {
    type: "command",
    command: `${HOOK_COMMAND_PREFIX}${event} --repo "\${CLAUDE_PROJECT_DIR}"`,
    timeout,
  };
}

/**
 * The three hooks of docs/10, turned from prose into configuration. `SessionStart` takes no matcher
 * (its matchers are `startup|resume|clear|compact|fork`, and all of them want the health answer);
 * the two `PreToolUse` groups match on tool name. `pre-commit` gets the longer timeout because it
 * computes the same gate `empo check` does over a staged diff.
 *
 * The same three entries for every target: there is one channel left and it puts `empo` on PATH, so
 * there is nothing about the repository left to branch on.
 */
export function empoHooks(): HookEntries {
  return {
    SessionStart: [{ hooks: [command("session-start", 10)] }],
    PreToolUse: [
      { matcher: "Edit|Write", hooks: [command("pre-edit", 10)] },
      { matcher: "Bash", hooks: [command("pre-commit", 20)] },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------------------------

export interface SettingsMerge {
  /** The text to write, or the text that arrived when there is nothing to change. */
  text: string;
  /** Entries the merge took out and did not put back in the same place. Usually empty. */
  removed: RemovedHook[];
}

/**
 * Merge EmPo's hook entries into the text of a `settings.json`, and report what that cost.
 *
 * The pure heart of this module, kept pure because it is the one place EmPo touches bytes a team
 * owns. Four rules make it safe.
 *
 * **Refuse rather than guess.** A file that is not parseable JSON, or whose `hooks` is not an
 * object, or one of whose events is not an array, throws. Never rewrite a file you could not read:
 * the alternative is starting from `{}` and silently deleting a team's permissions.
 *
 * **Compare parsed, not printed.** "Nothing changed" is decided by deep equality of the parsed
 * document before and after, never by string comparison, because serializing is lossy for
 * formatting. A file that is already correct but indented with four spaces, or whose keys sit in
 * another order, is semantically identical and is returned byte for byte as it arrived. Otherwise
 * `empo update` would reformat a file it had no change to make, on every run.
 *
 * **Say what reformatting costs.** When there really is a change the whole document is reprinted as
 * `JSON.stringify(merged, null, 2)`, so formatting elsewhere in the file is normalized. That is a
 * real cost of the merge and the generated docs state it rather than implying the write is
 * surgical.
 *
 * **Report what was removed and not put back.** Ownership is by content, so the merge cannot tell
 * an entry EmPo wrote from one a human wrote that looks like EmPo's. That is the sharp edge of a
 * rule with no marker comments available, and it is unfixable here: what is fixable is the silence.
 * So every entry the merge takes out is checked against the regenerated output under the same event
 * and the same matcher, and anything that does not come back verbatim is reported. On an ordinary
 * run every removed entry is one EmPo is about to put back in the same place, so `removed` is empty
 * and nothing is said. It fills only when the removed entry was somebody's own idea: another event,
 * another matcher, another timeout, an older command string. The caller renders it; a hook a human
 * wired by hand should not disappear inside a diff that looks like a routine regenerate.
 */
export function mergeSettings(existing: string | null, entries: HookEntries): SettingsMerge {
  const parsed = parseSettings(existing);
  const { merged, removed } = withHooks(parsed, entries);

  // Compared as parsed documents rather than as printed text: key order is not meaning in JSON, so
  // a file that says the same thing in a different order is unchanged and must be left byte for byte
  // as the human wrote it.
  const text =
    existing !== null && isDeepStrictEqual(parsed, merged)
      ? existing
      : `${JSON.stringify(merged, null, 2)}\n`;
  return { text, removed };
}

/** An absent or empty file is `{}`: there is nothing in it to preserve and nothing to refuse. */
function parseSettings(existing: string | null): Record<string, unknown> {
  if (existing === null || existing.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    throw refuse("is not valid JSON", [
      `The parser said: ${error instanceof Error ? error.message : String(error)}`,
      "JSON has no comments and no trailing commas, whatever the editor allows.",
      // Named only when it is really there, so the ordinary syntax-error message stays uncluttered.
      // It is worth the branch: a BOM is invisible in every editor that writes one, so the message
      // above sends someone hunting for a syntax error that is not in the file.
      ...(existing.charCodeAt(0) === 0xfeff
        ? [
            "This file starts with a UTF-8 byte order mark, which JSON does not allow and which",
            "your editor will not show you. Save it as UTF-8 without a BOM.",
          ]
        : []),
    ]);
  }

  if (!isRecord(parsed)) throw refuse("does not hold a JSON object at its top level", []);
  return parsed;
}

/**
 * Drop every entry EmPo owns wherever it appears, insert the current ones, and leave every other
 * key in the document exactly as it was, in the order it was in.
 *
 * EmPo appends its own group rather than joining a group whose matcher happens to match. A team's
 * `PreToolUse` group on `Edit|Write` is theirs, including its other fields, and two groups on one
 * event both fire. So the merge never edits a group it does not own, and a hand-written hook is
 * never deduplicated away by one that looks similar.
 */
function withHooks(
  parsed: Record<string, unknown>,
  entries: HookEntries,
): { merged: Record<string, unknown>; removed: RemovedHook[] } {
  const before = parsed.hooks;
  if (before !== undefined && !isRecord(before)) {
    throw refuse('has a "hooks" key that is not an object', [
      "It is an object keyed by event name, each event holding an array of hook groups.",
    ]);
  }

  // In document order, so what the caller renders reads in the order the file did.
  const taken: Taken[] = [];
  const events: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(before ?? {})) {
    if (!Array.isArray(groups)) {
      throw refuse(`has a "hooks.${event}" that is not an array`, [
        "Each event holds an array of { matcher, hooks } groups.",
      ]);
    }

    const kept = groups.flatMap((group) => stripGroup(group, event, taken));
    // An event EmPo emptied is dropped, so removing the last EmPo entry leaves no `"Bash": []`
    // behind. An event that arrived empty is the repository's own and stays as it is: EmPo removes
    // what it can prove is its own, and an empty array proves nothing.
    if (kept.length === 0 && groups.length > 0) continue;
    events[event] = kept;
  }

  // Cloned, so nothing that later reads the merged document can reach into the caller's entries.
  for (const [event, groups] of Object.entries(structuredClone(entries))) {
    const existing = events[event];
    events[event] = Array.isArray(existing) ? [...existing, ...groups] : groups;
  }

  // Spread first, then assign: an existing `hooks` keeps its position in the document and a new one
  // lands at the end, which keeps the diff on a first run down to an appended block.
  const next = { ...parsed };
  if (Object.keys(events).length > 0) next.hooks = events;
  else if (isRecord(before) && Object.keys(before).length === 0) next.hooks = before;
  else delete next.hooks;

  return { merged: next, removed: taken.filter((one) => !replaced(one, events)).map(report) };
}

/** A removed entry, kept whole while the merge runs so it can be compared against the output. */
interface Taken {
  event: string;
  matcher: string | undefined;
  entry: unknown;
}

/**
 * One group as it should survive: the same object when EmPo owns nothing inside it, a copy without
 * its entries, or nothing at all when a EmPo entry was the only thing left in it. Returning the
 * original object in the common case is what keeps a group's own keys and their order intact.
 *
 * A group EmPo cannot read (not an object, or a `hooks` that is not an array) is passed through
 * rather than refused. It holds no entry EmPo can identify, so there is nothing to remove, and
 * leaving it is the non-destructive answer.
 */
function stripGroup(group: unknown, event: string, taken: Taken[]): unknown[] {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];

  const kept = group.hooks.filter((entry) => !isEmpoHook(entry));
  if (kept.length === group.hooks.length) return [group];

  const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
  for (const entry of group.hooks) {
    if (isEmpoHook(entry)) taken.push({ event, matcher, entry });
  }

  if (kept.length === 0) return [];
  return [{ ...group, hooks: kept }];
}

/**
 * Whether the regenerated document holds this entry again, verbatim, on the same event and behind
 * the same matcher. Event and matcher are part of the question rather than the entry alone: an
 * entry that fired on `PostToolUse` and comes back only on `PreToolUse` was not put back, it was
 * taken away, even though the two entries are identical. The group it sits in does not matter,
 * because two groups on one event both fire.
 */
function replaced(one: Taken, events: Record<string, unknown>): boolean {
  const groups = events[one.event];
  if (!Array.isArray(groups)) return false;

  return groups.some((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
    const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
    if (matcher !== one.matcher) return false;
    return group.hooks.some((entry) => isDeepStrictEqual(entry, one.entry));
  });
}

/** `isEmpoHook` has already established that `command` is a string. */
function report(one: Taken): RemovedHook {
  const command = (one.entry as { command: string }).command;
  return one.matcher === undefined
    ? { event: one.event, command }
    : { event: one.event, matcher: one.matcher, command };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(what: string, details: string[]): EmpoError {
  return configError(`${SETTINGS_PATH} ${what}, so nothing was written`, [
    ...details,
    "EmPo merges its hook entries into this file and leaves every other key as it found it,",
    "which it cannot do without reading the file first. So it wrote nothing at all, here or",
    "under .claude/skills/. Fix the file and run empo update again.",
  ]);
}

// ---------------------------------------------------------------------------------------------
// Reading back what is wired
// ---------------------------------------------------------------------------------------------

export interface WiredHook {
  /** The host event name the entry sits under, e.g. "SessionStart" or "PreToolUse". */
  event: string;
  /** The group's tool-name matcher, or null when the group has none. */
  matcher: string | null;
  /** The command string exactly as settings.json spells it, unexpanded. */
  command: string;
  /** The configured timeout in seconds, or null when the entry does not set one. */
  timeout: number | null;
}

/**
 * Every EmPo-owned hook currently wired in this repository's settings.json, in file order.
 *
 * The read-only counterpart of the merge above, and the only way to learn what is really wired
 * without rewriting anything. `empo doctor` executes each of these to prove the command resolves and
 * runs, because a hook whose binary is missing fails open (127, which the host treats as "other")
 * and a repository with three broken hooks is indistinguishable from a clean one.
 *
 * **Every unreadable state is an empty list, and nothing throws.** No `.claude/`, no file, a file
 * that cannot be read, JSON that does not parse, no `hooks` key, a `hooks` that is not an object:
 * all of it means "no EmPo hook is wired here", which is the fact doctor renders. Refusing is
 * `mergeSettings`'s job, because it is the one that rewrites the file and must never write over what
 * it could not read; a section that only reports has nothing to protect by stopping the run, and a
 * doctor that dies on a stray comma tells you nothing about the other twenty checks it never got to.
 * Ownership is `isEmpoHook` and only `isEmpoHook`, so this list and what the merge would remove can
 * never disagree.
 */
export function wiredHooks(repoRoot: string): WiredHook[] {
  const hooks = settingsHooks(repoRoot);
  if (!isRecord(hooks)) return [];

  const found: WiredHook[] = [];
  // Object key order, then array order, twice over: what comes back reads in the order somebody
  // scrolling the file would meet it, which is what makes a doctor line findable by eye.
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      // Shape-checked rather than trusted: this is hand-editable JSON, so a `matcher` that is a
      // number and a `timeout` that is a string are both things a real file holds.
      const matcher: HookGroup["matcher"] =
        typeof group.matcher === "string" ? group.matcher : undefined;

      for (const entry of group.hooks) {
        if (!isEmpoHook(entry)) continue;
        // `isEmpoHook` has already established `type` and a string `command`; `timeout` is optional
        // in the type and unconstrained in the file, so it is the one field still worth checking.
        const { command, timeout } = entry as HookCommand;
        found.push({
          event,
          matcher: matcher ?? null,
          command,
          timeout: typeof timeout === "number" ? timeout : null,
        });
      }
    }
  }
  return found;
}

/** The parsed `hooks` value, or undefined for every state this function refuses to make a fuss of. */
function settingsHooks(repoRoot: string): unknown {
  let text: string;
  try {
    // Not `read` above: that one asks `existsSync` first, which still leaves the race and the
    // unreadable-file case to handle. One try/catch covers absent, unreadable and a directory.
    text = readFileSync(join(repoRoot, SETTINGS_PATH), "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed.hooks : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// The three skills
// ---------------------------------------------------------------------------------------------

/**
 * Generated whole from the shipped discipline plus this project's config, the rule `AGENTS.md`
 * follows, so each file names this repository's roots, forge and tracker instead of telling an
 * agent to go and find out.
 *
 * Neither `empo-review` nor `empo-map` restates the discipline its command prints. That is not
 * house style: the copy the command hands over is the one the verification gate is built around, so
 * a second copy in a generated file drifts from it and teaches a workflow the gate does not
 * implement. Both files point at the command instead.
 */
export function renderSkill(name: SkillName, config: EmpoConfig): string {
  const body =
    name === "empo-query"
      ? querySkill(config)
      : name === "empo-review"
        ? reviewSkill(config)
        : mapSkill(config);
  return `${body.join("\n")}\n`;
}

/**
 * A skill is matched on its `description`, so that line is written for the matcher and not for a
 * human reading a list. `disable-model-invocation: true` makes a skill user-invoked only.
 */
function frontmatter(name: SkillName, description: string, userInvokedOnly: boolean): string[] {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    ...(userInvokedOnly ? ["disable-model-invocation: true"] : []),
    "---",
    "",
    "<!--",
    "Generated by `empo update` from this repository's EmPo config. This whole file is replaced on",
    "the next run, so a hand edit here is lost. Change `.empo/config.json` and run `empo update`.",
    "-->",
  ];
}

/**
 * The facts every skill needs: which directory is which language, which forge and tracker this
 * repository really has, and what each absence costs. The last part is the point. An agent that is
 * not told an adapter is missing reads a review's silence as "the ticket was fine" and "there was
 * no pull request to read", which are both fabrications.
 *
 * `detail` decides how much of the `mcp` payload protocol comes with the adapter lines. Only
 * `empo-review` takes the full text, because it is the only one of the three that will meet the
 * request block: a mapping table sitting between a `empo query` and the answer it came for is
 * thirty lines of something to skip, and a file that trains an agent to skim is a file that gets
 * skimmed on the day it matters. The adapter lines themselves are shared with the `AGENTS.md`
 * block rather than restated here (src/host/agents.ts), for the reason that file gives.
 */
function repositoryFacts(config: EmpoConfig, detail: "full" | "summary"): string[] {
  return [
    "## This repository, as EmPo sees it",
    "",
    "Roots, each indexed by one language pack:",
    "",
    ...config.roots.map((root) => {
      const framework = root.framework === undefined ? "" : `, ${root.framework}`;
      return `- \`${root.path}\` (${root.lang}${framework})`;
    }),
    "",
    ...bridgeLines(config),
    ...adapterLines(config, detail),
  ];
}

/**
 * A missing bridge is the silence that reads worst of all, so it is stated. With two roots and no
 * bridge nothing joins them, cross-language reach reads as zero, and that is the identical answer a
 * repository with no coupling at all would give. `empo init` prints this same gap for the same
 * reason.
 */
function bridgeLines(config: EmpoConfig): string[] {
  if (config.roots.length < 2) return [];

  if (config.bridges.length === 0) {
    return [
      "No bridge is configured, so nothing joins these roots and cross-language reach reads as",
      "zero. That is exactly what a repository with no coupling would report, so say the bridge is",
      "missing rather than reporting the empty answer as proof that nothing downstream is touched.",
      "",
    ];
  }

  const kinds = [...new Set(config.bridges.map((bridge) => bridge.kind))].sort();
  return [
    `Bridges: ${kinds.map((kind) => `\`${kind}\``).join(", ")}. Reach crosses the roots through`,
    "these and nothing else, and a low match rate (`empo doctor` prints it) means a mis-tuned",
    "`normalize`, not an absence of coupling.",
    "",
  ];
}

/**
 * Model invocation stays enabled here, unlike the other two. Asking the graph before guessing at
 * consumers is exactly the thing worth firing without anybody remembering to type it, and a query
 * reads and changes nothing.
 */
function querySkill(config: EmpoConfig): string[] {
  return [
    ...frontmatter(
      "empo-query",
      "Blast radius of a symbol, file or route from the EmPo dependency graph. Use before " +
        "changing shared code, when asked who calls or consumes something, and when scoping what " +
        "a change can break.",
      false,
    ),
    "",
    "# Blast radius, from the graph",
    "",
    "Run:",
    "",
    "```sh",
    "empo query $ARGUMENTS",
    "```",
    "",
    "`$ARGUMENTS` is a node id, a file path or a short symbol name. With nothing to go on, ask for",
    "the symbol before running anything; do not guess one from the conversation.",
    "",
    "Useful on their own, and each answers a question grep cannot: `--blind` for flows a test",
    "reaches without asserting a value, `--gods` for the widest blast radius in the repository,",
    "`--orphans` for nodes nothing references, `--hazards` for jobs dispatched inside a transaction",
    "before it commits, `--json` when another step has to read the answer.",
    "`--orphans` leaves out the kinds a pack marks framework-resolved, a view rendered by `view($name)`",
    "or a migration the runner discovers, and says how many it left out; `--all` lists them too. Nothing",
    "on that list is dead until you have read the file: it is a candidate, not a verdict.",
    "`--hazards` names which languages scanned for one and which scanned for none. An empty list",
    "under a language that scanned for none is not a finding, and a null list means the graph",
    "predates the record. Neither is a clean bill of health, so never report either as none found.",
    "",
    "## Reading the answer back",
    "",
    "- Report the fan-in, the flows reached and the blind flows with the citation the command",
    "  printed beside each one. A claim that arrives without a citation does not go in the answer.",
    "- **Say out loud that the number is a floor and not a ceiling.** Reflection, dynamic dispatch,",
    "  configuration and anything that builds a name at runtime add reach no static graph can see.",
    "  A blast radius reported as complete is worse than no blast radius, because it gets trusted.",
    "- A blind flow is a flow a test reaches without asserting a value. Name it as a coverage gap",
    "  in the change, not as a test that is missing somewhere else.",
    "- When an answer looks wrong, run `empo doctor` first. A stale graph answers accurately about",
    "  code that has moved, and `empo index` is the repair.",
    "",
    "Never hand-edit anything under `.empo/generated/` to make an answer come out the way you",
    "expected. Only `empo index` writes it. An edited graph produces an impact answer that looks",
    "generated and is invented, which is the single failure this tool exists to prevent.",
    "",
    ...repositoryFacts(config, "summary"),
  ];
}

/**
 * User-invoked only: a review is a deliberate act with a cost, and one that starts itself because
 * a diff was mentioned is one nobody asked for.
 */
function reviewSkill(config: EmpoConfig): string[] {
  return [
    ...frontmatter(
      "empo-review",
      "Review a pull request or the local diff under the EmPo review discipline, where no finding " +
        "reaches the author until it has been verified against the real source.",
      true,
    ),
    "",
    "# Review, under the shipped discipline",
    "",
    "Run:",
    "",
    "```sh",
    "empo review $ARGUMENTS",
    "```",
    "",
    "`$ARGUMENTS` is a pull request id, or nothing at all to review the local diff against the base",
    "ref. `--base <ref>` pins the comparison, which matters on a stacked pull request.",
    "",
    // A review against an `mcp` forge starts with a run that reviews nothing, and an agent that
    // does not expect that reads it as a failure and starts working around it: rerunning, dropping
    // the id, reviewing the local diff and reporting on the wrong code. Cheaper to say so here.
    ...(config.adapters?.forge?.kind === "mcp"
      ? [
          "The first run against a pull request id reviews nothing. This repository's forge is one",
          "EmPo cannot reach, so that run is phase 0: it prints a request block asking you to fetch",
          "the pull request and write it to a file, and the review happens when you run the command",
          'it prints. "This repository, as EmPo sees it" below names the tool to fetch it with',
          "and the four things that fail quietly.",
          "The request block itself carries the path, the exact JSON and the fields to map,",
          "and it is the copy to work from.",
          "",
        ]
      : []),
    "## Run what it prints",
    "",
    "The command prints the brief (the facts: the pull request, the ticket and its criteria, the",
    "diff, the blast radius of every changed file, the blind flows it touches, the tests that",
    "exist) and beneath it the full discipline: the pipeline, the two invariants, and the",
    "verification gate every finding has to survive.",
    "",
    "**The discipline is not repeated in this file, deliberately.** The copy `empo review` hands",
    "you is the one the verification gate is built around, and a second copy here would drift from",
    "it and teach a workflow the gate does not implement. Read what the command prints and run",
    "that. Do not improvise a review from this file.",
    "",
    "## The second phase is not optional",
    "",
    // Counted the same way the paragraph above counts, or the file says "phase 0" in one place and
    // "a review is two phases" in another and leaves an agent to work out whether it has missed a
    // step. Two numberings of one procedure is the same defect as two copies of one instruction.
    config.adapters?.forge?.kind === "mcp"
      ? "The CLI makes no model call anywhere, so a review is two more phases after the fetch above."
      : "The CLI makes no model call anywhere, so a review is two phases.",
    "Phase 1 is the brief.",
    "Phase 2 is the `--findings` command the brief prints, which resolves every citation against",
    "the source phase 1 read, drops what hedges or cites text that is not there, and prints only",
    "the survivors. Write the findings file to the path it names and run the line it gives you.",
    "A finding that has not been through phase 2 has not been verified, whatever it claims.",
    "",
    "Read `.empo/conventions.md` before flagging anything. It is the register of what this team has",
    "already judged correct as it stands, and a review that raises a settled question twice is how",
    "a review stops being read.",
    "",
    ...repositoryFacts(config, "full"),
  ];
}

/**
 * User-invoked only. Proposing flows and spines rewrites a team's map of its own product, which is
 * not something to start because the word "flow" appeared in a sentence.
 */
function mapSkill(config: EmpoConfig): string[] {
  return [
    ...frontmatter(
      "empo-map",
      "Propose this repository's end-user flows and its spines from the EmPo map brief, as a " +
        "diff for a human to approve.",
      true,
    ),
    "",
    "# Map the repository into flows and spines",
    "",
    "Run:",
    "",
    "```sh",
    "empo init",
    "```",
    "",
    "It prompts for nothing and never overwrites what a human owns: a file under `.empo/` that",
    "already exists is reported `kept` and left byte for byte as it was, so this is safe on a",
    "repository that is already set up. The `.claude/` files and the `AGENTS.md` block are EmPo's own",
    "and are regenerated, reported `created`, `updated` or `unchanged` and never `kept`, which is why",
    "a hand edit to this file is lost. It detects the roots, scaffolds anything missing, builds the",
    "graph, then prints the map brief and the map discipline.",
    "",
    "## Run what it prints",
    "",
    "The brief is the evidence: the roots and their languages, the graph's kinds, the entrypoints,",
    "the produced route symbols, the widest blast radius, and the flows and spines that already",
    "exist and must not be proposed again. Beneath it is the map discipline, the procedure to run",
    "over that evidence.",
    "",
    "**The discipline is not repeated in this file**, for the reason `empo-review` gives: the copy",
    "the command prints is the one the gate is built around, and a second copy drifts from it.",
    "",
    "Write the proposal to the path the brief names, then:",
    "",
    "```sh",
    "empo init --proposal <the path it named>            the verdict, nothing written",
    "empo init --proposal <the path it named> --apply    write what survived",
    "```",
    "",
    "## What you are proposing, and who owns it",
    "",
    "`.empo/flows.json` and the spines under `.empo/spines/` are human-owned. They come back as a",
    "proposal for a human to approve, never as a fait accompli, and `--apply` is a human's",
    "keystroke and not yours to run unasked.",
    "",
    "The gate that reads the proposal drops what it cannot resolve: a flow path matching no node",
    "goes, and one citation whose anchor is nowhere drops the whole spine, because a findings list",
    "is read one item at a time and a spine is read as a map. So propose nothing you have not read.",
    "A flow inferred from a directory name and a `file:line` reconstructed from memory fail in the",
    "same way, quietly, inside an artifact every later reader treats as ground truth.",
    "",
    ...repositoryFacts(config, "summary"),
  ];
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/**
 * Every file, in a deterministic order: the three skills, then `settings.json`.
 *
 * The merge runs before anything is written, because the merge is the only step that can refuse. A
 * refusal that had already rewritten three skill files would leave the repository half configured,
 * and a generator that fails dirty is worse than one that does not run.
 *
 * The settings result carries `removed` when the merge took a hook entry out and did not put it
 * back in the same place, so the caller can say so. It is absent on an ordinary run, which is what
 * keeps the report worth reading when it does appear.
 */
export function writeClaude(repoRoot: string, config: EmpoConfig): ClaudeFile[] {
  const settings = join(repoRoot, SETTINGS_PATH);
  const before = read(settings);
  const merge = mergeSettings(before, empoHooks());

  const written = SKILL_NAMES.map((name) => {
    const path = skillPath(name);
    const target = join(repoRoot, path);
    return put(target, path, read(target), renderSkill(name, config));
  });

  const file = put(settings, SETTINGS_PATH, before, merge.text);
  written.push(merge.removed.length === 0 ? file : { ...file, removed: merge.removed });
  return written;
}

/**
 * Identical content means there is nothing to do, and saying so is what makes `empo update` safe to
 * run from a hook or a CI step: it never dirties a checkout it has nothing to change.
 */
function put(target: string, path: string, existing: string | null, content: string): ClaudeFile {
  if (existing === content) return { path, state: "unchanged" };

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  return { path, state: existing === null ? "created" : "updated" };
}

function read(target: string): string | null {
  return existsSync(target) ? readFileSync(target, "utf8") : null;
}
