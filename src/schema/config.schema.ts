import { z } from "zod";

/**
 * The runtime validator for config.json (docs/03-config-schema.md). This is the single source
 * of truth: the editor JSON Schema is generated from it, never maintained beside it.
 */

const name = z.string().min(1);

/**
 * The spellings of one repo-relative path that mean the same path, flattened once, at the moment the
 * config is validated, so that nothing downstream ever sees two of them.
 *
 * A trailing slash is the obvious pair: `apps/api/` and `apps/api` name the same directory. A leading
 * `./` is the same idea and the more dangerous one, because the filesystem forgives it and string
 * comparison does not. `join(repoRoot, "./apps/api")` and `join(repoRoot, "apps/api")` are the same
 * directory, so a root spelled either way scans the same files and `empo doctor` finds it on disk,
 * and then every comparison in the engine is a comparison of characters: engine/bridger.ts probes a
 * `Set` of the bridge's declared roots with `node.root`, engine/health.ts validates a bridge side the
 * same way, engine/coverage.ts asks whether two nodes share a root with `===`, commands/index.ts asks
 * which roots contain a file by `startsWith`, and engine/guard.ts builds a test-path prefix out of
 * the root. Each of those is a different opportunity for a config that scans correctly to match
 * nothing, silently, with no diagnostic anywhere.
 *
 * Doing it here rather than in each of them is what makes those consumers correct without any of them
 * having to remember. It also settles the two sides of one comparison at once: a node's `file` is
 * built by engine/scanner.ts out of the root path, and a flow's declared prefix is matched against
 * that `file` by engine/flows.ts, so the two must be flattened by one rule or a declared `./apps/api`
 * comes back empty against nodes spelled `./apps/api/...`. Both call this.
 *
 * Only those two spellings, and only at the ends. Nothing here touches an interior segment, so the
 * path boundary rule engine/flows.ts enforces is exactly as strict as it was. A path that spells only
 * the repository root, `.`, `./`, `.//` or `/`, lands on `.` and never on the empty string. Empty
 * would be a prefix of length zero: it matches a top-level dotfile, and it ties with every other
 * prefix at that length, so a path naming nothing would start claiming nodes nobody assigned to it.
 * A worse answer than none, and one no human wrote down.
 *
 * A leading `/` is deliberately not flattened away, and it is not accepted either: `repoPath` below
 * refuses it, which is where a config path is validated and where a refusal can carry a message. It
 * cannot be refused here, because this function also serves engine/flows.ts, and there a leading
 * slash is a path a human typed into flows.json that has to come back as a prefix matching no node,
 * with an explanation from engine/proposal.ts, rather than as a throw in the middle of a build.
 */
export function normalizeRepoPath(path: string): string {
  const flattened = path.replace(/\/+$/, "").replace(/^(?:\.\/+)+/, "");
  return flattened === "" ? "." : flattened;
}

/**
 * A repo-relative path a human types into a config file. Validated as a name, then flattened, so the
 * value every reader of the parsed config sees is the one canonical spelling, including the readers
 * that only print it back: `empo index`, `empo doctor` and the managed blocks in AGENTS.md and
 * `.claude/` all name a root, and naming it two ways across two commands is its own small lie.
 *
 * An absolute path is refused here rather than flattened, and it is refused after the flattening so
 * that a lone `/`, which is a spelling of the repository root and lands on `.`, still parses. There
 * is no spelling of `/apps/api` that means anything a repo-relative path can mean, and every layer
 * below this one takes it and stays silent: `join(repoRoot, "/apps/api")` ignores the repoRoot's tail
 * and resolves to `/apps/api`, so the scanner reads a real directory and `empo doctor` reports the
 * root present, while every node it produces carries a `root` and a `file` starting with a slash and
 * matches no path git ever names in a diff and no flow prefix a human would write. That is exactly
 * the "scans correctly to match nothing, silently" failure `normalizeRepoPath` above is written to
 * make impossible, arriving through the one spelling it does not touch. The error is the same shape
 * as the empty string's: a refusal at parse time, on the field, before a single command has run.
 *
 * `normalizeRepoPath` itself keeps accepting it, because it is not only a config reader. engine/
 * flows.ts calls it on a path a human declared in flows.json, where a leading slash has to come out
 * the other side as a prefix that matches no node and gets explained by engine/proposal.ts, not as a
 * thrown error in the middle of assigning a graph.
 */
const repoPath = name.transform(normalizeRepoPath).refine((path) => !path.startsWith("/"), {
  message:
    'a path here is relative to the repository root, so it cannot begin with "/". ' +
    'Write "apps/api" rather than "/apps/api".',
});

/**
 * One alias pattern, spelled the way a tsconfig `paths` key is spelled, and refused where it names
 * something this map can never be asked about.
 *
 * At most one `*`, which is tsconfig's own rule and the only spelling `engine/resolver.ts`
 * substitutes. Two would need a decision about which one the matched text belongs to, and the
 * toolchain the alias is copied from does not make that decision either.
 *
 * A pattern beginning `./` or `../` is refused rather than accepted and ignored. A relative
 * specifier never reaches the alias map at all, because `resolveModulePath` resolves it against the
 * importing file first and answers before it looks here, so such a key would sit in a config file
 * looking like it did something and match nothing forever. That is the same silent-no-match failure
 * `normalizeRepoPath` above exists to make impossible, arriving through a different field.
 *
 * **Checked on the map rather than on the key**, and that is not a style choice. A refinement
 * attached to a record's key schema has its message discarded: zod reports `Invalid key in record`
 * and the tailored sentence never reaches the human, which is the failure the `renamedKind` message
 * below exists to prevent one field over. A refusal that does not carry its repair is a config
 * nobody can get working again. So the rules live in `aliasesSchema`'s `superRefine`, where the
 * message survives and the offending pattern is still on the issue path.
 */
function patternProblem(pattern: string): string | undefined {
  if ((pattern.match(/\*/g)?.length ?? 0) > 1) {
    return `an alias pattern may hold at most one "*", as in "@/*". "${pattern}" holds more.`;
  }
  if (pattern.startsWith("./") || pattern.startsWith("../")) {
    return (
      `an alias pattern cannot be relative, and "${pattern}" is: a specifier starting with ` +
      "./ or ../ is resolved against the importing file and never reaches this map."
    );
  }
  return undefined;
}

/**
 * Where an alias points, repo-relative, in the same list-of-candidates shape a tsconfig `paths`
 * value has. Repo-relative and not root-relative, deliberately, because a node id is repo-relative
 * (docs/05-graph-model.md) and a target that had to be joined to a root before it could be compared
 * would be the third path form in a codebase that already documents having two.
 *
 * A list rather than a single string, because tsconfig allows one and `empo init` seeds this field
 * by copying rather than by translating: a shape that dropped the second candidate would seed a
 * subtly narrower map than the one the toolchain is using, and the difference would be invisible.
 */
const aliasTarget = repoPath.refine((path) => (path.match(/\*/g)?.length ?? 0) <= 1, {
  message: 'an alias target may hold at most one "*", as in "resources/js/*"',
});

/**
 * The alias map for one root: a non-relative specifier this root's files may write, and the
 * repo-relative path or paths it stands for.
 *
 * This is layer 4 and a human owns it, the same as every other field here. `empo init` seeds it
 * from a tsconfig where it finds one (`engine/aliases.ts`), and says out loud where it could not,
 * because an alias map that is silently absent looks exactly like a repository that has none: every
 * aliased import then resolves to no node, and the fan-in of a heavily-imported file reads as the
 * handful of relative importers it happens to have. That is a wrong answer rather than a narrow one.
 */
const aliasesSchema = z.record(name, z.array(aliasTarget).min(1)).superRefine((map, ctx) => {
  for (const pattern of Object.keys(map)) {
    const problem = patternProblem(pattern);
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem, path: [pattern] });
  }
});

export const rootSchema = z.strictObject({
  path: repoPath,
  lang: name,
  framework: z.string().optional(),
  aliases: aliasesSchema.optional(),
});

export const packSelectionSchema = z.strictObject({
  version: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A bridge side is one root or a list of roots. Flattened by the same rule as `rootSchema.path`,
 * because a bridge side is that path written a second time: engine/health.ts checks the side against
 * the set of configured root paths and engine/bridger.ts probes `node.root` with it, both by string
 * equality. Normalizing the root and leaving the reference alone would break the pair that already
 * agreed.
 */
const rootRef = z.union([repoPath, z.array(repoPath).min(1)]);

export const bridgeSchema = z.strictObject({
  kind: name,
  produces: rootRef,
  consumes: rootRef,
  normalize: z
    .strictObject({
      stripPrefix: z.array(z.string()).optional(),
      lowercase: z.boolean().optional(),
      stripTrailingSlash: z.boolean().optional(),
      collapseParams: z.boolean().optional(),
    })
    .optional(),
});

/**
 * The human-facing name of the system behind an `mcp` adapter ("bitbucket", "jira", "linear").
 *
 * Free text, and deliberately so: **the engine never branches on it.** Every `mcp` adapter behaves
 * identically whatever this says, because the fetching is done by the agent host and empo only
 * validates what comes back. The one thing this value does is get interpolated into the request
 * block empo prints, so the agent knows which of its tools to reach for ("fetch it with your
 * Bitbucket tool"). An `mcp` adapter with no `host` still works; the request block then says "your
 * pull request tool" instead of naming one. The moment a `switch` is written over this, a value a
 * team invented for a host nobody anticipated stops working, and the enum above is what a closed
 * set is for.
 */
const host = z.string().min(1).optional();

/**
 * The kinds that became `mcp`, and the message a config carrying one gets.
 *
 * This is the one error a user meets at the exact moment they upgrade, before a single command has
 * run and before they have any reason to trust this tool: a config saying `"kind": "jira"` now fails
 * `configSchema` and exits 2 on **every** command, not only `empo review`. Zod's default message
 * lists the kinds that are valid and says nothing about what became of theirs, which reads as the
 * tool breaking rather than as a rename. So the message carries the replacement, spelled the way it
 * has to be typed, and nobody has to find a changelog to get their repository working again.
 */
const RENAMED = {
  forge: ["bitbucket", "gitlab"],
  tracker: ["jira", "asana", "linear"],
} as const;

/** Returning undefined leaves zod's own message, which is the right one for a genuine typo. */
function renamedKind(role: "forge" | "tracker") {
  const retired: readonly string[] = RENAMED[role];
  return (issue: { input: unknown }): string | undefined => {
    if (typeof issue.input !== "string" || !retired.includes(issue.input)) return undefined;
    return `"${issue.input}" is no longer a ${role} kind. Use { "kind": "mcp", "host": "${issue.input}" } instead.`;
  };
}

export const forgeSchema = z.strictObject({
  kind: z.enum(["github", "mcp", "local"], { error: renamedKind("forge") }),
  host,
  repo: z.string().optional(),
  workspace: z.string().optional(),
});

export const trackerSchema = z
  .strictObject({
    kind: z.enum(["mcp", "github-issues", "none"], { error: renamedKind("tracker") }),
    host,
    keyPattern: z.string().optional(),
    project: z.string().optional(),
  })
  .refine((tracker) => compiles(tracker.keyPattern), {
    message: "keyPattern is not a valid regular expression",
    path: ["keyPattern"],
  });

export const adaptersSchema = z.strictObject({
  forge: forgeSchema.optional(),
  tracker: trackerSchema.optional(),
});

/**
 * Every object here refuses a key it does not know. There are two carve-outs, `$schema` and `_note`,
 * and both are keys that must be *ignored* rather than keys that are allowed.
 *
 * The rule this replaces was zod's default, which strips an undeclared key and says nothing, and it
 * cost exactly what a silent strip always costs: a config spelling the section `"adaptors"` lost the
 * whole adapters block, and every command downstream then reported, honestly and wrongly, that no
 * forge and no tracker were configured. That answer is indistinguishable from the one a repository
 * with no adapters gets, so nothing anywhere could tell the reader they had made a typo. The payload,
 * spine and proposal schemas have refused unknown keys since they were written, and docs/03 called
 * the difference "not principled, it is unfinished" rather than a decision.
 *
 * `$schema` is why this is not a one-line switch. It is the key an editor reads to find a schema
 * document to validate the file against, it is written by tooling rather than by the human, and a
 * strict schema refuses it: the one config key that must be ignored is the one nothing in EmPo reads.
 * So it is declared here rather than allowlisted somewhere else, which also puts it in the generated
 * editor document, where a reader completing the file will now be offered it.
 *
 * `_note` is declared for the same reason and found the same way, by turning this on and watching the
 * repository's own shipped example fail: JSON has no comments, the example carries its "every value
 * here is invented" disclaimer as a key, and that disclaimer has to travel inside the file that gets
 * copied rather than beside it (docs/11-security-boundaries.md). One named key rather than a rule
 * about a prefix, because "anything starting with an underscore is ignored" is the silent strip this
 * change exists to end, re-admitted for every key somebody spells that way by accident.
 *
 * The cost, stated because it is real: a config written for a later version of EmPo fails on an older
 * binary rather than degrading. That is the direction to prefer here. An unknown key is either a typo,
 * where refusing it is the whole point, or a feature this binary does not have, where quietly ignoring
 * it produces an answer computed without the thing the author asked for.
 */
export const configSchema = z.strictObject({
  /** Read by editors, never by EmPo. Declared only so a strict schema does not refuse it. */
  $schema: z.string().optional(),
  /** A comment for whoever reads the file, in the one language JSON has for one. Never read. */
  _note: z.string().optional(),
  version: z.literal(1),
  roots: z.array(rootSchema).min(1),
  packs: z.record(name, packSelectionSchema),
  bridges: z.array(bridgeSchema).default([]),
  flows: z.string().default(".empo/flows.json"),
  spines: z.string().default(".empo/spines"),
  adapters: adaptersSchema.optional(),
  ignore: z.array(z.string()).default([]),
  commit: z.array(z.string()).default([]),
});

export type EmpoConfig = z.infer<typeof configSchema>;
export type EmpoRoot = z.infer<typeof rootSchema>;
export type EmpoBridge = z.infer<typeof bridgeSchema>;
export type EmpoAdapters = z.infer<typeof adaptersSchema>;
export type EmpoForge = z.infer<typeof forgeSchema>;
export type EmpoTracker = z.infer<typeof trackerSchema>;

/** The JSON Schema editors validate against. Generated, never hand-written. */
export function configJsonSchema(): unknown {
  return z.toJSONSchema(configSchema, { io: "input" });
}

function compiles(pattern: string | undefined): boolean {
  if (pattern === undefined) return true;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
