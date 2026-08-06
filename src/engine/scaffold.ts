import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmpoAdapters, EmpoConfig } from "../schema/config.schema";
import type { FlowsFile } from "../schema/flows.schema";
import { CONFIG_LOCATIONS, parseConfig } from "./config";
import type { DetectedForge } from "./detect";

/**
 * What `empo init` writes into a target repository (docs/02-on-disk-layout.md, and step 2 of
 * `empo init` in docs/06-cli.md). Everything here is layer 4 and layer 2 seed material: the shape of
 * the repository, and empty vessels for the knowledge a team curates afterwards.
 *
 * One rule governs the whole module: **nothing is ever overwritten.** A repository that already has
 * a `.empo/` has a config someone tuned, flows someone approved and a false-positive register that
 * grew over months of reviews, and none of it is reproducible from a file listing. So a file that
 * exists is reported `kept` and left byte for byte as it was, which is what makes `empo init` safe
 * to run twice and safe to run over an existing installation.
 */

export interface DetectedRootLike {
  path: string;
  lang: string;
  /**
   * What `engine/aliases.ts` read out of this root's toolchain config, already repo-relative.
   * Omitted where there was nothing to read, so a repository with no aliases gets a config with no
   * `aliases` key rather than an empty object, which would read as a map somebody emptied.
   */
  aliases?: Record<string, string[]>;
}

export interface ScaffoldOptions {
  roots: DetectedRootLike[];
  /** Write `empo.config.json` at the repository root instead of `.empo/config.json`. */
  configAtRoot?: boolean;
  /** Keep `generated/` in version control (docs/02's "alternative some teams prefer"). */
  commitGenerated?: boolean;
  /** Seeds config `ignore`. */
  ignore?: string[];
  /** What `detectForge` read out of the origin remote. Absent means write no forge section. */
  forge?: DetectedForge;
  /** The host named by `empo init --tracker <host>`, which is the only way a tracker gets here. */
  trackerHost?: string;
}

export interface ScaffoldedFile {
  /** Repo-relative path. */
  path: string;
  state: "wrote" | "kept";
}

/**
 * Vendored code and build output, and deliberately **not** test files. Ignoring them would leave
 * every flow looking untested, so `empo query --blind` would call the whole repository blind and
 * the commit gate would find no assertion anywhere. docs/03-config-schema.md's `ignore` section says
 * the same rule twice, in its prose ("Test **files** are not ignored (the graph needs them to
 * compute coverage)") and in the five patterns it says `empo init` seeds, which are these five. An
 * earlier draft of that doc contradicted itself by listing a glob over `.test.ts` in its example
 * config; the example was corrected when this module was written, so the doc is safe to follow.
 */
const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
];

/** The config `empo init` would write, validated before it is returned. */
export function buildConfig(options: ScaffoldOptions): EmpoConfig {
  // Sorted, so the same set of roots produces the same file whatever order detection found them in.
  const langs = [...new Set(options.roots.map((root) => root.lang))].sort();
  const packs: Record<string, { version: string }> = {};
  for (const lang of langs) packs[lang] = { version: "^1" };

  const draft = {
    version: 1,
    // Path, lang, and the alias map if the root's toolchain declared one. No `framework`: nothing
    // in a pack's `match` carries a framework signal, so a generated hint would be the engine
    // guessing at a language specific, which is the one thing the pack contract exists to keep out
    // of it. A human adds it, and the pack acts on it. `aliases` is the opposite case and that is
    // why it is seeded: it is not a guess at all, it is a copy of what the build already resolves
    // with, and left unwritten every aliased import in the repository resolves to nothing.
    roots: options.roots.map((root) => ({
      path: root.path,
      lang: root.lang,
      ...(root.aliases === undefined || Object.keys(root.aliases).length === 0
        ? {}
        : { aliases: root.aliases }),
    })),
    packs,
    // Empty on purpose. A bridge is a claim that two roots exchange a symbol under a normalization
    // rule, and neither half is visible in a file listing. docs/03: no bridges at all is valid.
    bridges: [],
    // Stated rather than left to the schema default, because these two are the paths a human edits
    // when they move the directory, and a knob nobody can see is a knob nobody turns.
    flows: ".empo/flows.json",
    spines: ".empo/spines",
    ignore: options.ignore ?? [...DEFAULT_IGNORE],
    commit: options.commitGenerated === true ? ["generated"] : [],
    // Omitted entirely when neither half is known, because `"adapters": {}` reads as a section
    // somebody configured and then emptied, and an absent adapter is not a broken one: no forge
    // means `empo review` reads the local diff, and no tracker means it skips ticket-fit and says so.
    ...adapters(options),
  };

  // Through the same validator that reads it back, so this generator cannot emit a config the rest
  // of the CLI rejects. It also fails before a single file is written (see scaffold below).
  return parseConfig(draft, "The config empo init generates");
}

/**
 * The forge as detection reported it, and the tracker as the flag named it. A tracker is always
 * kind `mcp`: the two trackers empo can read for itself are GitHub issues, which nothing detects,
 * and `none`, which is a decision rather than a seed.
 */
function adapters(options: ScaffoldOptions): { adapters?: EmpoAdapters } {
  const forge = options.forge;
  const host = options.trackerHost;
  if (forge === undefined && host === undefined) return {};

  return {
    adapters: {
      ...(forge === undefined ? {} : { forge }),
      ...(host === undefined ? {} : { tracker: { kind: "mcp" as const, host } }),
    },
  };
}

/** Writes every missing file and leaves every existing one alone. Deterministic order. */
export function scaffold(repoRoot: string, options: ScaffoldOptions): ScaffoldedFile[] {
  const config = buildConfig(options);
  // The two paths findConfigPath searches, in its order, so the writer and the reader can never
  // disagree about where a config lives.
  const [inEmpo, atRoot] = CONFIG_LOCATIONS;
  const configPath = options.configAtRoot === true ? atRoot : inEmpo;

  // The config first, because it is the file every other one is described by, and the `.gitignore`
  // last, so a run that dies part way leaves a directory that is missing files rather than one that
  // is already hiding them from git. Even with the config at the repository root, the rest stays
  // under `.empo/`: the root form moves one file, it does not move the directory.
  const files: [string, string][] = [
    [configPath, json(config)],
    [".empo/flows.json", json(EMPTY_FLOWS)],
    [".empo/spines/.gitkeep", ""],
    [".empo/conventions.md", CONVENTIONS],
    [".empo/.gitignore", gitignore(options.commitGenerated === true)],
  ];

  return files.map(([path, content]) => write(repoRoot, path, content));
}

const EMPTY_FLOWS: FlowsFile = { version: 1, flows: {} };

function write(repoRoot: string, path: string, content: string): ScaffoldedFile {
  const target = join(repoRoot, path);
  if (existsSync(target)) return { path, state: "kept" };

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  return { path, state: "wrote" };
}

/** Two spaces and a trailing newline, the shape of every other JSON artifact in a `.empo/`. */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gitignore(commitGenerated: boolean): string {
  if (commitGenerated) {
    return [
      "# Nothing is ignored here. This repository commits its generated output deliberately, so a",
      "# fresh clone can run empo query with no setup, and the config's commit list records the",
      "# same decision. The tradeoff (diff noise against zero setup) is the team's to make.",
      "",
    ].join("\n");
  }

  return [
    "# Machine-owned output. empo index rebuilds it in seconds, it changes on every meaningful",
    "# commit, and its built_against sha says when it is stale, so committing it buys noise.",
    "generated/",
    "",
  ].join("\n");
}

/**
 * The false-positive register, seeded empty and explaining itself.
 *
 * The one hard constraint on this text: `empo review` counts an entry as any line opening with
 * "- " or "## " (commands/review.ts, conventionsFacts), so a seed using either would make a brand
 * new repository report a register full of entries the team never wrote, and the brief would send
 * the reviewer off to read them. Every line below opens with something else, deliberately, and a
 * spec pins it through the real counter.
 */
const CONVENTIONS = `# Conventions

The false-positive register. When a review flags something that a human judges to be correct as it
stands, the judgement belongs here, so the next review does not raise it again. \`empo review\`
counts the entries and tells the reviewer to read them before flagging anything.

It starts empty, because a convention nobody agreed to is worse than none: the register earns its
authority from having been written by this team, about this repository, one confirmed false
positive at a time.

Write one entry per convention. Open it with a second-level heading naming the rule, then a short
paragraph saying why the obvious finding is wrong here, with a file and line an author can open. A
heading and a bullet are both counted as entries, so keep the prose in paragraphs.
`;
