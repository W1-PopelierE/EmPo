import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initCommand, proposalPath } from "../../src/commands/init";
import { verifyCommand } from "../../src/commands/verify";
import { mapWorkflow } from "../../src/discipline/load";
import { run } from "../../src/engine/git";
import { LIST_FRAMEWORK_RESOLVED, NOT_AN_ARRIVAL_REASON } from "../../src/engine/kinds";
import { EmpoError } from "../../src/errors";
import { AGENTS_PATH, EMPO_BEGIN } from "../../src/host/agents";
import { SKILL_NAMES } from "../../src/host/claude";
import { codexSkillPath } from "../../src/host/codex";

/**
 * `empo init` end to end over the acme fixture: the on-ramp, judged on what it leaves on disk.
 *
 * Every case copies the fixture to a throwaway directory and deletes its `.empo/` first, so init
 * runs against what it is actually for: a repository that has source and manifests and no EmPo at
 * all. Most of them are not git checkouts either, which is deliberate rather than laziness. Nothing
 * in init needs git, `engine/git.ts` is best-effort by design, and a scaffolding command that only
 * worked inside a checkout would be useless in exactly the freshly extracted directory people run it
 * in. One case does commit, to prove the other half.
 *
 * No line number below is counted by hand. Every coordinate a proposal states is read out of the
 * file it cites, so an edit to the fixture shows up here as a failure rather than as a test that
 * quietly checks the wrong number.
 *
 * What is deliberately *not* tested here lives one layer down and already has a spec:
 * engine/detect.ts, engine/scaffold.ts, engine/proposal.ts and host/agents.ts. This file pins the
 * command: that it composes them in the right order, prints what a human needs, and writes nothing
 * a human did not ask for.
 */

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

const CONFIG_PATH = ".empo/config.json";
const ROOT_CONFIG_PATH = "empo.config.json";
const FLOWS_PATH = ".empo/flows.json";
const GITKEEP_PATH = ".empo/spines/.gitkeep";
const CONVENTIONS_PATH = ".empo/conventions.md";
const GITIGNORE_PATH = ".empo/.gitignore";

/** Everything init scaffolds, in the order it writes them. */
const SCAFFOLDED = [CONFIG_PATH, FLOWS_PATH, GITKEEP_PATH, CONVENTIONS_PATH, GITIGNORE_PATH];

const ROUTES_FILE = "apps/api/routes/api.php";
const CALCULATOR_FILE = "apps/api/app/Libraries/Price/PriceCalculator.php";
const CONTROLLER_FILE = "apps/api/app/Http/Controllers/OrderController.php";
const OBSERVER_FILE = "apps/api/app/Observers/OrderObserver.php";
const PAGE_FILE = "apps/portal/src/Pages/Orders/Show.vue";
/** Two nodes under it, both tests, so the graph holds it and no flow can ever own it. */
const TESTS_DIR = "apps/api/tests";

const ORDERS_ROUTE_ANCHOR = "Route::post('/v1/orders'";
const CHECKOUT_ROUTE_ANCHOR = "Route::post('/v1/checkout'";
const SHOW_ROUTE_ANCHOR = "Route::get('/v1/orders/{order}'";
const PAGE_ROUTE_ANCHOR = "Route::get('/orders/{order}'";
const TOTAL_ANCHOR = "return $order->subtotal + $this->tax(";
const CACHE_ANCHOR = "the order summary cache is refreshed here";

/** An anchor that reads like the calculator and is nowhere in it: the fiction the gate exists for. */
const INVENTED_ANCHOR = "$total = round($subtotal * 1.21);";

const temps: string[] = [];

interface Recorded {
  printed: string;
  thrown: unknown;
}

/** One run of a command, with everything it printed and whatever it threw kept side by side. */
function record(body: () => void): Recorded {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });

  let thrown: unknown;
  try {
    body();
  } catch (error) {
    thrown = error;
  } finally {
    log.mockRestore();
  }

  return { printed: lines.join("\n"), thrown };
}

/** Everything the command printed, joined, so a test can look for one line in it. */
function capture(body: () => void): string {
  const { printed, thrown } = record(body);
  if (thrown !== undefined) throw thrown;
  return printed;
}

/**
 * init prints a long report and then, on a usage error, fails. A test that only caught the error
 * would be blind to the part a human reads, so both halves come back from one run.
 */
function expectEmpoError(
  exitCode: number,
  body: () => void,
): { error: EmpoError; printed: string } {
  const { printed, thrown } = record(body);
  expect(thrown, `expected a EmpoError with exit code ${exitCode}`).toBeInstanceOf(EmpoError);
  expect((thrown as EmpoError).exitCode).toBe(exitCode);
  return { error: thrown as EmpoError, printed };
}

/** The fixture's source and manifests with no EmPo at all, which is what init is for. */
function target(): string {
  const repo = mkdtempSync(join(tmpdir(), "empo-init-"));
  cpSync(fixture, repo, { recursive: true });
  rmSync(join(repo, ".empo"), { recursive: true, force: true });
  temps.push(repo);
  // The brief creates the scratch directory it names, outside the repository, so it is cleaned up
  // with the repository rather than left behind under the system temp directory.
  temps.push(dirname(proposalPath(repo)));
  return repo;
}

/** A directory with nothing any installed pack claims: no manifest, no source. */
function emptyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "empo-init-bare-"));
  writeFileSync(join(repo, "README.md"), "# acme-platform\n");
  temps.push(repo);
  return repo;
}

function git(repo: string, args: string[]): void {
  const result = run(repo, "git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** -c on the commit so this passes with no git identity and no signing key configured. */
function commitEverything(repo: string): void {
  git(repo, ["init", "-b", "main"]);
  git(repo, ["add", "-A", "-f"]);
  git(repo, [
    "-c",
    "user.email=empo@example.com",
    "-c",
    "user.name=EmPo Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "the fixture as it stands",
  ]);
}

function read(repo: string, path: string): string {
  return readFileSync(join(repo, path), "utf8");
}

function configOf(repo: string, path = CONFIG_PATH): Record<string, unknown> {
  return JSON.parse(read(repo, path)) as Record<string, unknown>;
}

/** The line an anchor really sits on, read from the file, never counted by hand. */
function lineOf(repo: string, path: string, anchor: string): number {
  const index = read(repo, path)
    .split("\n")
    .findIndex((line) => line.includes(anchor));
  if (index === -1) throw new Error(`no line of ${path} contains "${anchor}"`);
  return index + 1;
}

/**
 * The rows printed under one heading of the brief, up to the blank line that ends the section, with
 * the column padding collapsed. Reading the section back is what lets a test assert an order.
 */
function section(printed: string, heading: string): string[] {
  const lines = printed.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) throw new Error(`the brief printed no section starting with "${heading}"`);

  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    rows.push(line.trim().replace(/\s+/g, " "));
  }
  return rows;
}

/**
 * Every byte under `.empo/`, so "wrote nothing" can be asserted against disk and not against text.
 *
 * The walk is written out rather than handed to `readdirSync`'s `recursive` option. Both halves of
 * that option used to be newer than the Node this package claimed to run on: `recursive` landed in
 * 20.1.0, and `Dirent.parentPath`, the only way to rebuild a full path from an entry a recursive
 * walk yields, landed in 20.12.0 and 21.4.0, while `package.json` declared `"node": ">=20"`. On
 * 20.0 through 20.11 `entry.parentPath` is `undefined` and `join` throws `ERR_INVALID_ARG_TYPE`, so
 * the three tests that call this helper failed on the helper instead of asserting anything.
 *
 * The floor has since moved to `>=22.12.0`, so both halves are inside it now and this helper is
 * kept because it works. The paragraph above is left standing because of what closing that gap
 * showed: the package had never run on Node 20 at all, `execa@10` needs 22, and the care that went
 * into avoiding an API three minor versions inside the range went nowhere near the dependency two
 * majors outside it. `test/engines.test.ts` is the check that asks the second question.
 */
function snapshot(repo: string): Map<string, string> {
  const bytes = new Map<string, string>();
  const root = join(repo, ".empo");

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) bytes.set(path, readFileSync(path, "utf8"));
    }
  }
  walk(root);

  // An equality between two empty maps passes whatever the command did, so the one thing this
  // helper must never do quietly is come back with nothing.
  if (bytes.size === 0) throw new Error(`${root} holds no files, so comparing it proves nothing`);
  return bytes;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Phase 1: detect, scaffold, wire, index, brief
// ---------------------------------------------------------------------------------------------

describe("a repository with no EmPo in it", () => {
  test("scaffolds five files and detects the roots the fixture's own config states", () => {
    const repo = target();

    const printed = capture(() => {
      initCommand(repo);
    });

    // Detection has to arrive at the roots a human wrote by hand for this same repository, so the
    // expectation is read out of the fixture's committed config rather than restated here. If the
    // two ever disagree, one of them is wrong and this is where it shows.
    const handWritten = JSON.parse(readFileSync(join(fixture, CONFIG_PATH), "utf8")) as {
      roots: { path: string; lang: string }[];
    };
    const roots = handWritten.roots.map((root) => ({ path: root.path, lang: root.lang }));
    expect(roots).toEqual([
      { path: "apps/api", lang: "php" },
      { path: "apps/mobile", lang: "typescript" },
      { path: "apps/portal", lang: "typescript" },
    ]);
    expect(configOf(repo).roots).toEqual(roots);
    expect(configOf(repo).packs).toEqual({ php: { version: "^1" }, typescript: { version: "^1" } });

    expect(printed).toContain("detected   3 roots under");
    expect(printed).toMatch(/apps\/api\s+php\s+\d+ files \(manifest\)/);
    expect(printed).toMatch(/apps\/mobile\s+typescript\s+\d+ files \(manifest\)/);
    expect(printed).toMatch(/apps\/portal\s+typescript\s+\d+ files \(manifest\)/);
    // The workspace container at the repository root declares the packages and holds no code. A
    // root there would swallow all three of them, so it is dropped, and the drop is printed rather than
    // swallowed: a missing root is the first thing a human asks about.
    expect(printed).toContain("skipped . (typescript): every typescript file under it belongs");

    for (const path of SCAFFOLDED) {
      expect(printed).toContain(`wrote ${path}`);
      expect(existsSync(join(repo, path))).toBe(true);
    }
    expect(existsSync(join(repo, ".empo/generated/graph.json"))).toBe(true);
  });

  test("works with no git at all, because nothing in it needs a checkout", () => {
    // The case a freshly extracted directory depends on. git is best-effort everywhere in EmPo, so
    // the only thing missing here is staleness tracking, and init says so instead of failing.
    const repo = target();
    expect(existsSync(join(repo, ".git"))).toBe(false);
    // A `.git` of its own is only half of it. git walks *up*, so a $TMPDIR that itself sits inside
    // a checkout makes this directory part of that work tree and init reports a real sha, and the
    // check above cannot see that. Ask git, which is the one answer that settles it.
    expect(run(repo, "git", ["rev-parse", "--show-toplevel"]).ok).toBe(false);

    const printed = capture(() => {
      initCommand(repo);
    });

    expect(printed).toContain("built      not a git repository, no staleness tracking");
    expect(existsSync(join(repo, ".empo/generated/graph.json"))).toBe(true);
  });

  test("records the commit it indexed against when there is a checkout", () => {
    const repo = target();
    commitEverything(repo);

    const printed = capture(() => {
      initCommand(repo);
    });

    expect(printed).not.toContain("not a git repository");
    expect(printed).toMatch(/built {6}[0-9a-f]{7}/);
    const graph = JSON.parse(read(repo, ".empo/generated/graph.json")) as { builtAgainst: string };
    expect(graph.builtAgainst).toMatch(/^[0-9a-f]{40}$/);
  });

  test("exits 2 when nothing any installed pack matches, rather than writing a config", () => {
    // The alternative is worse than failing: a config with no roots does not satisfy the schema, so
    // every later command would reject a `.empo/` that init itself had just written.
    const repo = emptyRepo();

    const { error, printed } = expectEmpoError(2, () => {
      initCommand(repo);
    });

    expect(error.message).toContain("Detected nothing EmPo can index");
    expect(error.details.join("\n")).toContain("docs/03-config-schema.md has a complete example");
    expect(printed).toContain("detected   0 roots under");
    expect(existsSync(join(repo, ".empo"))).toBe(false);
  });
});

describe("running it a second time", () => {
  test("keeps every file, changes no bytes, and still prints the brief", () => {
    // This is what makes init the repair command for a half-scaffolded project, and why there is no
    // --force. A repository that already has a `.empo/` has a config someone tuned and a register
    // that grew over months of reviews, none of which is reproducible from a file listing.
    const repo = target();
    capture(() => {
      initCommand(repo);
    });
    const before = SCAFFOLDED.map((path) => read(repo, path));

    const printed = capture(() => {
      initCommand(repo);
    });

    for (const path of SCAFFOLDED) expect(printed).toContain(`kept  ${path}`);
    expect(printed).not.toContain("wrote .empo/");
    for (const [index, path] of SCAFFOLDED.entries()) expect(read(repo, path)).toBe(before[index]);

    // And the detected roots are reported as not written, because the config on disk is the
    // human's and detection disagreeing with it is theirs to settle.
    expect(printed).toContain(`${CONFIG_PATH} was already there, so the detected roots above`);
    expect(printed).toContain("the map brief: the facts to propose flows and spines from");
  });
});

describe("the flags", () => {
  test("--lang restricts detection to the packs named", () => {
    const repo = target();

    const printed = capture(() => {
      initCommand(repo, { lang: "php" });
    });

    expect(configOf(repo).roots).toEqual([{ path: "apps/api", lang: "php" }]);
    expect(configOf(repo).packs).toEqual({ php: { version: "^1" } });
    expect(printed).toContain("detected   1 root under");
    expect(printed).toContain("roots      apps/api (php)");
  });

  test("--no-host writes no host files, and the default run writes shared instructions and both skill targets", () => {
    const skipped = target();
    const skippedOutput = capture(() => {
      initCommand(skipped, { host: false });
    });

    expect(existsSync(join(skipped, AGENTS_PATH))).toBe(false);
    for (const name of SKILL_NAMES)
      expect(existsSync(join(skipped, codexSkillPath(name)))).toBe(false);
    expect(skippedOutput).toContain("skipped (--no-host). Nothing outside .empo/ was touched.");

    const wired = target();
    const wiredOutput = capture(() => {
      initCommand(wired);
    });

    expect(wiredOutput).toContain(`created   ${AGENTS_PATH}`);
    const agents = read(wired, AGENTS_PATH);
    expect(agents).toContain(EMPO_BEGIN);
    // Generated from the config init just wrote, not shipped as static text: the useful half of
    // these instructions is which directory is which language in *this* repository.
    expect(agents).toContain("- `apps/api` (php)");
    expect(agents).toContain("- `apps/mobile` (typescript)");
    for (const name of SKILL_NAMES) {
      expect(wiredOutput).toContain(`created   ${codexSkillPath(name)}`);
      expect(existsSync(join(wired, codexSkillPath(name)))).toBe(true);
    }
  });

  test("--config-at-root moves one file and leaves the rest under .empo/", () => {
    const repo = target();

    const printed = capture(() => {
      initCommand(repo, { configAtRoot: true });
    });

    expect(printed).toContain(`wrote ${ROOT_CONFIG_PATH}`);
    expect(existsSync(join(repo, ROOT_CONFIG_PATH))).toBe(true);
    expect(existsSync(join(repo, CONFIG_PATH))).toBe(false);
    for (const path of SCAFFOLDED.slice(1)) expect(existsSync(join(repo, path))).toBe(true);

    const config = configOf(repo, ROOT_CONFIG_PATH);
    expect(config.flows).toBe(FLOWS_PATH);
    expect(config.spines).toBe(".empo/spines");
    // And the index step that follows reads the config from where it really landed, which is the
    // half a scaffolder that only moved the file would get away with breaking.
    expect(printed).toContain(join(repo, ROOT_CONFIG_PATH));
  });

  test("--commit-generated changes both halves of the decision", () => {
    // One decision, two files that have to agree. A `.gitignore` still hiding `generated/` while
    // the config claims it is committed would make git and `empo doctor` disagree about the same
    // repository.
    const committed = target();
    capture(() => {
      initCommand(committed, { commitGenerated: true });
    });

    expect(read(committed, GITIGNORE_PATH)).not.toContain("generated/\n");
    expect(read(committed, GITIGNORE_PATH)).toContain("deliberately");
    expect(configOf(committed).commit).toEqual(["generated"]);

    const ignored = target();
    capture(() => {
      initCommand(ignored);
    });

    expect(read(ignored, GITIGNORE_PATH)).toContain("generated/");
    expect(configOf(ignored).commit).toEqual([]);
  });

  test("--apply with no --proposal exits 2 before it scaffolds anything", () => {
    const repo = target();

    const { error } = expectEmpoError(2, () => {
      initCommand(repo, { apply: true });
    });

    expect(error.message).toContain("empo init --apply needs a proposal to apply");
    expect(error.details.join("\n")).toContain("empo init --proposal <path> --apply");
    // A usage error is refused before any work, so the repository is exactly as it was.
    expect(existsSync(join(repo, ".empo"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The aliases section, printed between the scaffold and the forge
// ---------------------------------------------------------------------------------------------

const TSCONFIG_PATH = "apps/mobile/tsconfig.json";

/**
 * A tsconfig in the shape `tsc --init` really writes one: a comment above the block it belongs to,
 * a comment at the end of a line, and a trailing comma after the last entry of two nested objects.
 * None of that is valid JSON.
 *
 * That is deliberate and it is half of what these cases assert. A seeder built on `JSON.parse`
 * alone would refuse the majority of real tsconfigs and report every one of those repositories as
 * having no aliases, which is indistinguishable from a repository that genuinely has none.
 */
function tsconfigWith(paths: string[], extendsClause?: string): string {
  return [
    "{",
    "  // Visit https://aka.ms/tsconfig to read more about this file",
    ...(extendsClause === undefined ? [] : [`  "extends": ${JSON.stringify(extendsClause)},`]),
    '  "compilerOptions": {',
    "    /* Modules */",
    '    "moduleResolution": "bundler",',
    '    "paths": {',
    ...paths.map((line) => `      ${line}`),
    "    },",
    "",
    '    "strict": true, // every file, no exceptions',
    "  },",
    "}",
    "",
  ].join("\n");
}

const ONE_ALIAS = tsconfigWith(['"@/*": ["./src/*"],']);

function writeTsconfig(repo: string, body: string): void {
  writeFileSync(join(repo, TSCONFIG_PATH), body);
}

/** A human editing the seeded map back out, which is the disagreement the rerun has to notice. */
function stripAliases(repo: string): void {
  const path = join(repo, CONFIG_PATH);
  const config = JSON.parse(readFileSync(path, "utf8")) as {
    roots: { path: string; aliases?: Record<string, string[]> }[];
  };
  for (const root of config.roots) delete root.aliases;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

describe("the aliases section", () => {
  test("seeds the map its toolchain declares into the config it writes, and prints it", () => {
    const repo = target();
    writeTsconfig(repo, ONE_ALIAS);

    const printed = capture(() => {
      initCommand(repo, { host: false });
    });

    // The target is repo-relative, not root-relative: `./src/*` in a tsconfig under `apps/mobile`
    // becomes `apps/mobile/src/*`, because that is the form a node id has.
    expect(configOf(repo).roots).toEqual([
      { path: "apps/api", lang: "php" },
      { path: "apps/mobile", lang: "typescript", aliases: { "@/*": ["apps/mobile/src/*"] } },
      { path: "apps/portal", lang: "typescript" },
    ]);

    // apps/api is absent from the section rather than listed as having none, because the php pack
    // declares no `aliasSources` at all: a language whose imports carry no aliases has nothing to
    // be told, and a row saying "no aliases" would read as a gap somebody should close.
    expect(section(printed, "aliases")).toEqual([
      "apps/mobile 1 alias from apps/mobile/tsconfig.json",
      "@/* -> apps/mobile/src/*",
      "apps/portal no toolchain config under it, so no aliases",
    ]);

    // The cost, stated at the moment the copy is taken rather than discovered later, because the
    // graph never reopens the tsconfig and a map that has silently drifted deletes edges.
    expect(printed).toContain("This map is a copy taken once");
    expect(printed).toContain("an alias the config does not name resolves to nothing");
  });

  test("names a root with no toolchain config, and prints nothing for a language that has none", () => {
    // The fixture carries no tsconfig, so both typescript roots land in the honest middle case:
    // a normal root, read, nothing found. This is the wording a reader gets on most repositories.
    const repo = target();

    const printed = capture(() => {
      initCommand(repo, { host: false });
    });

    expect(section(printed, "aliases")).toEqual([
      "apps/mobile no toolchain config under it, so no aliases",
      "apps/portal no toolchain config under it, so no aliases",
    ]);
    // Nothing was seeded, so there is no copy to warn about going stale, and the paragraph that
    // would say so is absent rather than printed over an empty map.
    expect(printed).not.toContain("This map is a copy taken once");
    expect(configOf(repo).roots).toEqual([
      { path: "apps/api", lang: "php" },
      { path: "apps/mobile", lang: "typescript" },
      { path: "apps/portal", lang: "typescript" },
    ]);

    // And a php-only repository gets no section at all, rather than a heading with nothing under
    // it. An empty heading is a question a reader then has to answer by reading the source.
    const php = target();
    const phpPrinted = capture(() => {
      initCommand(php, { lang: "php", host: false });
    });

    expect(phpPrinted).not.toContain("\naliases\n");
  });

  test("raises no alarm on a rerun whose config already says what the toolchain says", () => {
    // The half that is easy to get wrong and was got wrong once already. "NOT written" printed over
    // a rerun that had nothing to write is an alarm that is usually false, and an alarm that is
    // usually false is one nobody reads on the day it is true. Same constraint the tracker block
    // below is pinned against.
    const repo = target();
    writeTsconfig(repo, ONE_ALIAS);
    capture(() => {
      initCommand(repo, { host: false });
    });
    const before = read(repo, CONFIG_PATH);

    const printed = capture(() => {
      initCommand(repo, { host: false });
    });

    expect(read(repo, CONFIG_PATH)).toBe(before);
    const rows = section(printed, "aliases");
    expect(rows).toContain("apps/mobile 1 alias from apps/mobile/tsconfig.json");
    // Scoped to this section, because the forge and tracker blocks print "NOT written" lines of
    // their own on a rerun and an unscoped assertion would be satisfied by one of those.
    expect(rows.some((row) => row.includes("NOT written"))).toBe(false);
    expect(rows.some((row) => row.includes("never overwrites"))).toBe(false);
  });

  test("says the map was not written when the config on disk disagrees with the toolchain", () => {
    // The case the section exists for. init never overwrites a config, so a repository whose
    // tsconfig grew an alias after init, or whose map somebody edited out, resolves every import
    // written through that alias to nothing, and this is the only place anybody is told.
    const repo = target();
    writeTsconfig(repo, ONE_ALIAS);
    capture(() => {
      initCommand(repo, { host: false });
    });
    stripAliases(repo);
    const before = read(repo, CONFIG_PATH);

    const printed = capture(() => {
      initCommand(repo, { host: false });
    });

    expect(printed).toContain(
      "NOT written: a config was already there, and empo init never overwrites one.",
    );
    // The consequence, not just the fact. A reader who is only told a file was not written has no
    // reason to act, and the cost here is edges the graph does not hold.
    expect(printed).toContain("import written through them is an edge the graph does not hold");
    expect(printed).toContain("into roots[].aliases by hand.");
    // The blank line between the prose and the map. Without it the table reads as a continuation
    // of the sentence, which is how every other block here would have printed it wrong.
    expect(printed).toContain("by hand.\n\n  apps/mobile");
    // Still printed underneath, because the repair is a copy and the reader needs the map to copy.
    // Read off the raw lines rather than through `section()`, which stops at the first blank line
    // and so cannot see past the separator the assertion above just pinned. The helper's blind spot
    // is exactly what hid two shipped defects in this repository before.
    expect(printed).toMatch(/^ {6}@\/\* +-> apps\/mobile\/src\/\*$/m);

    // And the config really was left alone, asserted against the bytes rather than against that
    // sentence, which is exactly what a command that had overwritten would still print.
    expect(read(repo, CONFIG_PATH)).toBe(before);
  });

  test("names a package extends rather than following it, because that file is not the repo's", () => {
    // A relative extends is followed; a package one resolves through the module system, and a
    // seeder that guessed at node_modules would seed a map out of a file this repository does not
    // control. What is not followed is said out loud, on the same rule the whole section runs on:
    // a map that is quietly narrower than the one the build uses deletes edges.
    const repo = target();
    writeTsconfig(repo, tsconfigWith(['"@/*": ["./src/*"],'], "@acme/tsconfig-base"));

    const printed = capture(() => {
      initCommand(repo, { host: false });
    });

    // Joined, because the note is wrapped to the width the rest of this command prints at and so
    // spans more than one line. The sentence is what is being pinned, not where it breaks.
    expect(section(printed, "aliases").join(" ")).toContain(
      'apps/mobile/tsconfig.json extends "@acme/tsconfig-base", which is a package rather than ' +
        "a path, so any aliases it declares were not read",
    );
    // And it really is wrapped. The notes are assembled in engine/aliases.ts for source width and
    // know nothing about a terminal, so the longest of them ran to 137 characters against the 78
    // every other block here wraps at, and a line that overflows is a line a reader skips.
    const overflowing = printed
      .split("\n")
      .filter((line) => line.startsWith("      apps/mobile/tsconfig.json extends"))
      .filter((line) => line.length > 78);
    expect(overflowing).toEqual([]);
    // The aliases the file declares itself are still seeded: what could not be read is the
    // inherited half, and dropping the half that was readable would be a second silent narrowing.
    expect(configOf(repo).roots).toContainEqual({
      path: "apps/mobile",
      lang: "typescript",
      aliases: { "@/*": ["apps/mobile/src/*"] },
    });
  });

  test("indents a pattern under its root and lines the arrows up, in the raw printed lines", () => {
    // Three properties of the layout, none of which any assertion above can see: `section()` stops
    // at the first blank line and collapses runs of whitespace, so separators, indentation and
    // column widths are exactly its blind spot. Two shipped defects in this repository lived in
    // that blind spot before. docs/14 calls printed text an interface.
    const repo = target();
    const paths = ['"@/*": ["./src/*"],', '"@components/*": ["./src/components/*"],'];
    writeTsconfig(repo, tsconfigWith(paths));

    const lines = capture(() => {
      initCommand(repo, { host: false });
    }).split("\n");

    const heading = lines.indexOf("aliases");
    expect(heading, "the brief printed no aliases section").toBeGreaterThan(-1);
    // A heading at column zero and a blank line above it, so the section is a section.
    expect(lines[heading - 1]).toBe("");

    const root = lines[heading + 1] ?? "";
    const first = lines[heading + 2] ?? "";
    const second = lines[heading + 3] ?? "";

    // A root row sits at two spaces and a pattern under it at six, so a pattern can never be read
    // as a root of its own. The noun after the count is deliberately not pinned here: `plural()`
    // spells it "aliass", which is a defect in src/ and not something this test should freeze.
    expect(root).toMatch(/^ {2}apps\/mobile {14}2 alias/);
    expect(first).toMatch(/^ {6}@\/\* /);
    expect(second).toMatch(/^ {6}@components\/\* /);

    // The patterns are sorted and their targets line up in one column, which is what makes two
    // patterns of different lengths readable as a map rather than as two sentences.
    expect(first.indexOf(" -> ")).toBe(second.indexOf(" -> "));
    expect(first).toContain("-> apps/mobile/src/*");
    expect(second).toContain("-> apps/mobile/src/components/*");

    // And the closing paragraph is set apart by a blank line and sits at root indent, so it is not
    // read as another root of the repository.
    const closing = lines.findIndex(
      (line, index) => index > heading && line.includes("This map is a copy taken once"),
    );
    expect(closing).toBeGreaterThan(heading);
    expect(lines[closing - 1]).toBe("");
    expect(lines[closing]).toMatch(/^ {2}\S/);
  });
});

describe("the forge and the tracker", () => {
  /** A checkout whose origin says where the pull requests live, which is all detection reads. */
  function withOrigin(repo: string, url: string): void {
    git(repo, ["init", "-b", "main"]);
    git(repo, ["remote", "add", "origin", url]);
  }

  function adaptersOf(repo: string): Record<string, unknown> | undefined {
    return configOf(repo).adapters as Record<string, unknown> | undefined;
  }

  test("seeds an mcp forge from a host empo cannot reach itself, and names it", () => {
    const repo = target();
    withOrigin(repo, "git@bitbucket.org:acme/acme-platform.git");

    const printed = capture(() => {
      initCommand(repo);
    });

    expect(adaptersOf(repo)).toEqual({
      forge: { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "acme-platform" },
    });
    expect(printed).toContain("mcp, host bitbucket, acme/acme-platform, from the origin");
    // The half a human would otherwise have to be told twice: `mcp` is not a server they have to
    // go and run, it is the agent in front of them being asked to fetch.
    expect(printed).toContain(
      "the agent running it fetches the pull request with its own connector",
    );
  });

  test("seeds the gh-CLI forge for github, rather than the round trip", () => {
    const repo = target();
    withOrigin(repo, "https://github.com/W1-PopelierE/EmPo.git");

    const printed = capture(() => {
      initCommand(repo);
    });

    expect(adaptersOf(repo)).toEqual({
      forge: { kind: "github", workspace: "W1-PopelierE", repo: "EmPo" },
    });
    expect(printed).toContain("github, W1-PopelierE/EmPo, from the origin remote");
    expect(printed).toContain("through the gh CLI");
  });

  test("writes no forge at all when the checkout has no origin to read one from", () => {
    const repo = target();

    const printed = capture(() => {
      initCommand(repo);
    });

    expect(configOf(repo).adapters).toBeUndefined();
    expect(printed).toContain("none: this checkout has no origin remote to read one from");
    expect(printed).toContain("empo review works");
  });

  test("says a tracker could not be detected, because a silent absence costs a review", () => {
    // The note this whole block exists for. A missing tracker means every review skips ticket-fit,
    // and the person who could have supplied the ticket should hear that at init time rather than
    // discover it in a report weeks later. Same reasoning as the bridge gap two sections down.
    const repo = target();

    const printed = capture(() => {
      initCommand(repo);
    });

    expect(printed).toContain("tracker");
    expect(printed).toContain("Nothing in a checkout names the system the tickets live in");
    expect(printed).toContain("skips ticket-fit");
    expect(printed).toContain("empo init --tracker <host> (jira, asana, linear)");
  });

  test("--tracker writes an mcp tracker under the host it names", () => {
    const repo = target();

    const printed = capture(() => {
      initCommand(repo, { tracker: "jira" });
    });

    expect(adaptersOf(repo)).toEqual({ tracker: { kind: "mcp", host: "jira" } });
    expect(printed).toContain("mcp, host jira, from --tracker");
    expect(printed).not.toContain("Nothing in a checkout names the system");
  });

  test("--tracker takes a host nothing in empo has heard of, because nothing branches on it", () => {
    // `host` is free text that is only ever printed at the agent. An enum here would refuse a
    // perfectly good connector for no gain.
    const repo = target();

    capture(() => {
      initCommand(repo, { tracker: "shortcut" });
    });

    expect(adaptersOf(repo)).toEqual({ tracker: { kind: "mcp", host: "shortcut" } });
  });

  test("--tracker with no host exits 2 before anything is written", () => {
    const repo = target();

    const { error } = expectEmpoError(2, () => {
      initCommand(repo, { tracker: "   " });
    });

    expect(error.message).toContain("--tracker was given no host");
    expect(error.details.join("\n")).toContain("--tracker jira");
    expect(existsSync(join(repo, ".empo"))).toBe(false);
  });

  test("leads with the no-op when a flag was refused by a config that was already there", () => {
    // The whole point of the wording. `empo init --tracker linear` on an initialised repository
    // changes nothing, and a block that opened with three lines of present-tense prose about a
    // working Linear tracker read as a success with a footnote. The verdict comes first now, and
    // the repair is a literal line to paste rather than a pointer at the schema doc.
    const repo = target();
    withOrigin(repo, "git@bitbucket.org:acme/acme-platform.git");
    capture(() => {
      initCommand(repo, { tracker: "jira" });
    });
    const before = read(repo, CONFIG_PATH);

    const printed = capture(() => {
      initCommand(repo, { tracker: "linear" });
    });

    expect(read(repo, CONFIG_PATH)).toBe(before);
    expect(adaptersOf(repo)).toMatchObject({ tracker: { host: "jira" } });
    expect(printed).toContain("--tracker linear was NOT written: a config was already there");
    // What the repository really does now, which is the fact the old wording buried: reviews use
    // the tracker on disk, not the one that was asked for.
    expect(printed).toContain("still configures mcp, host jira, which is what reviews will use");
    // In the shape of the file it goes into, so the repair is a copy and not a translation.
    expect(printed).toContain('"tracker": { "kind": "mcp", "host": "linear" }');
    // And the description of a working Linear tracker is gone, because there is not one.
    expect(printed).not.toContain("mcp, host linear, from --tracker");
  });

  test("says a refused tracker leaves ticket-fit ungraded, when the config configures none", () => {
    // The dangerous half of the same no-op, and it needs a different sentence: a config with no
    // tracker at all means the review grades against no acceptance criteria, which is worse than
    // it grading against the wrong ticket system.
    const repo = target();
    capture(() => {
      initCommand(repo);
    });

    const printed = capture(() => {
      initCommand(repo, { tracker: "jira" });
    });

    expect(configOf(repo).adapters).toBeUndefined();
    expect(printed).toContain("--tracker jira was NOT written: a config was already there");
    expect(printed).toContain("still configures no tracker at all, so every empo review");
    expect(printed).toContain("skips ticket-fit");
    expect(printed).toContain('"tracker": { "kind": "mcp", "host": "jira" }');
  });

  test("does not cry no-op when the config already says exactly what was asked for", () => {
    // The other half of the constraint: a warning that fires on every rerun of an unchanged
    // repository is one that gets learned and then ignored, which would cost the two cases above
    // the attention they need. Rerunning with the same flag is not a failed write.
    const repo = target();
    withOrigin(repo, "git@bitbucket.org:acme/acme-platform.git");
    capture(() => {
      initCommand(repo, { tracker: "jira" });
    });

    const printed = capture(() => {
      initCommand(repo, { tracker: "jira" });
    });

    expect(printed).not.toContain("NOT written");
    expect(printed).toContain("mcp, host bitbucket, acme/acme-platform, from the origin remote");
    expect(printed).toContain("mcp, host jira, from --tracker");
    // Stated rather than left out: a forge printed with no verdict beside it is the same
    // ambiguity in a quieter form.
    expect(printed).toContain("Already in the config, unchanged.");
  });

  test("tells a repository whose remote appeared after init what its config is missing", () => {
    // A real sequence: init in a fresh directory, push it somewhere, run init again. Detection now
    // has a forge and the config has none, and nothing else in empo would ever mention it.
    const repo = target();
    capture(() => {
      initCommand(repo);
    });
    withOrigin(repo, "https://github.com/acme/acme-platform.git");

    const printed = capture(() => {
      initCommand(repo);
    });

    expect(configOf(repo).adapters).toBeUndefined();
    expect(printed).toContain("NOT written: a config was already there");
    expect(printed).toContain("The origin remote says github, acme/acme-platform.");
    expect(printed).toContain("The config says no forge at all");
    expect(printed).toContain(
      '"forge": { "kind": "github", "repo": "acme-platform", "workspace": "acme" }',
    );
  });

  test("lets a config that names a forge stand when the checkout has no remote to confirm it", () => {
    // init reads git, it does not overrule a file. A clone with no origin (or a worktree of one)
    // must not read as though the configured forge had gone away.
    const repo = target();
    withOrigin(repo, "git@bitbucket.org:acme/acme-platform.git");
    capture(() => {
      initCommand(repo);
    });
    git(repo, ["remote", "remove", "origin"]);

    const printed = capture(() => {
      initCommand(repo);
    });

    expect(printed).toContain("none detected: this checkout has no origin remote");
    expect(printed).toContain("The config configures mcp, host bitbucket");
    expect(printed).toContain("that is what every command reads");
    // Not the local-diff sentence, which would be false here: a forge is configured.
    expect(printed).not.toContain("empo review works");
  });
});

describe("the map brief", () => {
  test("names the produced routes, the widest fan-in and the entrypoints", () => {
    const repo = target();

    const printed = capture(() => {
      initCommand(repo);
    });

    // A route is the strongest flow signal there is, so every one the API declares is printed with
    // the coordinate it was extracted at. The lines come from the file, never from this test.
    expect(section(printed, "produced symbols")).toEqual([
      `http-route GET orders/{order} ${ROUTES_FILE}:${lineOf(repo, ROUTES_FILE, PAGE_ROUTE_ANCHOR)}`,
      `http-route GET v1/orders/{order} ${ROUTES_FILE}:${lineOf(repo, ROUTES_FILE, SHOW_ROUTE_ANCHOR)}`,
      `http-route POST v1/checkout ${ROUTES_FILE}:${lineOf(repo, ROUTES_FILE, CHECKOUT_ROUTE_ANCHOR)}`,
      `http-route POST v1/orders ${ROUTES_FILE}:${lineOf(repo, ROUTES_FILE, ORDERS_ROUTE_ANCHOR)}`,
      // The one symbol here that is not a route, and the only one whose line is not the line it was
      // read from: an inertia-page comes from the file's path, so the whole file is the coordinate
      // and the anchor is line 1 (engine/extractor.ts). A route says where to look; this says what
      // to open.
      `inertia-page Orders/Show ${PAGE_FILE}:1`,
    ]);

    // Widest first, because the ordering is the whole answer: the node many journeys touch is the
    // one a spine is most likely to run through.
    const widest = section(printed, "widest blast radius");
    expect(widest[0]).toContain("Acme\\Models\\Order");
    expect(widest[0]).toContain("fan-in 6");
    expect(widest[0]).toContain("apps/api/app/Models/Order.php");
    expect(widest[1]).toContain("Acme\\Libraries\\Price\\PriceCalculator");
    expect(widest[1]).toContain("fan-in 3");
    expect(widest).toHaveLength(4);

    // Nothing in the graph references these four, so a journey starts at one of them. The test
    // files are not here because a test is not an entrypoint into the product.
    //
    // The route file is first and says why. Sorted by file it would come last of the four, and on a
    // repository with a directory of views it came 280th and never printed at all: the rows a pack
    // marks `arrivedBy: "user"` are ranked ahead of the rest so the cap can never hide the
    // strongest flow signal a repository has. The rest keep their file order behind it.
    //
    // The Inertia page is here because init writes no bridge, ever: a bridge cannot be detected, so
    // the graph this brief reads holds the page's produced symbol and no edge into it. The fixture's
    // own committed config does declare the bridge, and there the controller that renders the page
    // references it, which is the difference between the two graphs and not a defect in either.
    //
    // The fifth row is what per-export ids added. `apps/mobile/src/api/client.ts` exports three
    // functions and two of them are imported by the order screen; `fetchLoyaltyPoints` is imported
    // by nothing, so it is an entrypoint and the file it lives in is not. That row is spelled with
    // its export name for exactly that reason: printing the path would say the api client is
    // referenced by nothing, which the two rows of fan-in above it flatly contradict.
    expect(section(printed, "entrypoints").map((row) => row.split(" ")[0])).toEqual([
      ROUTES_FILE,
      "apps/api/app/Http/Controllers/AdminController.php",
      "apps/api/app/Providers/AppServiceProvider.php",
      "apps/mobile/src/api/client.ts#fetchLoyaltyPoints",
      PAGE_FILE,
    ]);
    expect(section(printed, "entrypoints")[0]).toBe(`${ROUTES_FILE} route-file arrived by user`);

    // This fixture holds no view, migration or seeder, so nothing was subtracted and the note that
    // would say so is absent. A note printed here would be a count of zero dressed as a finding.
    // Asserted against the note's real wording and its reason, not against a phrase that used to be
    // in it: an earlier revision checked for "not shown", which the note stopped saying, so the
    // assertion went on passing while guarding nothing. Scoped to the section for the same reason
    // the truncation case below is: the shipped map discipline this brief prints in full also says
    // "held back", of the cap, so the unscoped assertion caught that instead and failed.
    expect(section(printed, "entrypoints").some((row) => row.includes("held back"))).toBe(false);
    expect(printed).not.toContain(NOT_AN_ARRIVAL_REASON);
  });

  /**
   * The defect this section was built to fix, reproduced at the scale it was measured at.
   *
   * On one real Laravel repository the entrypoints section held 285 rows, 278 of them kinds the php
   * pack already marks framework-resolved, and the five route files sat at positions 280 to 284 and
   * never printed, under a heading that says a journey starts here. The fixture has no views or
   * migrations of its own, so this test writes enough of them into its copy to push the route file
   * past the cap of 12, which is what the old rule did on the repository the count came from.
   *
   * Every file written here is one the framework reaches by name and nobody arrives at, which is
   * the whole claim: a migration is run by a deploy and a view is rendered by a controller the user
   * already reached, so neither is a place a journey starts.
   */
  function repoWithFrameworkClutter(): string {
    const repo = target();

    for (let i = 0; i < 15; i += 1) {
      const view = join(repo, "apps/api/resources/views/orders", `panel-${i}.blade.php`);
      mkdirSync(dirname(view), { recursive: true });
      writeFileSync(view, `<div>panel ${i}</div>\n`);
    }

    const migration = join(repo, "apps/api/database/migrations/2024_01_01_create_orders.php");
    mkdirSync(dirname(migration), { recursive: true });
    writeFileSync(migration, "<?php\n\nreturn new class {};\n");

    // A second arrival, and a different kind from the route file, so the ranking is shown to be
    // about the mark and not about one hard-coded kind.
    const command = join(repo, "apps/api/app/Console/Commands/SyncOrders.php");
    mkdirSync(dirname(command), { recursive: true });
    writeFileSync(
      command,
      "<?php\n\nnamespace Acme\\Console\\Commands;\n\nclass SyncOrders\n{\n}\n",
    );

    return repo;
  }

  test("ranks the kinds a user arrives at first, where the old rule pushed them past the cap", () => {
    const repo = repoWithFrameworkClutter();

    const printed = capture(() => {
      initCommand(repo);
    });

    const rows = section(printed, "entrypoints");

    // First, and this is the defect itself: the route file is on the list at all. Sorted by file
    // it comes after every view, so under the old rule it sat 20th of 21 rows behind a cap of 12
    // and did not print, which is what happened at 280th of 285 on the repository this was
    // measured on.
    expect(rows.map((row) => row.split(" ")[0])).toContain(ROUTES_FILE);

    // Then the ranking: both arrivals lead, in file order behind the mark, each saying why it is
    // there, so no future directory of views can push one back off the end of the section.
    expect(rows[0]).toBe("apps/api/app/Console/Commands/SyncOrders.php command arrived by user");
    expect(rows[1]).toBe(`${ROUTES_FILE} route-file arrived by user`);

    // Nothing framework-resolved and unarrived survives, at any position.
    expect(rows.some((row) => row.includes("panel-"))).toBe(false);
    expect(rows.some((row) => row.includes("migrations/"))).toBe(false);

    // And nothing is dropped silently: the count, every kind that made it up, why, and the command
    // that lists them anyway. This is the rule `--orphans` already follows for the same subtraction.
    expect(printed).toContain("16 rows held back (view 15, migration 1).");
    // The reason names the arrival axis and not framework-resolution, because a route file is
    // framework-resolved and is printed two lines above: the shared property cannot be the reason
    // one row was held back and another was not.
    expect(printed).toContain(NOT_AN_ARRIVAL_REASON);
    expect(printed).toContain(`${LIST_FRAMEWORK_RESOLVED} lists them`);
  });

  /** A php repository holding only the files named, with a manifest so detection roots it. */
  function phpRepo(files: Record<string, string>): string {
    const repo = mkdtempSync(join(tmpdir(), "empo-init-php-"));
    temps.push(repo);
    temps.push(dirname(proposalPath(repo)));
    writeFileSync(join(repo, "composer.json"), '{"name":"acme/api"}\n');
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), body);
    }
    return repo;
  }

  test("says nothing about indexing when every candidate was held back", () => {
    // The section's empty sentence is "every node is referenced by another, which usually means the
    // entrypoints are not indexed". On a repository whose only zero-fan-in nodes are
    // framework-resolved kinds nobody arrives at, that sentence is false twice: nothing here is
    // referenced by anything, and the indexing is fine. Worse, it prescribes an action, and the
    // agent reading this brief has no other context with which to doubt it. So where a note exists
    // the note is the whole answer.
    const repo = phpRepo({
      "resources/views/orders/panel-1.blade.php": "<div>one</div>\n",
      "resources/views/orders/panel-2.blade.php": "<div>two</div>\n",
      "database/migrations/2024_01_01_create_orders.php": "<?php\n\nreturn new class {};\n",
    });

    const printed = capture(() => {
      initCommand(repo, { host: false });
    });

    expect(printed).not.toContain("the entrypoints are not indexed");
    expect(printed).toContain("3 rows held back (view 2, migration 1).");
    expect(printed).toContain(NOT_AN_ARRIVAL_REASON);
  });

  test("sets the note apart from the rows, which the section helper cannot see", () => {
    // The note is separated by a blank line and indented four rather than two, because at row
    // indent a sentence about the list reads as an entry in it, and this one names counts and a
    // command. Both properties are stated in `printSection`'s docstring and both were mutable with
    // the whole suite staying green, because `section()` stops at the first blank line and
    // collapses runs of whitespace: the two things this asserts are exactly the two it is blind to.
    // So this reads the raw lines. docs/14 calls printed text an interface.
    const repo = phpRepo({
      "routes/api.php": '<?php\n\nRoute::get("/orders", fn () => 1);\n',
      "resources/views/orders/panel-1.blade.php": "<div>one</div>\n",
    });

    const lines = capture(() => {
      initCommand(repo, { host: false });
    }).split("\n");

    const heading = lines.findIndex((line) => line.startsWith("entrypoints ("));
    expect(heading, "the brief printed no entrypoints section").toBeGreaterThan(-1);

    const noteAt = lines.findIndex((line) => line.includes("1 row held back (view 1)."));
    expect(noteAt).toBeGreaterThan(heading);
    // A blank line above it, so it cannot be read as the next row.
    expect(lines[noteAt - 1]).toBe("");
    // And a deeper indent than any row, so it is not read as one even at a glance.
    expect(lines[noteAt]).toMatch(/^ {4}\S/);
    expect(lines[heading + 1]).toMatch(/^ {2}\S/);
  });

  test("sends a truncated section to the command that can actually show the rest", () => {
    // The cap's line says "run empo query for the rest", and for every other section that is true.
    // Here it is not: arrivals are ranked first, arrivals are framework-resolved kinds, and
    // `empo query --orphans` drops exactly those, so the default line would send a reader to a
    // command that answers "none". Pinned against the whole string, because the defect is which
    // command is named and not that a line is printed.
    const routes: Record<string, string> = {};
    for (let i = 1; i <= 15; i += 1) {
      routes[`routes/r${String(i).padStart(2, "0")}.php`] =
        `<?php\n\nRoute::get("/r${i}", fn () => 1);\n`;
    }

    const repo = phpRepo(routes);
    const printed = capture(() => {
      initCommand(repo, { host: false });
    });

    // Scoped to this section, not to the whole brief: `produced symbols` truncates here too, and
    // its own "run empo query for the rest" is true, so a global assertion would catch that line
    // and say nothing about this defect.
    const rows = section(printed, "entrypoints");
    expect(rows.at(-1)).toBe(`... 3 more, run ${LIST_FRAMEWORK_RESOLVED} for the rest`);
    expect(rows.at(-1)).not.toBe("... 3 more, run empo query for the rest");
  });

  test("keeps a kind the pack makes no claim about, because unclaimed is not denied", () => {
    // The three-case rule, and this is the case a reuse of `--orphans`' filter would have got
    // wrong. A plain class carries neither mark, so the pack says nothing about whether a journey
    // starts there, and the brief prints it exactly as it did before either axis existed. Filtering
    // to marked kinds alone would have left this repository's brief with two rows and thrown away
    // the honest "nothing references this" the section has always been.
    const repo = repoWithFrameworkClutter();

    const printed = capture(() => {
      initCommand(repo);
    });

    const rows = section(printed, "entrypoints");

    expect(rows).toContain("apps/api/app/Http/Controllers/AdminController.php class");
    expect(rows.filter((row) => row.includes("arrived by user"))).toHaveLength(2);
  });

  test("names the path it wants the proposal written to, and both commands over it", () => {
    const repo = target();
    const wanted = proposalPath(repo);

    const printed = capture(() => {
      initCommand(repo);
    });

    // Scratch lives in the OS temp directory and never under `.empo/`, which holds only what a
    // human has approved. The directory exists by the time the agent is told to write into it.
    expect(wanted.startsWith(tmpdir())).toBe(true);
    expect(wanted.startsWith(repo)).toBe(false);
    expect(existsSync(dirname(wanted))).toBe(true);
    expect(printed).toContain(`empo init --proposal ${wanted}            the verdict`);
    expect(printed).toContain(`empo init --proposal ${wanted} --apply    write what survived`);
  });

  test("ends with the shipped map discipline, byte for byte", () => {
    // The discipline ships as data so a team can read it and diff it between versions. A copy
    // pasted into TypeScript would drift from the file the gate below is built around, so what the
    // brief prints is compared against the shipped file itself.
    const repo = target();

    const printed = capture(() => {
      initCommand(repo);
    });

    expect(printed.endsWith(mapWorkflow())).toBe(true);
    expect(printed).toContain("# Map discipline");
  });

  test("prints the bridge gap for a two-language repository and not for a one-language one", () => {
    // The one thing a generated config cannot contain and a monorepo needs most. Left unsaid, a
    // repository with real cross-language coupling reports zero reach, which is indistinguishable
    // from one that genuinely has none.
    const both = target();
    const bothPrinted = capture(() => {
      initCommand(both);
    });

    expect(configOf(both).bridges).toEqual([]);
    expect(bothPrinted).toContain("none, across 2 languages. A bridge cannot be detected");
    expect(bothPrinted).toContain("empo doctor prints the match rate");

    const one = target();
    const onePrinted = capture(() => {
      initCommand(one, { lang: "php" });
    });

    expect(onePrinted).not.toContain("none, across");
    expect(onePrinted).not.toContain("A bridge cannot be detected");
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 2: the gate over an agent's proposal
// ---------------------------------------------------------------------------------------------

/** A repository that has been through phase 1, which is what the gate needs: a config and a graph. */
function initialized(): string {
  const repo = target();
  capture(() => {
    initCommand(repo);
  });
  return repo;
}

/** Written where the brief said to write it: outside `.empo/`, which holds only approved work. */
function writeProposal(repo: string, document: unknown): string {
  const path = proposalPath(repo);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

interface Hop {
  n: number;
  title: string;
  file: string;
  line: number;
  anchor: string;
}

function hop(repo: string, n: number, title: string, file: string, anchor: string): Hop {
  return { n, title, file, line: lineOf(repo, file, anchor), anchor };
}

/**
 * A spine an agent could plausibly have proposed for this fixture: two real hops and one real trap,
 * every coordinate read out of the source. Overrides let one case at a time break one thing.
 */
function pricingSpine(repo: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    name: "pricing",
    principle: "Every hop copies the subtotal forward and nothing between them asserts the total.",
    hops: [
      hop(repo, 0, "request enters the api", ROUTES_FILE, ORDERS_ROUTE_ANCHOR),
      hop(repo, 1, "total resolution", CALCULATOR_FILE, TOTAL_ANCHOR),
    ],
    guarded: ["apps/api/app/Libraries/Price/**"],
    assertionTerms: ["assertSame("],
    traps: [
      {
        what: "the observer refreshes a cached summary on save, so a total written without a model event leaves a stale cache",
        file: OBSERVER_FILE,
        line: lineOf(repo, OBSERVER_FILE, CACHE_ANCHOR),
        anchor: CACHE_ANCHOR,
      },
    ],
    ...overrides,
  };
}

/** The flow half of a proposal that survives whole. */
function ordersFlow(): Record<string, unknown> {
  return { orders: { label: "Place an order", paths: [CONTROLLER_FILE] } };
}

describe("the proposal gate", () => {
  test("prints keep verdicts and, without --apply, writes nothing at all", () => {
    const repo = initialized();
    const path = writeProposal(repo, {
      version: 1,
      flows: ordersFlow(),
      spines: [pricingSpine(repo)],
    });
    const before = snapshot(repo);

    const printed = capture(() => {
      initCommand(repo, { proposal: path });
    });

    expect(printed).toContain(`proposal   ${path}`);
    expect(printed).toContain("keep  orders");
    expect(printed).toContain("keep  pricing");
    expect(printed).toContain("1 flow and 1 spine would be written. Nothing was touched.");
    expect(printed).toContain(`empo init --proposal ${path} --apply`);

    // Asserted against the bytes on disk and not against that sentence, because the sentence is
    // exactly what a command that had already written would still print.
    expect(snapshot(repo)).toEqual(before);
    expect(existsSync(join(repo, ".empo/spines/pricing.json"))).toBe(false);
  });

  test("--apply writes the survivors, and empo verify accepts the spine it wrote", () => {
    // The real proof that init produces artifacts the drift checker accepts, run through the
    // checker rather than asserted against its output format. A generator whose spine `empo verify`
    // rejects hands every new repository a failing gate on day one.
    const repo = initialized();
    const path = writeProposal(repo, {
      version: 1,
      flows: ordersFlow(),
      spines: [pricingSpine(repo)],
    });

    const printed = capture(() => {
      initCommand(repo, { proposal: path, apply: true });
    });

    expect(printed).toContain(`wrote ${FLOWS_PATH}`);
    expect(printed).toContain("wrote .empo/spines/pricing.json");
    expect(printed).toContain("These files are yours now.");

    const flows = JSON.parse(read(repo, FLOWS_PATH)) as {
      flows: Record<string, { label?: string; paths: string[] }>;
    };
    expect(flows.flows.orders).toEqual({ label: "Place an order", paths: [CONTROLLER_FILE] });

    const verified = capture(() => {
      verifyCommand(repo);
    });

    // Two hops and one trap, all three resolved against the source they were copied from.
    expect(verified).toContain("pricing  .empo/spines/pricing.json");
    expect(verified).toContain("OK  every anchor resolved (3 citations)");
  });

  test("corrects a hop whose line slipped, and the corrected line is what lands on disk", () => {
    const repo = initialized();
    const hops = [
      hop(repo, 0, "request enters the api", ROUTES_FILE, ORDERS_ROUTE_ANCHOR),
      { ...hop(repo, 1, "total resolution", CALCULATOR_FILE, TOTAL_ANCHOR), line: 2 },
    ];
    const path = writeProposal(repo, {
      version: 1,
      spines: [pricingSpine(repo, { hops })],
    });

    const printed = capture(() => {
      initCommand(repo, { proposal: path, apply: true });
    });

    expect(printed).toContain("keep  pricing                  2 hops, 1 corrected");

    const written = JSON.parse(read(repo, ".empo/spines/pricing.json")) as {
      hops: { line: number; anchor: string }[];
    };
    // A coordinate that is a few lines off is a stale number, not a fiction, so the skeleton lives
    // and points at the line the human will really open. The anchor itself is untouched.
    expect(written.hops[1]?.line).toBe(lineOf(repo, CALCULATOR_FILE, TOTAL_ANCHOR));
    expect(written.hops[1]?.anchor).toBe(TOTAL_ANCHOR);
  });

  test("drops a spine whole for one invented anchor, naming the coordinate that was invented", () => {
    // The severity is the point. A spine is a map somebody reads to locate themselves before
    // touching a chain where mistakes are expensive, and one invented coordinate turns every other
    // coordinate in the file into a question.
    const repo = initialized();
    const hops = [
      hop(repo, 0, "request enters the api", ROUTES_FILE, ORDERS_ROUTE_ANCHOR),
      {
        ...hop(repo, 1, "total resolution", CALCULATOR_FILE, TOTAL_ANCHOR),
        anchor: INVENTED_ANCHOR,
      },
    ];
    const path = writeProposal(repo, { version: 1, spines: [pricingSpine(repo, { hops })] });

    const printed = capture(() => {
      initCommand(repo, { proposal: path, apply: true });
    });

    expect(printed).toContain("DROP  pricing");
    expect(printed).toContain('invented: hop 1 "total resolution"');
    expect(printed).toContain(`anchor is nowhere in ${CALCULATOR_FILE}`);
    expect(printed).toContain("the whole skeleton is held back for a human to check");
    // Including the hop that was right: the spine is dropped, not the hop.
    expect(existsSync(join(repo, ".empo/spines/pricing.json"))).toBe(false);
  });

  test("keeps a flow's live paths and drops one whose paths are all dead", () => {
    const repo = initialized();
    const path = writeProposal(repo, {
      version: 1,
      flows: {
        orders: { paths: [CONTROLLER_FILE, "apps/api/app/Payments"] },
        ghost: { paths: ["apps/web"] },
      },
    });

    const printed = capture(() => {
      initCommand(repo, { proposal: path, apply: true });
    });

    expect(printed).toContain("keep  orders");
    expect(printed).toContain("dropped: apps/api/app/Payments (no file or directory of that name)");
    // The dead flow's whole block, contiguous, rather than three fragments that could each match a
    // line printed anywhere. `ghost` lost its one path, so a human reads the reason once, on the
    // `dropped:` line, and the note below it says only that the flow itself did not survive. The
    // note used to restate the path and the reason verbatim, one line under the line that had just
    // given them, which is one dropped path presented as two.
    expect(printed).toContain(
      "  DROP  ghost                    0 nodes\n" +
        "         dropped: apps/web (no file or directory of that name)\n" +
        "         no proposed path matches a node in the graph.\n",
    );

    const flows = JSON.parse(read(repo, FLOWS_PATH)) as {
      flows: Record<string, { paths: string[] }>;
    };
    // Writing a path the graph could not match would put the fiction the gate just caught into the
    // file the gate exists to protect.
    expect(Object.keys(flows.flows)).toEqual(["orders"]);
    expect(flows.flows.orders?.paths).toEqual([CONTROLLER_FILE]);
  });

  test("says why a kept flow's path was dropped, on the line for the kept flow", () => {
    // A kept flow prints no note, so this `dropped:` line is the only place a human is told what to
    // do about the path that fell out, and it used to say the path matched no node. False here: the
    // graph holds both of the fixture's api tests under this directory and engine/flows.ts assigns
    // neither, because a flow is the code of a journey rather than its tests. The reason travels
    // with every dropped path now, not only with a flow that lost all of them, which is exactly the
    // case that never printed one: this flow survives on its controller.
    const repo = initialized();
    const path = writeProposal(repo, {
      version: 1,
      flows: { payments: { paths: [CONTROLLER_FILE, TESTS_DIR] } },
    });

    const printed = capture(() => {
      initCommand(repo, { proposal: path });
    });

    expect(printed).toContain("keep  payments");
    expect(printed).toContain(`         ${CONTROLLER_FILE}`);
    expect(printed).toContain(
      `dropped: ${TESTS_DIR} (every node the graph holds under it is a test`,
    );
    // Naming the code the suite covers is the repair. Re-indexing is not, so the answer a stale
    // graph gets must not be the answer here.
    expect(printed).not.toContain(`dropped: ${TESTS_DIR} (exists on disk`);
  });

  test("counts what --apply would really write, not what merely survived", () => {
    // A flow the human already defines survives the gate and is still not written, because their
    // entry stands. Counting survivors would promise a change that never comes, and read as a bug
    // the first time somebody opened the file afterwards.
    const repo = initialized();
    writeFileSync(
      join(repo, FLOWS_PATH),
      `${JSON.stringify(
        { version: 1, flows: { orders: { label: "Place an order", paths: [CONTROLLER_FILE] } } },
        null,
        2,
      )}\n`,
    );
    const before = read(repo, FLOWS_PATH);
    const path = writeProposal(repo, {
      version: 1,
      flows: { orders: { label: "Orders, renamed by a machine", paths: [OBSERVER_FILE] } },
    });

    const printed = capture(() => {
      initCommand(repo, { proposal: path });
    });

    expect(printed).toContain("keep  orders");
    expect(printed).toContain("0 flows and 0 spines would be written. Nothing was touched.");
    expect(printed).toContain(`${FLOWS_PATH} already defines "orders"`);

    const applied = capture(() => {
      initCommand(repo, { proposal: path, apply: true });
    });

    expect(applied).toContain(`kept  ${FLOWS_PATH}`);
    expect(read(repo, FLOWS_PATH)).toBe(before);
  });

  test("exits 0 when it drops everything, because a proposal is a suggestion", () => {
    // Only the mechanical gates return 1 (docs/06-cli.md). What a dropped proposal costs is the
    // agent's next attempt, not somebody's commit, so capture rethrowing is the assertion here.
    const repo = initialized();
    const before = snapshot(repo);
    const path = writeProposal(repo, {
      version: 1,
      flows: { ghost: { paths: ["apps/web"] } },
      spines: [
        pricingSpine(repo, {
          hops: [
            {
              ...hop(repo, 0, "total resolution", CALCULATOR_FILE, TOTAL_ANCHOR),
              anchor: INVENTED_ANCHOR,
            },
          ],
        }),
      ],
    });

    const printed = capture(() => {
      initCommand(repo, { proposal: path, apply: true });
    });

    expect(printed).toContain("DROP  ghost");
    expect(printed).toContain("DROP  pricing");
    expect(printed).toContain("Nothing survived the gate, so nothing was written.");
    expect(snapshot(repo)).toEqual(before);
  });
});

describe("a proposal the gate cannot read", () => {
  test("exits 2 when the file is not there, naming the path it looked at", () => {
    const repo = initialized();
    const missing = join(dirname(proposalPath(repo)), "not-written-yet.json");

    const { error } = expectEmpoError(2, () => {
      initCommand(repo, { proposal: missing });
    });

    expect(error.message).toBe(`No proposal at ${missing}`);
    expect(error.details.join("\n")).toContain("have the agent write the file the brief names");
  });

  test("exits 2 when the file is not valid JSON, naming the file", () => {
    const repo = initialized();
    const path = proposalPath(repo);
    writeFileSync(path, '{ "version": 1, "flows": {\n');

    const { error } = expectEmpoError(2, () => {
      initCommand(repo, { proposal: path });
    });

    expect(error.message).toBe(`${path} is not valid JSON`);
  });

  test("exits 2 on an unrecognized key, naming the file and the key", () => {
    // Strict on purpose. A proposal is written by an agent and applied by a machine, so a misspelt
    // key that was silently dropped would become a spine with no guarded globs, and the human
    // approving the diff would have no way to see what went missing.
    const repo = initialized();
    const path = writeProposal(repo, { version: 1, flows: {}, spines: [], unguarded_flows: [] });

    const { error } = expectEmpoError(2, () => {
      initCommand(repo, { proposal: path });
    });

    expect(error.message).toBe(`${path} is not a valid EmPo proposal`);
    expect(error.details.join("\n")).toContain("unguarded_flows");
  });

  test("leaves the repository alone when the proposal cannot be read", () => {
    const repo = initialized();
    const before = snapshot(repo);
    const path = writeProposal(repo, { version: 1, flows: {}, spines: [], typo: true });

    expectEmpoError(2, () => {
      initCommand(repo, { proposal: path, apply: true });
    });

    expect(snapshot(repo)).toEqual(before);
  });
});
