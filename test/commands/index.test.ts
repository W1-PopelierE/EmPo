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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { indexCommand } from "../../src/commands/index";
import { buildRoot } from "../../src/engine/build";
import { run } from "../../src/engine/git";
import { GRAPH_PATH, LOCK_PATH } from "../../src/engine/graph";
import { loadPack } from "../../src/engine/pack-loader";
import { EmpoError } from "../../src/errors";
import type { Graph } from "../../src/schema/types";

/**
 * `empo index` end to end over the acme fixture: build a real graph from real files and read back
 * what landed on disk. Every test works on its own copy of the fixture under the system temp
 * directory, because the command writes, and because a fixture that a test can dirty is a fixture
 * that makes the next test lie.
 *
 * The copy is deliberately not a git checkout, which is a case worth covering on its own: a
 * directory outside git still indexes, it just cannot report staleness.
 */

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

const CALCULATOR = "Acme\\Libraries\\Price\\PriceCalculator";
const ORDER_CONTROLLER = "Acme\\Http\\Controllers\\OrderController";
const ADMIN_CONTROLLER = "Acme\\Http\\Controllers\\AdminController";
const CHECKOUT_TEST = "Acme\\Tests\\Feature\\CheckoutTest";
const ORDER_TEST = "Acme\\Tests\\Feature\\OrderTest";
const PAGE_CONTROLLER = "Acme\\Http\\Controllers\\OrderPageController";
const PAGE_CONTROLLER_FILE = "apps/api/app/Http/Controllers/OrderPageController.php";
const INERTIA_PAGE = "apps/portal/src/Pages/Orders/Show.vue";

let repo: string;

function graphOnDisk(): Graph {
  return JSON.parse(readFileSync(join(repo, GRAPH_PATH), "utf8")) as Graph;
}

/** The line an anchor really sits on, read from the copy, never counted by hand. */
function lineOf(relPath: string, anchor: string): number {
  const index = readFileSync(join(repo, relPath), "utf8")
    .split("\n")
    .findIndex((line) => line.includes(anchor));
  expect(index, `no line of ${relPath} contains "${anchor}"`).toBeGreaterThanOrEqual(0);
  return index + 1;
}

function writeGraph(graph: Graph): void {
  writeFileSync(join(repo, GRAPH_PATH), `${JSON.stringify(graph, null, 2)}\n`);
}

/**
 * A second root nested inside the first, so every file under it is scanned twice. The config is
 * written into the copy rather than into the fixture, which stays a single-root repository.
 */
function useOverlappingRoots(): void {
  const config = {
    version: 1,
    roots: [
      { path: "apps/api", lang: "php" },
      { path: "apps/api/app", lang: "php" },
    ],
    packs: { php: { version: "^1" } },
  };
  writeFileSync(join(repo, ".empo/config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * One root declared twice, the second time with a trailing slash. `normalizeRepoPath` flattens both
 * spellings to "apps/api" while the config is validated, so this is two identical declarations by
 * the time anything reads them, and every file under the root is scanned twice under one
 * repo-relative path.
 */
function useTrailingSlashRoot(): void {
  const config = {
    version: 1,
    roots: [
      { path: "apps/api", lang: "php" },
      { path: "apps/api/", lang: "php" },
    ],
    packs: { php: { version: "^1" } },
  };
  writeFileSync(join(repo, ".empo/config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Three roots over one tree in two languages: a typescript root over the whole repository and two
 * nested php roots under it. Every `.php` file falls under all three by path and is read by two of
 * them, which is the difference between counting roots and counting the roots that scan.
 */
function useMixedLanguageRoots(): void {
  const config = {
    version: 1,
    roots: [
      { path: ".", lang: "typescript" },
      { path: "apps/api", lang: "php" },
      { path: "apps/api/app", lang: "php" },
    ],
    packs: { php: { version: "^1" }, typescript: { version: "^1" } },
  };
  writeFileSync(join(repo, ".empo/config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** Three nested roots, so the deepest file falls under all of them and three names get listed. */
function useThreeNestedRoots(): void {
  const config = {
    version: 1,
    roots: [
      { path: "apps/api", lang: "php" },
      { path: "apps/api/app", lang: "php" },
      { path: "apps/api/app/Libraries", lang: "php" },
    ],
    packs: { php: { version: "^1" } },
  };
  writeFileSync(join(repo, ".empo/config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * A second file declaring the class the fixture already declares, the copied-class case the
 * deduplicator exists for. It sorts after the original, so the original is the one that survives.
 */
function copyTheCalculator(): void {
  const source = [
    "<?php",
    "",
    "namespace Acme\\Libraries\\Price;",
    "",
    "class PriceCalculator",
    "{",
    "}",
    "",
  ].join("\n");

  mkdirSync(join(repo, "apps/api/app/Support"), { recursive: true });
  writeFileSync(join(repo, "apps/api/app/Support/PriceCalculator.php"), source);
}

/**
 * Everything one run printed, as the lines a terminal would show. The warning wording is the thing
 * under test here, so the silencer installed in beforeEach is swapped for a recorder and then put
 * back, rather than restored, so the rest of the test stays as quiet as every other test in this
 * file.
 *
 * Lines rather than one joined string, which is what test/commands/doctor.test.ts already returns
 * and for the same reason. Every claim below is a claim about one printed line, and a substring
 * match over the whole run is satisfied by text that landed somewhere else entirely, by a line that
 * carries the expected text and then more after it, and by a warning printed under a condition that
 * should not have produced one. All three are ways a wrong line reads as a right one.
 */
function printedLines(run: () => void): string[] {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });

  try {
    run();
  } finally {
    log.mockImplementation(() => {});
  }

  return lines.join("\n").split("\n");
}

/**
 * Where one exact line is, asserted to be printed exactly once. Each duplicate warning is a pair, a
 * `warn` line and the indented line that explains it, so the index is what lets the pairing itself
 * be asserted: an explanation that is merely somewhere in the output is an explanation a reader can
 * pair with the wrong node id.
 */
function lineAt(lines: string[], line: string): number {
  expect(lines.filter((candidate) => candidate === line)).toEqual([line]);
  return lines.indexOf(line);
}

/**
 * Counted from disk, so the expectation does not come from the same code that is under test.
 *
 * The walk is written out rather than handed to `readdirSync`'s `recursive` option. That was
 * required when `engines` said `>=20`, because the option landed in 20.1.0 and an unknown option is
 * ignored rather than refused, so on 20.0 this would have counted the top level only and reported a
 * number that is wrong without ever saying so. The floor is now `>=22.12.0`, so the
 * option is inside it and the twelve lines below are kept because they work rather than because
 * they are needed. The rule they came from has not moved: `test/` may use no Node API newer than
 * `engines` admits, and this one failed silently rather than loudly, which is the reason to write
 * it out rather than to test for it.
 */
function phpFileCount(dir: string): number {
  let found = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found += phpFileCount(join(dir, entry.name));
    else if (entry.name.endsWith(".php")) found += 1;
  }
  return found;
}

function expectEmpoError(exitCode: number, run: () => void): EmpoError {
  try {
    run();
    return expect.unreachable(`expected a EmpoError with exit code ${exitCode}`);
  } catch (error) {
    expect(error).toBeInstanceOf(EmpoError);
    expect((error as EmpoError).exitCode).toBe(exitCode);
    return error as EmpoError;
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "empo-index-"));
  cpSync(fixture, repo, { recursive: true });
  // A local run may have left generated output in the fixture. Every test here starts unindexed.
  rmSync(join(repo, ".empo/generated"), { recursive: true, force: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe("indexCommand", () => {
  test("writes both the graph and the pack lock to disk", () => {
    indexCommand(repo);

    expect(existsSync(join(repo, GRAPH_PATH))).toBe(true);
    expect(existsSync(join(repo, LOCK_PATH))).toBe(true);

    const graph = graphOnDisk();
    // Literal rather than read off GRAPH_SCHEMA, so a bump goes red here and stays a decision
    // somebody makes rather than one that rides along. 3 was the hazards axis; 4 is `fanin`
    // counting the nodes that reference one node rather than the edges that do (docs/05), which is
    // the shape this number exists for: a field whose name stayed and whose meaning moved. 5 is
    // `names`, and it is 3's case rather than 4's: an added field announces itself only where its
    // absence and its emptiness mean the same thing, and those are the two answers this one exists
    // to tell apart. 6 is 4's case twice over. 7 is 4's case at its widest: a pack may identify a
    // node by an exported symbol rather than by a file, so `nodes[].id`, `edges`, `fanin` and
    // `flows` all keep their names and answer per export.
    expect(graph.schema).toBe(7);
    expect(graph.roots).toEqual([
      { path: "apps/api", lang: "php" },
      { path: "apps/mobile", lang: "typescript" },
      { path: "apps/portal", lang: "typescript" },
    ]);

    const lock = JSON.parse(readFileSync(join(repo, LOCK_PATH), "utf8"));
    expect(lock.schema).toBe(1);
    expect(lock.packs.php).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packs.typescript).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packs).toEqual(graph.packs);
  });

  test("indexes a directory that is not a git checkout, with no sha to be stale against", () => {
    // Half of that title is a claim about the machine, not about the code. git walks *up* looking
    // for a repository, so a $TMPDIR that itself sits inside a checkout gives this copy of the
    // fixture a real sha and the assertion below fails against a working `empo index`. Asserted
    // first, so such a machine says which of the two is wrong instead of blaming the command.
    expect(run(repo, "git", ["rev-parse", "--show-toplevel"]).ok).toBe(false);

    indexCommand(repo);

    expect(graphOnDisk().builtAgainst).toBe("");
  });

  test("names every class and route file the fixture defines", () => {
    indexCommand(repo);
    const ids = graphOnDisk().nodes.map((node) => node.id);

    expect(ids).toContain(CALCULATOR);
    expect(ids).toContain(ORDER_CONTROLLER);
    expect(ids).toContain(ADMIN_CONTROLLER);
    // A path-shaped id is repo-relative, never root-relative, so two roots can never claim one.
    expect(ids).toContain("apps/api/routes/api.php");
    expect(ids).not.toContain("routes/api.php");
  });

  test("marks the feature tests as tests and the code they exercise as not", () => {
    indexCommand(repo);
    const byId = new Map(graphOnDisk().nodes.map((node) => [node.id, node]));

    expect(byId.get(CHECKOUT_TEST)?.isTest).toBe(true);
    expect(byId.get(ORDER_TEST)?.isTest).toBe(true);
    expect(byId.get(CALCULATOR)?.isTest).toBe(false);
  });

  test("records the controller that imports the calculator, with the line it was found on", () => {
    indexCommand(repo);
    const edge = graphOnDisk().edges.find(
      (candidate) => candidate.from === ORDER_CONTROLLER && candidate.to === CALCULATOR,
    );

    expect(edge?.kind).toBe("import");
    expect(edge?.evidence.file).toBe("apps/api/app/Http/Controllers/OrderController.php");
    expect(edge?.evidence.line).toBeGreaterThan(0);
  });

  test("joins the controller to the Vue page it renders, which no import edge could reach", () => {
    // Level 2 through the whole pipeline (docs/01-architecture.md), and the reason the fixture
    // carries a third root at all. The two sides share no import, no symbol table and no directory:
    // the php file names the string "Orders/Show", the page's identity is where the file sits, and
    // the edge exists only because a bridge matched one produced key against one consumed key.
    indexCommand(repo);
    const edge = graphOnDisk().edges.find(
      (candidate) => candidate.from === PAGE_CONTROLLER && candidate.to === INERTIA_PAGE,
    );

    expect(edge?.kind).toBe("bridge");
    expect(edge?.symbol).toBe("inertia-page");
    // The evidence is the call site and never the page, so the line a reader opens is the line that
    // would have to change (engine/bridger.ts).
    expect(edge?.evidence.file).toBe(PAGE_CONTROLLER_FILE);
    expect(edge?.evidence.line).toBe(lineOf(PAGE_CONTROLLER_FILE, "Inertia::render("));
  });

  test("derives the page name from the path on one side and from a string on the other", () => {
    // The two halves the bridge joins, asserted apart, because a matched key proves they agree and
    // not that either was read correctly. `Pages/Orders/Show.vue` carries the name nowhere inside
    // it, which is the whole point of a `pathPattern` producer (docs/04-language-packs.md).
    indexCommand(repo);
    const byId = new Map(graphOnDisk().nodes.map((node) => [node.id, node]));

    expect(byId.get(INERTIA_PAGE)?.produces).toEqual([
      { symbol: "inertia-page", key: "Orders/Show", line: 1 },
    ]);
    expect(byId.get(PAGE_CONTROLLER)?.consumes).toEqual([
      {
        symbol: "inertia-page",
        key: "Orders/Show",
        line: lineOf(PAGE_CONTROLLER_FILE, "Inertia::render("),
      },
    ]);
  });

  test("splits the three flows into covered, blind, and never exercised", () => {
    indexCommand(repo);
    const { coverage } = graphOnDisk();

    expect(coverage.checkout?.blind).toBe(true);
    expect(coverage.orders?.blind).toBe(false);
    expect(coverage.orders?.assertsValue).toBe(true);
    // admin is not blind, and that is not an oversight: blind means a test runs the flow and
    // asserts nothing. No test reaches admin at all, so there is nothing to be blind about, and
    // calling it blind would hide a louder problem inside a quieter word.
    expect(coverage.admin?.reaches).toBe(false);
    expect(coverage.admin?.blind).toBe(false);
  });

  test("the header states how many flows a test reaches, beside how many are blind", () => {
    // The denominator `blind` is a numerator of, printed for the reason `--blind` carries
    // `flowsConsidered`: a flow no test reaches can never be blind, so the blind count alone is the
    // same number over a well tested repository and over one nothing tests at all.
    const lines = printedLines(() => {
      indexCommand(repo);
    });
    const { coverage } = graphOnDisk();

    expect(lines).toContain("flows      3 defined, 2 reached by a test, 1 blind: checkout");
    // Cross-checked against the graph, so the literal above cannot drift away from the fixture
    // without one of the two going red and naming which.
    expect(Object.values(coverage).filter((entry) => entry.reaches)).toHaveLength(2);
  });

  test("the header states what the name-resolving rules read, and their denominator", () => {
    // The defect this closes: `short-name` and `observer` refuse a name carried by more than one
    // node, and refused it in silence. One duplicate basename anywhere in a root takes every edge
    // to that name with it, including the ones written in a file whose own import says which is
    // meant, and nothing counted or printed that. Measured on a 16-file React tree, a second
    // `OrderTable.tsx` under another feature directory took it from 12 template edges to 7 with no
    // warning and doctor OK; on a 640-file copy where every component name was 40-way ambiguous,
    // no template edge resolved at all. This line is what makes that visible from the outside.
    //
    // The fixture refuses nothing, so this is also the pin on the clean shape: the ratio prints
    // anyway. A number that appeared only once something had gone wrong would be a number nobody
    // had a baseline for at the moment they needed one.
    const lines = printedLines(() => {
      indexCommand(repo);
    });

    expect(lines).toContain("names      hook     2 of 2 resolved");
    expect(lines).toContain("names      template 1 of 1 resolved");
    // Cross-checked against the graph, so the two literals above cannot drift away from the fixture
    // without one of them going red and naming which. The tally is on the graph rather than beside
    // it, because `empo doctor` reads the graph and nothing else, and a count that lived only in
    // this command's output would have left doctor exactly as silent as it was.
    expect(graphOnDisk().names).toEqual([
      {
        family: "hook",
        resolved: 2,
        unknown: 0,
        ambiguous: 0,
        wrongKind: 0,
        local: 0,
        vendor: 0,
        ambiguousNames: [],
      },
      {
        family: "template",
        resolved: 1,
        unknown: 0,
        ambiguous: 0,
        wrongKind: 0,
        local: 0,
        vendor: 0,
        ambiguousNames: [],
      },
    ]);
  });

  test("a repository no test reaches says so, instead of reading as one with no blind flows", () => {
    // The defect this closes, in the state that made it wrong: with the tests gone, nothing reaches
    // any of the three flows, and the old header printed `3 defined, 0 blind` here and printed the
    // identical line over a repository whose every flow is asserted on. Those are opposite results.
    rmSync(join(repo, "apps/api/tests"), { recursive: true, force: true });
    rmSync(join(repo, "apps/mobile/tests"), { recursive: true, force: true });

    const lines = printedLines(() => {
      indexCommand(repo);
    });

    expect(lines).toContain("flows      3 defined, 0 reached by a test, 0 blind");
    expect(graphOnDisk().nodes.some((node) => node.isTest)).toBe(false);
  });

  test("stores only non-zero fan-in, so a node nothing references is absent rather than zero", () => {
    indexCommand(repo);
    const { fanin, nodes } = graphOnDisk();

    expect(fanin[CALCULATOR]).toBeGreaterThan(0);
    expect(Object.values(fanin).every((count) => count > 0)).toBe(true);
    // Nothing in the fixture imports AdminController, so it is in the graph but not in the map.
    expect(ADMIN_CONTROLLER in fanin).toBe(false);
    expect(nodes.some((node) => node.id === ADMIN_CONTROLLER)).toBe(true);
  });

  test("passes its own check right after a write, and leaves the file untouched", () => {
    indexCommand(repo);
    const written = readFileSync(join(repo, GRAPH_PATH), "utf8");

    expect(() => indexCommand(repo, { check: true })).not.toThrow();
    expect(readFileSync(join(repo, GRAPH_PATH), "utf8")).toBe(written);
  });

  test("fails the check with exit code 1 when an edge is missing from the graph on disk", () => {
    indexCommand(repo);
    const graph = graphOnDisk();
    graph.edges = graph.edges.slice(1);
    graph.stats.edges = graph.edges.length;
    writeGraph(graph);

    const error = expectEmpoError(1, () => indexCommand(repo, { check: true }));

    expect(error.details.join("\n")).toContain("edges");
  });

  test("fails the check with exit code 1 when the graph claims a different build sha", () => {
    indexCommand(repo);
    const graph = graphOnDisk();
    graph.builtAgainst = "a".repeat(40);
    writeGraph(graph);

    const error = expectEmpoError(1, () => indexCommand(repo, { check: true }));

    expect(error.details.join("\n")).toContain("built against");
  });

  test("fails the check with exit code 1 when there is no graph at all", () => {
    expectEmpoError(1, () => indexCommand(repo, { check: true }));
  });

  test("says the graph does not parse when the file on disk is broken JSON", () => {
    indexCommand(repo);
    writeFileSync(join(repo, GRAPH_PATH), "{ not json");

    const details = expectEmpoError(1, () => indexCommand(repo, { check: true })).details.join(
      "\n",
    );

    expect(details).toContain(`${join(repo, GRAPH_PATH)} is not valid JSON`);
    expect(details).not.toContain("no stats block");
  });

  test("says the graph parses but is not a graph when the stats block is gone", () => {
    // The two failures have to read differently. Telling someone whose file parses that it "is not
    // valid JSON" sends them hunting for a syntax error that is not there.
    indexCommand(repo);
    writeFileSync(join(repo, GRAPH_PATH), '{"schema":1,"nodes":[]}');

    const details = expectEmpoError(1, () => indexCommand(repo, { check: true })).details.join(
      "\n",
    );

    expect(details).toContain(
      `${join(repo, GRAPH_PATH)} parses but has no stats block, so it is not a graph`,
    );
    expect(details).not.toContain("is not valid JSON");
  });

  test("counts a file once when a nested root re-scans it", () => {
    // apps/api/app sits inside apps/api, so every file under app/ is scanned by both roots. Nodes
    // and edges are deduplicated across roots, and a file count summed per root would claim a
    // repository larger than the one on disk.
    useOverlappingRoots();
    indexCommand(repo);

    const distinct = phpFileCount(join(repo, "apps/api"));
    // What the nested root scans on its own, so the overlap is a measured fact rather than an
    // assumption: without it this test would also pass if the second root scanned nothing at all.
    const nested = buildRoot({
      repoRoot: repo,
      root: { path: "apps/api/app", lang: "php" },
      pack: loadPack("php"),
    });

    expect(nested.files.length).toBeGreaterThan(0);
    expect(nested.files).toEqual(nested.files.filter((file) => file.startsWith("apps/api/app/")));
    expect(graphOnDisk().stats.files).toBe(distinct);
    expect(graphOnDisk().stats.files).toBeLessThan(distinct + nested.files.length);
  });

  test("keeps one node per id when two roots overlap", () => {
    useOverlappingRoots();
    indexCommand(repo);
    const ids = graphOnDisk().nodes.map((node) => node.id);

    expect(ids.filter((id) => id === CALCULATOR)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("names both files and the survivor when two files claim one node id", () => {
    // The wording is the whole point: a reader who is told an id collided has to be able to find
    // both files without running anything, and to know which of them the graph actually contains.
    copyTheCalculator();

    const lines = printedLines(() => indexCommand(repo));

    const warned = lineAt(
      lines,
      `warn   2 files claim node id "${CALCULATOR}": ` +
        "apps/api/app/Libraries/Price/PriceCalculator.php, " +
        "apps/api/app/Support/PriceCalculator.php",
    );
    expect(lines[warned + 1]).toBe(
      "       only apps/api/app/Libraries/Price/PriceCalculator.php is in the graph. " +
        "Rename one or change the id rule.",
    );
  });

  test("names the roots that overlap when one file is scanned by two of them", () => {
    // One file scanned twice is a different defect from two files with one id, and the repair is a
    // different one, so it gets a different sentence. The old wording said "two files claim" over
    // both and then printed one path twice, which sent the reader hunting for a second file.
    useOverlappingRoots();

    const lines = printedLines(() => indexCommand(repo));

    const warned = lineAt(
      lines,
      `warn   node id "${CALCULATOR}" is claimed by one file that 2 roots scan: ` +
        "apps/api/app/Libraries/Price/PriceCalculator.php",
    );
    expect(lines[warned + 1]).toBe(
      '       roots "apps/api" and "apps/api/app" overlap. Narrow one or add an ignore.',
    );
    // Nothing here may claim a second file exists, because there is only one. This one stays a
    // search over everything printed: the claim is that the sentence appears nowhere at all.
    expect(lines.join("\n")).not.toContain("2 files claim node id");
  });

  test("joins three overlapping root names with commas and a final and", () => {
    useThreeNestedRoots();

    const lines = printedLines(() => indexCommand(repo));

    const warned = lineAt(
      lines,
      `warn   node id "${CALCULATOR}" is claimed by one file that 3 roots scan: ` +
        "apps/api/app/Libraries/Price/PriceCalculator.php",
    );
    expect(lines[warned + 1]).toBe(
      '       roots "apps/api", "apps/api/app" and "apps/api/app/Libraries" overlap. ' +
        "Narrow one or add an ignore.",
    );
  });

  test("counts only the roots whose pack would have read the file that collided", () => {
    // A typescript root over the repository and two php roots under it. The `.php` file falls
    // under all three by path, and engine/build.ts scans a root with its pack's extensions and
    // nothing else, so the typescript root never opened it and cannot be part of the overlap that
    // duplicated the node. Counted by path alone the warning said three roots scan, and then asked
    // the reader to narrow one of three roots, one of which had read no file of that extension:
    // the unactionable advice `rootsContaining` exists to prevent, produced by `rootsContaining`.
    useMixedLanguageRoots();

    const lines = printedLines(() => indexCommand(repo));

    // The excluded root is a real root that really scanned files, which is what makes leaving it
    // out of the count a judgement about extensions rather than about an empty root.
    expect(graphOnDisk().roots).toEqual([
      { path: ".", lang: "typescript" },
      { path: "apps/api", lang: "php" },
      { path: "apps/api/app", lang: "php" },
    ]);
    expect(graphOnDisk().nodes.some((node) => node.root === ".")).toBe(true);

    const warned = lineAt(
      lines,
      `warn   node id "${CALCULATOR}" is claimed by one file that 2 roots scan: ` +
        "apps/api/app/Libraries/Price/PriceCalculator.php",
    );
    expect(lines[warned + 1]).toBe(
      '       roots "apps/api" and "apps/api/app" overlap. Narrow one or add an ignore.',
    );
    // Neither the count nor the repair may name the root that scanned no php at all, and neither
    // may appear on any other line either, so both of these search everything printed.
    expect(lines.join("\n")).not.toContain("3 roots scan");
    expect(lines.join("\n")).not.toContain('"."');
  });

  test("counts the declarations when two spellings of one root flatten to the same path", () => {
    // Two declarations of one root survive normalization as two entries that are the same string,
    // so the file really is scanned twice, but there is only one root and nothing to narrow. The
    // overlap sentence said `roots "apps/api" and "apps/api" overlap`, which asked the reader to
    // narrow one of two roots that are one root and showed neither spelling they wrote, because
    // both are gone by the time the graph records a path. The graph keeping two entries is asserted
    // rather than assumed, because that is what makes the count two.
    //
    // This is also why nothing here covers the last wording `duplicateLines` can produce, the one
    // saying no two configured roots contain the file. No config reaches it once root paths are
    // flattened; src/commands/index.ts argues why at the branch itself.
    useTrailingSlashRoot();

    const lines = printedLines(() => indexCommand(repo));

    expect(graphOnDisk().roots).toEqual([
      { path: "apps/api", lang: "php" },
      { path: "apps/api", lang: "php" },
    ]);

    const warned = lineAt(
      lines,
      `warn   node id "${CALCULATOR}" is claimed by one file that root "apps/api" scans 2 times: ` +
        "apps/api/app/Libraries/Price/PriceCalculator.php",
    );
    expect(lines[warned + 1]).toBe(
      '       "apps/api" is declared 2 times in the config. Remove all but one.',
    );
    // Still one file, so the two-file sentence must appear nowhere: one root declared twice is not
    // two files colliding, and sending the reader hunting for a second file is the older defect.
    expect(lines.join("\n")).not.toContain("2 files claim node id");
    // And no sentence anywhere may name the one root as if it were two. This stays a search over
    // everything printed, because the defect was a repair the reader cannot carry out, and it would
    // be just as wrong on a line this test does not know to look at.
    expect(lines.join("\n")).not.toContain('"apps/api" and "apps/api"');
    expect(lines.join("\n")).not.toContain("2 roots scan");
  });

  test("fails with exit code 2 in a directory that has no EmPo config", () => {
    rmSync(join(repo, ".empo"), { recursive: true, force: true });

    expectEmpoError(2, () => indexCommand(repo));
  });
});

// ---------------------------------------------------------------------------------------------
// A root that declares aliases
// ---------------------------------------------------------------------------------------------

const MONEY = "apps/mobile/src/shared/money.ts";
const RECEIPT_SCREEN = "apps/mobile/src/screens/ReceiptScreen.tsx";
const ALIAS_IMPORT = 'import { formatMoney, type Money } from "@/shared/money";';

/**
 * One screen written the way an alias-style front end writes them: the shared module is reached
 * through the toolchain's `@/` rather than by climbing out of the screen's own directory. Written
 * into the copy, never into `fixtures/acme-platform`, whose node and edge counts a dozen specs pin.
 */
function writeAliasedScreen(): void {
  writeFileSync(
    join(repo, RECEIPT_SCREEN),
    [
      ALIAS_IMPORT,
      "",
      "export function ReceiptScreen(props: { total: Money }): string {",
      '  return "Receipt " + formatMoney(props.total);',
      "}",
      "",
    ].join("\n"),
  );
}

/**
 * The fixture's own config with the mobile root's `aliases` set, or with the key removed when given
 * undefined. Everything else in the file survives, bridges included, so the two runs below differ
 * in exactly one key and nothing else.
 *
 * The target is repo-relative and not root-relative. Node ids are repo-relative
 * (docs/05-graph-model.md), and an alias is allowed to point out of its own root, so `apps/mobile/`
 * is part of what the map says rather than something the engine prepends.
 */
function setMobileAliases(aliases: Record<string, string[]> | undefined): void {
  const path = join(repo, ".empo/config.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as {
    roots: { path: string; aliases?: Record<string, string[]> }[];
  };

  const mobile = config.roots.find((root) => root.path === "apps/mobile");
  expect(mobile, "the fixture no longer declares an apps/mobile root").toBeDefined();
  if (mobile === undefined) return;

  if (aliases === undefined) delete mobile.aliases;
  else mobile.aliases = aliases;

  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

describe("a root whose config declares aliases", () => {
  test("resolves an import written through one, with the line the import really sits on", () => {
    writeAliasedScreen();

    // One repository indexed twice, differing in one config key, so what the alias map buys is
    // measured here rather than asserted against a literal the fixture could drift away from.
    // Indexing twice into the same copy is safe: `empo index` is the only writer of
    // `.empo/generated/` and it rewrites the graph whole.
    setMobileAliases(undefined);
    indexCommand(repo);
    const without = graphOnDisk().fanin[MONEY] ?? 0;
    expect(without, "nothing in the fixture imports money.ts any more").toBeGreaterThan(0);

    setMobileAliases({ "@/*": ["apps/mobile/src/*"] });
    indexCommand(repo);
    const graph = graphOnDisk();
    const edge = graph.edges.find(
      (candidate) => candidate.from === RECEIPT_SCREEN && candidate.to === MONEY,
    );

    expect(edge?.kind).toBe("import");
    // The evidence is the import line in the importing file, the same as for a relative import: an
    // alias changes which node the specifier names and nothing about where the coupling is written.
    expect(edge?.evidence.file).toBe(RECEIPT_SCREEN);
    expect(edge?.evidence.line).toBe(lineOf(RECEIPT_SCREEN, ALIAS_IMPORT));

    // And the answer the whole feature exists for: the shared module's fan-in counts this importer
    // now, where before the aliased half of its importers were invisible.
    expect(graph.fanin[MONEY]).toBe(without + 1);
  });

  test("holds no such edge when the config declares no aliases, though the file is right there", () => {
    writeAliasedScreen();
    setMobileAliases(undefined);

    indexCommand(repo);
    const graph = graphOnDisk();

    // The screen is a node either way, so what is absent below is the edge and not a file the
    // scanner never opened. Without this the test would also pass if the alias had broken scanning.
    expect(graph.nodes.some((node) => node.id === RECEIPT_SCREEN)).toBe(true);
    expect(graph.nodes.some((node) => node.id === MONEY)).toBe(true);
    expect(
      graph.edges.some((candidate) => candidate.from === RECEIPT_SCREEN && candidate.to === MONEY),
    ).toBe(false);
    // Nothing is guessed at either: an alias empo was not told about resolves to nothing at all,
    // rather than to some other node whose path happens to end the same way.
    expect(graph.edges.some((candidate) => candidate.from === RECEIPT_SCREEN)).toBe(false);

    // Stated against the file on disk, because the claim is about a key that is not in the config
    // and an assertion about an object this test just wrote would only restate its own helper.
    const written = JSON.parse(readFileSync(join(repo, ".empo/config.json"), "utf8")) as {
      roots: Record<string, unknown>[];
    };
    expect(written.roots.some((root) => "aliases" in root)).toBe(false);
  });

  test("resolves nothing through a pattern the config does not name", () => {
    // The rule the resolver's docstring states as the reason there is no fallthrough: an edge the
    // compiler would never have loaded is worse than a missing one. Here the map answers about
    // `~/`, the import is written through `@/`, and no rule matches, so the specifier stays what it
    // looks like to every other rule in the resolver, a package name.
    writeAliasedScreen();
    setMobileAliases({ "~/*": ["apps/mobile/src/*"] });

    indexCommand(repo);

    expect(
      graphOnDisk().edges.some(
        (candidate) => candidate.from === RECEIPT_SCREEN && candidate.to === MONEY,
      ),
    ).toBe(false);
  });
});
