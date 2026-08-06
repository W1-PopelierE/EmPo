import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { indexCommand } from "../../src/commands/index";
import { reviewCommand } from "../../src/commands/review";
import { parseConfig } from "../../src/engine/config";
import { run } from "../../src/engine/git";
import { buildConfig, scaffold } from "../../src/engine/scaffold";

/**
 * What `empo init` writes (docs/02-on-disk-layout.md step 2 of docs/06-cli.md `empo init`).
 *
 * Two properties carry the whole module. The generator can only emit a config its own validator
 * accepts, which is asserted by running the written bytes back through `parseConfig` rather than by
 * reading the generator's source. And nothing it writes is ever overwritten, which is what makes
 * `empo init` safe in a repository that already has a `.empo/`, so every "kept" case below edits the
 * file first and asserts the edit survived.
 */

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

const CONFIG_PATH = ".empo/config.json";
const ROOT_CONFIG_PATH = "empo.config.json";
const FLOWS_PATH = ".empo/flows.json";
const GITKEEP_PATH = ".empo/spines/.gitkeep";
const CONVENTIONS_PATH = ".empo/conventions.md";
const GITIGNORE_PATH = ".empo/.gitignore";

/** Every file `empo init` seeds, in the order it writes them. */
const ALL_PATHS = [CONFIG_PATH, FLOWS_PATH, GITKEEP_PATH, CONVENTIONS_PATH, GITIGNORE_PATH];

const ROOTS = [
  { path: "apps/api", lang: "php" },
  { path: "apps/mobile", lang: "typescript" },
  { path: "packages/shared", lang: "typescript" },
];

/**
 * The review below is asked for under an id of its own rather than the default local one. A review
 * session lives at a fixed path under the system temp directory, keyed only by that id, so two
 * reviews running at once under one id delete each other's session halfway through. The process id
 * keeps this file's session to itself, whatever else is running against this checkout.
 */
const SESSION_ID = `empo-scaffold-seed-${process.pid}`;
const SESSION_DIR = join(tmpdir(), "empo-review", SESSION_ID);

let repo: string;
const temps: string[] = [];

function make(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-scaffold-"));
  temps.push(dir);
  return dir;
}

function read(path: string): string {
  return readFileSync(join(repo, path), "utf8");
}

function config(path = CONFIG_PATH): unknown {
  return JSON.parse(read(path));
}

/** Everything a command printed, joined, so a test can parse or search it. */
function capture(body: () => void): string {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });

  try {
    body();
  } finally {
    log.mockRestore();
  }

  return lines.join("\n");
}

beforeEach(() => {
  repo = make();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(SESSION_DIR, { recursive: true, force: true });
});

describe("buildConfig", () => {
  test("declares one pack per distinct language, whatever the roots", () => {
    const built = buildConfig({ roots: ROOTS });

    expect(built.roots).toEqual(ROOTS);
    expect(built.packs).toEqual({ php: { version: "^1" }, typescript: { version: "^1" } });
  });

  test("leaves bridges empty and invents no framework", () => {
    const built = buildConfig({ roots: ROOTS });

    // A bridge cannot be guessed from a file listing, and no pack's `match` carries a framework
    // signal, so both are the human's to add. Inventing either would be the engine pretending to
    // know a language specific it has no evidence for.
    expect(built.bridges).toEqual([]);
    for (const root of built.roots) expect(root.framework).toBeUndefined();
  });

  test("passes the validator that reads it back", () => {
    // The generator and the validator are two halves of one contract. A generator that can emit a
    // config its own reader rejects turns `empo init` into a command that leaves a repository
    // broken, so the round trip is asserted rather than assumed.
    const built = buildConfig({ roots: ROOTS });

    expect(parseConfig(JSON.parse(JSON.stringify(built)), "built by buildConfig")).toEqual(built);
  });

  test("ignores vendored and build output, and never test files", () => {
    // docs/03-config-schema.md's example ignore list contains `**/*.test.ts`, which contradicts the
    // prose two paragraphs under it: "Test **files** are not ignored (the graph needs them to
    // compute coverage)". Ignoring them would leave every flow looking untested, which is the exact
    // signal `empo query --blind` and the commit gate are built on. The prose wins.
    const built = buildConfig({ roots: ROOTS });

    expect(built.ignore).toEqual([
      "**/node_modules/**",
      "**/vendor/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
    ]);
    for (const pattern of built.ignore) expect(pattern).not.toContain("test");
  });

  test("takes the caller's ignore list when there is one", () => {
    const built = buildConfig({ roots: ROOTS, ignore: ["**/vendor/**"] });

    expect(built.ignore).toEqual(["**/vendor/**"]);
  });

  test("records the commit decision when a team keeps generated output", () => {
    expect(buildConfig({ roots: ROOTS }).commit).toEqual([]);
    expect(buildConfig({ roots: ROOTS, commitGenerated: true }).commit).toEqual(["generated"]);
  });

  test("writes a root in the one spelling every later command compares against", () => {
    // Detection mints its paths from `dirname`, so it never produces these itself. A human running
    // `empo init` past a detection it disagreed with does, and the config this writes is the file
    // the whole repository is read through afterwards. Passing the spelling straight to disk would
    // hand the engine a root that scans the right directory and matches nothing: a `./`-prefixed
    // root makes every node's `file` carry the `./` too, and a flow declared over it comes back
    // empty. The generator emits the canonical form because it emits through the validator.
    const built = buildConfig({
      roots: [
        { path: "./apps/api/", lang: "php" },
        { path: "packages/shared/", lang: "typescript" },
      ],
    });

    expect(built.roots).toEqual([
      { path: "apps/api", lang: "php" },
      { path: "packages/shared", lang: "typescript" },
    ]);
  });

  test("refuses to build a config with no roots, rather than writing one nothing can load", () => {
    // The schema wants at least one root. Failing here means `empo init` fails before it has
    // written anything, instead of leaving a `.empo/` that every later command rejects.
    expect(() => buildConfig({ roots: [] })).toThrow(/not a valid EmPo config/);
  });
});

describe("the adapters section", () => {
  const BITBUCKET = {
    kind: "mcp" as const,
    host: "bitbucket",
    workspace: "acme",
    repo: "acme-platform",
  };

  test("writes no adapters at all when neither half is known", () => {
    // `"adapters": {}` reads as a section somebody configured and then emptied. An absent adapter is
    // not a broken one, and the schema says so by making the whole section optional.
    const built = buildConfig({ roots: ROOTS });

    expect(built.adapters).toBeUndefined();
    scaffold(repo, { roots: ROOTS });
    expect(Object.keys(config() as object)).not.toContain("adapters");
  });

  test("writes the forge detection found, with the host it named", () => {
    const built = buildConfig({ roots: ROOTS, forge: BITBUCKET });

    expect(built.adapters).toEqual({ forge: BITBUCKET });
    // Through the validator that reads it back, which is the property this generator lives or dies
    // by: the new `mcp` kind and the free-text `host` both have to survive a round trip.
    scaffold(repo, { roots: ROOTS, forge: BITBUCKET });
    expect(parseConfig(config(), CONFIG_PATH).adapters).toEqual({ forge: BITBUCKET });
  });

  test("writes a github forge with no host, because the kind already names it", () => {
    const forge = { kind: "github" as const, workspace: "W1-PopelierE", repo: "EmPo" };

    expect(buildConfig({ roots: ROOTS, forge }).adapters).toEqual({ forge });
  });

  test("writes the tracker as mcp under the host the flag named", () => {
    // The only shape a seeded tracker can have. github-issues is not detectable from anything and
    // `none` is a decision rather than a seed, so a named host means one round trip through the
    // agent's connector.
    const built = buildConfig({ roots: ROOTS, trackerHost: "jira" });

    expect(built.adapters).toEqual({ tracker: { kind: "mcp", host: "jira" } });
  });

  test("writes both halves when both are known", () => {
    const built = buildConfig({ roots: ROOTS, forge: BITBUCKET, trackerHost: "jira" });

    expect(built.adapters).toEqual({
      forge: BITBUCKET,
      tracker: { kind: "mcp", host: "jira" },
    });
  });

  test("keeps a config that already has adapters, like every other file it writes", () => {
    // The rule the whole module is built on, restated for the one section a rerun would most like
    // to "fix": a human who edited their forge by hand keeps it.
    scaffold(repo, { roots: ROOTS, forge: BITBUCKET });
    const curated = read(CONFIG_PATH).replace('"host": "bitbucket"', '"host": "bitbucket-server"');
    writeFileSync(join(repo, CONFIG_PATH), curated);

    expect(scaffold(repo, { roots: ROOTS, forge: BITBUCKET })).toContainEqual({
      path: CONFIG_PATH,
      state: "kept",
    });
    expect(read(CONFIG_PATH)).toBe(curated);
  });
});

describe("a fresh repository", () => {
  test("gets all five files, in a fixed order", () => {
    const written = scaffold(repo, { roots: ROOTS });

    expect(written).toEqual(ALL_PATHS.map((path) => ({ path, state: "wrote" })));
    for (const path of ALL_PATHS) expect(existsSync(join(repo, path))).toBe(true);
  });

  test("writes a config the loader accepts, from the bytes on disk", () => {
    scaffold(repo, { roots: ROOTS });

    expect(parseConfig(config(), CONFIG_PATH)).toEqual(buildConfig({ roots: ROOTS }));
  });

  test("writes JSON with two-space indentation and a trailing newline", () => {
    // Same shape as every other artifact in a `.empo/`, so a hand edit beside a generated file does
    // not produce a whitespace-only diff.
    scaffold(repo, { roots: ROOTS });

    for (const path of [CONFIG_PATH, FLOWS_PATH]) {
      expect(read(path).endsWith("}\n")).toBe(true);
      expect(read(path)).toContain('\n  "version": 1');
    }
  });

  test("seeds an empty flows file the flows loader can read", () => {
    scaffold(repo, { roots: ROOTS });

    expect(JSON.parse(read(FLOWS_PATH))).toEqual({ version: 1, flows: {} });
  });

  test("seeds an empty spines directory that survives a clone", () => {
    // git does not track directories, so without the keep file the directory `config.spines` points
    // at would not exist in a fresh checkout. `loadSpines` filters to `*.json`, so it is inert.
    scaffold(repo, { roots: ROOTS });

    expect(read(GITKEEP_PATH)).toBe("");
  });

  test("gitignores generated output by default", () => {
    scaffold(repo, { roots: ROOTS });

    expect(read(GITIGNORE_PATH)).toContain("generated/");
    expect(config()).toMatchObject({ commit: [] });
  });
});

describe("running it a second time", () => {
  test("keeps every file and reports it", () => {
    scaffold(repo, { roots: ROOTS });

    expect(scaffold(repo, { roots: ROOTS })).toEqual(
      ALL_PATHS.map((path) => ({ path, state: "kept" })),
    );
  });

  test("rewrites nothing, even when the file on disk says something else entirely", () => {
    // The case this protects: `empo init` run again in a repository whose team has since curated
    // its config, its flows and its false-positive register. Overwriting any of it would be the
    // single most expensive thing this command could do, so each file is edited first and the edit
    // has to survive verbatim.
    scaffold(repo, { roots: ROOTS });
    for (const path of ALL_PATHS) writeFileSync(join(repo, path), `curated ${path}\n`);
    const before = ALL_PATHS.map((path) => statSync(join(repo, path)).mtimeMs);

    const second = scaffold(repo, { roots: [{ path: ".", lang: "go" }] });

    expect(second.every((file) => file.state === "kept")).toBe(true);
    for (const [index, path] of ALL_PATHS.entries()) {
      expect(read(path)).toBe(`curated ${path}\n`);
      expect(statSync(join(repo, path)).mtimeMs).toBe(before[index]);
    }
  });

  test("writes the files a partly scaffolded repository is missing, and only those", () => {
    mkdirSync(join(repo, ".empo"), { recursive: true });
    writeFileSync(join(repo, CONVENTIONS_PATH), "## a convention we learned\n");

    const written = scaffold(repo, { roots: ROOTS });

    expect(written).toContainEqual({ path: CONVENTIONS_PATH, state: "kept" });
    expect(written.filter((file) => file.state === "wrote")).toHaveLength(4);
    expect(read(CONVENTIONS_PATH)).toBe("## a convention we learned\n");
  });
});

describe("configAtRoot", () => {
  test("puts the config at the repository root and leaves the rest under .empo/", () => {
    const written = scaffold(repo, { roots: ROOTS, configAtRoot: true });

    expect(written[0]).toEqual({ path: ROOT_CONFIG_PATH, state: "wrote" });
    expect(existsSync(join(repo, CONFIG_PATH))).toBe(false);
    expect(parseConfig(config(ROOT_CONFIG_PATH), ROOT_CONFIG_PATH)).toEqual(
      buildConfig({ roots: ROOTS }),
    );

    // The root form moves one file, not the directory. flows, spines and the register are still
    // read from `.empo/` by the paths the config itself states.
    for (const path of ALL_PATHS.slice(1)) expect(existsSync(join(repo, path))).toBe(true);
    expect(config(ROOT_CONFIG_PATH)).toMatchObject({
      flows: ".empo/flows.json",
      spines: ".empo/spines",
    });
  });
});

describe("commitGenerated", () => {
  test("changes both halves of the decision: the .gitignore and the config", () => {
    // One decision, two files that have to agree. A `.gitignore` that still hides `generated/`
    // while the config claims it is committed would make `empo doctor` and git disagree about the
    // same repository.
    scaffold(repo, { roots: ROOTS, commitGenerated: true });

    expect(read(GITIGNORE_PATH)).not.toContain("generated/\n");
    expect(read(GITIGNORE_PATH)).toContain("deliberately");
    expect(config()).toMatchObject({ commit: ["generated"] });
  });

  test("leaves nothing but comments in the .gitignore", () => {
    scaffold(repo, { roots: ROOTS, commitGenerated: true });

    const rules = read(GITIGNORE_PATH)
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(rules).toEqual([]);
  });
});

describe("the seeded conventions.md", () => {
  test("counts as zero entries in a real review brief", () => {
    // `empo review` counts a register entry as any line opening with "- " or "## ", so a seeded
    // file that used either would make a brand new repository report a false-positive register it
    // has not written a word of, and the brief would tell the reviewer to go read it. This goes
    // through the real command rather than a copy of its rule, because the rule is the thing being
    // pinned and a copy of it could drift.
    const target = make();
    cpSync(fixture, target, { recursive: true });
    rmSync(join(target, ".empo/generated"), { recursive: true, force: true });

    // The fixture ships a config, which scaffold keeps; the register is what it is missing.
    const written = scaffold(target, { roots: [{ path: "apps/api", lang: "php" }] });
    expect(written).toContainEqual({ path: CONFIG_PATH, state: "kept" });
    expect(written).toContainEqual({ path: CONVENTIONS_PATH, state: "wrote" });

    capture(() => indexCommand(target));
    for (const args of [
      ["init", "-b", "main"],
      ["add", "-A", "-f"],
      [
        "-c",
        "user.email=empo@example.com",
        "-c",
        "user.name=EmPo Test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "the fixture as it stands",
      ],
    ]) {
      const result = run(target, "git", args);
      if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }

    // No forge is configured, so the id names no pull request anybody can fetch and the review
    // falls back to the local diff, which is all this needs: the brief still reports the register.
    const brief = JSON.parse(
      capture(() => reviewCommand(target, SESSION_ID, { json: true, workflow: false })),
    ) as { conventions: { path: string; entries: number } };

    expect(brief.conventions).toEqual({ path: CONVENTIONS_PATH, entries: 0 });
  });

  test("still explains what an entry looks like", () => {
    scaffold(repo, { roots: ROOTS });

    const seeded = read(CONVENTIONS_PATH);
    expect(seeded).toContain("false-positive register");
    // Zero entries by the counter's own rule, asserted on the bytes as well as through the command
    // above, because this is the one property the file's wording has to keep.
    const counted = seeded.split("\n").filter((l) => l.startsWith("- ") || l.startsWith("## "));
    expect(counted).toEqual([]);
  });
});
