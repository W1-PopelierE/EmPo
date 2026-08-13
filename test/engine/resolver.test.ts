import { describe, expect, test } from "vitest";
import type { Capture, ExtractedFile } from "../../src/engine/extractor";
import {
  buildNodeIndex,
  compileAliases,
  normalizeFqcn,
  type ResolveContext,
  resolveEdges,
} from "../../src/engine/resolver";

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
    // The resolver reads none of these, but an ExtractedFile carries them, and a hand-made one that
    // omitted them would stop compiling rather than quietly resolve differently.
    symbols: [],
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
});

/**
 * The one strategy whose target is a template. Every other strategy makes a template a source; this
 * is what makes one a sink, so a controller reports the page it renders.
 *
 * The captures are already normalized here, exactly as the extractor hands them over: the pack's
 * `dot-to-slash` has turned `orders.show` into `orders/show` before the resolver ever sees it, so
 * nothing below knows that Blade spells a view name with dots.
 */
describe("resolveEdges, view", () => {
  const VIEWS = { roots: ["resources/views"], extensions: [".blade.php", ".php"] };

  function viewCapture(name: string, line: number): Capture {
    return { family: "template", resolve: "view", groups: [`@include('${name}')`, name], line };
  }

  function template(path: string): ExtractedFile {
    const file = node(path, path.split("/").pop() ?? path, path);
    return { ...file, kind: "view" };
  }

  test("resolves a view name against the pack's view roots", () => {
    const show = template("resources/views/orders/show.blade.php");
    const controller = node("Acme\\OrderController", "OrderController", "app/OrderController.php", [
      viewCapture("orders/show", 12),
    ]);

    const resolved = resolveEdges(controller, buildNodeIndex([show, controller], VIEWS), PHP);

    expect(resolved.edges).toEqual([
      {
        from: "Acme\\OrderController",
        to: "resources/views/orders/show.blade.php",
        kind: "template",
        symbol: null,
        evidence: { file: "app/OrderController.php", line: 12 },
      },
    ]);
    expect(resolved.names).toEqual([
      { family: "template", name: "orders/show", outcome: "resolved", candidates: 1 },
    ]);
  });

  test("finds the root anywhere in a repo-relative path, so a monorepo resolves", () => {
    // `apps/api/resources/views/...` is as normal a Laravel layout as the bare one, and a node id
    // is repo-relative for exactly the reason resolveModuleFile's are.
    const show = template("apps/api/resources/views/orders/show.blade.php");
    const controller = node("Acme\\OrderController", "OrderController", "apps/api/app/O.php", [
      viewCapture("orders/show", 3),
    ]);

    const resolved = resolveEdges(controller, buildNodeIndex([show, controller], VIEWS), PHP);

    expect(resolved.edges.map((edge) => edge.to)).toEqual([
      "apps/api/resources/views/orders/show.blade.php",
    ]);
  });

  test("counts a name no template carries rather than refusing it silently", () => {
    const controller = node("Acme\\OrderController", "OrderController", "app/OrderController.php", [
      viewCapture("orders/archived", 7),
    ]);

    const resolved = resolveEdges(controller, buildNodeIndex([controller], VIEWS), PHP);

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([
      { family: "template", name: "orders/archived", outcome: "unknown", candidates: 0 },
    ]);
  });

  test("refuses a view name two applications in one repository both carry", () => {
    // The same refusal `short-name` makes, for the same reason: picking one would put a confident
    // wrong file:line in front of a reader where the honest answer is that nothing here can tell.
    const api = template("apps/api/resources/views/orders/show.blade.php");
    const admin = template("apps/admin/resources/views/orders/show.blade.php");
    const controller = node("Acme\\OrderController", "OrderController", "apps/api/app/O.php", [
      viewCapture("orders/show", 3),
    ]);

    const resolved = resolveEdges(controller, buildNodeIndex([api, admin, controller], VIEWS), PHP);

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([
      { family: "template", name: "orders/show", outcome: "ambiguous", candidates: 2 },
    ]);
  });

  test("resolves nothing at all for a pack that declares no view roots", () => {
    // The index is built without them, so the strategy has nothing to look in. The schema refuses
    // that pack at load (src/schema/pack.schema.ts); this pins what the engine does if it ever
    // arrives anyway, which is refuse and say so rather than invent.
    const show = template("resources/views/orders/show.blade.php");
    const controller = node("Acme\\OrderController", "OrderController", "app/OrderController.php", [
      viewCapture("orders/show", 12),
    ]);

    const resolved = resolveEdges(controller, buildNodeIndex([show, controller]), PHP);

    expect(resolved.edges).toEqual([]);
    expect(resolved.names[0]?.outcome).toBe("unknown");
  });

  test("takes the longest declared suffix off, so a blade file is not named `show.blade`", () => {
    const show = template("resources/views/orders/show.blade.php");
    const index = buildNodeIndex([show], VIEWS);

    expect([...index.byViewName.keys()]).toEqual(["orders/show"]);
  });

  test("indexes no file outside a view root", () => {
    const index = buildNodeIndex([node("Acme\\Order", "Order", "app/Models/Order.php")], VIEWS);

    expect(index.byViewName.size).toBe(0);
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

  test("resolves past a node of a kind the rule cannot name, and still refuses two of one kind", () => {
    // The kind filter runs before the uniqueness test, and this is where that order is visible.
    //
    // It used to run after, on the argument that narrowing the field hides a guess behind a
    // plausible pick. That argument reads a `targetKinds` list as a tiebreaker, and it is not one: a
    // rule declaring `["component"]` is the pack saying what a reference of this family can denote,
    // so a node of another kind was never a second reading of the tag. It is a different thing that
    // happens to be spelled the same, and counting it makes the name ambiguous against a candidate
    // that could not have won.
    //
    // What forced the order is the `symbol` strategy. While a node was a file, a short name was a
    // file basename and two files of different kinds rarely shared one, so asking last cost almost
    // nothing. Under per-export ids the namespace is every exported name in the repository, and one
    // `export const Modal = ...` in a constants file is then enough to refuse every `<Modal />` in
    // the codebase. The refusal takes every edge to that name with it, including the ones nothing
    // else covers: a globally registered component that no import binds has no other evidence, so
    // the coupling disappears and no count reports that it went missing.
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

    expect(resolved.edges.map((edge) => edge.to)).toEqual(["Acme\\View\\Components\\Badge"]);
    expect(resolved.names).toEqual([
      { family: "template", name: "Badge", outcome: "resolved", candidates: 1 },
    ]);

    // The refusal this did not weaken: two nodes the rule's own kinds both admit are still a name
    // this strategy cannot read, and narrowing there really would be a guess. Only the impossible
    // candidate is removed, never a possible one.
    const second = kinded(
      "Acme\\View\\Components\\Widgets\\Badge",
      "Badge",
      "app/View/Components/Widgets/Badge.php",
      "component",
    );
    const both = resolveEdges(view, buildNodeIndex([component, second, view]), PHP);

    expect(both.edges).toEqual([]);
    expect(both.names).toEqual([
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
    // is counted apart from the three that lose one, and it is asked of the one name that was about
    // to become an edge: a name in no node was never at risk and stays `unknown`.
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
      { family: "template", name: "SelectInput", outcome: "local", candidates: 1 },
    ]);
  });

  test("refuses a name the file imports from a package the repository depends on", () => {
    // The last of the four ways this strategy was measured to be wrong, and the only one no question
    // about the name can reach: `import Button from "@mui/material/Button"` beside a local
    // Button.tsx leaves the index one node, of the right kind, in one place. Measured on
    // marmelab/react-admin, 189 of 2715 template edges were MUI components landing on a local file.
    const local = kinded(
      "src/components/Button.tsx",
      "Button",
      "src/components/Button.tsx",
      "component",
    );
    const view = {
      ...kinded(
        "src/reviews/AcceptButton.tsx",
        "AcceptButton",
        "src/reviews/AcceptButton.tsx",
        "component",
      ),
      captures: [
        {
          family: "import" as const,
          resolve: "module-path" as const,
          groups: ['import Button from "@mui/material/Button"', "@mui/material/Button"],
          line: 2,
        },
        kindedCapture("Button", 54, ["component"]),
      ],
    };

    const resolved = resolveEdges(view, buildNodeIndex([local, view]), {
      ...TS,
      vendorPackages: new Set(["@mui/material"]),
    });

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([
      { family: "template", name: "Button", outcome: "vendor", candidates: 1 },
    ]);
  });

  test("resolves a name imported from a package this repository is, not one it depends on", () => {
    // The half that keeps the family worth having. A component reached through a workspace barrel is
    // the coupling no import parser sees, and `@acme/ui` is spelled at the import site exactly like a
    // third-party package. `vendorPackages` is the manifests' dependencies minus their own names, so
    // a workspace never reaches this refusal and cal.com's 1300-odd barrel edges stay.
    const button = kinded(
      "packages/ui/src/Button.tsx",
      "Button",
      "packages/ui/src/Button.tsx",
      "component",
    );
    const view = {
      ...kinded("apps/web/src/Page.tsx", "Page", "apps/web/src/Page.tsx", "component"),
      captures: [
        {
          family: "import" as const,
          resolve: "module-path" as const,
          groups: ['import { Button } from "@acme/ui"', "@acme/ui"],
          line: 1,
        },
        kindedCapture("Button", 12, ["component"]),
      ],
    };

    const resolved = resolveEdges(view, buildNodeIndex([button, view]), {
      ...TS,
      vendorPackages: new Set(["@mui/material"]),
    });

    expect(resolved.edges.map((edge) => edge.to)).toEqual(["packages/ui/src/Button.tsx"]);
  });

  test("does not read a vendor import that renamed the name away as binding it", () => {
    // The false refusal the first version made, found by opening the ones it refused: react-admin's
    // AppBar.stories.tsx aliases MUI's ThemeProvider out of the way (`ThemeProvider as
    // MuiThemeProvider`) and imports the local one under the plain name on the next line. A check
    // that read the statement for the bare name refused a real edge, which costs the same coupling
    // the wrong edge would have invented.
    const local = kinded(
      "packages/ui/src/theme/ThemeProvider.tsx",
      "ThemeProvider",
      "packages/ui/src/theme/ThemeProvider.tsx",
      "component",
    );
    const story = {
      ...kinded(
        "packages/ui/src/AppBar.stories.tsx",
        "AppBar.stories",
        "packages/ui/src/AppBar.stories.tsx",
        "component",
      ),
      captures: [
        {
          family: "import" as const,
          resolve: "module-path" as const,
          groups: [
            'import { ThemeProvider as MuiThemeProvider } from "@mui/material"',
            "@mui/material",
          ],
          line: 5,
        },
        {
          family: "import" as const,
          resolve: "module-path" as const,
          groups: ['import { ThemeProvider } from "./theme"', "./theme"],
          line: 31,
        },
        kindedCapture("ThemeProvider", 176, ["component"]),
      ],
    };

    const resolved = resolveEdges(story, buildNodeIndex([local, story]), {
      ...TS,
      vendorPackages: new Set(["@mui/material"]),
    });

    expect(resolved.names).toEqual([
      { family: "template", name: "ThemeProvider", outcome: "resolved", candidates: 1 },
    ]);
  });

  test("does not read a name that appears only inside the specifier as bound by it", () => {
    // The same false refusal by the other route, and the typescript pack's side-effect import rule
    // is what put it in reach: a bare `import "@mui/material/Button/Button.css"` binds nothing at
    // all, yet the statement carries the word `Button` twice. Read whole, it refuses the local
    // `Button.tsx` the file actually renders. A specifier is a path and never a binding clause.
    const local = kinded(
      "src/components/Button.tsx",
      "Button",
      "src/components/Button.tsx",
      "component",
    );
    const view = {
      ...kinded("src/reviews/Review.tsx", "Review", "src/reviews/Review.tsx", "component"),
      captures: [
        {
          family: "import" as const,
          resolve: "module-path" as const,
          groups: ['import "@mui/material/Button/Button.css"', "@mui/material/Button/Button.css"],
          line: 1,
        },
        kindedCapture("Button", 30, ["component"]),
      ],
    };

    const resolved = resolveEdges(view, buildNodeIndex([local, view]), {
      ...TS,
      vendorPackages: new Set(["@mui/material"]),
    });

    expect(resolved.edges.map((edge) => edge.to)).toEqual(["src/components/Button.tsx"]);
    expect(resolved.names).toEqual([
      { family: "template", name: "Button", outcome: "resolved", candidates: 1 },
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

/**
 * The redirect, which is the one thing the index cannot do on its own: a bare specifier naming a
 * package this repository **is** says which subtree the name came out of, and the index only knows
 * which nodes carry it.
 *
 * Measured on cal.com, where `apps/web/modules/webhooks/components/WebhookListItem.tsx:222` renders
 * `</Button>` under `import { Button } from "@coss/ui/components/button"`. `@coss/ui` is the
 * workspace package at `packages/coss-ui` and the component is its `src/components/button.tsx`;
 * every question the index asks answers `packages/ui/components/button/Button.tsx`, which is the one
 * node named exactly `Button`, and `vendorPackages` cannot refuse it because `@coss/ui` is a name
 * the repository is. The redirect moved 35 of cal.com's template edges onto the file the import
 * really reaches and turned 301 more references into `resolved` (275 from `ambiguous`, 21 from
 * `unknown`, 5 from `local`), removing no edge on any of the four repositories measured.
 */
describe("resolveEdges, a name bound from a workspace package", () => {
  function kinded(id: string, name: string, kind: string): ExtractedFile {
    return { ...node(id, name, id), kind, lang: "typescript" };
  }

  function importing(id: string, statement: string, specifier: string, tag: string): ExtractedFile {
    return {
      ...kinded(id, (id.split("/").pop() ?? id).replace(/\.[^.]+$/, ""), "component"),
      captures: [
        {
          family: "import" as const,
          resolve: "module-path" as const,
          groups: [statement, specifier],
          line: 3,
        },
        { ...shortNameCapture(tag, 42), targetKinds: ["component", "screen"] },
      ],
    };
  }

  const COSS_UI = new Map([["@coss/ui", "packages/coss-ui"]]);

  test("prefers the node inside the package the specifier names over the one the index found", () => {
    // The measured case, with the folding cal.com does: the workspace file is `button.tsx` and the
    // tag is `<Button />`, so the exact spelling inside the package carries nothing and the fold
    // inside it carries one. The fold needs no separate witness here the way `foldedCandidates`
    // does, because the import that made this subtree the one to search is that witness.
    const collision = kinded("packages/ui/components/button/Button.tsx", "Button", "component");
    const real = kinded("packages/coss-ui/src/components/button.tsx", "button", "component");
    const view = importing(
      "apps/web/modules/webhooks/components/WebhookListItem.tsx",
      'import { Button } from "@coss/ui/components/button"',
      "@coss/ui/components/button",
      "Button",
    );

    const resolved = resolveEdges(view, buildNodeIndex([collision, real, view]), {
      ...TS,
      internalPackages: COSS_UI,
    });

    expect(resolved.edges.map((edge) => edge.to)).toEqual([
      "packages/coss-ui/src/components/button.tsx",
    ]);
    expect(resolved.names).toEqual([
      { family: "template", name: "Button", outcome: "resolved", candidates: 1 },
    ]);
  });

  test("falls through to the index where the named package carries the name nowhere", () => {
    // The reason containment is a preference and never a requirement, and the case that would have
    // been deleted by the obvious version of this rule. On marmelab/react-admin a file imports from
    // `react-admin`, whose `packages/react-admin/index.ts` re-exports `ra-ui-materialui` and
    // `ra-core`, so the component legitimately lives in another package's directory:
    // `examples/crm/src/deals/DealList.tsx:105` reaches
    // `packages/ra-ui-materialui/src/layout/TopToolbar.tsx` and must go on reaching it.
    const toolbar = kinded(
      "packages/ra-ui-materialui/src/layout/TopToolbar.tsx",
      "TopToolbar",
      "component",
    );
    const list = importing(
      "examples/crm/src/deals/DealList.tsx",
      'import { TopToolbar } from "react-admin"',
      "react-admin",
      "TopToolbar",
    );

    const resolved = resolveEdges(list, buildNodeIndex([toolbar, list]), {
      ...TS,
      internalPackages: new Map([["react-admin", "packages/react-admin"]]),
    });

    expect(resolved.edges.map((edge) => edge.to)).toEqual([
      "packages/ra-ui-materialui/src/layout/TopToolbar.tsx",
    ]);
  });

  test("redirects a name the index calls ambiguous when the named package holds one of them", () => {
    // Where the yield comes from. Two feature directories carrying `Select` is the ordinary shape of
    // a monorepo and the index has to refuse it, because nothing in the tag says which is meant. The
    // import does say, and once the subtree is searched the refusal is answerable: react-admin went
    // from 3386 ambiguous to 3142 and cal.com from 515 to 240 on that alone.
    const inside = kinded("packages/ui/components/Select.tsx", "Select", "component");
    const elsewhere = kinded("apps/web/components/Select.tsx", "Select", "component");
    const view = importing(
      "apps/web/pages/Booking.tsx",
      'import { Select } from "@calcom/ui"',
      "@calcom/ui",
      "Select",
    );

    const index = buildNodeIndex([inside, elsewhere, view]);
    const packages = new Map([["@calcom/ui", "packages/ui"]]);

    expect(resolveEdges(view, index, TS).names).toEqual([
      { family: "template", name: "Select", outcome: "ambiguous", candidates: 2 },
    ]);
    expect(
      resolveEdges(view, index, { ...TS, internalPackages: packages }).edges.map((e) => e.to),
    ).toEqual(["packages/ui/components/Select.tsx"]);
  });

  test("falls through where the named package holds two nodes of the name, refusing rather than picking", () => {
    // Inside a package the ambiguity is the same fact it is outside one, and a subtree narrow enough
    // to feel decisive is not evidence. Two answers and the question goes back to the index, which
    // refuses it for the same reason.
    const one = kinded("packages/ui/src/form/Select.tsx", "Select", "component");
    const two = kinded("packages/ui/src/data/Select.tsx", "Select", "component");
    const view = importing(
      "apps/web/pages/Booking.tsx",
      'import { Select } from "@calcom/ui"',
      "@calcom/ui",
      "Select",
    );

    const resolved = resolveEdges(view, buildNodeIndex([one, two, view]), {
      ...TS,
      internalPackages: new Map([["@calcom/ui", "packages/ui"]]),
    });

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([
      { family: "template", name: "Select", outcome: "ambiguous", candidates: 2 },
    ]);
  });

  test("declines a node inside the package whose kind the rule does not allow", () => {
    // `targetKinds` is not softened by the specifier being specific. A `.ts` module sharing a
    // basename with a component is exactly what that filter was declared for, and a redirect that
    // skipped it would land a tag on a type module with more confidence than the index ever had.
    const types = kinded("packages/ui/src/types/Select.ts", "Select", "module");
    const view = importing(
      "apps/web/pages/Booking.tsx",
      'import { Select } from "@calcom/ui"',
      "@calcom/ui",
      "Select",
    );

    const resolved = resolveEdges(view, buildNodeIndex([types, view]), {
      ...TS,
      internalPackages: new Map([["@calcom/ui", "packages/ui"]]),
    });

    expect(resolved.edges).toEqual([]);
    expect(resolved.names).toEqual([
      { family: "template", name: "Select", outcome: "wrong-kind", candidates: 1 },
    ]);
  });

  test("reads no package out of an import that renamed the name away", () => {
    // The same false refusal `importsVendorName` had to be taught, aimed the other way: a statement
    // that binds `Button` to something else has not bound `Button`, so it cannot say which subtree
    // `Button` came from either. Both questions go through `statementBinds` for this reason.
    const inside = kinded("packages/coss-ui/src/components/button.tsx", "button", "component");
    const local = kinded("apps/web/components/Button.tsx", "Button", "component");
    const view = {
      ...importing(
        "apps/web/pages/Signup.tsx",
        'import { Button as CossButton } from "@coss/ui"',
        "@coss/ui",
        "Button",
      ),
    };

    const resolved = resolveEdges(view, buildNodeIndex([inside, local, view]), {
      ...TS,
      internalPackages: COSS_UI,
    });

    expect(resolved.edges.map((edge) => edge.to)).toEqual(["apps/web/components/Button.tsx"]);
  });

  test("outranks a declaration that is itself a dynamic import of the named package's file", () => {
    // Why the redirect is asked before `local` rather than after it, which was measured rather than
    // chosen. Guarding it on the declared set cost five cal.com edges, and opening all five found
    // the same shape:
    // `packages/features/bookings/components/event-meta/Price.tsx:22` renders
    // `<AlbyPriceComponent />` under
    // `const AlbyPriceComponent = dynamic(() => import("@calcom/app-store/alby/components/AlbyPriceComponent"))`.
    // The file does declare the name, so `local` refused it, and the thing it declares is a wrapper
    // around an import of exactly the file the redirect finds. `local` exists to stop an edge to a
    // file the line does not mean; here the line means that file and says so in the same statement.
    const real = kinded(
      "packages/app-store/alby/components/AlbyPriceComponent.tsx",
      "AlbyPriceComponent",
      "component",
    );
    const price = {
      ...kinded("packages/features/bookings/components/event-meta/Price.tsx", "Price", "component"),
      declares: ["AlbyPriceComponent", "Price"],
      captures: [
        {
          family: "import" as const,
          resolve: "module-path" as const,
          groups: [
            'import("@calcom/app-store/alby/components/AlbyPriceComponent")',
            "@calcom/app-store/alby/components/AlbyPriceComponent",
          ],
          line: 8,
        },
        { ...shortNameCapture("AlbyPriceComponent", 22), targetKinds: ["component", "screen"] },
      ],
    };

    const resolved = resolveEdges(price, buildNodeIndex([real, price]), {
      ...TS,
      internalPackages: new Map([["@calcom/app-store", "packages/app-store"]]),
    });

    expect(resolved.edges.map((edge) => edge.to)).toEqual([
      "packages/app-store/alby/components/AlbyPriceComponent.tsx",
    ]);
    expect(resolved.names).toEqual([
      { family: "template", name: "AlbyPriceComponent", outcome: "resolved", candidates: 1 },
    ]);
  });

  test("resolves exactly as before where the pack declares no packages block", () => {
    // php's bargain, unchanged for the third time: no `packages` block means no map, and a map that
    // is absent narrows nothing. It is also the state of every `empo pack test` run whose corpus
    // declares no manifest.
    const collision = kinded("packages/ui/components/button/Button.tsx", "Button", "component");
    const real = kinded("packages/coss-ui/src/components/button.tsx", "button", "component");
    const view = importing(
      "apps/web/modules/webhooks/components/WebhookListItem.tsx",
      'import { Button } from "@coss/ui/components/button"',
      "@coss/ui/components/button",
      "Button",
    );

    const resolved = resolveEdges(view, buildNodeIndex([collision, real, view]), TS);

    expect(resolved.edges.map((edge) => edge.to)).toEqual([
      "packages/ui/components/button/Button.tsx",
    ]);
  });
});

/**
 * What resolution does once a file yields several nodes. `test/engine/build.test.ts` pins the same
 * strategy end to end over a fixture; these are the two decisions this file makes on its own, and
 * both fail silently if they are wrong: an import that resolves to nothing looks exactly like a
 * vendor import, which this file drops by design.
 */
describe("resolveEdges under a pack whose files yield many nodes", () => {
  /** A file partitioned into exports, as extraction hands it over. */
  function exporting(filePath: string, names: string[], captures: Capture[] = []): ExtractedFile {
    return {
      ...module_(filePath, captures),
      symbols: names.map((name, position) => ({
        name,
        id: `${filePath}#${name}`,
        startLine: 10 + position,
        endLine: 10 + position,
      })),
    };
  }

  function importer(filePath: string, statement: string, specifier: string): ExtractedFile {
    const owners = [`${filePath}#use`];
    return exporting(
      filePath,
      ["use"],
      [
        {
          family: "import",
          resolve: "module-path",
          groups: [statement, specifier],
          line: 1,
          owners,
        },
      ],
    );
  }

  test("resolves a specifier against the files the index holds, no path being a node id", () => {
    const money = exporting("src/money.ts", ["formatMoney", "parseMoney"]);
    const total = importer("src/total.ts", 'import { formatMoney } from "./money"', "./money");

    const resolved = resolveEdges(total, buildNodeIndex([money, total]), TS);

    expect(resolved.edges.map((edge) => edge.to)).toEqual(["src/money.ts#formatMoney"]);
    expect(resolved.edges.map((edge) => edge.from)).toEqual(["src/total.ts#use"]);
  });

  test("reaches the whole module where the statement binds no name the target exports", () => {
    // A default import names the module and not one of its exports, so every export of it is in
    // reach and the floor stays a floor.
    const money = exporting("src/money.ts", ["formatMoney", "parseMoney"]);
    const total = importer("src/total.ts", 'import money from "./money"', "./money");

    const resolved = resolveEdges(total, buildNodeIndex([money, total]), TS);

    expect(resolved.edges.map((edge) => edge.to)).toEqual([
      "src/money.ts#formatMoney",
      "src/money.ts#parseMoney",
    ]);
  });

  test("corroborates a folded short name against a file that yields many nodes", () => {
    // The regression this exists to catch is silent, which is why it is worth a test of its own.
    // `importsNameFrom` asks whether this file imports a name from the file a candidate node lives
    // in. A specifier names a module and never one export of it, so the only honest comparison is
    // against the file. Comparing against a resolved **id** answers false for every file holding
    // more than one export, because no specifier resolves to one of them, and the fold is then
    // refused as a name that corroborated nothing. Nothing errors, no count drops to zero, and every
    // JSX edge whose target module happens to export a second symbol simply stops existing.
    const badge: ExtractedFile = {
      ...node("src/components/badge.tsx", "badge", "src/components/badge.tsx"),
      lang: "typescript",
      kind: "component",
      symbols: [
        { name: "badge", id: "src/components/badge.tsx#badge", startLine: 1, endLine: 4 },
        { name: "helper", id: "src/components/badge.tsx#helper", startLine: 5, endLine: 9 },
      ],
    };
    const screen: ExtractedFile = {
      ...node("src/screens/Cart.tsx", "Cart", "src/screens/Cart.tsx"),
      lang: "typescript",
      kind: "screen",
      captures: [
        {
          family: "import" as const,
          resolve: "module-path" as const,
          groups: ['import { Badge } from "../components/badge"', "../components/badge"],
          line: 1,
        },
        { ...shortNameCapture("Badge", 7), targetKinds: ["component", "screen"] },
      ],
    };

    const resolved = resolveEdges(screen, buildNodeIndex([badge, screen]), TS);

    // The template edge is the one under test. The import capture emits its own edges to both
    // exports beside it, which is the documented fallback: the clause binds `Badge`, that file
    // exports no such name, and an import this engine cannot pin to one export reaches the module.
    expect(
      resolved.edges.filter((edge) => edge.kind === "template").map((edge) => edge.to),
    ).toEqual(["src/components/badge.tsx#badge"]);
    expect(resolved.names).toEqual([
      { family: "template", name: "Badge", outcome: "resolved", candidates: 1 },
    ]);
  });
});
