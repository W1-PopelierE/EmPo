import { describe, expect, test } from "vitest";
import { GRAPH_SCHEMA } from "../../src/engine/graph";
import { claims, kindAxes, kindKey } from "../../src/engine/kinds";
import type { Graph } from "../../src/schema/types";

/**
 * The two axes a pack declares over kinds, and the keying that keeps two packs from being read as
 * one. The marks themselves are the packs' data and are pinned in test/packs/php.test.ts against
 * the real `loadPack`; what is asserted here is what this module does with them.
 *
 * The graphs are the smallest thing `kindAxes` reads, which is `roots` alone: it never looks at a
 * node, because the question is which kinds a language marks and not which kinds a graph happens to
 * hold.
 */

function graphWithRoots(roots: { path: string; lang: string }[]): Graph {
  return {
    schema: GRAPH_SCHEMA,
    builtAgainst: "",
    builtAtCommitSubject: "",
    roots,
    packs: {},
    stats: { files: 0, nodes: 0, edges: 0, bridgedEdges: 0 },
    nodes: [],
    edges: [],
    flows: {},
    fanin: {},
    coverage: {},
    hazards: [],
    hazardsScanned: [],
    names: [],
    fanout: [],
    permanentFailures: [],
  };
}

describe("the kind axes", () => {
  test("reads both axes off one rule, so a route file is resolved and arrived at", () => {
    // The php pack marks its route-file rule with both. Neither can be derived from the other:
    // the framework reaches the file by name, so its fan-in says nothing about whether it is dead,
    // and a user walks in through it, so a journey starts there. `empo query --orphans` reads the
    // first and `empo init`'s brief reads the second, off the same line of pack.json.
    const axes = kindAxes(graphWithRoots([{ path: "apps/api", lang: "php" }]));

    expect(claims(axes.frameworkResolved, { lang: "php", kind: "route-file" })).toBe(true);
    expect(claims(axes.userArrived, { lang: "php", kind: "route-file" })).toBe(true);
  });

  test("keeps framework-resolved and arrived-at apart", () => {
    // A view is reached by name and nobody arrives at one: it is rendered by a controller the user
    // already reached. So it is hidden from the brief and excluded from --orphans, which is the
    // one kind combination that separates the two axes.
    const axes = kindAxes(graphWithRoots([{ path: "apps/api", lang: "php" }]));

    expect(claims(axes.frameworkResolved, { lang: "php", kind: "view" })).toBe(true);
    expect(claims(axes.userArrived, { lang: "php", kind: "view" })).toBe(false);
  });

  test("a plain class carries neither mark, and neither does an unknown kind", () => {
    const axes = kindAxes(graphWithRoots([{ path: "apps/api", lang: "php" }]));

    expect(claims(axes.frameworkResolved, { lang: "php", kind: "class" })).toBe(false);
    expect(claims(axes.userArrived, { lang: "php", kind: "class" })).toBe(false);
    expect(claims(axes.userArrived, { lang: "php", kind: "invented" })).toBe(false);
  });

  test("keys by language, so one pack's marks never answer for another's kind", () => {
    // Two packs may each declare a kind called `config` and mean unrelated things by it. The
    // typescript pack marks nothing at all, so a graph holding both roots must still answer false
    // for every typescript kind while answering true for php's.
    const axes = kindAxes(
      graphWithRoots([
        { path: "apps/api", lang: "php" },
        { path: "apps/portal", lang: "typescript" },
      ]),
    );

    expect(claims(axes.frameworkResolved, { lang: "php", kind: "view" })).toBe(true);
    expect(claims(axes.frameworkResolved, { lang: "typescript", kind: "view" })).toBe(false);
    expect(claims(axes.userArrived, { lang: "typescript", kind: "component" })).toBe(false);
  });

  test("the typescript pack marks no arrival at all, which is a decision and not an oversight", () => {
    // A fork somebody chose deliberately: no typescript
    // kind is framework-resolved, so the brief subtracts nothing there anyway, and marking `screen`
    // would be a claim about a router this pack cannot see, where a wrong claim ranks a file above
    // a real route. Asserted over every rule rather than over the kinds that exist today, so
    // marking any of them turns this red and whoever does it has to reopen the decision.
    const axes = kindAxes(graphWithRoots([{ path: "apps/portal", lang: "typescript" }]));

    expect(axes.userArrived.size).toBe(0);
    expect(axes.frameworkResolved.size).toBe(0);
  });

  test("the key joins on a tab, which no language or kind name may contain", () => {
    // A space would collapse distinct pairs the moment a kind name held one, which is the same
    // rule the graph's dedupe keys follow with their NUL byte.
    expect(kindKey("php", "route-file")).toBe("php\troute-file");
  });
});
