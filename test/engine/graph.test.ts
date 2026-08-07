import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../../src/engine/config";
import { run } from "../../src/engine/git";
import {
  buildGraph,
  computeFanin,
  driftLines,
  GRAPH_PATH,
  GRAPH_SCHEMA,
  graphDrift,
  readGraph,
  serializeGraph,
  staleness,
  stalenessLine,
  stalenessLineFrom,
  stalenessLines,
} from "../../src/engine/graph";
import { loadPack } from "../../src/engine/pack-loader";
import { configError } from "../../src/errors";
import type { Graph, GraphEdge } from "../../src/schema/types";

/**
 * The staleness split: `staleness()` computes how old a graph is and `stalenessLine()` renders it.
 * They were one function until `empo doctor --json` needed the numbers without the sentence.
 *
 * The four rendered cases are pinned byte for byte here because `empo query` and `empo review` both
 * print that line and a reader uses it to decide whether to trust the answer above it. A split that
 * quietly reworded one of them would be a silent change to the interface, which is why this file
 * spells out every expected string in full rather than matching a fragment of it.
 *
 * Two of the four need a real repository, since a distance from HEAD is a fact only git holds. Those
 * build a throwaway one and read the shas back out of it, so no sha below is written by hand.
 *
 * The last two sections are the staleness git cannot hold at all. A pack is data and a schema is a
 * meaning, so either moves without one tracked file moving, and a graph in that state is exactly one
 * that git reports as current with HEAD and is right to.
 */

/**
 * Every case below spawns git. The 5s default is a limit on a machine that is doing nothing else,
 * and these are not tests that get slower because something is wrong, so they state their own.
 */
const GIT_TIMEOUT = 30_000;

/**
 * The php pack as installed beside this test, read rather than written down. A literal here would be
 * a line that is true until the next bump, which is the exact class of stale answer the drift line
 * exists to announce.
 */
const PHP_INSTALLED = loadPack("php").version;

/** A version no pack will carry, so a graph recording it is unambiguously built by another one. */
const PHP_BEFORE = "0.0.1-before";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The smallest graph the functions under test read: a sha, an empty `packs` map so nothing can have
 * drifted, and the current schema. A fixture-built graph here would tie these expectations to the
 * fixture's node count for nothing.
 */
function graphBuiltAgainst(sha: string): Graph {
  return {
    schema: GRAPH_SCHEMA,
    builtAgainst: sha,
    builtAtCommitSubject: "",
    roots: [],
    packs: {},
    stats: { files: 0, nodes: 0, edges: 0, bridgedEdges: 0 },
    nodes: [],
    edges: [],
    flows: {},
    fanin: {},
    coverage: {},
    hazards: [],
    // No pack looked, which is what an empty `hazards` beside an empty `hazardsScanned` says. The
    // functions under test here read neither, and the two fields still have to be written out: a
    // Graph is the shape on disk, and a literal that omits half of it would compile against a
    // partial type nothing ever produces.
    hazardsScanned: [],
    names: [],
  };
}

function git(repo: string, args: string[]): string {
  const result = run(repo, "git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** -c on the commit so this passes with no git identity and no signing key configured. */
function commit(repo: string, message: string): string {
  writeFileSync(join(repo, `${message}.txt`), `${message}\n`);
  git(repo, ["add", "-A"]);
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

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-staleness-"));
  temps.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

/**
 * A directory that is not a checkout at all, so every git question comes back unanswered.
 *
 * That sentence is a claim about the machine and not only about this function, so it is checked
 * here rather than trusted. git walks *up* looking for a repository, and a $TMPDIR that itself sits
 * inside a checkout puts this directory in that work tree. The tests below would then still pass,
 * on a sha the enclosing repository does not have rather than on the absence the helper promises,
 * which is the worst of the three outcomes: green, and about something else.
 */
function plainDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-staleness-nogit-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  temps.push(dir);
  expect(run(dir, "git", ["rev-parse", "--show-toplevel"]).ok).toBe(false);
  return dir;
}

describe("staleness", () => {
  test(
    "an empty builtAgainst is an unknown on both fields, never a zero",
    () => {
      const repo = gitRepo();
      commit(repo, "one");

      // Both null even though this *is* a git repository: the graph was built somewhere that had no
      // sha to record, so there is nothing to measure a distance from.
      expect(staleness(repo, graphBuiltAgainst(""))).toEqual({
        builtAgainst: null,
        commitsBehind: null,
      });
    },
    GIT_TIMEOUT,
  );

  test(
    "a sha git cannot answer for leaves the distance null and keeps the sha",
    () => {
      const repo = plainDirectory();
      const sha = "0".repeat(40);

      expect(staleness(repo, graphBuiltAgainst(sha))).toEqual({
        builtAgainst: sha,
        commitsBehind: null,
      });
    },
    GIT_TIMEOUT,
  );

  test(
    "a graph built at HEAD is zero commits behind, which is not the same as unknown",
    () => {
      const repo = gitRepo();
      const head = commit(repo, "one");

      expect(staleness(repo, graphBuiltAgainst(head))).toEqual({
        builtAgainst: head,
        commitsBehind: 0,
      });
    },
    GIT_TIMEOUT,
  );

  test(
    "commitsBehind counts the commits HEAD gained since the graph was built",
    () => {
      const repo = gitRepo();
      const first = commit(repo, "one");
      commit(repo, "two");
      commit(repo, "three");

      expect(staleness(repo, graphBuiltAgainst(first))).toEqual({
        builtAgainst: first,
        commitsBehind: 2,
      });
    },
    GIT_TIMEOUT,
  );
});

describe("stalenessLine", () => {
  test(
    "built outside a git repository",
    () => {
      const repo = gitRepo();
      commit(repo, "one");

      expect(stalenessLine(repo, graphBuiltAgainst(""))).toBe(
        "graph      built outside a git repository",
      );
    },
    GIT_TIMEOUT,
  );

  test(
    "distance from HEAD unknown",
    () => {
      const repo = plainDirectory();

      expect(
        stalenessLine(repo, graphBuiltAgainst("abcdef1234567890abcdef1234567890abcdef12")),
      ).toBe("graph      built against abcdef1, distance from HEAD unknown");
    },
    GIT_TIMEOUT,
  );

  test(
    "current with HEAD",
    () => {
      const repo = gitRepo();
      const head = commit(repo, "one");

      expect(stalenessLine(repo, graphBuiltAgainst(head))).toBe(
        `graph      built against ${head.slice(0, 7)}, current with HEAD`,
      );
    },
    GIT_TIMEOUT,
  );

  test(
    "one commit ahead is singular, more than one is plural",
    () => {
      const repo = gitRepo();
      const first = commit(repo, "one");
      commit(repo, "two");

      expect(stalenessLine(repo, graphBuiltAgainst(first))).toBe(
        `graph      built against ${first.slice(0, 7)}, HEAD is 1 commit ahead`,
      );

      commit(repo, "three");
      expect(stalenessLine(repo, graphBuiltAgainst(first))).toBe(
        `graph      built against ${first.slice(0, 7)}, HEAD is 2 commits ahead`,
      );
    },
    GIT_TIMEOUT,
  );

  test(
    "renders from an already-computed staleness, so no caller pays for a second git call",
    () => {
      const repo = gitRepo();
      const first = commit(repo, "one");
      commit(repo, "two");

      // The whole point of the split: the line the command prints and the numbers the JSON document
      // carries come from one computation, so they cannot disagree.
      expect(stalenessLineFrom(staleness(repo, graphBuiltAgainst(first)))).toBe(
        stalenessLine(repo, graphBuiltAgainst(first)),
      );
    },
    GIT_TIMEOUT,
  );
});

/** A pack version reader whose answer is written into the test rather than read off the disk. */
function packs(versions: Record<string, string>): (lang: string) => string | null {
  return (lang) => versions[lang] ?? null;
}

/** A graph that names the packs it was built with, which is what drift is computed against. */
function graphBuiltWith(built: Record<string, string>, schema: number = GRAPH_SCHEMA): Graph {
  return { ...graphBuiltAgainst(""), packs: built, schema };
}

describe("graphDrift", () => {
  test("a pack whose installed version moved comes back with both versions", () => {
    expect(graphDrift(graphBuiltWith({ php: "1.0.0" }), packs({ php: "1.2.0" }))).toEqual({
      packs: [{ lang: "php", built: "1.0.0", loaded: "1.2.0" }],
      unloadable: [],
      schema: null,
    });
  });

  test("a graph recording the installed versions has drifted nothing", () => {
    expect(
      graphDrift(
        graphBuiltWith({ php: "1.2.0", typescript: "2.0.0" }),
        packs({ php: "1.2.0", typescript: "2.0.0" }),
      ),
    ).toEqual({ packs: [], unloadable: [], schema: null });
  });

  test("a pack that is not installed at all is skipped in silence, and is not drift", () => {
    // There is no version to reindex to, and the config checks in engine/health.ts already name a
    // pack that is not installed in their own words.
    expect(graphDrift(graphBuiltWith({ cobol: "1.0.0" }), packs({}))).toEqual({
      packs: [],
      unloadable: [],
      schema: null,
    });
  });

  test("a pack that is installed and will not load comes back with the loader's own words", () => {
    // The branch that used to share the silent `continue` above. It is a different fact and it needs
    // a different answer: something is installed under that name and nothing can say what it holds.
    // The reason carries the loader's details as well as its message, because "will not load" alone
    // leaves the reader choosing between three different repairs.
    const reader = (lang: string): string | null => {
      if (lang === "php")
        throw configError("packs/php/pack.json is not a valid pack", ["version: Required"]);
      return "2.0.0";
    };

    expect(graphDrift(graphBuiltWith({ php: "1.0.0", typescript: "2.0.0" }), reader)).toEqual({
      // The loop keeps going: typescript sorts after php and is still compared.
      packs: [],
      unloadable: [
        { lang: "php", reason: "packs/php/pack.json is not a valid pack version: Required" },
      ],
      schema: null,
    });
  });

  test("a graph written at another schema names both schemas", () => {
    expect(graphDrift(graphBuiltWith({}, 1), packs({})).schema).toEqual({
      built: 1,
      writes: GRAPH_SCHEMA,
    });
  });

  test("a graph whose schema is absent, or is not a number, records no schema rather than a guess", () => {
    // `readGraph` casts without checking a key, so this field is whatever the file held. Coercing a
    // missing or non-numeric schema to a number would invent the one fact it exists to record.
    const noSchema = { ...graphBuiltAgainst(""), schema: undefined } as unknown as Graph;
    const wrongType = { ...graphBuiltAgainst(""), schema: "1" } as unknown as Graph;

    expect(graphDrift(noSchema, packs({})).schema).toEqual({ built: null, writes: GRAPH_SCHEMA });
    expect(graphDrift(wrongType, packs({})).schema).toEqual({ built: null, writes: GRAPH_SCHEMA });
  });
});

/**
 * The lines `empo doctor`, `empo query` and `empo review` all print for a graph that git calls
 * current. They live in one renderer so the three surfaces cannot word one state three ways, and
 * they are pinned byte for byte here for the same reason the git line above is.
 */
describe("driftLines", () => {
  test("one line per moved pack, each naming both versions and the repair", () => {
    expect(
      driftLines(
        [
          { lang: "php", built: "1.0.0", loaded: "1.2.0" },
          { lang: "typescript", built: "1.9.0", loaded: "2.0.0" },
        ],
        null,
      ),
    ).toEqual([
      "drift      graph built with php pack 1.0.0, 1.2.0 is installed (run empo index)",
      "drift      graph built with typescript pack 1.9.0, 2.0.0 is installed (run empo index)",
    ]);
  });

  test("a pack version the graph never recorded is said, not guessed at", () => {
    expect(driftLines([{ lang: "php", built: null, loaded: "1.2.0" }], null)).toEqual([
      "drift      graph does not record which php pack built it, 1.2.0 is installed (run empo index)",
    ]);
  });

  test("the schema line comes last, after however many packs moved", () => {
    // Last so a reader who has seen this block before finds the pack lines where they have always
    // been, and because a schema moving is the wider fact: it changes what a field means for every
    // language at once.
    expect(
      driftLines([{ lang: "php", built: "1.0.0", loaded: "1.2.0" }], { built: 1, writes: 2 }),
    ).toEqual([
      "drift      graph built with php pack 1.0.0, 1.2.0 is installed (run empo index)",
      "drift      graph was written at schema 1, this empo writes schema 2 (run empo index)",
    ]);
  });

  test("a graph that records no schema is said, not guessed at either", () => {
    expect(driftLines([], { built: null, writes: 2 })).toEqual([
      "drift      graph records no schema, this empo writes schema 2 (run empo index)",
    ]);
  });

  test("nothing drifted is no lines at all, never a line saying so", () => {
    // A block that says "0 packs drifted" every time is noise, and noise is what teaches a reader to
    // skip the line above it too.
    expect(driftLines([], null)).toEqual([]);
  });
});

describe("stalenessLines", () => {
  test(
    "a graph current with HEAD still says the pack moved, on the line under it",
    () => {
      // The finding this exists for: `empo query` and `empo review` printed the git line alone, and
      // the git line is right. A pack is data, so the graph is exactly current with the commit and
      // every answer derived from that pack is the recorded pack's answer.
      const repo = gitRepo();
      const head = commit(repo, "one");
      const graph = { ...graphBuiltAgainst(head), packs: { php: PHP_BEFORE } };

      // The installed version is read off the pack rather than written down, so this stays a real
      // difference after the next bump instead of quietly comparing two equal strings.
      expect(PHP_BEFORE).not.toBe(PHP_INSTALLED);
      expect(stalenessLines(repo, graph)).toEqual([
        `graph      built against ${head.slice(0, 7)}, current with HEAD`,
        `drift      graph built with php pack ${PHP_BEFORE}, ${PHP_INSTALLED} is installed (run empo index)`,
      ]);
    },
    GIT_TIMEOUT,
  );

  test(
    "a graph with nothing drifted is the one git line and nothing more",
    () => {
      const repo = gitRepo();
      const head = commit(repo, "one");

      expect(stalenessLines(repo, graphBuiltAgainst(head))).toEqual([
        `graph      built against ${head.slice(0, 7)}, current with HEAD`,
      ]);
    },
    GIT_TIMEOUT,
  );
});

/**
 * Fan-in is a count of the nodes that reference one node, and not of the edges that do.
 *
 * The two were the same number until a pack declared two families that can both claim one pair. The
 * typescript pack's JSX and Vue tags do: a file imports a component and then renders it, and
 * `dedupeEdges` keys on `(from, to, kind)`, so the pair carries an `import` edge and a `template`
 * edge. Counting edges made a component rendered by its one importer answer "fan-in 2 direct, 1
 * transitive", where the transitive number is the size of a set of nodes and can never be the
 * smaller of the two.
 *
 * Written against a hand-made edge list rather than through a build, because the property is
 * arithmetic on edges and a fixture would only assert that the fixture holds what it holds.
 */
describe("computeFanin", () => {
  const edge = (from: string, to: string, kind: GraphEdge["kind"]): GraphEdge => ({
    from,
    to,
    kind,
    symbol: null,
    evidence: { file: from, line: 1 },
  });

  test("counts one referencing file once, however many families found it", () => {
    const fanin = computeFanin([
      edge("src/App.tsx", "src/Card.tsx", "import"),
      edge("src/App.tsx", "src/Card.tsx", "template"),
    ]);

    expect(fanin["src/Card.tsx"]).toBe(1);
  });

  test("still counts two referencing files as two, and omits a node nothing references", () => {
    const fanin = computeFanin([
      edge("src/App.tsx", "src/Card.tsx", "import"),
      edge("src/App.tsx", "src/Card.tsx", "template"),
      edge("src/List.tsx", "src/Card.tsx", "template"),
    ]);

    expect(fanin["src/Card.tsx"]).toBe(2);
    expect(fanin["src/App.tsx"]).toBeUndefined();
  });
});

const acmeRoot = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

/**
 * A repository holding one transaction and one job, so the pipeline has something to carry the whole
 * way. It is built through `empo index`'s own path, config and installed pack included, because the
 * fields under test are the ones on disk and a hand-written Graph literal would assert only that
 * JSON.stringify works.
 */
function repoWithHazard(
  roots: { path: string; lang: string }[] = [{ path: ".", lang: "php" }],
): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-hazards-"));
  temps.push(dir);
  mkdirSync(join(dir, ".empo"), { recursive: true });
  mkdirSync(join(dir, "app", "Jobs"), { recursive: true });

  writeFileSync(
    join(dir, ".empo", "config.json"),
    JSON.stringify({
      version: 1,
      roots,
      packs: { php: { version: "^1" } },
      bridges: [],
      flows: ".empo/flows.json",
      spines: ".empo/spines",
      ignore: [],
    }),
  );

  writeFileSync(
    join(dir, "app", "Checkout.php"),
    [
      "<?php",
      "namespace App;",
      "class Checkout",
      "{",
      "    public function place()",
      "    {",
      "        DB::transaction(function () {",
      "            ProcessOrder::dispatch();",
      "        });",
      "    }",
      "}",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(dir, "app", "Jobs", "ProcessOrder.php"),
    [
      "<?php",
      "namespace App\\Jobs;",
      "class ProcessOrder implements ShouldQueue",
      "{",
      "}",
      "",
    ].join("\n"),
  );

  return dir;
}

/**
 * The third axis on the graph itself. A hazard found during a build has to survive into graph.json,
 * and a build that found none has to record that it looked: those are the two answers `Graph.hazards`
 * and `Graph.hazardsScanned` exist to keep apart, and only the second is legible from the file alone.
 */
describe("hazards on the built graph", () => {
  test("a dispatch inside a transaction reaches the serialized graph", () => {
    const dir = repoWithHazard();
    const { config } = loadConfig(dir);
    const graph = buildGraph({ repoRoot: dir, config }).graph;

    // Read back out of the serialized bytes rather than off the object, because the field is only
    // useful if it survives the one write `empo index` performs.
    const written = JSON.parse(serializeGraph(graph)) as typeof graph;

    expect(written.hazards).toEqual([
      {
        file: "app/Checkout.php",
        line: 8,
        job: "ProcessOrder",
        target: "App\\Jobs\\ProcessOrder",
        transactionLine: 7,
      },
    ]);
    expect(written.hazardsScanned).toEqual(["php"]);
  });

  test("hazards come after coverage, and the schema line above them does not move", () => {
    const dir = repoWithHazard();
    const { config } = loadConfig(dir);
    const keys = Object.keys(buildGraph({ repoRoot: dir, config }).graph);

    // Field order is part of the bytes, and `schema` staying first is what lets every reader of a
    // graph.json find out which empo wrote it without parsing the whole document. A field added
    // since goes on the end, which is why the tail is `names` and not `hazardsScanned`: appending
    // is what keeps every key above it at the offset the previous schema left it at.
    expect(keys[0]).toBe("schema");
    expect(keys.indexOf("hazards")).toBeGreaterThan(keys.indexOf("coverage"));
    expect(keys.slice(-3)).toEqual(["hazards", "hazardsScanned", "names"]);
  });

  test("a repository whose pack looked and found nothing says so, in the graph", () => {
    const { config } = loadConfig(acmeRoot);
    const graph = buildGraph({ repoRoot: acmeRoot, config }).graph;

    // What is pinned is the derivation, not the php pack's current rules: every language named here
    // is one whose loaded pack carries a hazards block, and it is read off the packs this build
    // loaded rather than off the packs on disk when somebody later asks.
    expect(graph.hazardsScanned).toContain("php");
    for (const lang of graph.hazardsScanned) {
      expect(loadPack(lang).hazards, `${lang} is named as scanned`).toBeDefined();
    }
    expect(graph.hazardsScanned).toEqual([...graph.hazardsScanned].sort());
  });

  test("two roots of one language are one entry, and one file is one hazard", () => {
    // The nested root re-scans every file the outer one already saw, which is the case dedupeNodes
    // exists for, and both halves of this axis have to survive it: a language is named once because
    // it is one pack that looked, and a dispatch site is reported once because it is one line of
    // source however many roots walked past it.
    const dir = repoWithHazard([
      { path: ".", lang: "php" },
      { path: "app", lang: "php" },
    ]);
    const { config } = loadConfig(dir);
    const graph = buildGraph({ repoRoot: dir, config }).graph;

    expect(graph.hazardsScanned).toEqual(["php"]);
    expect(graph.hazards).toHaveLength(1);
    expect(graph.hazards[0]?.file).toBe("app/Checkout.php");
  });
});

/**
 * The read boundary, which is where a graph written by an older empo meets code that expects the
 * fields it never wrote. `readGraph` casts what it parsed and checks no key, so this is the one
 * place the two new fields can be repaired, and they are repaired differently on purpose.
 */
describe("readGraph over a graph written before the hazard axis", () => {
  /** A graph.json in the shape schema 2 wrote: every field of that shape, and neither new one. */
  function repoWithOldGraph(): string {
    const dir = mkdtempSync(join(tmpdir(), "empo-old-graph-"));
    temps.push(dir);
    mkdirSync(join(dir, ".empo", "generated"), { recursive: true });
    writeFileSync(
      join(dir, GRAPH_PATH),
      JSON.stringify({
        schema: 2,
        builtAgainst: "",
        builtAtCommitSubject: "",
        roots: [{ path: ".", lang: "php" }],
        packs: { php: "1.0.0" },
        stats: { files: 0, nodes: 0, edges: 0, bridgedEdges: 0 },
        nodes: [],
        edges: [],
        flows: {},
        fanin: {},
        coverage: {},
      }),
    );
    return dir;
  }

  test("hazardsScanned comes back as an empty list rather than as undefined", () => {
    const graph = readGraph(repoWithOldGraph());

    // Not a default standing in for an unknown: no pack looked during that build, and the empty
    // list says exactly that. A reader can iterate it without a guard, which is what keeps the
    // next caller from crashing on a graph nobody has reindexed.
    expect(graph.hazardsScanned).toEqual([]);
    expect(Array.isArray(graph.hazardsScanned)).toBe(true);
  });

  test("hazards stays absent, because absent and empty are not the same claim", () => {
    const graph = readGraph(repoWithOldGraph());

    // The one field that must not be defaulted here. `empo query --hazards` reads the absence as
    // "nobody ever looked" and prints a caveat for it (commands/query.ts), and an empty array in
    // its place would be a clean bill of health invented out of a field no run ever wrote.
    expect("hazards" in graph).toBe(false);
    expect(graph.hazards).toBeUndefined();
  });

  test("and the graph is still announced as older than the code reading it", () => {
    const graph = readGraph(repoWithOldGraph());

    // The bump is the channel that tells a user their graph predates these rules, so the repair
    // above must not quiet it: a graph missing both fields is exactly one written at schema 2.
    expect(graphDrift(graph, packs({})).schema).toEqual({ built: 2, writes: GRAPH_SCHEMA });
    expect(driftLines([], graphDrift(graph, packs({})).schema)).toEqual([
      `drift      graph was written at schema 2, this empo writes schema ${GRAPH_SCHEMA} (run empo index)`,
    ]);
  });
});
