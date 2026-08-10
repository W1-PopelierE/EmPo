import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { parseConfig } from "../../src/engine/config";
import type { DetectedForge } from "../../src/engine/detect";
import { run, type ShellResult } from "../../src/engine/git";
import { GRAPH_SCHEMA, installedPackVersion } from "../../src/engine/graph";
import {
  adapterHealth,
  checkConfig,
  flowHealth,
  type HealthProbes,
  healthReport,
  hookHealth,
  nameHealth,
  quietProbes,
  systemProbes,
} from "../../src/engine/health";
import { loadPack } from "../../src/engine/pack-loader";
import { configError, EmpoError } from "../../src/errors";
import type { WiredHook } from "../../src/host/claude";
import type { EmpoConfig } from "../../src/schema/config.schema";
import type { Graph } from "../../src/schema/types";

/**
 * The facts `empo doctor` reports, computed once so its two renderers cannot disagree. Everything
 * here is about the answer rather than the wording: the prose is pinned in
 * test/commands/doctor.test.ts and the staleness sentence in test/engine/graph.test.ts.
 *
 * The case this file exists for is the null one. A graph whose distance from HEAD git cannot answer
 * is not a stale graph and not a current one, and the SessionStart hook in docs/10-distribution.md
 * warns on `stale`. Collapsing the unknown into either answer gives a hook that either warns on
 * every session in a checkout git cannot read, or never warns at all, so `stale` is asserted false
 * on an unknown from three directions below.
 *
 * The fixture is read in place only where nothing is mutated. Every other case copies it, because a
 * fixture one test can dirty is a fixture that makes the next test lie. A copy is deliberately not
 * a git checkout, which is also the cheapest way to reach the unknown distance.
 */

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

const GRAPH_PATH = ".empo/generated/graph.json";
const GENERATED_DIR = ".empo/generated";
const SPINES_DIR = ".empo/spines";
const CONFIG_PATH = ".empo/config.json";
const EMPO_GITIGNORE = ".empo/.gitignore";

/** The two `.empo/.gitignore` bodies `empo init` writes, abbreviated to the line that decides. */
const IGNORES_GENERATED = "# machine-owned output\ngenerated/\n";
const IGNORES_NOTHING = "# committed deliberately\n";
const ROUTES_FILE = "apps/api/routes/api.php";
const CALCULATOR_FILE = "apps/api/app/Libraries/Price/PriceCalculator.php";

/** The whole fixture spine: 4 hops, 1 invariant that cites a test, 2 traps. */
const CITATION_COUNT = 7;

/** Hop 0's anchor, the one destroyed below to produce hard drift. */
const ROUTE_ANCHOR = "Route::post('/v1/orders'";

/**
 * The php pack as installed beside this test, read and never written down. The defect this whole
 * section covers is an answer that was true when someone typed it and false after the next pack
 * bump, so a literal version here would be that same defect one level up: green today, and green
 * tomorrow for the wrong reason.
 */
const PHP_INSTALLED = loadPack("php").version;

/** A version no pack will carry, asserted different from the installed one where it is used. */
const PHP_BEFORE = "0.0.1-before";

/** A lang with no pack on disk at all, used for the branch that skips one rather than reporting it. */
const ABSENT_LANG = "cobol";

/** The two halves of what a broken pack.json says, so the finding below is asserted in full. */
const PACK_ERROR = "src/packs/php/pack.json is not a valid pack";
const PACK_DETAIL = "node.id.strategy: Invalid enum value";

/**
 * A pack version reader that answers for every lang but php, and refuses for php the way `loadPack`
 * refuses a pack.json that is there and fails the schema.
 *
 * Substituted rather than staged on disk, and that is worth stating rather than reading as a shortcut.
 * Packs resolve out of the empo installation and never out of the repository under report
 * (src/engine/pack-loader.ts), so there is no repository a test can build that holds a broken pack,
 * and corrupting the real src/packs/php/pack.json would break every other spec in the suite at once.
 * The seam exists in src/engine/graph.ts for this one branch, and this one branch is the one that
 * used to answer "OK  config is valid" over a repository whose pack cannot be read at all.
 */
function packThatWillNotLoad(lang: string): string | null {
  if (lang !== "php") return installedPackVersion(lang);
  throw configError(PACK_ERROR, [PACK_DETAIL]);
}

/**
 * The two cases that build a real checkout spawn git several times over. The 5s default is a limit
 * on a machine that is doing nothing else, and neither of them gets slower because something is
 * wrong, so they state their own.
 */
const GIT_TIMEOUT = 30_000;

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the fixture, deliberately not a git repository: git can answer nothing about it. */
function copyFixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "empo-health-"));
  cpSync(fixture, repo, { recursive: true });
  temps.push(repo);
  return repo;
}

function git(repo: string, args: string[]): string {
  const result = run(repo, "git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** -c on the commit so this passes with no git identity and no signing key configured. */
function commit(repo: string, message: string): string {
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
    message,
  ]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/**
 * A fixture copy that really is a checkout, with the graph repointed at its first commit. The graph
 * on disk names a sha of *this* repository, which the throwaway knows nothing about, so leaving it
 * alone would only ever produce the unknown distance the other tests already cover.
 */
function gitFixture(): { repo: string; head: string } {
  const repo = copyFixture();
  git(repo, ["init", "-q", "-b", "main"]);
  const head = commit(repo, "the fixture");

  const graph = JSON.parse(readFileSync(join(repo, GRAPH_PATH), "utf8")) as Graph;
  graph.builtAgainst = head;
  writeFileSync(join(repo, GRAPH_PATH), `${JSON.stringify(graph, null, 2)}\n`);

  return { repo, head };
}

function linesOf(repo: string, path: string): string[] {
  return readFileSync(join(repo, path), "utf8").split("\n");
}

function writeLines(repo: string, path: string, lines: string[]): void {
  writeFileSync(join(repo, path), lines.join("\n"));
}

/** The graph as it sits on disk, so no node or edge count below is written by hand. */
function graphOnDisk(repo: string): Graph {
  return JSON.parse(readFileSync(join(repo, GRAPH_PATH), "utf8")) as Graph;
}

/** The graph on disk, edited in place. Every pack-drift case below is a change to its `packs` map. */
function rewriteGraph(repo: string, change: (graph: Graph) => void): void {
  const path = join(repo, GRAPH_PATH);
  const graph = JSON.parse(readFileSync(path, "utf8")) as Graph;
  change(graph);
  writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`);
}

function rewriteConfig(repo: string, change: (config: Record<string, unknown>) => void): void {
  const path = join(repo, CONFIG_PATH);
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  change(config);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

describe("healthReport graph state", () => {
  test("built: the state, the sha and the counts all come off the graph on disk", () => {
    const repo = copyFixture();
    const graph = graphOnDisk(repo);

    const health = healthReport(repo).graph;

    expect(health.state).toBe("built");
    expect(health.builtAgainst).toBe(graph.builtAgainst);
    expect(health.nodes).toBe(graph.stats.nodes);
    expect(health.edges).toBe(graph.stats.edges);
  });

  test("missing: no graph file at all, every number null and not stale", () => {
    const repo = copyFixture();
    rmSync(join(repo, ".empo/generated"), { recursive: true, force: true });

    expect(healthReport(repo).graph).toEqual({
      state: "missing",
      builtAgainst: null,
      commitsBehind: null,
      nodes: null,
      edges: null,
      stale: false,
      // A graph that does not exist was built by no pack, so there is nothing to have drifted. Empty
      // rather than absent, so the hook in docs/10-distribution.md can read the field unconditionally.
      packDrift: [],
      // And it declares no schema to disagree with, for the same reason. null is "the graph carries
      // the schema this binary writes", and a graph that is not there carries no claim to contradict.
      schemaDrift: null,
    });
  });

  test("unreadable: a graph file that is not JSON is one state, not a failed report", () => {
    const repo = copyFixture();
    writeFileSync(join(repo, GRAPH_PATH), "{ this is not a graph\n");

    expect(healthReport(repo).graph).toEqual({
      state: "unreadable",
      builtAgainst: null,
      commitsBehind: null,
      nodes: null,
      edges: null,
      stale: false,
      // No drift either: a graph nobody could read records no pack versions to compare against, and
      // reporting drift off one would be inventing the very versions that could not be read. The
      // schema is the same argument: nothing was read, so nothing declares one.
      packDrift: [],
      schemaDrift: null,
    });

    // Unreadable is a state and never an error: doctor is the command you run when something else
    // already went wrong, and it still has a config to report on.
    expect(healthReport(repo).ok).toBe(true);
  });

  test("unreadable: valid JSON that is not a graph is unreadable, not a stack trace", () => {
    // `readGraph` casts what it parsed without checking its shape, so this one parses and then
    // throws on the first field read off it. Both halves have to be inside the same guard.
    const repo = copyFixture();
    writeFileSync(join(repo, GRAPH_PATH), "[]\n");

    expect(healthReport(repo).graph).toEqual({
      state: "unreadable",
      builtAgainst: null,
      commitsBehind: null,
      nodes: null,
      edges: null,
      stale: false,
      // `[]` has no `packs` to read, and reading one off it is inside the same guard as every other
      // field. A drift check pulled out of that guard would turn this state back into a stack trace.
      packDrift: [],
      schemaDrift: null,
    });
  });

  test("an unknown distance is not staleness", () => {
    // The copy is not a checkout, so git cannot say how far HEAD has moved. A hook that read this
    // as stale would warn on every session in a repository it can learn nothing about.
    const repo = copyFixture();

    const health = healthReport(repo).graph;

    expect(health.state).toBe("built");
    expect(health.commitsBehind).toBeNull();
    // Pinned so a red on the line below names its own cause. `stale` now has two sources, and
    // without this the drift half failing would read as the unknown distance having become
    // staleness, which is the one thing this test exists to deny.
    expect(health.packDrift).toEqual([]);
    expect(health.stale).toBe(false);
  });

  test(
    "a graph built at HEAD is zero commits behind and not stale",
    () => {
      const { repo, head } = gitFixture();

      expect(healthReport(repo).graph).toMatchObject({
        state: "built",
        builtAgainst: head,
        commitsBehind: 0,
        // Both halves of `stale` are false here, and this is the fixture that says so: it records
        // the versions of the packs installed beside it. A red here is the fixture graph having
        // fallen behind a bumped pack, and regenerating it is the fix.
        packDrift: [],
        stale: false,
      });
    },
    GIT_TIMEOUT,
  );

  test(
    "a graph HEAD has moved past is stale, with the distance stated",
    () => {
      const { repo, head } = gitFixture();
      writeFileSync(join(repo, "README.md"), "a commit the graph knows nothing about\n");
      commit(repo, "move HEAD on");

      expect(healthReport(repo).graph).toMatchObject({
        state: "built",
        builtAgainst: head,
        commitsBehind: 1,
        stale: true,
      });
    },
    GIT_TIMEOUT,
  );
});

/**
 * A graph holding only what `flowHealth` reads, so each case below is the counting rule and nothing
 * around it. Node ids are the file paths, which is what the module-path strategy produces anyway.
 */
function graphOf(
  files: { file: string; isTest?: boolean }[],
  flows: Record<string, string[]>,
): Graph {
  const nodes = files.map((entry, index) => ({
    id: entry.file,
    file: entry.file,
    root: ".",
    lang: "typescript",
    kind: "module",
    name: `n${index}`,
    produces: [],
    consumes: [],
    isTest: entry.isTest === true,
    assertsValue: false,
  }));

  return {
    schema: GRAPH_SCHEMA,
    builtAgainst: "",
    builtAtCommitSubject: "",
    roots: [],
    packs: {},
    stats: { files: nodes.length, nodes: nodes.length, edges: 0, bridgedEdges: 0 },
    nodes,
    edges: [],
    flows,
    fanin: {},
    coverage: {},
    hazards: [],
    hazardsScanned: [],
    names: [],
  };
}

/**
 * The count that closes the drift nothing printed: a module joins the graph, no flow claims it, and
 * until this landed no command said so. Two of this repository's own engine
 * modules drifted out that way and sat outside every flow for weeks.
 *
 * The rule the cases below exist for is the one that decides whether the number can ever be zero.
 * engine/flows.ts assigns no test node to a flow, so a count over every node would report every test
 * file in the repository as unclaimed forever, and a number that cannot reach zero is one nobody
 * acts on. The second is the null: no graph is not "nothing is unclaimed".
 */
describe("healthReport unclaimed files", () => {
  test("a file no flow claims is counted, one a flow claims is not", () => {
    const graph = graphOf([{ file: "src/a.ts" }, { file: "src/b.ts" }, { file: "src/c.ts" }], {
      checkout: ["src/a.ts", "src/b.ts"],
    });

    expect(flowHealth(graph)).toEqual({ defined: 1, files: 3, unclaimed: 1 });
  });

  test("a test file is neither claimed nor unclaimed, because no flow can ever hold one", () => {
    // Both non-test files are claimed, so the honest answer is zero. Counting the two test files
    // would answer 2 here and 2 forever, whatever anybody did to flows.json.
    const graph = graphOf(
      [
        { file: "src/a.ts" },
        { file: "src/b.ts" },
        { file: "test/a.test.ts", isTest: true },
        { file: "test/b.test.ts", isTest: true },
      ],
      { checkout: ["src/a.ts", "src/b.ts"] },
    );

    expect(flowHealth(graph)).toEqual({ defined: 1, files: 2, unclaimed: 0 });
  });

  test("two nodes in one file are one file, claimed or not", () => {
    // A language that puts two classes in one file must not have it counted twice, in either column.
    const claimed = graphOf([{ file: "src/pair.php" }, { file: "src/pair.php" }], {
      checkout: ["src/pair.php"],
    });
    const unclaimed = graphOf([{ file: "src/pair.php" }, { file: "src/pair.php" }], {});

    expect(flowHealth(claimed)).toEqual({ defined: 1, files: 1, unclaimed: 0 });
    expect(flowHealth(unclaimed)).toEqual({ defined: 0, files: 1, unclaimed: 1 });
  });

  test("no flow at all: every file is unclaimed, which is the state every repository starts in", () => {
    const graph = graphOf([{ file: "src/a.ts" }, { file: "src/b.ts" }], {});

    expect(flowHealth(graph)).toEqual({ defined: 0, files: 2, unclaimed: 2 });
  });

  test("no graph: every count is null, because nothing was counted", () => {
    // The distinction the whole report is built on. Zero would read as "every file belongs to a
    // flow", which is the best possible answer, invented out of a graph nobody could read.
    expect(flowHealth(null)).toEqual({ defined: null, files: null, unclaimed: null });

    const repo = copyFixture();
    rmSync(join(repo, GENERATED_DIR), { recursive: true, force: true });
    expect(healthReport(repo).flows).toEqual({ defined: null, files: null, unclaimed: null });

    // An unreadable graph answers the same way, and for the same reason: nothing was counted.
    mkdirSync(join(repo, GENERATED_DIR), { recursive: true });
    writeFileSync(join(repo, GRAPH_PATH), "{ this is not a graph\n");
    expect(healthReport(repo).flows).toEqual({ defined: null, files: null, unclaimed: null });
  });

  test("the fixture's own count, read off its graph, and it raises no finding", () => {
    const repo = copyFixture();
    const graph = graphOnDisk(repo);
    const claimed = new Set(Object.values(graph.flows).flat());
    const files = new Set(graph.nodes.filter((node) => !node.isTest).map((node) => node.file));

    const health = healthReport(repo);

    expect(health.flows).toEqual({
      defined: Object.keys(graph.flows).length,
      files: files.size,
      unclaimed: [...files].filter(
        (file) =>
          !graph.nodes.some((node) => node.file === file && !node.isTest && claimed.has(node.id)),
      ).length,
    });
    // The fixture really does have unclaimed files, so the assertion below is about a repository in
    // the state that would raise the finding if there were one.
    expect(health.flows.unclaimed).toBeGreaterThan(0);
    // A fact and never a finding: commands/hook.ts prints every finding on every session, and the
    // files a repository leaves out of its flows are usually left out on purpose. A warning that
    // fires forever on a deliberate state is a warning somebody turns off.
    expect(health.findings).toEqual([]);
    expect(health.ok).toBe(true);
  });
});

/**
 * The name tally, and the one distinction it cannot afford to lose: absent and empty are different
 * claims. A graph written before schema 5 carries no `names` key at all, which is "nobody counted",
 * and `readGraph` casts what it parsed without checking a key, so the field is whatever the file
 * holds. The empty array is a real answer — "counted, and no name-resolving rule read a name" —
 * and handing it back for a graph nobody counted would recreate the exact silence this field exists
 * to end: a family that resolved nothing looking identical to a family with nothing to find.
 *
 * The last case is the other half, and it is the rule flowHealth's docblock states: an ambiguous
 * component name is the normal shape of a React tree, commands/hook.ts prints every finding on every
 * session, and a warning that fires forever on a deliberate state is a warning somebody turns off.
 * So the tally is a fact in doctor's block and never a HealthFinding.
 */
describe("healthReport name resolution", () => {
  test("a graph that counted hands the tally back verbatim", () => {
    const repo = copyFixture();
    const graph = graphOnDisk(repo);

    // The fixture really does resolve names, so the case below is about a graph with something to
    // report rather than one whose emptiness would pass either way.
    expect(graph.names.length).toBeGreaterThan(0);
    expect(nameHealth(graph)).toEqual(graph.names);
  });

  test("a graph with no names key at all is null, because nobody counted", () => {
    // Exactly the shape of every graph written before schema 5: the key is missing, not empty.
    // `readGraph` casts without checking it, so the absence survives the read and has to be answered
    // here. Defaulting it to the empty list would report "these packs resolve no names" about a run
    // that never looked.
    const repo = copyFixture();
    rewriteGraph(repo, (graph) => {
      delete (graph as Partial<Graph>).names;
    });

    expect(nameHealth(graphOnDisk(repo))).toBeNull();
    expect(healthReport(repo).names).toBeNull();
  });

  test("a names key that is not an array is null, because the file can hold anything", () => {
    // `readGraph` parses JSON and casts, so nothing between the disk and here checks this key. A
    // hand-edited or half-written graph reaches the report as whatever it says, and treating an
    // object as a tally would put a shape no renderer can read into doctor's --json.
    const repo = copyFixture();
    rewriteGraph(repo, (graph) => {
      (graph as unknown as Record<string, unknown>).names = { hook: 2 };
    });

    expect(nameHealth(graphOnDisk(repo))).toBeNull();
    expect(healthReport(repo).names).toBeNull();
  });

  test("an array of the wrong records is null, because the container was never the claim", () => {
    // The same argument one line up, carried one level down: an array checked only as an array puts
    // whatever it holds into `Health.names`, and `nameLines` adds four numbers off each record, so a
    // `null` entry is a TypeError out of `empo doctor` rather than the shrug the object above gets.
    for (const names of [
      [null],
      [{ family: "template" }],
      [{ family: "hook", resolved: 1, unknown: 0, ambiguous: 0, wrongKind: 0 }],
      [
        {
          family: "hook",
          resolved: "1",
          unknown: 0,
          ambiguous: 0,
          wrongKind: 0,
          ambiguousNames: [],
        },
      ],
    ]) {
      const repo = copyFixture();
      rewriteGraph(repo, (graph) => {
        (graph as unknown as Record<string, unknown>).names = names;
      });

      expect(nameHealth(graphOnDisk(repo))).toBeNull();
      expect(healthReport(repo).names).toBeNull();
    }
  });

  test("one malformed ambiguousNames entry refuses the whole tally", () => {
    // A partial tally read as a complete one is a denominator that is quietly wrong, which is the
    // failure this block exists to end rather than a milder version of it. So the record goes with
    // its names: `nodes` missing is a line that would print "undefined files".
    const repo = copyFixture();
    rewriteGraph(repo, (graph) => {
      (graph as unknown as Record<string, unknown>).names = [
        {
          family: "template",
          resolved: 1,
          unknown: 0,
          ambiguous: 1,
          wrongKind: 0,
          ambiguousNames: [{ name: "StatusPill", references: 2 }],
        },
      ];
    });

    expect(nameHealth(graphOnDisk(repo))).toBeNull();
    expect(healthReport(repo).names).toBeNull();
  });

  test("no graph: null, for the reason every other count is null", () => {
    // Missing or unreadable, both arrive here as null, and neither one counted anything.
    expect(nameHealth(null)).toBeNull();

    const repo = copyFixture();
    rmSync(join(repo, GENERATED_DIR), { recursive: true, force: true });
    expect(healthReport(repo).names).toBeNull();

    mkdirSync(join(repo, GENERATED_DIR), { recursive: true });
    writeFileSync(join(repo, GRAPH_PATH), "{ this is not a graph\n");
    expect(healthReport(repo).names).toBeNull();
  });

  test("an empty tally comes back empty and never as null", () => {
    // The case the whole null/empty split is for. A build whose packs declare no name-resolving rule
    // counted, and found nothing, and that is a statement a reader can act on: it is the answer
    // "these packs resolve no names", not "this graph is too old to say". Collapsing it into null
    // would throw away the only difference the field was added to carry.
    const empty = nameHealth(graphOf([{ file: "src/a.ts" }], {}));

    expect(empty).not.toBeNull();
    expect(empty).toEqual([]);
  });

  test("the fixture's own tally reaches Health, and it raises no finding", () => {
    const repo = copyFixture();
    const graph = graphOnDisk(repo);

    const health = healthReport(repo);

    expect(health.names).not.toBeNull();
    expect(health.names).toEqual(graph.names);
    // A fact in doctor's block and never a HealthFinding, the same call flowHealth's docblock makes:
    // commands/hook.ts prints every finding on every session, and unresolved and ambiguous names are
    // the normal steady state of a React tree or a Blade component library. Asserted as the whole
    // list rather than "no error", because a warning nobody can act on is the failure here.
    expect(health.findings).toEqual([]);
    expect(health.ok).toBe(true);
  });
});

/**
 * The staleness git cannot see. A pack is data, so changing a pack.json changes every answer derived
 * from it without moving one tracked file in the repository being indexed: widening the php
 * `assertionTerms` took one repository from 15 value-asserting test files to 393, and the graph
 * built before that kept serving 15 on the same commit with doctor calling it healthy. Nothing in
 * this file caught that, which is why the first case below asserts drift *at zero commits behind*:
 * the git line says "current with HEAD" and is right, and it is still the wrong answer.
 */
describe("healthReport pack drift", () => {
  test(
    "a pack that moved is staleness even when the graph is current with HEAD",
    () => {
      // The whole point of the section: the distance is 0 and honest, and the graph is stale anyway.
      const { repo } = gitFixture();
      rewriteGraph(repo, (graph) => {
        graph.packs.php = PHP_BEFORE;
      });

      const health = healthReport(repo).graph;

      // Read from the pack rather than compared against a literal, so this stays a real difference
      // after the next bump instead of quietly becoming a comparison of two equal strings.
      expect(PHP_BEFORE).not.toBe(PHP_INSTALLED);
      expect(health.commitsBehind).toBe(0);
      expect(health.packDrift).toEqual([{ lang: "php", built: PHP_BEFORE, loaded: PHP_INSTALLED }]);
      // A red here is the hook in docs/10-distribution.md going silent on a graph whose numbers a
      // rebuild would change, which is the failure the field was added for.
      expect(health.stale).toBe(true);
    },
    GIT_TIMEOUT,
  );

  test("a graph recording the installed versions has drifted nothing and is not stale for it", () => {
    // The other half, and the one that keeps the check from crying wolf: the fixture graph records
    // the packs installed beside it, so a red here is a pack bumped without regenerating the fixture
    // rather than a bug in the comparison.
    const repo = copyFixture();
    expect(graphOnDisk(repo).packs.php).toBe(PHP_INSTALLED);

    const health = healthReport(repo).graph;

    expect(health.packDrift).toEqual([]);
    expect(health.stale).toBe(false);
  });

  test("a graph that records no version for a lang says so rather than naming one", () => {
    // Graphs built before the versions were recorded. `built: null` is the honest answer and doctor
    // has a sentence for it; inventing a version it never wrote down would be the same lie quieter.
    // A null and not a deleted key: a lang the graph does not name at all is a lang it claims
    // nothing about, and there is no build to call drifted. What is reported is the lang the graph
    // does list without being able to say which version produced it.
    const repo = copyFixture();
    rewriteGraph(repo, (graph) => {
      graph.packs.php = null as unknown as string;
    });

    const health = healthReport(repo).graph;

    expect(health.packDrift).toEqual([{ lang: "php", built: null, loaded: PHP_INSTALLED }]);
    expect(health.stale).toBe(true);
  });

  test("a lang with no pack installed at all is skipped, not reported as drift", () => {
    // A pack that is not there is a broken installation, which the config checks name in their own
    // words. Answering "your pack moved" to a pack that is absent would send the reader to reindex
    // against nothing, and the version to reindex *to* does not exist to be printed.
    const repo = copyFixture();
    rewriteGraph(repo, (graph) => {
      graph.packs[ABSENT_LANG] = "1.0.0";
    });

    const health = healthReport(repo).graph;

    expect(health.packDrift).toEqual([]);
    expect(health.stale).toBe(false);
  });

  test("a pack that is installed and will not load is an error, and ok is false", () => {
    // The state the silent `continue` above used to swallow whole, and it is not the absent pack
    // beside it: something is installed under that name and nothing in the report could say what it
    // holds. `checkConfig` cannot see it either, because its only pack check is `packDir`, which
    // returns as soon as a pack.json exists without opening it. So doctor printed "OK  config is
    // valid" over a repository where no answer derived from php can be produced at all.
    const repo = copyFixture();

    const health = healthReport(repo, packThatWillNotLoad);

    expect(health.findings).toContainEqual({
      level: "error",
      message: `pack "php" is named by the graph and will not load: ${PACK_ERROR} ${PACK_DETAIL}`,
    });
    // An error, so doctor exits 2 rather than closing with the OK line.
    expect(health.ok).toBe(false);
    // And not drift: there is no installed version to name, so there is nothing to reindex *to*.
    // Reported as drift this would read "graph built with php pack 1.2.0, undefined is installed".
    expect(health.graph.packDrift).toEqual([]);
    // The rest of the report still stands. doctor is the command you run when something else already
    // went wrong, and a pack that will not load does not stop it reading the graph or the config.
    expect(health.graph.state).toBe("built");
  });

  test("a pack that loads is compared as usual when another pack in the same graph fails", () => {
    // The loop has to keep going past the failure. "php" sorts before "typescript", so a throw that
    // escaped rather than being collected would silently stop comparing every lang after it.
    const before = "0.0.1-before";
    const repo = copyFixture();
    rewriteGraph(repo, (graph) => {
      graph.packs.typescript = before;
    });

    const health = healthReport(repo, packThatWillNotLoad).graph;

    expect(health.packDrift).toEqual([
      { lang: "typescript", built: before, loaded: loadPack("typescript").version },
    ]);
    expect(health.stale).toBe(true);
  });
});

/**
 * The staleness that is neither git's nor a pack's: the graph's own schema.
 *
 * A schema bump records that a field the readers already knew kept its name and changed its meaning
 * (src/engine/graph.ts). Nothing else on disk can say so. `readGraph` casts the parsed JSON without
 * checking a key, and a TypeScript-only repository has no second pack whose version bump would give
 * the drift check something to notice, so a graph written by an older empo was served as current by
 * every command, indefinitely.
 */
describe("healthReport schema drift", () => {
  test("a graph written at an older schema is stale, and says which schema it was", () => {
    const repo = copyFixture();
    rewriteGraph(repo, (graph) => {
      graph.schema = 1;
    });

    const health = healthReport(repo).graph;

    // The state is still "built": the file parses and every field reads, which is exactly why
    // nothing else notices it. What it is not is current.
    expect(health.state).toBe("built");
    expect(health.schemaDrift).toEqual({ built: 1, writes: GRAPH_SCHEMA });
    expect(health.stale).toBe(true);
  });

  test("a graph carrying no schema at all is stale without being given a number", () => {
    // A hand-made or foreign graph.json. Coercing the absence to 0, or to 1, would be inventing the
    // one fact the field exists to record, so `built` stays null the way an unrecorded pack version
    // does, and the sentences built from it have to cope.
    const repo = copyFixture();
    rewriteGraph(repo, (graph) => {
      delete (graph as { schema?: number }).schema;
    });

    const health = healthReport(repo).graph;

    expect(health.schemaDrift).toEqual({ built: null, writes: GRAPH_SCHEMA });
    expect(health.stale).toBe(true);
  });

  test("the graph empo index just wrote declares the current schema and is not stale for it", () => {
    // The other half, and the one that keeps this from firing on every session: the suite indexes
    // the fixture with this binary, so a red here is the writer and the reader having parted.
    const repo = copyFixture();
    expect(graphOnDisk(repo).schema).toBe(GRAPH_SCHEMA);

    const health = healthReport(repo).graph;

    expect(health.schemaDrift).toBeNull();
    expect(health.stale).toBe(false);
  });
});

describe("healthReport spine state", () => {
  test("loaded: the clean fixture spine, every anchor resolving", () => {
    const repo = copyFixture();

    expect(healthReport(repo).spines).toEqual({
      dir: ".empo/spines",
      state: "loaded",
      count: 1,
      citations: CITATION_COUNT,
      soft: 0,
      hard: 0,
      drifted: [],
    });
  });

  test("none: no spines directory is the common case, not a finding", () => {
    const repo = copyFixture();
    rmSync(join(repo, SPINES_DIR), { recursive: true, force: true });

    const health = healthReport(repo);

    expect(health.spines).toEqual({
      dir: ".empo/spines",
      state: "none",
      count: 0,
      citations: 0,
      soft: 0,
      hard: 0,
      drifted: [],
    });
    expect(health.findings).toEqual([]);
    expect(health.ok).toBe(true);
  });

  test("unreadable: a spine file that will not parse is a config error", () => {
    const repo = copyFixture();
    writeFileSync(join(repo, SPINES_DIR, "pricing.json"), '{ "name": \n');

    const health = healthReport(repo);

    expect(health.spines).toMatchObject({ dir: ".empo/spines", state: "unreadable", count: 0 });
    expect(health.findings).toHaveLength(1);
    expect(health.findings[0]?.level).toBe("error");
    expect(health.findings[0]?.message).toContain(".empo/spines/pricing.json is not valid JSON");
    // A spine nobody can read is a config error like any other (docs/06-cli.md), so doctor exits 2.
    expect(health.ok).toBe(false);
  });

  test("unreadable: a spine whose name disagrees with its filename is reported, not thrown", () => {
    const repo = copyFixture();
    const spine = JSON.parse(readFileSync(join(repo, SPINES_DIR, "pricing.json"), "utf8"));
    spine.name = "totals";
    writeFileSync(join(repo, SPINES_DIR, "pricing.json"), `${JSON.stringify(spine, null, 2)}\n`);

    const health = healthReport(repo);

    expect(health.spines.state).toBe("unreadable");
    expect(health.findings[0]?.message).toContain('declares name "totals"');
    expect(health.ok).toBe(false);
  });

  test("drift is counted per level, listed per spine and warned about, never an error", () => {
    const repo = copyFixture();

    // Two hops live in PriceCalculator, so one inserted line above them moves both: soft drift, the
    // quoted source still there a line further down.
    const calculator = linesOf(repo, CALCULATOR_FILE);
    calculator.splice(1, 0, "// a line that pushes every anchor below it down by one");
    writeLines(repo, CALCULATOR_FILE, calculator);

    // Hop 0's anchor is destroyed rather than moved, which is hard drift: it now points at nothing.
    const routes = linesOf(repo, ROUTES_FILE);
    const index = routes.findIndex((line) => line.includes(ROUTE_ANCHOR));
    expect(index, `no line of ${ROUTES_FILE} contains "${ROUTE_ANCHOR}"`).toBeGreaterThanOrEqual(0);
    routes[index] = "// the route that was here is gone";
    writeLines(repo, ROUTES_FILE, routes);

    const health = healthReport(repo);

    expect(health.spines.state).toBe("loaded");
    expect(health.spines.soft).toBe(2);
    expect(health.spines.hard).toBe(1);
    expect(health.spines.drifted).toEqual([
      { name: "pricing", path: ".empo/spines/pricing.json", soft: 2, hard: 1 },
    ]);

    // Warned, never errored: `empo verify` is the command that exits 1 on drift, and a rotted spine
    // still answers, loudly and in one place.
    expect(health.findings).toEqual([
      {
        level: "warn",
        message: 'spine "pricing" has drifted: 2 soft, 1 hard. Run empo verify.',
      },
    ]);
    expect(health.ok).toBe(true);
  });

  test("dir echoes the configured path, so a reader is told where to look", () => {
    const repo = copyFixture();
    mkdirSync(join(repo, "tools/spines"), { recursive: true });
    cpSync(join(repo, SPINES_DIR), join(repo, "tools/spines"), { recursive: true });
    rmSync(join(repo, SPINES_DIR), { recursive: true, force: true });
    rewriteConfig(repo, (config) => {
      config.spines = "tools/spines";
    });

    const health = healthReport(repo);

    expect(health.spines.dir).toBe("tools/spines");
    expect(health.spines.state).toBe("loaded");
    expect(health.spines.count).toBe(1);
    // The path of the spine itself stays repo-relative to the file that was really opened.
    expect(health.spines.citations).toBe(CITATION_COUNT);
  });
});

describe("healthReport config facts", () => {
  test("the clean fixture is ok, read in place because nothing here writes", () => {
    const health = healthReport(fixture);

    expect(health.ok).toBe(true);
    expect(health.findings).toEqual([]);
    expect(health.configPath).toBe(join(fixture, CONFIG_PATH));
    expect(health.roots).toEqual([
      { path: "apps/api", lang: "php" },
      { path: "apps/mobile", lang: "typescript" },
      { path: "apps/portal", lang: "typescript" },
    ]);
  });

  test("a root that points nowhere is an error and ok is false", () => {
    const repo = copyFixture();
    rewriteConfig(repo, (config) => {
      (config.roots as { path: string; lang: string }[]).push({ path: "apps/web", lang: "php" });
    });

    const health = healthReport(repo);

    expect(health.ok).toBe(false);
    expect(health.findings).toContainEqual({
      level: "error",
      message: 'root "apps/web" points at a directory that does not exist',
    });
  });

  test("a warning alone leaves ok true, since doctor fails only on a config it cannot trust", () => {
    const repo = copyFixture();
    mkdirSync(join(repo, "tools/scripts"), { recursive: true });
    writeFileSync(join(repo, "tools/scripts/release.sh"), "#!/bin/sh\n");

    const health = healthReport(repo);

    expect(health.ok).toBe(true);
    expect(health.findings).toEqual([
      { level: "warn", message: 'directory "tools" is under no root, nothing in it is indexed' },
    ]);
  });

  test("config errors come before spine warnings, which is the order doctor prints", () => {
    const repo = copyFixture();
    mkdirSync(join(repo, "tools"), { recursive: true });
    writeFileSync(join(repo, "tools/release.sh"), "#!/bin/sh\n");
    rewriteConfig(repo, (config) => {
      (config.roots as { path: string; lang: string }[]).push({ path: "apps/web", lang: "php" });
    });
    const routes = linesOf(repo, ROUTES_FILE);
    const index = routes.findIndex((line) => line.includes(ROUTE_ANCHOR));
    routes[index] = "// the route that was here is gone";
    writeLines(repo, ROUTES_FILE, routes);

    const messages = healthReport(repo).findings.map((finding) => finding.message);

    expect(messages).toEqual([
      'root "apps/web" points at a directory that does not exist',
      'directory "tools" is under no root, nothing in it is indexed',
      'spine "pricing" has drifted: 0 soft, 1 hard. Run empo verify.',
    ]);
  });

  test("packs are sorted by code unit, whatever order config states them in", () => {
    const repo = mkdtempSync(join(tmpdir(), "empo-health-packs-"));
    temps.push(repo);
    mkdirSync(join(repo, ".empo"), { recursive: true });
    writeFileSync(
      join(repo, CONFIG_PATH),
      `${JSON.stringify(
        {
          version: 1,
          roots: [{ path: ".", lang: "php" }],
          packs: { typescript: { version: "^1" }, php: { version: "^1" } },
        },
        null,
        2,
      )}\n`,
    );

    expect(healthReport(repo).packs).toEqual(["php", "typescript"]);
  });

  test("bridges report a match rate against the graph, and bridgeCount survives without one", () => {
    const repo = copyFixture();

    const withGraph = healthReport(repo);
    expect(withGraph.bridgeCount).toBe(2);
    expect(withGraph.bridges).toHaveLength(2);
    expect(withGraph.bridges.map((bridge) => bridge.kind)).toEqual(["http-route", "inertia-page"]);
    expect(withGraph.bridges[0]?.matched).toBeGreaterThan(0);
    expect(withGraph.bridges[1]?.matched).toBeGreaterThan(0);

    rmSync(join(repo, ".empo/generated"), { recursive: true, force: true });

    // The distinction the two fields exist for: a reader must be able to tell "this repository
    // couples nothing" from "there was no graph to measure the coupling against".
    const without = healthReport(repo);
    expect(without.bridgeCount).toBe(2);
    expect(without.bridges).toEqual([]);
  });

  test("a missing config throws exit 2, exactly as loadConfig does", () => {
    const repo = mkdtempSync(join(tmpdir(), "empo-health-noconfig-"));
    temps.push(repo);

    let thrown: unknown;
    try {
      healthReport(repo);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EmpoError);
    expect((thrown as EmpoError).exitCode).toBe(2);
  });
});

/**
 * The adapters, which doctor read nothing about at all until this landed. Three symptoms were
 * reported from three directions and each was
 * invisible until somebody wanted a review: a config with no tracker grades ticket-fit never, a
 * forge that disagrees with the origin remote is nobody's finding, and a `github` forge on a machine
 * with no `gh` is discovered at the moment it is needed.
 *
 * Every case here goes through `adapterHealth` with substituted probes, and that is the only way
 * these answers can be asserted at all: `commandExists` and `detectForge` answer for the machine the
 * suite happens to be running on, so a spec that let them through would pin whether this developer
 * has `gh` installed and whether the temp directory has an origin remote.
 *
 * The split the section is really about is fact against finding. Every finding this module produces
 * is printed by the SessionStart hook on every session (src/commands/hook.ts), so a finding raised on
 * a steady state is a line a team reads once and then uninstalls the hook over. Only two states earn
 * one: a CLI config asks for that is not on PATH, and an origin on a different *kind* of host that
 * detection knows by name. Everything else is a fact, and the silences are asserted here one at a
 * time: no adapters at all, a slug that disagrees with origin, an origin on a host detection only
 * repeated back, and an origin git could not read.
 */
describe("healthReport adapters", () => {
  /**
   * A repoRoot that is deliberately not a directory. `adapterHealth` reads no file: the only place
   * this value goes is `probes.detectForge`, which is substituted in every case, so a real path here
   * would suggest something is read out of it. The cases below assert it arrives there unchanged.
   */
  const REPO = join(tmpdir(), "empo-adapters-no-such-repo");

  interface FakeProbes extends HealthProbes {
    /** One entry per commandExists call, so "asked once" is a length and not a guess. */
    commands: string[];
    /** One entry per detectForge call, holding the repoRoot it was handed. */
    detected: string[];
  }

  function probes(answers: { gh?: boolean; origin?: DetectedForge | null } = {}): FakeProbes {
    const commands: string[] = [];
    const detected: string[] = [];
    return {
      commands,
      detected,
      // Null, and this section never varies it: `adapterHealth` reads no hook, so a probe that
      // could run one here would be a way for a case in this file to spawn a subprocess by accident.
      runHook: null,
      commandExists: (command: string) => {
        commands.push(command);
        return answers.gh === true;
      },
      detectForge: (repoRoot: string) => {
        detected.push(repoRoot);
        return answers.origin ?? null;
      },
    };
  }

  /**
   * Config through the real schema and never built by hand. Zod strips a key the schema does not
   * declare (CLAUDE.md), so an object assembled here directly could pin a field that no load would
   * ever produce, and the assertion would pass over a config that reaches the engine empty.
   */
  function configWith(adapters?: Record<string, unknown>): EmpoConfig {
    const raw: Record<string, unknown> = {
      version: 1,
      roots: [{ path: ".", lang: "php" }],
      packs: { php: { version: "^1" } },
    };
    if (adapters !== undefined) raw.adapters = adapters;
    return parseConfig(raw, "the adapters test config");
  }

  test("no adapters section: every field null, no finding, and no probe is run at all", () => {
    const fake = probes({
      gh: true,
      origin: { kind: "github", workspace: "acme", repo: "platform" },
    });

    const { health, findings } = adapterHealth(configWith(), REPO, fake);

    expect(health).toEqual({
      forge: { kind: null, host: null, slug: null, cli: null, remote: null },
      tracker: { kind: null, host: null, project: null, cli: null },
    });
    // A repository with no forge and no tracker reviews the local diff and grades no ticket, which
    // is legitimate and common. Warning about it would fire on every session forever.
    expect(findings).toEqual([]);
    // And the point of the case: nothing spawns a subprocess where there is nothing to compare. The
    // probes above would both answer, so a red here is work being done on behalf of a config that
    // asked for none, on every doctor run and every session start.
    expect(fake.commands).toEqual([]);
    expect(fake.detected).toEqual([]);
  });

  test("a local forge is not a silence, and its origin is nobody's business", () => {
    // The probe would report a github origin, which against a `local` forge is exactly the kind
    // disagreement that warns two cases down. It must never be asked: "local" is a statement that
    // there is no host, not a guess about one, so there is nothing for origin to contradict.
    const fake = probes({ origin: { kind: "github", workspace: "acme", repo: "platform" } });

    const { health, findings } = adapterHealth(
      configWith({ forge: { kind: "local" } }),
      REPO,
      fake,
    );

    expect(health.forge).toEqual({
      kind: "local",
      host: null,
      slug: null,
      // Null rather than a satisfied requirement about a command nobody asked for: `local` reaches
      // no binary, and reporting `gh` present would say this machine is ready for a fetch that is
      // never going to happen.
      cli: null,
      remote: null,
    });
    expect(findings).toEqual([]);
    expect(fake.detected).toEqual([]);
    expect(fake.commands).toEqual([]);
  });

  test("a github forge names its slug the way the adapter joins it, and reports gh on PATH", () => {
    const config = configWith({ forge: { kind: "github", workspace: "acme", repo: "platform" } });

    const { health, findings } = adapterHealth(config, REPO, probes({ gh: true }));

    expect(health.forge).toEqual({
      kind: "github",
      // Null even though the kind names a host: config declared none, and `github` is its own answer.
      host: null,
      // The `forgeSlug` join, which is the only form a github tool accepts. Config keeps the two
      // fields apart because every Bitbucket call wants them apart, and doctor has to report the
      // joined form or it is describing something other than what the adapter will use.
      slug: "acme/platform",
      cli: { command: "gh", present: true },
      // The probe answered null: git could not say. See the "not a disagreement" case below.
      remote: null,
    });
    expect(findings).toEqual([]);
  });

  test("a github forge with no gh on PATH warns that the review reads the local diff", () => {
    const config = configWith({ forge: { kind: "github", workspace: "acme", repo: "platform" } });

    const { health, findings } = adapterHealth(config, REPO, probes({ gh: false }));

    expect(health.forge.cli).toEqual({ command: "gh", present: false });
    // The state that used to be discovered at the moment somebody wanted a review. The message has
    // to name the command to install and the consequence of not having it, because "gh is missing"
    // alone leaves the reader to guess whether the review still runs.
    expect(findings).toEqual([
      {
        level: "warn",
        message:
          'forge "github" needs the gh CLI, which is not on PATH, so empo review reads the local ' +
          "diff instead of the pull request",
      },
    ]);
  });

  test("a github-issues tracker with no gh on PATH warns that ticket-fit is not graded", () => {
    const config = configWith({ tracker: { kind: "github-issues", project: "acme/platform" } });
    const fake = probes({ gh: false });

    const { health, findings } = adapterHealth(config, REPO, fake);

    expect(health.tracker).toEqual({
      kind: "github-issues",
      host: null,
      project: "acme/platform",
      cli: { command: "gh", present: false },
    });
    expect(findings).toEqual([
      {
        level: "warn",
        message:
          'tracker "github-issues" needs the gh CLI, which is not on PATH, so empo review grades ' +
          "no ticket-fit",
      },
    ]);
    // No forge is configured, so there is no forge for a remote to disagree with and git is never
    // asked. A tracker alone must not drag a subprocess in behind it.
    expect(fake.detected).toEqual([]);
  });

  test("a github forge and a github-issues tracker warn once each, off one PATH lookup", () => {
    const config = configWith({
      forge: { kind: "github", workspace: "acme", repo: "platform" },
      tracker: { kind: "github-issues", project: "acme/platform" },
    });
    const fake = probes({ gh: false });

    const { findings } = adapterHealth(config, REPO, fake);

    // Two adapters, two consequences, two findings: a reader who installs gh for one of them has
    // fixed both, and a reader who reads only the forge line must still be told about ticket-fit.
    expect(findings.map((finding) => finding.message)).toEqual([
      'forge "github" needs the gh CLI, which is not on PATH, so empo review reads the local diff ' +
        "instead of the pull request",
      'tracker "github-issues" needs the gh CLI, which is not on PATH, so empo review grades no ' +
        "ticket-fit",
    ]);
    // One lookup for both. The answer cannot differ between two calls inside one report, and the
    // lookup is a PATH walk that every doctor run and every session start pays for.
    expect(fake.commands).toEqual(["gh"]);
  });

  test("an mcp tracker shells out to nothing, and carries its host and project", () => {
    const config = configWith({ tracker: { kind: "mcp", host: "jira", project: "ACME" } });
    const fake = probes({ gh: false });

    const { health, findings } = adapterHealth(config, REPO, fake);

    expect(health.tracker).toEqual({
      kind: "mcp",
      host: "jira",
      project: "ACME",
      // The agent fetches through its own connector and empo validates what comes back, so there is
      // no command for this machine to be missing and no requirement to report satisfied.
      cli: null,
    });
    expect(findings).toEqual([]);
    expect(fake.commands).toEqual([]);
  });

  test("tracker none and no tracker at all are two facts, and neither is a finding", () => {
    // The distinction the null exists for: one is somebody stating that this repository tracks no
    // tickets, the other is a silence, which is also what a misspelled section leaves behind. Both
    // grade no ticket-fit, and only one of them was chosen.
    const stated = adapterHealth(configWith({ tracker: { kind: "none" } }), REPO, probes());
    const silent = adapterHealth(configWith({ forge: { kind: "local" } }), REPO, probes());

    expect(stated.health.tracker).toEqual({ kind: "none", host: null, project: null, cli: null });
    expect(silent.health.tracker).toEqual({ kind: null, host: null, project: null, cli: null });
    expect(stated.findings).toEqual([]);
    expect(silent.findings).toEqual([]);
  });

  test("an origin that agrees is recorded as a fact and raises nothing", () => {
    const config = configWith({ forge: { kind: "github", workspace: "acme", repo: "platform" } });
    const fake = probes({
      gh: true,
      origin: { kind: "github", workspace: "acme", repo: "platform" },
    });

    const { health, findings } = adapterHealth(config, REPO, fake);

    expect(health.forge.remote).toEqual({
      kind: "github",
      // Absent on `github`, where the kind already names the host. Carried as null rather than the
      // string "github", so the renderer decides how to say it once.
      host: null,
      slug: "acme/platform",
      // github.com is a host detection knows by name, so a disagreement here would be believed. See
      // the unrecognized case below for the half where it may not be.
      recognized: true,
    });
    expect(findings).toEqual([]);
    // Asked about the repository under report, and not about the process's working directory.
    expect(fake.detected).toEqual([REPO]);
  });

  test("an origin on another kind of host is a warning naming both sides", () => {
    const config = configWith({ forge: { kind: "github", workspace: "acme", repo: "platform" } });
    const fake = probes({
      gh: true,
      origin: { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "platform" },
    });

    const { health, findings } = adapterHealth(config, REPO, fake);

    expect(health.forge.remote).toEqual({
      kind: "mcp",
      host: "bitbucket",
      slug: "acme/platform",
      recognized: true,
    });
    // Both sides named, because the repair depends on which one is wrong and only the human knows.
    // The remote is named by its host and never by its kind: "mcp" is EmPo's own word for a host it
    // cannot reach, and answering with it would tell somebody who asked what their git remote is.
    expect(findings).toEqual([
      {
        level: "warn",
        message:
          'forge is "github" but the origin remote is bitbucket acme/platform, so empo review ' +
          "would look for the pull request on the wrong host",
      },
    ]);
  });

  test("an origin on a host detection only repeated back is recorded and never warned about", () => {
    // The false-positive class, and the line was drawn by running the code rather than by reasoning
    // about it: doctor in a container whose origin is a local proxy raised this warning against a
    // perfectly good config, and a GitHub Enterprise checkout is indistinguishable from here.
    // `github.acme.com` is deliberately not `github.com` to detection (engine/detect.ts), so it
    // lands on kind `mcp` while `gh` with GH_HOST set is exactly the right adapter for it. A
    // detected kind is only ever an inference, and a warning may stand on the recognized half of it.
    const config = configWith({ forge: { kind: "github", workspace: "acme", repo: "platform" } });
    const fake = probes({
      gh: true,
      origin: { kind: "mcp", host: "github.acme.com", workspace: "acme", repo: "platform" },
    });

    const { health, findings } = adapterHealth(config, REPO, fake);

    // Still a fact, and still printed: the reader gets both sides and decides, which is the same
    // treatment the fork workflow below gets for the same reason.
    expect(health.forge.remote).toEqual({
      kind: "mcp",
      host: "github.acme.com",
      slug: "acme/platform",
      recognized: false,
    });
    expect(findings).toEqual([]);
  });

  test("an origin git could not read is not a disagreement", () => {
    // Not a checkout, no origin, or an origin naming no host. Every one of them is "nobody looked",
    // and a finding built on a remote nothing read would be inventing the disagreement it reports.
    // The silence is asserted with the config that would warn loudest if the null were coerced to
    // anything: a github forge, which any concrete answer other than github contradicts.
    const config = configWith({ forge: { kind: "github", workspace: "acme", repo: "platform" } });

    const { health, findings } = adapterHealth(config, REPO, probes({ gh: true, origin: null }));

    expect(health.forge.remote).toBeNull();
    expect(findings).toEqual([]);
  });

  test("the disagreement is symmetric: an mcp config against a github origin warns too", () => {
    const config = configWith({
      forge: { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "platform" },
    });
    const fake = probes({ origin: { kind: "github", workspace: "acme", repo: "platform" } });

    const { findings } = adapterHealth(config, REPO, fake);

    expect(findings).toEqual([
      {
        level: "warn",
        message:
          'forge is "mcp" (bitbucket) but the origin remote is github acme/platform, so empo ' +
          "review would look for the pull request on the wrong host",
      },
    ]);
    // An mcp forge reaches no binary of its own, so nothing was asked about PATH either.
    expect(fake.commands).toEqual([]);
  });

  test("a fork workflow, origin and config on different slugs of the same kind, is never a finding", () => {
    // The judgement rather than the rule. Origin points at the fork and config names the upstream,
    // which is how a great many people work, and a warning here would nag every session forever with
    // nothing to repair. Both slugs are reported and the human decides.
    const config = configWith({ forge: { kind: "github", workspace: "acme", repo: "platform" } });
    const fake = probes({
      gh: true,
      origin: { kind: "github", workspace: "me", repo: "platform" },
    });

    const { health, findings } = adapterHealth(config, REPO, fake);

    expect(health.forge.slug).toBe("acme/platform");
    expect(health.forge.remote?.slug).toBe("me/platform");
    expect(findings).toEqual([]);
  });

  test("host is free text, so two spellings of one host are not a disagreement", () => {
    // `adapters.*.host` is free text and the engine may not branch on it (docs/03-config-schema.md),
    // and a warning is a branch. "Bitbucket Cloud" against a detected "bitbucket" is a config that
    // works perfectly, and comparing the two strings would report it broken.
    const config = configWith({
      forge: { kind: "mcp", host: "Bitbucket Cloud", workspace: "acme", repo: "platform" },
    });
    const fake = probes({
      origin: { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "platform" },
    });

    const { health, findings } = adapterHealth(config, REPO, fake);

    expect(health.forge.host).toBe("Bitbucket Cloud");
    expect(health.forge.remote?.host).toBe("bitbucket");
    expect(findings).toEqual([]);
  });

  test("healthReport carries the block and its findings, and no adapter finding fails the report", () => {
    const repo = copyFixture();
    rewriteConfig(repo, (config) => {
      config.adapters = {
        forge: { kind: "github", workspace: "acme", repo: "platform" },
        tracker: { kind: "github-issues", project: "acme/platform" },
      };
    });

    const health = healthReport(repo, installedPackVersion, probes({ gh: false }));

    expect(health.adapters.forge).toMatchObject({ kind: "github", slug: "acme/platform" });
    expect(health.adapters.tracker).toMatchObject({ kind: "github-issues" });
    // The findings reach the report's own list, which is what doctor prints and what the SessionStart
    // hook reads. A block computed and then dropped on the floor would pass every case above.
    expect(health.findings.map((finding) => finding.level)).toEqual(["warn", "warn"]);
    expect(health.findings.every((finding) => finding.message.includes("gh CLI"))).toBe(true);
    // Never an error: a missing CLI is a machine that cannot fetch, not a config nobody can trust,
    // so doctor still closes with the OK line and exits 0.
    expect(health.ok).toBe(true);
  });
});

/**
 * The `commit` list against what git really does with `.empo/generated`. The two are written as a
 * pair by one `empo init` run and nothing has ever compared them since, so a team could edit either
 * half and be told nothing (docs/02-on-disk-layout.md, docs/03-config-schema.md).
 *
 * Every case here is about when to stay quiet, and that is deliberate. Any finding at all makes the
 * SessionStart hook speak (src/commands/hook.ts), so a check that fires on a repository which is not
 * actually drifted is a check that opens every session with a false alarm, and the header of
 * engine/health.ts is explicit that such a warning is uninstalled within a day. Three states look
 * like drift and are not: no `.empo/.gitignore` to compare against, no `generated/` on disk for a
 * directory rule to match, and no git to ask.
 */
describe("healthReport commit record", () => {
  /**
   * A fixture copy that really is a checkout and respects its own ignore rules: `git init` with no
   * `add` at all, because the `commit(repo)` helper above force-adds with `-f` and a force-added
   * path is one git reports as not ignored however the rules read. Nothing here needs a commit;
   * `check-ignore` answers off the rules and the index, and both exist from `init`.
   */
  function ignoringRepo(rules: string): string {
    const repo = copyFixture();
    writeFileSync(join(repo, EMPO_GITIGNORE), rules);
    git(repo, ["init", "-q", "-b", "main"]);
    // The rules written above are the only ones this scenario may obey. `check-ignore` also reads
    // the machine's global excludes file, and a EmPo developer plausibly ignores `.empo/generated/`
    // there, which is exactly what this repository's own .gitignore does: that flips git's answer
    // and fails the two directions below in opposite ways, on a machine where nothing is wrong.
    // So the throwaway checkout takes the vote away from the home directory rather than inheriting
    // it. An ignore file and not a config setting, because a rule in the repository outranks
    // core.excludesFile however that config was set, and config levels do outrank each other. The
    // fixture still decides: a .gitignore file outranks info/exclude whichever directory it sits
    // in, so `.empo/.gitignore` above wins where it carries a rule and this line answers where it
    // does not. Writing the file also discards whatever an init template left in it.
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(join(repo, ".git", "info", "exclude"), "!.empo/generated/\n");
    return repo;
  }

  function commitFindings(repo: string): string[] {
    return healthReport(repo)
      .findings.filter((finding) => finding.message.includes("commit"))
      .map((finding) => finding.message);
  }

  test(
    "warns when the record says generated is committed and git ignores it anyway",
    () => {
      const repo = ignoringRepo(IGNORES_GENERATED);
      rewriteConfig(repo, (config) => {
        config.commit = ["generated"];
      });

      const health = healthReport(repo);

      expect(health.findings).toContainEqual({
        level: "warn",
        message:
          'config commit records "generated" as committed but git ignores .empo/generated. ' +
          "Edit .empo/.gitignore or the commit list so the two agree.",
      });
      // A record that disagrees with git is worth saying and never worth failing on: every answer
      // EmPo gives is still correct, which is the same reason spine drift is a warning above.
      expect(health.ok).toBe(true);
    },
    GIT_TIMEOUT,
  );

  test(
    "warns when git does not ignore generated and the record says nothing is committed",
    () => {
      const repo = ignoringRepo(IGNORES_NOTHING);

      const health = healthReport(repo);

      expect(health.findings).toContainEqual({
        level: "warn",
        message:
          "git does not ignore .empo/generated but config commit records nothing as committed. " +
          "Edit .empo/.gitignore or the commit list so the two agree.",
      });
      expect(health.ok).toBe(true);
    },
    GIT_TIMEOUT,
  );

  test(
    "says nothing when the two halves agree, in either direction",
    () => {
      const ignored = ignoringRepo(IGNORES_GENERATED);
      expect(commitFindings(ignored)).toEqual([]);

      const committed = ignoringRepo(IGNORES_NOTHING);
      rewriteConfig(committed, (config) => {
        config.commit = ["generated"];
      });

      expect(commitFindings(committed)).toEqual([]);
    },
    GIT_TIMEOUT,
  );

  test(
    "says nothing when generated is not on disk, which no directory rule can match",
    () => {
      // The false alarm this guards. `generated/` is a directory rule, and git answers "not
      // ignored" for a path that is not there, so a repository that has simply never run
      // `empo index` would be reported as drifted on the strength of a rule that is doing exactly
      // what it was written to do.
      const repo = ignoringRepo(IGNORES_GENERATED);
      rmSync(join(repo, GENERATED_DIR), { recursive: true, force: true });

      expect(commitFindings(repo)).toEqual([]);
    },
    GIT_TIMEOUT,
  );

  test(
    "says nothing without a .empo/.gitignore, the half of the record init writes",
    () => {
      // EmPo compares two files it wrote as a pair. A repository that keeps its ignore rules
      // somewhere else has not drifted from anything EmPo knows about, and guessing otherwise is
      // how a check earns its way out of a config.
      const repo = copyFixture();
      git(repo, ["init", "-q", "-b", "main"]);

      expect(commitFindings(repo)).toEqual([]);
    },
    GIT_TIMEOUT,
  );

  test("says nothing outside a git checkout, where nothing is ignored or committed", () => {
    const repo = copyFixture();
    writeFileSync(join(repo, EMPO_GITIGNORE), IGNORES_NOTHING);

    expect(commitFindings(repo)).toEqual([]);
  });

  test(
    "answers off the repository under report and not off the machine running the test",
    () => {
      // The pin for the insulation in ignoringRepo. Every case above used to be decided by
      // whichever excludes file the developer keeps at home, so the two directions failed in
      // opposite ways on a machine that ignores `.empo/generated/` globally, and this repository's
      // own .gitignore holds exactly that rule. GIT_CONFIG_GLOBAL is how a test states a global
      // config it does not own; it replaces that config wholesale, so it is set around this one
      // call and restored, and nothing here needs an identity or a remote.
      const repo = ignoringRepo(IGNORES_NOTHING);
      const home = mkdtempSync(join(tmpdir(), "empo-health-home-"));
      temps.push(home);
      writeFileSync(join(home, "ignore"), "generated/\n**/.empo/generated/\n");
      writeFileSync(join(home, "gitconfig"), `[core]\n\texcludesFile = ${join(home, "ignore")}\n`);

      const previous = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
      try {
        expect(commitFindings(repo)).toEqual([
          "git does not ignore .empo/generated but config commit records nothing as committed. " +
            "Edit .empo/.gitignore or the commit list so the two agree.",
        ]);
      } finally {
        if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previous;
      }
    },
    GIT_TIMEOUT,
  );
});

/**
 * An alias that points nowhere costs edges and nothing else: `empo index` builds, every import
 * written through it resolves to no node, and the file it named comes out at the fan-in of its
 * relative importers alone. Silence is the whole failure, so the report says it out loud.
 */
describe("checkConfig on a root's aliases", () => {
  function configWithAliases(aliases: Record<string, string[]>): EmpoConfig {
    return parseConfig(
      {
        version: 1,
        roots: [{ path: "apps/api", lang: "php", aliases }],
        packs: { php: { version: "^1" } },
      },
      "the alias test config",
    );
  }

  test("a target whose directory is missing is a warning naming the pattern and the path", () => {
    const repo = copyFixture();

    const findings = checkConfig(configWithAliases({ "@/*": ["apps/api/nowhere/*"] }), repo);

    expect(findings).toContainEqual({
      level: "warn",
      message:
        'root "apps/api" aliases "@/*" to "apps/api/nowhere/*", and "apps/api/nowhere" ' +
        "does not exist, so every import written through it resolves to nothing",
    });
  });

  test("a target that resolves through the pack's extensions is not reported", () => {
    // The half a stricter check gets wrong. An alias target names a module, not a file:
    // "apps/api/app/Order" is resolved by trying the pack's extensions, so existsSync on the target
    // itself is false for a target that works perfectly. Only the literal directory is checked, and
    // this test is what stops somebody tightening that into a finding on every working config.
    const repo = copyFixture();
    const findings = checkConfig(configWithAliases({ "@/*": ["apps/api/app/*"] }), repo);

    expect(findings.filter((finding) => finding.message.includes("aliases"))).toEqual([]);
  });

  test("a root that declares no aliases is silent", () => {
    const repo = copyFixture();
    const findings = checkConfig(
      parseConfig(
        {
          version: 1,
          roots: [{ path: "apps/api", lang: "php" }],
          packs: { php: { version: "^1" } },
        },
        "the alias test config",
      ),
      repo,
    );

    expect(findings.filter((finding) => finding.message.includes("aliases"))).toEqual([]);
  });
});

/**
 * The hooks, executed. A hook fails open by design (src/commands/hook.ts), so a hook whose command
 * cannot be found is indistinguishable from a repository where every gate passed: the host runs it,
 * the shell says "command not found", the exit is 127 and the session is silent exactly as a clean
 * run is. Doctor had no hook line at all and its only executable probe was `commandExists("gh")`,
 * so nothing anywhere checked that the wired command runs.
 *
 * Every case below substitutes `runHook`, for the reason the adapters section substitutes its two:
 * a real run answers for the machine the suite happens to be on, and a spec that let it through
 * would pin whether this developer has `empo` on PATH. The one case that does not substitute it
 * asserts the probe itself, with a command that cannot depend on any of that.
 *
 * The distinction the whole section is about is which failure, not that there was one. A command
 * that is missing, a command that ran and broke, and a command the host killed are three different
 * repairs, and "the hook is broken" sends every one of them to the wrong place.
 */
describe("hookHealth", () => {
  /** What the recorder keeps per call, which is everything the probe is handed. */
  interface HookCall {
    repoRoot: string;
    command: string;
    timeout: number | null;
  }

  /** The command shape `isEmpoHook` recognizes, which is the only kind this reads back. */
  const SESSION = `empo hook session-start --repo "\${CLAUDE_PROJECT_DIR}"`;
  const EDIT = `empo hook pre-edit --repo "\${CLAUDE_PROJECT_DIR}"`;

  /**
   * A fixture copy with these entries in `.claude/settings.json`, one group per entry so the group
   * order and the file order are the same thing. Written as JSON rather than through
   * `mergeSettings`, because what is under test is what `wiredHooks` reads back off a real file,
   * and a hand-written file is also what a repository whose hooks broke actually holds.
   */
  function repoWithHooks(entries: WiredHook[]): string {
    const repo = copyFixture();
    const hooks: Record<string, unknown[]> = {};

    for (const entry of entries) {
      const command: Record<string, unknown> = { type: "command", command: entry.command };
      if (entry.timeout !== null) command.timeout = entry.timeout;
      const group: Record<string, unknown> = { hooks: [command] };
      if (entry.matcher !== null) group.matcher = entry.matcher;
      const groups = hooks[entry.event] ?? [];
      groups.push(group);
      hooks[entry.event] = groups;
    }

    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude/settings.json"), JSON.stringify({ hooks }, null, 2));
    return repo;
  }

  function wired(event: string, command: string, timeout: number | null = null): WiredHook {
    return { event, matcher: null, command, timeout };
  }

  /** A finished run at one exit code, with the two streams no case here reads. */
  function exited(exitCode: number | null): ShellResult {
    return { ok: exitCode === 0, exitCode, stdout: "", stderr: "", timedOut: false };
  }

  /** What `runShell` returns for a run the timeout killed: no exit code, and the flag. */
  const KILLED: ShellResult = {
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: true,
  };

  /**
   * Probes that record every hook run and answer them in wiring order. The other two members are
   * stubbed rather than inherited from `systemProbes`, so no case in this section can reach the
   * machine for an answer about `gh` or about origin.
   */
  function runProbes(answers: ShellResult[]): { probes: HealthProbes; calls: HookCall[] } {
    const calls: HookCall[] = [];
    return {
      calls,
      probes: {
        commandExists: () => false,
        detectForge: () => null,
        runHook: (repoRoot, hook) => {
          calls.push({ repoRoot, command: hook.command, timeout: hook.timeout });
          return answers[calls.length - 1] ?? exited(0);
        },
      },
    };
  }

  test("no hook wired is a fact and never a finding, and nothing is run", () => {
    // A Codex-only repository wires none of these, and so does one where `empo init` never ran.
    // Both are choices rather than faults, and a finding here would fire on them forever.
    const { probes, calls } = runProbes([]);

    const { health, findings } = hookHealth(copyFixture(), probes);

    expect(health).toEqual({ state: "none", hooks: [] });
    expect(findings).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("runHook null lists the hooks and says outright that none of them was run", () => {
    const repo = repoWithHooks([wired("SessionStart", SESSION), wired("PreToolUse", EDIT, 5)]);

    const { health, findings } = hookHealth(repo, quietProbes);

    // The state no reader may mistake for a verified one. "ok" on an entry nobody executed would
    // claim the command resolves and exits clean, which is the exact claim this block exists to
    // stop anybody from assuming, so the entries carry "unprobed" and not merely the block.
    expect(health).toEqual({
      state: "unprobed",
      hooks: [
        {
          event: "SessionStart",
          matcher: null,
          command: SESSION,
          state: "unprobed",
          exitCode: null,
        },
        { event: "PreToolUse", matcher: null, command: EDIT, state: "unprobed", exitCode: null },
      ],
    });
    // Nothing was proven, so nothing is claimed. An unexecuted hook is not a broken one.
    expect(findings).toEqual([]);
  });

  test("every hook exits 0: probed, every entry ok, and the report says nothing", () => {
    const repo = repoWithHooks([wired("SessionStart", SESSION), wired("PreToolUse", EDIT, 5)]);
    const { probes } = runProbes([exited(0), exited(0)]);

    const { health, findings } = hookHealth(repo, probes);

    expect(health.state).toBe("probed");
    expect(health.hooks.map((hook) => hook.state)).toEqual(["ok", "ok"]);
    expect(health.hooks.map((hook) => hook.exitCode)).toEqual([0, 0]);
    expect(findings).toEqual([]);
  });

  test("127 is the command not being found, and the finding says the hook enforces nothing", () => {
    // The case the section exists for. Under `shell: true` a missing command is not a spawn
    // failure: the shell starts, prints "command not found" and exits 127, which the host reads as
    // "nothing to say" exactly as it reads a clean run.
    const repo = repoWithHooks([wired("PreToolUse", EDIT)]);
    const { probes } = runProbes([exited(127)]);

    const { health, findings } = hookHealth(repo, probes);

    expect(health.hooks[0]?.state).toBe("not-found");
    expect(health.hooks[0]?.exitCode).toBe(127);
    expect(findings).toHaveLength(1);
    // The level, pinned explicitly, because the level is exactly what regressed: an error here made
    // every CI run and every stripped-PATH run exit 2 over a hook no session was ever going to fire.
    expect(findings[0]?.level).toBe("warn");
    expect(findings[0]?.message).toContain("hook PreToolUse");
    expect(findings[0]?.message).toContain("could not be found");
    expect(findings[0]?.message).toContain("fails open");
  });

  test("any other non-zero is a run that failed, and the finding names the exit code", () => {
    const repo = repoWithHooks([wired("SessionStart", SESSION)]);
    const { probes } = runProbes([exited(1)]);

    const { health, findings } = hookHealth(repo, probes);

    expect(health.hooks[0]?.state).toBe("failed");
    expect(health.hooks[0]?.exitCode).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("warn");
    expect(findings[0]?.message).toContain("hook SessionStart");
    // The number, because it is the one thing the run said and the first thing anybody
    // reproducing this compares against.
    expect(findings[0]?.message).toContain("exited 1");
  });

  test("a killed run is a timeout, and the finding names the seconds the host allows", () => {
    const repo = repoWithHooks([wired("SessionStart", SESSION, 5)]);
    const { probes } = runProbes([KILLED]);

    const { health, findings } = hookHealth(repo, probes);

    expect(health.hooks[0]?.state).toBe("timeout");
    // Never a number here: a process the host killed did not choose its exit code, and printing one
    // would read as a verdict the command never gave.
    expect(health.hooks[0]?.exitCode).toBeNull();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("warn");
    expect(findings[0]?.message).toContain("hook SessionStart");
    expect(findings[0]?.message).toContain("5 second timeout");
  });

  test("an entry with no timeout is reported against the host's 10 second default", () => {
    const repo = repoWithHooks([wired("SessionStart", SESSION)]);
    const { probes } = runProbes([KILLED]);

    const { findings } = hookHealth(repo, probes);

    expect(findings[0]?.message).toContain("10 second timeout");
  });

  test("the probe is run once per wired hook, with the repo root and the command as written", () => {
    // Once each and never once for the file: two hooks that are both broken are two findings and
    // two repairs, and a probe that ran the first and assumed the rest would report one of them.
    const repo = repoWithHooks([wired("SessionStart", SESSION), wired("PreToolUse", EDIT, 5)]);
    const { probes, calls } = runProbes([exited(0), exited(0)]);

    hookHealth(repo, probes);

    expect(calls).toEqual([
      { repoRoot: repo, command: SESSION, timeout: null },
      { repoRoot: repo, command: EDIT, timeout: 5 },
    ]);
  });

  test("the command string is handed over unexpanded, with the host's variable still in it", () => {
    // The probe is what expands `${CLAUDE_PROJECT_DIR}`, by handing it to a shell with that
    // variable set. Expanding it here instead would run a command line the host never runs, and a
    // quoting fault in the real string would be invisible.
    const repo = repoWithHooks([wired("SessionStart", SESSION)]);
    const { probes, calls } = runProbes([exited(0)]);

    hookHealth(repo, probes);

    expect(calls[0]?.command).toContain(`\${CLAUDE_PROJECT_DIR}`);
  });

  test("a broken hook is a warning, so it is said out loud and the report stays ok", () => {
    // The one thing a finding's level decides, and the direction it has to decide in. Saying which
    // hook is broken is the repair; refusing the whole report over it would fail every machine that
    // runs doctor and never runs a hook, which is CI, a container, and any stripped PATH.
    const repo = repoWithHooks([wired("PreToolUse", EDIT)]);
    const { probes } = runProbes([exited(127)]);

    const health = healthReport(repo, installedPackVersion, probes);

    // Not special-cased anywhere: `ok` is "no finding of level error", and a warn hook is not one.
    expect(health.ok).toBe(true);
    expect(health.findings.at(-1)?.level).toBe("warn");
    expect(health.hooks.state).toBe("probed");
    // Last of the list, after the spine warnings that have always closed it: every other finding is
    // about this repository, and this one is about the wiring around it.
    expect(health.findings.at(-1)?.message).toContain("hook PreToolUse");
  });

  test("healthReport with quiet probes carries the hooks and adds no finding", () => {
    const repo = repoWithHooks([wired("SessionStart", SESSION), wired("PreToolUse", EDIT, 5)]);

    const health = healthReport(repo, installedPackVersion, quietProbes);

    expect(health.hooks.state).toBe("unprobed");
    expect(health.hooks.hooks).toHaveLength(2);
    expect(health.findings.filter((finding) => finding.message.includes("hook "))).toEqual([]);
  });

  /**
   * The real probe, which every case above substitutes. Two things about it can be wrong in a way
   * no fake would ever show, and both are silent: the variable the host expands in the command
   * string, and the unit the timeout is stated in.
   */
  describe("systemProbes.runHook", () => {
    test("CLAUDE_PROJECT_DIR is the repo root, because that is what the command expands", () => {
      const repo = copyFixture();

      const result = systemProbes.runHook?.(repo, {
        event: "SessionStart",
        matcher: null,
        // Harmless and self-reporting: it runs no empo and touches nothing, it only says back what
        // the shell was given. A wrong or missing variable comes back as the empty string, which is
        // the `--repo ""` a real hook would have resolved somewhere else from.
        command: `printf %s "\${CLAUDE_PROJECT_DIR}"`,
        timeout: null,
      });

      expect(result?.exitCode).toBe(0);
      expect(result?.stdout).toBe(repo);
    });

    test("the configured timeout is seconds, so a run inside it survives and one past it is killed", () => {
      const repo = copyFixture();

      // Half a second of work against a one second budget. Read as milliseconds, this budget is
      // 1ms and the command is killed before it starts, which is how a report that called every
      // hook a timeout used to be produced.
      const inside = systemProbes.runHook?.(repo, {
        event: "SessionStart",
        matcher: null,
        command: "sleep 0.5",
        timeout: 1,
      });
      expect(inside?.timedOut).toBe(false);
      expect(inside?.exitCode).toBe(0);

      // And the other direction, which is what stops the multiplication being applied twice: 30
      // seconds of work against the same budget is killed, and this test finishes in about one.
      const past = systemProbes.runHook?.(repo, {
        event: "SessionStart",
        matcher: null,
        command: "sleep 30",
        timeout: 1,
      });
      expect(past?.timedOut).toBe(true);
      expect(past?.exitCode).toBeNull();
    }, 20_000);
  });
});
