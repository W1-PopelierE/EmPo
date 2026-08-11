import { describe, expect, test } from "vitest";
import type { Capture, ExtractedFile } from "../../src/engine/extractor";
import {
  buildNodeIndex,
  compileAliases,
  normalizeFqcn,
  type ResolveContext,
  resolveEdges,
} from "../../src/engine/resolver";
import { EmpoError } from "../../src/errors";
import type { ResolveStrategy } from "../../src/schema/types";

/**
 * The resolver takes raw captures and a node index and returns edges, so its inputs are plain
 * data: the files below are hand-made rather than extracted, per docs/14-implementation-notes.md.
 */

/** What each pack's node.id declares, which is all the resolver reads of a pack. */
const PHP: ResolveContext = { extensions: [".php"], indexNames: [] };
const TS: ResolveContext = { extensions: [".ts", ".tsx"], indexNames: ["index"] };

function node(id: string, name: string, filePath: string, captures: Capture[] = []): ExtractedFile {
  return {
    file: filePath,
    root: ".",
    lang: "php",
    id,
    name,
    kind: "class",
    isTest: false,
    assertsValue: false,
    produces: [],
    consumes: [],
    captures,
    declares: [],
    // The resolver reads neither, but an ExtractedFile carries them, and a hand-made one that
    // omitted them would stop compiling rather than quietly resolve differently.
    dispatches: [],
    defersCommit: false,
  };
}

/** A module-path node, whose id is its repo-relative path. */
function module_(filePath: string, captures: Capture[] = []): ExtractedFile {
  const name = (filePath.split("/").pop() ?? filePath).replace(/\.[^.]+$/, "");
  return { ...node(filePath, name, filePath, captures), lang: "typescript", kind: "module" };
}

/** An `import` capture, as the typescript pack's `import ... from "..."` rule produces it. */
function specifierCapture(specifier: string, line: number): Capture {
  return {
    family: "import",
    resolve: "module-path",
    groups: [`import x from "${specifier}"`, specifier],
    line,
  };
}

/** An `import` capture, as the php pack's `use ...;` rule produces it. */
function importCapture(target: string, line: number): Capture {
  return { family: "import", resolve: "fqcn", groups: [`use ${target};`, target], line };
}

/** A `hook` capture, as the php pack's `X::observe(Y::class)` rule produces it. */
function observerCapture(observed: string, listener: string, line: number): Capture {
  return {
    family: "hook",
    resolve: "observer",
    groups: [`${observed}::observe(${listener}::class`, observed, listener],
    line,
  };
}

/**
 * A `template` capture, as the php pack's `<x-...>` rule produces it. Group 1 is already the class
 * name because the rule's `normalize` list ran in the extractor; group 0 is the tag as written,
 * which no strategy reads and which is kept unnormalized for exactly that reason.
 */
function shortNameCapture(name: string, line: number): Capture {
  return { family: "template", resolve: "short-name", groups: [`<x-${name}`, name], line };
}

describe("normalizeFqcn", () => {
  test("collapses the doubled backslashes a quoted class name carries", () => {
    expect(normalizeFqcn("Acme\\\\Models\\\\Order")).toBe("Acme\\Models\\Order");
  });

  test("strips a leading separator", () => {
    expect(normalizeFqcn("\\Acme\\Models\\Order")).toBe("Acme\\Models\\Order");
  });
});

describe("resolveEdges", () => {
  test("drops an edge whose target is not a node in the index", () => {
    // A vendor import is not a coupling this repository can break.
    const controller = node(
      "Acme\\Http\\Controllers\\OrderController",
      "OrderController",
      "app/Http/Controllers/OrderController.php",
      [importCapture("Illuminate\\Support\\Facades\\Route", 5)],
    );
    const index = buildNodeIndex([controller]);

    expect(resolveEdges(controller, index, PHP).edges).toEqual([]);
  });

  test("does not create an edge from a node to itself", () => {
    const order = node("Acme\\Models\\Order", "Order", "app/Models/Order.php", [
      importCapture("Acme\\Models\\Order", 5),
    ]);
    const index = buildNodeIndex([order]);

    expect(resolveEdges(order, index, PHP).edges).toEqual([]);
  });

  test("runs a hook edge from the observed node to its listener, evidence on the registrar", () => {
    const order = node("Acme\\Models\\Order", "Order", "app/Models/Order.php");
    const observer = node(
      "Acme\\Observers\\OrderObserver",
      "OrderObserver",
      "app/Observers/OrderObserver.php",
    );
    const provider = node(
      "Acme\\Providers\\AppServiceProvider",
      "AppServiceProvider",
      "app/Providers/AppServiceProvider.php",
      [observerCapture("Order", "OrderObserver", 12)],
    );
    const index = buildNodeIndex([order, observer, provider]);

    expect(resolveEdges(provider, index, PHP).edges).toEqual([
      {
        from: "Acme\\Models\\Order",
        to: "Acme\\Observers\\OrderObserver",
        kind: "hook",
        symbol: null,
        evidence: { file: "app/Providers/AppServiceProvider.php", line: 12 },
      },
    ]);
  });

  test("creates no hook edge when the observed short name is ambiguous", () => {
    const order = node("Acme\\Models\\Order", "Order", "app/Models/Order.php");
    const otherOrder = node("Acme\\Support\\Order", "Order", "app/Support/Order.php");
    const observer = node(
      "Acme\\Observers\\OrderObserver",
      "OrderObserver",
      "app/Observers/OrderObserver.php",
    );
    const provider = node(
      "Acme\\Providers\\AppServiceProvider",
      "AppServiceProvider",
      "app/Providers/AppServiceProvider.php",
      [observerCapture("Order", "OrderObserver", 12)],
    );
    const index = buildNodeIndex([order, otherOrder, observer, provider]);

    expect(resolveEdges(provider, index, PHP).edges).toEqual([]);
  });

  test("runs a template edge from the file that wrote the tag to the class it names", () => {
    // The blade-to-class edge. The capture arrives already normalized, because the pack's
    // `normalize` list ran in the extractor: the tag said `<x-price-badge>` and the resolver is
    // handed `PriceBadge`, so nothing about Blade's spelling reaches this code.
    const badge = node(
      "Acme\\View\\Components\\PriceBadge",
      "PriceBadge",
      "app/View/Components/PriceBadge.php",
    );
    const view = node(
      "resources/views/orders/show.blade.php",
      "show.blade",
      "resources/views/orders/show.blade.php",
      [shortNameCapture("PriceBadge", 11)],
    );
    const index = buildNodeIndex([badge, view]);

    expect(resolveEdges(view, index, PHP).edges).toEqual([
      {
        from: "resources/views/orders/show.blade.php",
        to: "Acme\\View\\Components\\PriceBadge",
        kind: "template",
        symbol: null,
        evidence: { file: "resources/views/orders/show.blade.php", line: 11 },
      },
    ]);
  });

  test("creates no template edge when the short name is ambiguous", () => {
    // `<x-forms.text-input>` and `<x-fields.text-input>` both fold to TextInput once the namespace
    // segment is dropped, which is the commonest shape a real component library has. The refusal is
    // inherited from `observer` rather than re-implemented, so the two can never drift apart: a
    // guessed edge would put a wrong file:line in front of a reader, which is worse than an absence.
    const forms = node(
      "Acme\\View\\Components\\Forms\\TextInput",
      "TextInput",
      "app/View/Components/Forms/TextInput.php",
    );
    const fields = node(
      "Acme\\View\\Components\\Fields\\TextInput",
      "TextInput",
      "app/View/Components/Fields/TextInput.php",
    );
    const view = node(
      "resources/views/form.blade.php",
      "form.blade",
      "resources/views/form.blade.php",
      [shortNameCapture("TextInput", 4)],
    );
    const index = buildNodeIndex([forms, fields, view]);

    expect(resolveEdges(view, index, PHP).edges).toEqual([]);
  });

  test("creates no template edge when the short name is in no node", () => {
    // A vendor component, or a Blade built-in like `<x-slot>`. Same rule as everywhere else: a
    // capture that names nothing this graph holds is not a coupling this repository can break.
    const view = node(
      "resources/views/form.blade.php",
      "form.blade",
      "resources/views/form.blade.php",
      [shortNameCapture("Slot", 4)],
    );

    expect(resolveEdges(view, buildNodeIndex([view]), PHP).edges).toEqual([]);
  });

  test("creates no template edge from a file to itself", () => {
    const view = node("Acme\\View\\Components\\Card", "Card", "app/View/Components/Card.php", [
      shortNameCapture("Card", 9),
    ]);

    expect(resolveEdges(view, buildNodeIndex([view]), PHP).edges).toEqual([]);
  });

  test("fails with exit code 2 on a resolve strategy the engine has not implemented", () => {
    const unimplemented: ResolveStrategy[] = ["view"];

    for (const resolve of unimplemented) {
      const importer = node("Acme\\Thing", "Thing", "app/Thing.php", [
        { family: "import", resolve, groups: ["./other", "./other"], line: 3 },
      ]);
      const index = buildNodeIndex([importer]);

      try {
        resolveEdges(importer, index, PHP);
        expect.unreachable(`expected "${resolve}" to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(EmpoError);
        expect((error as EmpoError).exitCode).toBe(2);
        expect((error as EmpoError).message).toContain(resolve);
      }
    }
  });
});

/**
 * The strategy the typescript pack brought. Everything it knows about a language comes from the
 * ResolveContext, so the same code resolves a Python `__init__` the day a python pack declares it.
 */
describe("resolveEdges, module-path", () => {
  const screen = "apps/mobile/src/screens/OrderScreen.tsx";

  function graph(importer: ExtractedFile, ...others: string[]) {
    const files = [importer, ...others.map((path) => module_(path))];
    return { importer, index: buildNodeIndex(files) };
  }

  test("resolves a relative specifier against the file that wrote it", () => {
    const { importer, index } = graph(
      module_(screen, [specifierCapture("../shared/money", 3)]),
      "apps/mobile/src/shared/money.ts",
    );

    expect(resolveEdges(importer, index, TS).edges).toEqual([
      {
        from: screen,
        to: "apps/mobile/src/shared/money.ts",
        kind: "import",
        symbol: null,
        evidence: { file: screen, line: 3 },
      },
    ]);
  });

  test("resolves a directory through the pack's indexNames", () => {
    const { importer, index } = graph(
      module_(screen, [specifierCapture("../components", 4)]),
      "apps/mobile/src/components/index.ts",
    );

    expect(resolveEdges(importer, index, TS).edges[0]?.to).toBe(
      "apps/mobile/src/components/index.ts",
    );
  });

  test("does not resolve a directory when the pack declares no indexNames", () => {
    const { importer, index } = graph(
      module_(screen, [specifierCapture("../components", 4)]),
      "apps/mobile/src/components/index.ts",
    );

    expect(
      resolveEdges(importer, index, { extensions: [".ts", ".tsx"], indexNames: [] }).edges,
    ).toEqual([]);
  });

  test("prefers the pack's extensions in declared order", () => {
    const { importer, index } = graph(
      module_(screen, [specifierCapture("../components/PriceRow", 4)]),
      "apps/mobile/src/components/PriceRow.ts",
      "apps/mobile/src/components/PriceRow.tsx",
    );

    expect(resolveEdges(importer, index, TS).edges[0]?.to).toBe(
      "apps/mobile/src/components/PriceRow.ts",
    );
  });

  test("resolves a specifier that already names the file", () => {
    const { importer, index } = graph(
      module_(screen, [specifierCapture("./OrderScreen.styles.ts", 4)]),
      "apps/mobile/src/screens/OrderScreen.styles.ts",
    );

    expect(resolveEdges(importer, index, TS).edges[0]?.to).toBe(
      "apps/mobile/src/screens/OrderScreen.styles.ts",
    );
  });

  test("resolves an import that crosses a root, because ids are repo-relative", () => {
    // The monorepo case: the app imports a package that is its own root, and that is a coupling
    // a change to the package can break.
    const { importer, index } = graph(
      module_(screen, [specifierCapture("../../../../packages/ui/src/Button", 5)]),
      "packages/ui/src/Button.tsx",
    );

    expect(resolveEdges(importer, index, TS).edges[0]?.to).toBe("packages/ui/src/Button.tsx");
  });

  test("drops a bare specifier, which names a package and not a file here", () => {
    const { importer, index } = graph(
      module_(screen, [specifierCapture("react", 1), specifierCapture("@acme/ui", 2)]),
      "apps/mobile/src/shared/money.ts",
    );

    expect(resolveEdges(importer, index, TS).edges).toEqual([]);
  });

  test("drops a specifier that climbs above the repository root", () => {
    const { importer, index } = graph(
      module_("src/app.ts", [specifierCapture("../../elsewhere/money", 1)]),
      "src/shared/money.ts",
    );

    expect(resolveEdges(importer, index, TS).edges).toEqual([]);
  });

  test("drops a specifier that resolves to no file in the graph", () => {
    const { importer, index } = graph(module_(screen, [specifierCapture("./Missing", 1)]));

    expect(resolveEdges(importer, index, TS).edges).toEqual([]);
  });
});

/**
 * The alias half of `module-path`: the one bare-looking specifier that does name a file in this
 * repository, and the root's config is the only thing that can say which.
 *
 * Before `roots[].aliases` existed every one of these resolved to nothing, silently, so a file most
 * of whose importers write `@/lib/money` reported the fan-in of the few that happened to write
 * `../lib/money`. That is a wrong answer rather than a narrow one, which is why the cases below are
 * about what is *not* resolved at least as much as about what is.
 */
describe("resolveEdges, module-path through a root's aliases", () => {
  const screen = "apps/portal/src/screens/OrderScreen.tsx";

  /** The typescript pack's context plus one root's alias map, compiled the way build.ts compiles it. */
  function withAliases(aliases: Record<string, string[]>): ResolveContext {
    return { ...TS, aliases: compileAliases(aliases) };
  }

  function graph(importer: ExtractedFile, ...others: string[]) {
    const files = [importer, ...others.map((path) => module_(path))];
    return { importer, index: buildNodeIndex(files) };
  }

  test("resolves a wildcard alias to the file it names, with the importer's evidence", () => {
    // The target is repo-relative and points out of the importer's own root, which is the shape
    // config `aliases` is documented to have: a node id is repo-relative, so a target that had to
    // be joined to a root first would be a third path form in a codebase that documents two.
    const { importer, index } = graph(
      module_(screen, [specifierCapture("@/lib/money", 3)]),
      "src/lib/money.ts",
    );

    expect(resolveEdges(importer, index, withAliases({ "@/*": ["src/*"] })).edges).toEqual([
      {
        from: screen,
        to: "src/lib/money.ts",
        kind: "import",
        symbol: null,
        // Evidence stays on the file that wrote the import, exactly as a relative specifier's does.
        // An alias changes where the target is, never who is coupled to it.
        evidence: { file: screen, line: 3 },
      },
    ]);
  });

  test("resolves nothing for a root that declares no aliases", () => {
    // The regression guard for every repository that existed before this field did. `@/lib/money`
    // is a package specifier to a resolver with no map, and nothing here may guess a target out of
    // the node index just because one happens to look like it fits.
    const { importer, index } = graph(
      module_(screen, [specifierCapture("@/lib/money", 3)]),
      "src/lib/money.ts",
    );

    expect(resolveEdges(importer, index, TS).edges).toEqual([]);
    expect(resolveEdges(importer, index, withAliases({})).edges).toEqual([]);
    // The absent field compiles to no rules at all rather than to something a `find` could match.
    expect(compileAliases(undefined)).toEqual([]);
  });

  test("probes extensions and indexNames against an alias target, as against a relative path", () => {
    // Same probing order as `./lib`: the bare path, then each declared extension, then each index
    // name under it. A target reached through an alias is a path like any other once substituted.
    const { importer, index } = graph(
      module_(screen, [specifierCapture("@/lib", 4), specifierCapture("@/money", 5)]),
      "src/lib/index.ts",
      "src/money.ts",
    );

    expect(
      resolveEdges(importer, index, withAliases({ "@/*": ["src/*"] })).edges.map((e) => e.to),
    ).toEqual(["src/lib/index.ts", "src/money.ts"]);
  });

  test("resolves an exact pattern, which matches one specifier and substitutes nothing", () => {
    const { importer, index } = graph(
      module_(screen, [specifierCapture("@config", 1), specifierCapture("@config/dev", 2)]),
      "src/config/index.ts",
    );

    // Only the first capture resolves: an exact pattern is not a prefix, so `@config/dev` is a
    // package specifier again and gets the answer every unmapped specifier gets.
    expect(
      resolveEdges(importer, index, withAliases({ "@config": ["src/config"] })).edges.map(
        (e) => e.to,
      ),
    ).toEqual(["src/config/index.ts"]);
  });

  test("matches an exact pattern before a wildcard, and a longer wildcard prefix before a shorter", () => {
    const rules = compileAliases({
      "@/*": ["src/wide/*"],
      "@/lib/money": ["src/exact/money.ts"],
      "@/lib/*": ["src/lib/*"],
    });

    // Asserted on the compiled list as well as on the resolution below, because either could be
    // reordered on its own: a `find` over a differently sorted list resolves a real import to a
    // different file than the toolchain compiles, and nothing downstream would look wrong.
    expect(rules.map((rule) => rule.prefix)).toEqual(["@/lib/money", "@/lib/", "@/"]);
    expect(rules.map((rule) => rule.wildcard)).toEqual([false, true, true]);

    // Exact-before-wildcard is its own term in the sort and is pinned separately here, because for
    // any one specifier the two terms cannot disagree: a wildcard that matches a specifier holds
    // strictly less literal text than an exact pattern equal to it, so the length term alone would
    // order that pair the same way. This is the case where they do differ, and it is tsconfig's
    // documented rule, so the compiled order is where it can be held to.
    expect(
      compileAliases({ "@components/*": ["src/components/*"], "@db": ["src/db.ts"] }).map(
        (rule) => rule.prefix,
      ),
    ).toEqual(["@db", "@components/"]);

    const { importer, index } = graph(
      module_(screen, [
        specifierCapture("@/lib/money", 1),
        specifierCapture("@/lib/format", 2),
        specifierCapture("@/banner", 3),
      ]),
      "src/exact/money.ts",
      "src/lib/format.ts",
      "src/wide/banner.ts",
      // The file the widest pattern would have claimed for `@/lib/money` had specificity not won.
      "src/wide/lib/money.ts",
    );

    expect(
      resolveEdges(importer, index, { ...TS, aliases: rules }).edges.map((edge) => edge.to),
    ).toEqual(["src/exact/money.ts", "src/lib/format.ts", "src/wide/banner.ts"]);
  });

  test("tries only the best-matching pattern, and never falls through to a less specific one", () => {
    // Deliberate, and the decision this test exists to pin. `@/lib/*` is the pattern that matches,
    // its targets name no node, and `@/*` would have hit src/lib/money.ts. An edge the toolchain
    // would never have loaded is worse than a missing one: a blast radius is read as a floor, and a
    // floor made of invented couplings is not one.
    const { importer, index } = graph(
      module_(screen, [specifierCapture("@/lib/money", 2)]),
      "src/lib/money.ts",
    );

    expect(
      resolveEdges(
        importer,
        index,
        withAliases({ "@/lib/*": ["packages/lib/*"], "@/*": ["src/*"] }),
      ).edges,
    ).toEqual([]);
    // The less specific pattern really would have resolved, so the empty answer above is a refusal
    // and not a miss. Without this line the test would pass against a resolver that had simply
    // stopped resolving aliases at all.
    expect(resolveEdges(importer, index, withAliases({ "@/*": ["src/*"] })).edges[0]?.to).toBe(
      "src/lib/money.ts",
    );
  });

  test("tries one pattern's targets in declared order, first hit wins", () => {
    const { importer, index } = graph(
      module_(screen, [specifierCapture("@/Button", 1)]),
      "packages/ui/Button.tsx",
      "src/Button.tsx",
    );

    expect(
      resolveEdges(importer, index, withAliases({ "@/*": ["packages/ui/*", "src/*"] })).edges[0]
        ?.to,
    ).toBe("packages/ui/Button.tsx");
    // Reversed the other one wins, so the winner is the config's order and not the index's.
    expect(
      resolveEdges(importer, index, withAliases({ "@/*": ["src/*", "packages/ui/*"] })).edges[0]
        ?.to,
    ).toBe("src/Button.tsx");
    // First *hit*, not first target: a candidate that names no node is skipped within the pattern,
    // which is the one place falling onward is right, because a tsconfig list means exactly that.
    expect(
      resolveEdges(importer, index, withAliases({ "@/*": ["nowhere/*", "src/*"] })).edges[0]?.to,
    ).toBe("src/Button.tsx");
  });

  test("resolves nothing for a target that climbs out of the repository", () => {
    // Pinned as a contract rather than as an effect, in the sense test/suite-environment.test.ts
    // uses: a node id is repo-relative and can never begin with `../`, so removing the guard in
    // `resolveAlias` changes no answer this index can give. What it holds is that the config field
    // cannot be pointed out of the repository and get an edge back, whatever the index holds later.
    const { importer, index } = graph(
      module_(screen, [specifierCapture("@/money", 1)]),
      "src/money.ts",
    );

    expect(resolveEdges(importer, index, withAliases({ "@/*": ["../outside/*"] })).edges).toEqual(
      [],
    );
    // The same target spelled so that it only climbs out once normalized.
    expect(
      resolveEdges(importer, index, withAliases({ "@/*": ["src/../../out/*"] })).edges,
    ).toEqual([]);
  });

  test("does not claim the specifier that is exactly the wildcard's prefix", () => {
    // `@/` would substitute an empty path, so `@/*` -> ["src/*"] names `src/`, and the index-name
    // probe would then hand back src/index.ts for an import that named no path at all.
    const { importer, index } = graph(module_(screen, [specifierCapture("@/", 1)]), "src/index.ts");

    expect(resolveEdges(importer, index, withAliases({ "@/*": ["src/*"] })).edges).toEqual([]);
  });

  test("compiles the same order whatever order the config's keys were written in", () => {
    // The one place a human's typing order could have reached graph.json: JSON preserves key order,
    // Object.entries hands it back, and Array.sort is stable, so without the compareStrings
    // tiebreak two patterns of equal specificity would keep whichever order the file was saved in.
    const first = compileAliases({ "~/*": ["app/*"], "@/*": ["src/*"], "#/*": ["lib/*"] });
    const second = compileAliases({ "@/*": ["src/*"], "#/*": ["lib/*"], "~/*": ["app/*"] });

    expect(first.map((rule) => rule.prefix)).toEqual(second.map((rule) => rule.prefix));
    // Code units, which is what compareStrings is: "#" 35, "@" 64, "~" 126.
    expect(first.map((rule) => rule.prefix)).toEqual(["#/", "@/", "~/"]);
    // Two exact patterns of the same length tie on every earlier term too.
    expect(compileAliases({ "@z": ["z.ts"], "@a": ["a.ts"] }).map((rule) => rule.prefix)).toEqual([
      "@a",
      "@z",
    ]);
  });
});

/**
 * The second half of what `resolveEdges` returns: every bare name a name-resolving strategy read,
 * with the verdict the index gave it.
 *
 * The edge assertions above can only ever hold what came out. A strategy whose yield has quietly
 * gone to zero — a pack whose `normalize` chain stopped matching, a repository that grew a second
 * `TextInput` — produces exactly the same empty edge list as a repository with nothing to find, and
 * every test above passes either way. These pin the denominator, so the two stop looking alike.
 *
 * A name is counted **per reference read**, not per distinct name and not per edge, which is why the
 * counts below are asserted as whole arrays rather than by `toContainEqual`: a duplicated or a
 * dropped entry is the defect this channel exists to make visible.
 */
describe("resolveEdges, the names it declined", () => {
  /** A node whose kind is something other than the `node` factory's "class", for `targetKinds`. */
  function kinded(id: string, name: string, filePath: string, kind: string): ExtractedFile {
    return { ...node(id, name, filePath), kind };
  }

  /** A `<x-...>` capture whose rule declares `targetKinds`, as a real template rule's does. */
  function kindedCapture(name: string, line: number, targetKinds: string[]): Capture {
    return { ...shortNameCapture(name, line), targetKinds };
  }

  test("records a resolved name alongside the edge it produced", () => {
    // The success case is recorded too, and that is the whole point: a refusal count with no
    // denominator beside it says nothing about whether a strategy is working. `resolved` here is the
    // number the three failures below are read against.
    const badge = node(
      "Acme\\View\\Components\\PriceBadge",
      "PriceBadge",
      "app/View/Components/PriceBadge.php",
    );
    const view = node(
      "resources/views/orders/show.blade.php",
      "show.blade",
      "resources/views/orders/show.blade.php",
      [shortNameCapture("PriceBadge", 11)],
    );

    const resolved = resolveEdges(view, buildNodeIndex([badge, view]), PHP);

    expect(resolved.edges).toHaveLength(1);
    expect(resolved.names).toEqual([
      { family: "template", name: "PriceBadge", outcome: "resolved", candidates: 1 },
    ]);
  });

  test("records a name carried by two nodes as ambiguous, with the count of nodes carrying it", () => {
    // The one verdict of the three that hides a coupling this repository really has: `TextInput` is
    // rendered, one of these two files is really coupled to the view, and no edge is emitted. The
    // candidate count is what tells a reader that, rather than a vendor tag, is what happened.
    const forms = node(
      "Acme\\View\\Components\\Forms\\TextInput",
      "TextInput",
      "app/View/Components/Forms/TextInput.php",
    );
    const fields = node(
      "Acme\\View\\Components\\Fields\\TextInput",
      "TextInput",
      "app/View/Components/Fields/TextInput.php",
    );
    const view = node(
      "resources/views/form.blade.php",
      "form.blade",
      "resources/views/form.blade.php",
      [shortNameCapture("TextInput", 4)],
    );

    const resolved = resolveEdges(view, buildNodeIndex([forms, fields, view]), PHP);

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([
      { family: "template", name: "TextInput", outcome: "ambiguous", candidates: 2 },
    ]);
  });

  test("records a name carried by no node as unknown, with no candidates", () => {
    // A vendor component or a Blade built-in like `<x-slot>`. Distinguished from `ambiguous` because
    // it costs this repository nothing: a high `unknown` count is the normal price of reading a
    // language whose vendor tags are spelled exactly like local ones, and is not a bug to chase.
    const view = node(
      "resources/views/form.blade.php",
      "form.blade",
      "resources/views/form.blade.php",
      [shortNameCapture("Slot", 4)],
    );

    const resolved = resolveEdges(view, buildNodeIndex([view]), PHP);

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([
      { family: "template", name: "Slot", outcome: "unknown", candidates: 0 },
    ]);
  });

  test("records the one node of a kind targetKinds does not list as wrong-kind", () => {
    // The rule's own filter doing what it was declared for, and the third verdict rather than a
    // second flavour of `unknown`: the name was found, in exactly one place, and the rule chose not
    // to point at it. Nothing is wrong with the pack or the repository, so nobody should be paged.
    const type = kinded("src/types/Badge.ts", "Badge", "src/types/Badge.ts", "module");
    const view = node(
      "resources/views/badge.blade.php",
      "badge.blade",
      "resources/views/badge.blade.php",
      [kindedCapture("Badge", 3, ["component"])],
    );

    const resolved = resolveEdges(view, buildNodeIndex([type, view]), PHP);

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([
      { family: "template", name: "Badge", outcome: "wrong-kind", candidates: 1 },
    ]);
  });

  test("calls two nodes of which one is a legal kind ambiguous, never wrong-kind", () => {
    // Uniqueness is asked before the kind filter, and this is where that order is visible. Exactly
    // one of these two `Badge`s is a "component", so a filter-first resolver would narrow the field
    // to one candidate, resolve, and report `resolved`. It would also be guessing: a name shared by
    // two files is a name this strategy cannot read, and narrowing the field only hides that behind
    // a plausible pick. The verdict has to stay `ambiguous`, or the record would launder the guess.
    const component = kinded(
      "Acme\\View\\Components\\Badge",
      "Badge",
      "app/View/Components/Badge.php",
      "component",
    );
    const type = kinded("src/types/Badge.ts", "Badge", "src/types/Badge.ts", "module");
    const view = node(
      "resources/views/badge.blade.php",
      "badge.blade",
      "resources/views/badge.blade.php",
      [kindedCapture("Badge", 3, ["component"])],
    );

    const resolved = resolveEdges(view, buildNodeIndex([component, type, view]), PHP);

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([
      { family: "template", name: "Badge", outcome: "ambiguous", candidates: 2 },
    ]);
  });

  test("records both names of an observer capture even when the first one already refused", () => {
    // The `&&`-short-circuit trap the production code carries a comment about. `Order` is ambiguous,
    // and a resolver that read the listener only when the observed name resolved would leave
    // `OrderObserver`'s verdict uncounted — so a provider registering fifty observers on one
    // ambiguous model would report half the references it actually read, and the denominator this
    // whole channel exists to give would be wrong in exactly the case it matters most.
    const order = node("Acme\\Models\\Order", "Order", "app/Models/Order.php");
    const otherOrder = node("Acme\\Support\\Order", "Order", "app/Support/Order.php");
    const observer = node(
      "Acme\\Observers\\OrderObserver",
      "OrderObserver",
      "app/Observers/OrderObserver.php",
    );
    const provider = node(
      "Acme\\Providers\\AppServiceProvider",
      "AppServiceProvider",
      "app/Providers/AppServiceProvider.php",
      [observerCapture("Order", "OrderObserver", 12)],
    );

    const resolved = resolveEdges(
      provider,
      buildNodeIndex([order, otherOrder, observer, provider]),
      PHP,
    );

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([
      { family: "hook", name: "Order", outcome: "ambiguous", candidates: 2 },
      { family: "hook", name: "OrderObserver", outcome: "resolved", candidates: 1 },
    ]);
  });

  test("resolves a name a node carries in another case, and says it resolved", () => {
    // Measured on a real 186-file React Native application: components live in
    // `src/components/badge.tsx` and are rendered `<Badge />`, and 3 of 1531 tag references
    // resolved. None of the misses was an ambiguity anybody could repair by renaming a file, so an
    // exact-only index does not report a fixable problem here — it reports nothing at all.
    const badge = kinded(
      "src/components/badge.tsx",
      "badge",
      "src/components/badge.tsx",
      "component",
    );
    const screen = kinded(
      "src/screens/orderScreen.tsx",
      "orderScreen",
      "src/screens/orderScreen.tsx",
      "screen",
    );
    const view = {
      ...screen,
      captures: [
        // The witness the fold needs: this file imports `Badge` from that module. Without it the
        // fold is this engine guessing that a naming style is in play, which is how `<Toaster />`
        // from a package lands on a local `toaster.tsx`.
        {
          family: "import" as const,
          resolve: "module-path" as const,
          groups: ['import Badge from "../components/badge"', "../components/badge"],
          line: 1,
        },
        kindedCapture("Badge", 7, ["component", "screen"]),
      ],
    };

    const resolved = resolveEdges(view, buildNodeIndex([badge, screen]), TS);

    expect(resolved.edges).toContainEqual({
      from: "src/screens/orderScreen.tsx",
      to: "src/components/badge.tsx",
      kind: "template",
      symbol: null,
      evidence: { file: "src/screens/orderScreen.tsx", line: 7 },
    });
    expect(resolved.names).toEqual([
      { family: "template", name: "Badge", outcome: "resolved", candidates: 1 },
    ]);
  });

  test("prefers the exact spelling over the fold, and refuses a fold nothing corroborates", () => {
    // The fold is a fallback and never a competitor: a repository holding both `Badge.tsx` and
    // `badge.tsx` resolves `<Badge />` to the one it is spelled as, and the exact match needs no
    // witness. A fold does: the second case is cal.com's, where `<Toaster />` comes from the
    // `sonner` package and a local `toaster.tsx` folds onto its name. Nothing in the file imports
    // that file, so the fold is refused and the reference is what it always was, a name in no node.
    const exact = kinded(
      "src/components/Badge.tsx",
      "Badge",
      "src/components/Badge.tsx",
      "component",
    );
    const lower = kinded("src/widgets/badge.tsx", "badge", "src/widgets/badge.tsx", "component");
    const other = kinded("src/widgets/BADGE.tsx", "BADGE", "src/widgets/BADGE.tsx", "component");
    const view = kinded("src/screens/Cart.tsx", "Cart", "src/screens/Cart.tsx", "screen");

    const exactly = resolveEdges(
      { ...view, captures: [kindedCapture("Badge", 3, ["component"])] },
      buildNodeIndex([exact, lower, view]),
      TS,
    );
    const folded = resolveEdges(
      {
        ...view,
        captures: [
          {
            family: "import" as const,
            resolve: "module-path" as const,
            groups: ['import { Badge } from "sonner"', "sonner"],
            line: 1,
          },
          kindedCapture("Badge", 3, ["component"]),
        ],
      },
      buildNodeIndex([lower, other, view]),
      TS,
    );

    expect(exactly.edges.map((edge) => edge.to)).toEqual(["src/components/Badge.tsx"]);
    expect(folded.edges).toEqual([]);
    expect(folded.names).toEqual([
      { family: "template", name: "Badge", outcome: "unknown", candidates: 0 },
    ]);
  });

  test("refuses a name the file that rendered it declares itself", () => {
    // Measured on marmelab/react-admin: 139 of 2715 template edges pointed at a file the rendering
    // file was shadowing with its own `const`. A story file declaring `const SelectInput = ...` and
    // rendering `<SelectInput />` names nothing outside itself, whatever another package happens to
    // call a file. The refusal prevents a wrong edge rather than losing a right one, which is why it
    // is counted apart from the three that lose one.
    const real = kinded(
      "packages/ui/src/input/SelectInput.tsx",
      "SelectInput",
      "packages/ui/src/input/SelectInput.tsx",
      "component",
    );
    const story = {
      ...kinded(
        "packages/core/src/ReferenceInput.stories.tsx",
        "ReferenceInput.stories",
        "packages/core/src/ReferenceInput.stories.tsx",
        "component",
      ),
      declares: ["SelectInput"],
      captures: [kindedCapture("SelectInput", 186, ["component"])],
    };

    const resolved = resolveEdges(story, buildNodeIndex([real, story]), TS);

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([
      { family: "template", name: "SelectInput", outcome: "local", candidates: 0 },
    ]);
  });

  test("counts no name for a module-path capture, however little it resolved", () => {
    // Only the two bare-name strategies are counted. A specifier that resolves to nothing is a
    // vendor import or a file outside the graph, and nobody can act on that refusal, so folding it
    // in would bury the refusals somebody can act on under a number dominated by node_modules.
    const importer = module_("apps/mobile/src/screens/OrderScreen.tsx", [
      specifierCapture("./Missing", 1),
      specifierCapture("react", 2),
    ]);

    const resolved = resolveEdges(importer, buildNodeIndex([importer]), TS);

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([]);
  });

  test("counts a name that resolved to the file itself as resolved, though its edge is dropped", () => {
    // The self-edge is dropped downstream of the lookup, and the record is of the lookup. A
    // component whose own file renders its name read a name and found it, and counting that as a
    // refusal would make a healthy pack look like a failing one in proportion to how often it
    // happens — which is a property of the repository, not of the strategy.
    const card = node("Acme\\View\\Components\\Card", "Card", "app/View/Components/Card.php", [
      shortNameCapture("Card", 9),
    ]);

    const resolved = resolveEdges(card, buildNodeIndex([card]), PHP);

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([
      { family: "template", name: "Card", outcome: "resolved", candidates: 1 },
    ]);
  });
});
