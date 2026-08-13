import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildRoot, dedupeEdges, dedupeNodes } from "../../src/engine/build";
import { loadPack } from "../../src/engine/pack-loader";
import type { GraphEdge, GraphNode, Pack } from "../../src/schema/types";

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));
const symbolFixture = fileURLToPath(new URL("../../fixtures/symbol-fixture", import.meta.url));

/**
 * The two rules `build.ts` applies on behalf of every caller (docs/14-implementation-notes.md):
 * one node per id, and one edge per (from, to, kind) with the earliest evidence winning.
 */

function node(id: string, file: string): GraphNode {
  return {
    id,
    file,
    root: "apps/api",
    lang: "php",
    kind: "class",
    name: id,
    produces: [],
    consumes: [],
    isTest: false,
    assertsValue: false,
  };
}

function edge(from: string, to: string, file: string, line: number): GraphEdge {
  return { from, to, kind: "import", symbol: null, evidence: { file, line } };
}

describe("dedupeEdges", () => {
  test("keeps one edge per pair and kind, with the earliest evidence", () => {
    const first = edge("OrderController", "Calculator", "a/OrderController.php", 5);
    const later = edge("OrderController", "Calculator", "a/OrderController.php", 40);

    expect(dedupeEdges([later, first])).toEqual([first]);
  });

  test("keeps two edges between one pair when the kinds differ", () => {
    // An import and a bridge between the same two files are two different couplings.
    const imported = edge("client", "routes", "apps/mobile/client.ts", 2);
    const bridged: GraphEdge = {
      from: "client",
      to: "routes",
      kind: "bridge",
      symbol: "http-route",
      evidence: { file: "apps/mobile/client.ts", line: 9 },
    };

    expect(dedupeEdges([imported, bridged])).toHaveLength(2);
  });

  test("does not merge two edges whose ids differ only in where a space falls", () => {
    // A node id can be a path, and a path can hold a space, so a key joined on a space would read
    // both of these as "a b c import" and drop one real coupling. Joined on a NUL they stay two.
    const edges = [edge("a b", "c", "a b.ts", 1), edge("a", "b c", "a.ts", 1)];

    expect(dedupeEdges(edges)).toHaveLength(2);
  });
});

describe("dedupeNodes", () => {
  test("keeps the file that sorts first and reports the collision rather than throwing", () => {
    const kept = node("Acme\\Models\\Order", "apps/api/app/Models/Order.php");
    const dropped = node("Acme\\Models\\Order", "apps/api/stubs/Models/Order.php");

    const result = dedupeNodes([dropped, kept]);

    expect(result.nodes).toEqual([kept]);
    expect(result.duplicates).toEqual([
      {
        id: "Acme\\Models\\Order",
        files: ["apps/api/app/Models/Order.php", "apps/api/stubs/Models/Order.php"],
      },
    ]);
  });

  test("keeps the most specific root's node when two roots scanned the same file", () => {
    // Roots "." and "apps/api" both reach apps/api/tests/Feature/OrderTest.php. The php pack asks
    // whether the path relative to the root starts with "tests/", which is true under apps/api and
    // false under ".", so the same file arrives twice with the same id and a different isTest.
    // Sorting on `file` alone ties, and the outer root would win and demote a real test.
    const file = "apps/api/tests/Feature/OrderTest.php";
    const outer: GraphNode = { ...node("Acme\\Tests\\OrderTest", file), root: "." };
    const nested: GraphNode = { ...node("Acme\\Tests\\OrderTest", file), isTest: true };

    for (const bucket of [
      [outer, nested],
      [nested, outer],
    ]) {
      const result = dedupeNodes(bucket);

      expect(result.nodes).toEqual([nested]);
      expect(result.duplicates).toEqual([{ id: "Acme\\Tests\\OrderTest", files: [file, file] }]);
    }
  });
});

describe("buildRoot", () => {
  /**
   * Every node's `root` and its `file` are the configured root path written twice, and the engine
   * compares the first by string equality (engine/bridger.ts probes a bridge's declared roots with
   * it, engine/coverage.ts asks whether two nodes share one) while it prefix-matches the second. A
   * root that reaches the scanner without passing through the config schema's transform is not
   * hypothetical: commands/pack.ts builds one by hand today. So these spellings are asserted against
   * the flattened one rather than against each other, which would also pass if neither normalized.
   */
  test.each([["apps/api/"], ["./apps/api"], ["./apps/api/"], ["apps/api"]])(
    "gives a node built from the hand-written root %j the same root string as its file",
    (path) => {
      const graph = buildRoot({
        repoRoot: fixture,
        root: { path, lang: "php" },
        pack: loadPack("php"),
      });

      expect(graph.nodes.length).toBeGreaterThan(0);
      expect([...new Set(graph.nodes.map((node) => node.root))]).toEqual(["apps/api"]);
      expect(graph.nodes.every((node) => node.file.startsWith("apps/api/"))).toBe(true);
      expect(graph.files).toEqual(graph.files.filter((file) => file.startsWith("apps/api/")));
    },
  );

  /**
   * A pack the engine cannot honour is refused even when the root holds nothing it would have read.
   *
   * This is the case the old refusal could not reach. It lived in `identify`, one call per scanned
   * file, so a root whose `match.extensions` selected no file skipped the whole extraction loop:
   * `buildRoot` returned an empty `RootGraph`, nothing downstream refuses one, and `empo index`
   * reported the root as a success with the strategy it declared never looked at.
   *
   * It is pinned here and not beside the strategy's own test in test/engine/extractor.test.ts,
   * because compiling is not what was broken. `compilePack` never reads `match.extensions` at all,
   * so a test that calls it directly with an extension matching nothing exercises the same line as
   * a test that does not, and would pass whether or not the defect was ever fixed. The scan is what
   * has to run for the claim to mean anything, which makes this a `buildRoot` test.
   */
  test("refuses a pack declaring an incomplete id strategy even when the root matches no file", () => {
    const pack = loadPack("php");

    expect(() =>
      buildRoot({
        repoRoot: fixture,
        root: { path: "apps/api", lang: "php" },
        pack: {
          ...pack,
          node: { ...pack.node, id: { strategy: "symbol" } },
          match: { extensions: [".nothing-here"] },
        },
      }),
    ).toThrow(/symbolPattern/);
  });
});

/**
 * What a root looks like when its pack identifies a node by an export rather than by a file.
 *
 * Built from the shipped TypeScript pack with its `node.id` block replaced by a pattern of this
 * file's own, so the engine stays under test here rather than the shipped pack's pattern, which
 * `test/packs/typescript.test.ts` gates. The fixture is
 * `fixtures/symbol-fixture`, four files written so each case is visible at once: a file exporting
 * two names, a file importing one of them by name, a file importing the same module for its side
 * effects, and a file exporting nothing.
 */
describe("the symbol id strategy", () => {
  const SYMBOL_PATTERN =
    "^export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|const|let|var|type|interface|enum)\\s+([A-Za-z_$][A-Za-z0-9_$]*)";

  const symbolGraph = () => {
    const pack = loadPack("typescript");
    const symbolPack: Pack = {
      ...pack,
      node: {
        ...pack.node,
        id: { strategy: "symbol", symbolPattern: SYMBOL_PATTERN, indexNames: ["index"] },
      },
    };
    return buildRoot({
      repoRoot: symbolFixture,
      root: { path: ".", lang: "typescript" },
      pack: symbolPack,
    });
  };

  test("yields one node per exported symbol and no node for the file itself", () => {
    const ids = symbolGraph().nodes.map((node) => node.id);

    expect(ids).toContain("src/money.ts#formatMoney");
    expect(ids).toContain("src/money.ts#parseMoney");
    expect(ids).not.toContain("src/money.ts");
  });

  test("yields one node for a name declared twice, and gives it every one of its extents", () => {
    // src/merged.ts merges a type and a function under `Handler` with an unrelated export written
    // between them. Both halves open a boundary, so the function body is its own extent and not the
    // tail of HANDLER_NAME's, and the two extents fold back into the single node the id names.
    const graph = symbolGraph();
    const ids = graph.nodes.filter((node) => node.file === "src/merged.ts").map((node) => node.id);

    expect(ids).toEqual(["src/merged.ts#HANDLER_NAME", "src/merged.ts#Handler"]);
    // Two extents of one id are not two files claiming one id, so nothing here is a duplicate.
    expect(graph.duplicates).toEqual([]);
    expect(graph.edges.filter((edge) => edge.from === "src/merged.ts#Handler")).toHaveLength(1);
    expect(graph.edges.filter((edge) => edge.from === "src/merged.ts#HANDLER_NAME")).toEqual([]);
  });

  test("yields the file node for a file that exports nothing", () => {
    // The strategy narrows what a node is where it can and never invents one: a file whose pattern
    // matched nothing keeps exactly the node its path already named.
    expect(symbolGraph().nodes.map((node) => node.id)).toContain("src/setup.test.ts");
  });

  test("points an import at the symbol it names and at nothing else", () => {
    const targets = symbolGraph()
      .edges.filter((edge) => edge.from === "src/total.ts#total")
      .map((edge) => edge.to);

    expect(targets).toEqual(["src/money.ts#formatMoney"]);
  });

  test("points a side-effect import at every symbol of the module it runs", () => {
    // It binds no name, so nothing in the importing file can say which export it needed, and the
    // whole module is the honest answer.
    const targets = symbolGraph()
      .edges.filter((edge) => edge.from === "src/boot.ts#start")
      .map((edge) => edge.to);

    expect(targets).toEqual(["src/money.ts#formatMoney", "src/money.ts#parseMoney"]);
  });

  test("names the export on the node and the file it came out of", () => {
    const node = symbolGraph().nodes.find(
      (candidate) => candidate.id === "src/money.ts#parseMoney",
    );

    expect(node?.symbol).toBe("parseMoney");
    expect(node?.name).toBe("parseMoney");
    expect(node?.file).toBe("src/money.ts");
  });

  test("leaves the symbol field off a file-level node", () => {
    // A pack that never asked for per-export ids must not carry the key in its graph.json. The
    // shipped TypeScript pack declares `symbol` now, so the control is that same pack with its
    // `node.id` block put back the way it read before: this asserts the absence of the key is a
    // property of the strategy and not of the language, which is what a reader of a `fqcn` or
    // `module-path` graph is owed.
    const pack = loadPack("typescript");
    const graph = buildRoot({
      repoRoot: symbolFixture,
      root: { path: ".", lang: "typescript" },
      pack: {
        ...pack,
        node: { ...pack.node, id: { strategy: "module-path", indexNames: ["index"] } },
      },
    });

    expect(graph.nodes.map((node) => node.id)).toContain("src/money.ts");
    expect(graph.nodes.every((node) => !("symbol" in node))).toBe(true);
  });
});

/**
 * Every text file this repository writes, not only its TypeScript.
 *
 * The roots and extensions are declared rather than globbed from one pattern, so that adding a root
 * is a deliberate line and a root that stops matching anything fails loudly on its own floor rather
 * than quietly contributing nothing.
 */
const TEXT_ROOTS = [
  { path: "../../src", extensions: [".ts", ".json", ".md"], least: 30 },
  { path: "../../docs", extensions: [".md"], least: 10 },
  { path: "../../test", extensions: [".ts"], least: 30 },
  // README.md, CLAUDE.md and AGENTS.md, so the floor sits one below the three that exist today
  // rather than at them: this number guards against a walker matching nothing, and pinning it to
  // the exact count would turn adding a fourth root-level doc into an unrelated red.
  { path: "../..", extensions: [".md"], least: 2, topLevelOnly: true },
];

describe("the text this repository writes", () => {
  test("holds no raw NUL byte in any file, so git diffs them and grep reports them", () => {
    // build.ts did, for one commit: the dedupe key's separators were written as literal NULs, git
    // called the file binary, and every change to it stopped being reviewable. A tool whose whole
    // promise is a citation somebody can go and read cannot have a file nobody can diff.
    //
    // Every file rather than this one, because repairing build.ts alone left the identical key in
    // engine/proposal.ts standing, pinned by nothing, and that one was worse than the first: its
    // NUL sits past the 8000 bytes git sniffs, so git kept diffing the file as text and only grep
    // went quiet on it. A reviewer greps for a symbol, reads no hit, and concludes the code is not
    // there. So the claim is about the tree, and the next instance cannot land in a file this test
    // did not know to name.
    //
    // Widened past `src/**/*.ts` after the same escape turned back into a real byte three times
    // over, and only one of the three was anywhere this test could see. The
    // cause is not carelessness and will not be trained away: the tool that writes a file can
    // transform what was typed, so the escape is correct in the author's hands and a raw byte on
    // disk. It reached `docs/` and files outside the repository, while this walker read only
    // TypeScript under `src/` and stayed green through all of it.
    //
    // Markdown belongs here as much as source. A doc is this project's stated source of truth, and
    // one that grep will not search is worse than a doc that is merely wrong: a reader greps for a
    // heading, gets nothing, and concludes the section was never written.
    const offenders: string[] = [];

    for (const root of TEXT_ROOTS) {
      const dir = fileURLToPath(new URL(root.path, import.meta.url));
      const entries = readdirSync(dir, {
        recursive: root.topLevelOnly !== true,
        encoding: "utf8",
      })
        .filter((entry) => root.extensions.some((extension) => entry.endsWith(extension)))
        // The repository root walks one level deep on purpose: recursing it would descend into
        // node_modules and dist, which are neither written here nor reviewed here.
        .filter((entry) => root.topLevelOnly !== true || !entry.includes("/"))
        .sort();

      // A walker that found nothing would pass the claim below without reading a single byte, and
      // it is per root: one root silently matching nothing is exactly how a widening gets undone.
      expect(entries.length, `${root.path} matched nothing, so it proves nothing`).toBeGreaterThan(
        root.least,
      );

      for (const entry of entries) {
        if (readFileSync(join(dir, entry)).includes(0)) offenders.push(`${root.path}/${entry}`);
      }
    }

    // Named rather than counted, because the whole failure of a raw NUL is that searching for it
    // finds nothing, so a red that says "1 file" would send a reader back to the tool that hides it.
    expect(offenders).toEqual([]);
  });
});
