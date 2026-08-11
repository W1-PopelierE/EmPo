import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { runPackFixtures } from "../../src/commands/pack";
import { compilePack, compileTestPath, extractFile } from "../../src/engine/extractor";
import { maskComments } from "../../src/engine/mask";
import { fixturesDir, loadPack } from "../../src/engine/pack-loader";
import { resolveModulePath } from "../../src/engine/resolver";
import type { GraphEdge, GraphNode } from "../../src/schema/types";

/**
 * The same gate the php pack passes (docs/04-language-packs.md), against a pack built the other
 * way round: module-path ids instead of class names, no hook family, consumes instead of produces.
 * Everything below the snapshot pins a property the snapshot alone would not name.
 */
describe("typescript pack", () => {
  const { pack, actual } = runPackFixtures("typescript");
  const expected = JSON.parse(readFileSync(`${fixturesDir("typescript")}/expected.json`, "utf8"));

  const node = (id: string): GraphNode | undefined => actual.nodes.find((n) => n.id === id);
  const from = (id: string): GraphEdge[] => actual.edges.filter((edge) => edge.from === id);

  test("loads with its declared identity", () => {
    expect(pack.name).toBe("typescript");
    expect(pack.version).toBe("1.8.0");
  });

  test("reproduces the expected nodes", () => {
    expect(actual.nodes).toEqual(expected.nodes);
  });

  test("reproduces the expected edges", () => {
    expect(actual.edges).toEqual(expected.edges);
  });

  test("identifies a module by its path and names it by its basename", () => {
    expect(node("src/shared/money.ts")?.name).toBe("money");
    // Only the final extension comes off, so a colocated test keeps the .test that names it.
    expect(node("src/screens/OrderScreen.test.tsx")?.name).toBe("OrderScreen.test");
  });

  test("drops a vendor import, which names a package and not a file here", () => {
    // OrderScreen imports react and the api client imports axios. Neither is a coupling this
    // repository can break, so neither is an edge.
    expect(actual.edges.some((edge) => edge.to === "react" || edge.to === "axios")).toBe(false);
    expect(from("src/screens/OrderScreen.tsx")).toHaveLength(3);
  });

  test("resolves a directory import through the barrel, per the pack's indexNames", () => {
    const barrel = from("src/screens/OrderScreen.tsx").find((edge) =>
      edge.to.endsWith("components/index.ts"),
    );

    expect(barrel?.to).toBe("src/components/index.ts");
    expect(barrel?.evidence.line).toBe(2);
  });

  test("follows a re-export out of the barrel to both components", () => {
    expect(from("src/components/index.ts").map((edge) => edge.to)).toEqual([
      "src/components/OrderBadge.tsx",
      "src/components/PriceRow.tsx",
    ]);
  });

  test("reports a multi-line import on the line the statement starts, not the line it ends", () => {
    // PriceRow.tsx opens its import on line 1 and names the module on line 4. A citation pointing
    // at line 4 would send a reader to a closing brace.
    const edge = from("src/components/PriceRow.tsx")[0];

    expect(edge?.to).toBe("src/shared/money.ts");
    expect(edge?.evidence.line).toBe(1);
  });

  test("finds a dynamic import inside a function body", () => {
    const lazy = from("src/screens/OrderScreen.tsx").find((edge) =>
      edge.to.endsWith("OrderBadge.tsx"),
    );

    expect(lazy?.evidence.line).toBe(6);
  });

  test("reads no coupling out of a comment, in either comment syntax", () => {
    // OldOrderScreen.tsx holds a commented-out import in a block comment and a commented-out
    // dynamic import on a line comment, each pointing at a module that does exist. Removing the
    // pack's `comments` block turns both into edges, which is what makes this fixture worth having.
    expect(from("src/legacy/OldOrderScreen.tsx").map((edge) => edge.to)).toEqual([
      "src/shared/money.ts",
    ]);
  });

  test("does not let a // inside a string start a comment", () => {
    // health() calls an absolute URL. If the masker took the // in https:// for a comment, the
    // rest of that line would be blanked and the call would vanish from consumes.
    const keys = node("src/api/orders.ts")?.consumes.map((ref) => ref.key);

    expect(keys).toContain("GET https://api.acme.test/api/v1/health");
  });

  test("reads a route out of every call shape the pack declares", () => {
    expect(node("src/api/orders.ts")?.consumes).toEqual([
      // The ${id} is the literal text of the route the app calls, not an interpolation this file
      // wants evaluated. Joining it to the {order} the api declares is the bridge's job.
      // biome-ignore-start lint/suspicious/noTemplateCurlyInString: this is source text, quoted
      { symbol: "http-route", key: "DELETE api/v1/orders/${id}", line: 17 },
      { symbol: "http-route", key: "GET api/v1/orders/${id}", line: 9 },
      // biome-ignore-end lint/suspicious/noTemplateCurlyInString: this is source text, quoted
      { symbol: "http-route", key: "GET https://api.acme.test/api/v1/health", line: 13 },
      { symbol: "http-route", key: "POST api/v1/orders", line: 5 },
    ]);
  });

  test("does not read a bare fetch as the POST it sits next to", () => {
    // The two fetch rules are deliberately disjoint: one requires the call to close right after
    // the url, the other requires a method in the options object. A url that carries a method
    // must not also be reported as a GET.
    const keys = node("src/api/orders.ts")?.consumes.map((ref) => ref.key) ?? [];

    expect(keys).toContain("POST api/v1/orders");
    expect(keys).not.toContain("GET api/v1/orders");
  });

  test("indexes a single-file component as a node, named and kinded like any other", () => {
    // Half of a Vue frontend is .vue. While the pack matched only .ts and .tsx, every one of those
    // files was absent from the graph, so a composable used by nothing but components read as an
    // orphan with zero fan-in and a blast radius silently omitted the half that renders.
    expect(node("src/components/CartPanel.vue")?.name).toBe("CartPanel");
    expect(node("src/components/CartPanel.vue")?.lang).toBe("typescript");
  });

  test("kinds an SFC as a component wherever it sits, and lets a role directory still win", () => {
    // A .vue file is a component by construction, so the extension rule catches the ones no path
    // glob does. It sits after the role globs because a directory says what role the component
    // plays, and "module" is wrong for an SFC in any case.
    expect(node("src/App.vue")?.kind).toBe("component");
    expect(node("src/components/CartLine.vue")?.kind).toBe("component");
  });

  test("reads an import out of an SFC's script block", () => {
    // The edge the gap was about: a component that imports a shared module. The script block is
    // TypeScript and the rule that reads it is the same one that reads a .ts file.
    const edge = from("src/components/CartLine.vue")[0];

    expect(edge?.to).toBe("src/shared/money.ts");
    expect(edge?.evidence.line).toBe(2);
  });

  test("resolves an SFC named by the explicit .vue specifier a Vue import carries", () => {
    // Unlike a TypeScript import, a Vue import writes the extension, because .vue is not on any
    // bundler's default resolve list. candidatePaths yields the bare base first, so this needs no
    // resolver change once .vue files are nodes: it is the first candidate, not the last.
    expect(from("src/screens/CartScreen.ts").map((edge) => edge.to)).toEqual([
      "src/api/orders.ts",
      "src/components/CartPanel.vue",
    ]);
    // Two edges to one file, because App.vue imports CartPanel in its script and renders it in its
    // template, and the graph deduplicates per (from, to, kind). Both are true and they answer
    // different questions; what neither may do is count twice in a fan-in, which is why
    // computeFanin counts distinct sources (engine/graph.ts).
    expect(from("src/App.vue").map((edge) => `${edge.to} ${edge.kind}`)).toEqual([
      "src/components/CartPanel.vue import",
      "src/components/CartPanel.vue template",
    ]);
  });

  test("reads no coupling out of an html comment in a template", () => {
    // CartPanel's template holds a commented-out `import { PriceRow } from "../components/PriceRow"`
    // inside a <!-- --> block, pointing at a module that does exist. A template has no // and no
    // /* */, so without the html pair in the pack's comments that line is line-anchored, resolvable
    // and indistinguishable from a real import: a false edge citing a comment.
    expect(from("src/components/CartPanel.vue").map((edge) => `${edge.to} ${edge.kind}`)).toEqual([
      // Registered globally and imported nowhere, so this tag is the only reference to it in the
      // repository: the one edge here that no import rule could ever have produced.
      "src/components/CartBadge.vue template",
      "src/components/CartLine.vue import",
      "src/components/CartLine.vue template",
      "src/shared/money.ts import",
    ]);
  });

  test("keeps that comment out with the mask, not by an accident of the import rules", () => {
    // The negative control for the test above, because an edge that is absent proves nothing about
    // why. Masked with the js pair alone, the same fixture still holds the dead import, and it is
    // line-anchored and resolvable: dropping ["<!--", "-->"] from the pack turns it into an edge.
    const source = readFileSync(
      `${fixturesDir("typescript")}/src/src/components/CartPanel.vue`,
      "utf8",
    );
    // The html pair is on the .vue override now, not the base comments, because a .ts file must not
    // treat `<!--` as a comment. This asserts the override does the masking and, by using the base
    // comments as the negative control, that the base does not carry the pair.
    const pack = loadPack("typescript");
    const vue = pack.commentsByExtension?.[".vue"];
    if (vue === undefined) throw new Error("the typescript pack lost its .vue comment syntax");

    expect(maskComments(source, vue)).not.toContain("PriceRow");
    expect(maskComments(source, pack.comments)).toContain(
      'import { PriceRow } from "../components/PriceRow";',
    );
  });

  test("indexes plain JavaScript, which the pack's own manifest roots and it used to skip", () => {
    // The measured gap: match.extensions named .ts, .tsx and .vue while match.manifest named
    // package.json, so a pack rooted by a JavaScript project read no JavaScript. On a real
    // repository that hid a browser-side behaviour layer whole, and every file in it was absent
    // from the graph rather than present with no edges, so nothing printed said so.
    expect(node("src/browser/analytics.js")?.lang).toBe("typescript");
    expect(node("src/browser/tracker.js")?.name).toBe("tracker");
    expect(node("src/browser/widgets/PriceWidget.jsx")?.name).toBe("PriceWidget");
    expect(node("src/browser/instrument.mjs")?.name).toBe("instrument");
    expect(node("src/browser/legacy-bridge.cjs")?.name).toBe("legacy-bridge");
  });

  test("couples JavaScript to TypeScript in both directions", () => {
    // Both edges matter and only one of them needs the new extension. A .js file importing a .ts
    // module resolved even before this, had the .js file been a node at all; the specifier that
    // needs .js on the list is the one pointing *at* JavaScript, which is how the graph learns
    // that typed code depends on the untyped layer.
    expect(from("src/browser/analytics.js").map((edge) => edge.to)).toEqual([
      "src/browser/tracker.js",
      "src/shared/money.ts",
    ]);
    expect(from("src/browser/widgets/PriceWidget.jsx")[0]?.to).toBe("src/shared/money.ts");
    expect(from("src/browser/analytics.test.js")[0]?.to).toBe("src/browser/analytics.js");
  });

  test("prefers the TypeScript file where one specifier could name either", () => {
    // A repository mid-migration holds money.ts beside a leftover money.js and writes `./money`.
    // tsc resolves .ts before .js under allowJs and the .ts file is the one the build compiles, so
    // the pack declares .ts first and candidatePaths takes the first hit. Bundlers disagree with
    // each other here (vite's default list puts .js first), which is why this is pinned against the
    // shipped pack rather than left to whoever next edits the extension list.
    const pack = loadPack("typescript");
    const index = {
      ids: new Set(["src/shared/money.js", "src/shared/money.ts"]),
      byShortName: new Map<string, string[]>(),
      byFoldedName: new Map<string, string[]>(),
      kindById: new Map<string, string>(),
    };

    expect(
      resolveModulePath("src/browser/analytics.js", "../shared/money", index, {
        extensions: pack.match.extensions,
        indexNames: pack.node.id.indexNames ?? [],
      }),
    ).toBe("src/shared/money.ts");
  });

  test("reads a CommonJS require as the import it is", () => {
    // The third import rule has always matched `require(`, and no fixture file exercised it while
    // the pack read no JavaScript, because a .ts file does not write one. It is the only shape a
    // .cjs file has to say a coupling with.
    const edge = from("src/browser/legacy-bridge.cjs")[0];

    expect(edge?.to).toBe("src/browser/tracker.js");
    expect(edge?.evidence.line).toBe(1);
  });

  test("kinds a React component wherever it sits, on the extension and the tag together", () => {
    // This test used to assert `module` and to name the gap it was pinning: no kindRule marked
    // React, so a component outside **/components/** and **/screens/** read as a plain module while
    // its .vue equivalent read as a component. Closing that gap was meant to turn the old
    // assertion red.
    expect(node("src/browser/widgets/PriceWidget.jsx")?.kind).toBe("component");
    expect(node("src/react/cards/OrderCard.tsx")?.kind).toBe("component");
    expect(node("src/react/widgets/Badge.jsx")?.kind).toBe("component");
    expect(node("src/components/CartLine.vue")?.kind).toBe("component");
  });

  test("leaves a .tsx holding no tag at all a module, which is what the content half is for", () => {
    // The glob alone would have been one line shorter and would have called every .tsx a component,
    // including the hooks module and the types module every React tree has. OldOrderScreen.tsx is
    // the .tsx here that holds no tag, and Badge.tsx is the control: its only tag is a lowercase
    // element, which is a rendered component all the same. What the content half used not to do is
    // tell a tag from a tag inside a string, which was a gap this test named rather than pinned:
    // `maskStrings` was an edge-rule field and a kind rule had none. It is now a kind-rule field
    // too and CardTemplates.tsx below is the pin.
    expect(node("src/legacy/OldOrderScreen.tsx")?.kind).toBe("module");
    expect(node("src/react/types/OrderRow.ts")?.kind).toBe("module");
    expect(node("src/react/cards/Badge.tsx")?.kind).toBe("component");
  });

  test("kinds a .tsx whose only tags sit in strings a module, not a component", () => {
    // The kind half of what `maskStrings` closes, and the half CardDocs.tsx cannot pin: CardDocs
    // renders a real `<OrderCard />`, so it is a component whichever view its kind rule reads.
    // CardTemplates.tsx renders nothing and holds tag-shaped text only inside string literals, and
    // it sits under react/cards/ where no pathGlob rule reaches, so the `**/*.{tsx,jsx}` rule's
    // `contentPattern` is the only thing that answers for it. Drop `maskStrings` from that rule and
    // this goes red with "component", which is what it did before the fix.
    //
    // CardDocs is asserted here beside it because a rule that stopped matching altogether would buy
    // the module answer too, and would be a worse defect: `resolveName` in engine/resolver.ts filters
    // candidates on kind, so a component miskinded module stops being reachable as a tag target.
    expect(node("src/react/cards/CardTemplates.tsx")?.kind).toBe("module");
    expect(node("src/react/cards/CardDocs.tsx")?.kind).toBe("component");
    // The tag rules read the same blanked view, so the quoted markup produces no edge either.
    expect(from("src/react/cards/CardTemplates.tsx")).toEqual([]);
  });

  test("lets a role directory still win over the React rule", () => {
    // The React rule sits after the screens, components and api globs, so a .tsx under one of them
    // keeps the kind its directory gives it. OrderScreenView.tsx renders a tag and is a screen: the
    // file exists so this can go red, because OrderScreen.tsx holds no JSX and would keep its kind
    // whatever the ordering.
    expect(node("src/screens/OrderScreenView.tsx")?.kind).toBe("screen");
    expect(node("src/screens/OrderScreen.tsx")?.kind).toBe("screen");
    expect(node("src/api/orders.ts")?.kind).toBe("api-client");
  });

  test("reads a rendered component out of JSX, in both tag forms", () => {
    // The third piece of the React work. The two rules are deliberately the two
    // unambiguous shapes: a self-closing tag and a closing tag. The self-closing one here spans
    // four lines and is cited on the line it opens on, which is where a reader wants to be sent;
    // the closing one is how every element with children is caught.
    expect(
      from("src/react/Pages/Orders/Index.tsx")
        .filter((edge) => edge.kind === "template")
        .map((edge) => `${edge.to}:${edge.evidence.line}`),
    ).toEqual([
      "src/react/cards/OrderCard.tsx:11",
      "src/react/cards/OrderList.tsx:18",
      // A screen is a tag target too, which is the second kind the rules declare. Drop "screen"
      // from targetKinds and this row goes.
      "src/screens/OrderScreenView.tsx:17",
    ]);
  });

  test("reads no tag out of a string in the very files the tag rules are for", () => {
    // The half `pathGlob` could not reach. registry.ts below is kept out by its extension, but
    // CardDocs.tsx is a .tsx, which is exactly what the tag rules are supposed to read, so no glob
    // separates its rendered `<OrderCard />` from the two component names in its `examples`
    // strings. The rules declare `maskStrings`, so they read a view of the file with string
    // contents blanked and the prose cannot match.
    //
    // Both halves are asserted from one file on purpose: suppression alone would also be bought by
    // a rule that matched nothing, and the import edge is here to show the file really does sit
    // beside OrderCard in the graph. Drop `maskStrings` from the pack and this goes red with edges
    // to OrderList.tsx and OrderScreenView.tsx, which is 16 template edges in the corpus instead of
    // 14, and coverage travels along every non-bridge edge, so a test touching this module would
    // start reaching two components it never mounted.
    expect(from("src/react/cards/CardDocs.tsx").map((edge) => `${edge.kind} ${edge.to}`)).toEqual([
      "import src/react/cards/OrderCard.tsx",
      "template src/react/cards/OrderCard.tsx",
    ]);
  });

  test("runs no tag rule over a file that cannot hold a tag", () => {
    // registry.ts is a .ts module whose two string values are `<OrderCard />` and
    // `<OrderList>rows</OrderList>`, both naming components this graph holds. The rules' pathGlob
    // is what keeps them out here, and it is checked before anything reads the file, so this stays
    // the pathGlob's own test even now that the tag rules also decline to read strings: remove the
    // glob and the rule runs over a .ts file it has no business in. What the glob buys that
    // `maskStrings` does not is every other rule shape a .ts file could trip; what `maskStrings`
    // buys that the glob cannot is the .tsx case the glob must let through (CardDocs.tsx above).
    expect(from("src/react/registry.ts")).toEqual([]);
  });

  test("refuses a tag whose name belongs to a kind no tag can name", () => {
    // OrderRowList renders `<OrderRow />` from a package, so that import resolves to no node and
    // leaves no competing edge, while src/react/types/OrderRow.ts shares the basename. Without
    // targetKinds the tag resolves to the type module and the invented edge is the only thing the
    // graph says about the pair. `<Total />` is the same two questions in the other order: two
    // files carry that name, one component and one type module, and a kind filter applied before
    // the uniqueness test would resolve it. Asking uniqueness first refuses it, which is the only
    // honest answer about a name this strategy cannot read. The same file's `<CardHeader/>` shows
    // neither refusal is the rule failing to fire: written with no space before the slash, it
    // resolves.
    expect(
      from("src/react/cards/OrderRowList.tsx").map((edge) => `${edge.to} ${edge.kind}`),
    ).toEqual(["src/react/cards/CardHeader.tsx import", "src/react/cards/CardHeader.tsx template"]);
  });

  test("reads a tag whose props hold an arrow, which the obvious pattern would have missed", () => {
    // `onSelect={() => rows.push(order)}` puts a > inside the tag, and a rule written [^<>] stops
    // at it and matches nothing. Almost every real prop list holds one, so this is the case that
    // decides whether the family is worth having at all.
    const rendered = from("src/react/cards/OrderCard.tsx").find(
      (edge) => edge.kind === "template" && edge.to.endsWith("PriceWidget.jsx"),
    );

    expect(rendered?.evidence.line).toBe(17);
  });

  test("resolves a dotted tag and a generic tag to the component that owns them", () => {
    // <CardHeader.Title> names a compound the head component defines, and <CardHeader<OrderRow> />
    // is the same component with a type argument. Both resolve to CardHeader, and neither resolves
    // to Title or to OrderRow, which are the two plausible wrong answers.
    expect(
      from("src/react/cards/OrderCard.tsx")
        .filter((edge) => edge.kind === "template")
        .map((edge) => `${edge.to}:${edge.evidence.line}`),
    ).toEqual(["src/browser/widgets/PriceWidget.jsx:17", "src/react/cards/CardHeader.tsx:16"]);
    expect(
      from("src/react/cards/OrderList.tsx")
        .filter((edge) => edge.kind === "template")
        .map((edge) => `${edge.to}:${edge.evidence.line}`),
    ).toEqual(["src/react/cards/CardHeader.tsx:11"]);
  });

  test("reads no tag out of a generic type argument", () => {
    // `const rows: Array<OrderRow> = []` in OrderCard.tsx names a node of this graph inside angle
    // brackets. A rule that read a bare opening <Name> would emit an edge here, and measured over
    // this repository's own 146 sources as they stood before this change, such a rule fires 34
    // times, 31 of them generics. Both rules require a closing or self-closing tag instead.
    expect(
      from("src/react/cards/OrderCard.tsx")
        .filter((edge) => edge.to === "src/react/types/OrderRow.ts")
        .map((edge) => edge.kind),
    ).toEqual(["import"]);
  });

  test("refuses a tag whose name is in two files, and cites nothing rather than guessing", () => {
    // <Badge /> on Index.tsx:16 names a component that exists twice, cards/Badge.tsx and
    // widgets/Badge.jsx. short-name shares observer's refusal, so an ambiguous name yields no edge
    // at all. The import on line 1 still carries the coupling, which is the shape to notice: the
    // tag rule adds reach where a name is unique and subtracts none where it is not.
    expect(
      from("src/react/Pages/Orders/Index.tsx")
        .filter((edge) => edge.to.endsWith("cards/Badge.tsx"))
        .map((edge) => edge.kind),
    ).toEqual(["import"]);
  });

  test("counts every verdict a name-resolving rule can reach, refusals included", () => {
    // This corpus is the only place all six verdicts are exercised at once, which is why the tally
    // is pinned here rather than left to the snapshot. `Badge` and `Total` are ambiguous by
    // construction, each carried by two files; `OrderRow` is the `targetKinds` refusal, a name in
    // exactly one node of a kind no tag may name; `Spinner` is the vendor component in no node at
    // all, so it lands in `unknown` and must never be counted with the ambiguous ones; and
    // CardStory.tsx renders a `<CardFooter />` it declares itself, which `local` counts and the
    // other four must not, because that refusal prevented a wrong edge instead of losing a right
    // one. `CardShelf.tsx` renders the same name without declaring it and resolves through the case
    // fold to `cardFooter.tsx`, which is what says the guard is about the shadowing and not the
    // name.
    //
    // Pinning the counts is what makes a silent refusal gate-able at all. Every other test here
    // asserts an edge that is present or a list an edge is absent from, and no edge disappears from
    // a diff that was never there: a rule that quietly stopped resolving, or started refusing a
    // name it used to read, moves these numbers and nothing else.
    expect(actual.names).toEqual([
      {
        family: "template",
        resolved: 17,
        local: 1,
        vendor: 1,
        unknown: 1,
        ambiguous: 2,
        wrongKind: 1,
        ambiguousNames: [
          { name: "Badge", nodes: 2, references: 1 },
          { name: "Total", nodes: 2, references: 1 },
        ],
      },
    ]);
  });

  test("reads no tag out of a comment, and none out of a lowercase element", () => {
    // OrderList.tsx holds `<OrderCard />` inside a block comment, pointing at a file that does
    // exist, and Badge.tsx renders `<em className="badge" />`. The first is the masker's job and
    // the second is JSX's own rule that a capitalized tag is a component and a lowercase one is an
    // element: an `em` edge would be an edge to nothing, and worse, to whatever file is named em.
    expect(from("src/react/cards/OrderList.tsx").map((edge) => edge.to)).not.toContain(
      "src/react/cards/OrderCard.tsx",
    );
    expect(from("src/react/cards/Badge.tsx")).toEqual([]);
  });

  test("reads a rendered component out of a .vue template that imports nothing", () => {
    // The half of this that nobody asked for and the half that earns the family its keep. A Vue SFC
    // composes with the same PascalCase tag React does, and CartBadge is registered globally, so
    // this tag is the only reference to it anywhere in the corpus: reach no import rule can reach.
    expect(actual.edges.filter((edge) => edge.to === "src/components/CartBadge.vue")).toHaveLength(
      1,
    );
    expect(
      from("src/components/CartPanel.vue").find((edge) => edge.to.endsWith("CartBadge.vue"))?.kind,
    ).toBe("template");
  });

  test("produces an inertia-page from a React page, not only from a Vue one", () => {
    // Piece 4 of the same entry. The producer matched .vue alone, so a React-Inertia repository
    // produced no page symbol at all and its controller consumed a key nothing declared. The join
    // itself never had to change: engine/bridger.ts matches a symbol and a key and reads no
    // extension.
    expect(node("src/react/Pages/Orders/Index.tsx")?.produces).toEqual([
      { symbol: "inertia-page", key: "Orders/Index", line: 1 },
    ]);
    // Both dialects, because a tree mid-migration holds both under one Pages/ directory and an
    // alternation that named only one would leave half the pages producing nothing.
    expect(node("src/react/Pages/Orders/Print.jsx")?.produces).toEqual([
      { symbol: "inertia-page", key: "Orders/Print", line: 1 },
    ]);
  });

  test("counts a colocated *.test.js as a test, and scores its assertion", () => {
    // tests.paths gained a glob per JavaScript extension with the extensions themselves. Without
    // it a .js test file scores as production code, which is the direction that invents coverage:
    // the file counts as reached by the flow and asserts nothing for it.
    expect(node("src/browser/analytics.test.js")?.isTest).toBe(true);
    expect(node("src/browser/analytics.test.js")?.assertsValue).toBe(true);
    expect(node("src/browser/analytics.js")?.isTest).toBe(false);
  });

  test("counts a colocated *.test.tsx as a test, not only a tests/ directory", () => {
    // The php convention is one test tree; the typescript convention is a test beside its source.
    // A tests.paths entry holding a glob character is matched as a glob for exactly this reason.
    expect(node("src/screens/OrderScreen.test.tsx")?.isTest).toBe(true);
    expect(node("tests/orders.test.ts")?.isTest).toBe(true);
    expect(node("src/screens/OrderScreen.tsx")?.isTest).toBe(false);
  });

  test("separates a test that asserts a value from one that only runs the code", () => {
    // This is the input to the blind-flow computation, so a fixture where both tests looked the
    // same could not prove it works.
    expect(node("src/screens/OrderScreen.test.tsx")?.assertsValue).toBe(true);
    expect(node("tests/orders.test.ts")?.assertsValue).toBe(false);
  });

  test("scores the language's other two test dialects, not only the jest-shaped one", () => {
    // docs/04-language-packs.md section 6: a pack owns both dialects or it owns neither, and this
    // pack owned one. A repository testing with node:assert or chai had every one of its files
    // score as asserting nothing, so every flow it curated read BLIND, on the strength of a rule
    // about which framework the author reached for. Measured on a throwaway repository: the flow
    // whose only test is `strictEqual(checkout(1250), "Total 12.50")` was reported blind.
    expect(node("tests/money.node.test.ts")?.assertsValue).toBe(true);
    expect(node("tests/cart.chai.test.ts")?.assertsValue).toBe(true);
  });

  test("refuses the liveness spelling of a term it takes, which used to qualify a file", () => {
    // The half of this nobody predicted, and the worse half, because it fails
    // toward false comfort. `expect(typeof createOrder).toBe("function")` checks that an export
    // exists and never looks at anything the code computed, and it matched `toBe(` like any real
    // assertion: on the same measurement the flow whose only test was that line was reported
    // covered. This is the php pack's `assertTrue(method_exists(` hole, one language over.
    //
    // The loadPack line asserts the pack's own list reaches the engine through the real loader.
    // What it is NOT is the guard against a pack.schema.ts that stops declaring the field: that is
    // caught twice over, by tsc because `Pack.tests.assertionExcludes` is required in
    // schema/types.ts and pack-loader assigns the parsed data to `Pack`, and by the suite because
    // engine/extractor.ts reduces over the field unconditionally and a stripped one is undefined.
    // Measured, after an earlier version of this comment claimed only the first: the strip fails
    // the whole fixture build with a TypeError. `multilineQuotes` had neither guard, being optional
    // on `Pack` and read behind a `?? []`, which is why that one went silent and this one cannot.
    expect(node("tests/exports.test.ts")?.isTest).toBe(true);
    expect(node("tests/exports.test.ts")?.assertsValue).toBe(false);
    expect(loadPack("typescript").tests.assertionExcludes).toContain('toBe("function")');
  });

  test("cannot read a specifier out of a statement that is not an import", () => {
    // The import and re-export rules span lines, because a real import statement does, and the
    // first shape of them spanned statements too: `export function` reached forward to the next
    // `from "..."` line and reported an edge citing the line the function opened on. Masking
    // already hides the case below, so this is the second line of defence, not the first.
    const rules = loadPack("typescript").edges.import ?? [];
    const notAnImport =
      'export function ordersUrl(): string {\n  // import { PriceRow } from "../components/PriceRow";\n}';

    for (const rule of rules) {
      expect(new RegExp(rule.pattern, "gm").test(notAnImport)).toBe(false);
    }

    // ...and the statement it is meant to read still reads, multi-line included.
    const reExport = 'export {\n  OrderBadge,\n} from "./OrderBadge";';
    expect(rules.some((rule) => new RegExp(rule.pattern, "gm").test(reExport))).toBe(true);
  });

  test("is deterministic across runs", () => {
    const second = runPackFixtures("typescript");
    expect(JSON.stringify(second.actual)).toBe(JSON.stringify(actual));
  });
});

/**
 * One assertion spelling at a time, through the real pack.
 *
 * The corpus cannot do this job. A file is `assertsValue` when **any** term matches, so a fixture
 * proves that at least one term in a 40-entry list fired and never which, and the snapshot would
 * stay green with most of the list deleted. These run the shipped `pack.json` over one line of
 * source apiece, which is the only way a term earns its place.
 */
describe("what the typescript pack counts as asserting a value", () => {
  const compiled = compilePack(loadPack("typescript"));

  /** One line inside a file the pack calls a test, scored exactly as engine/extractor.ts scores it. */
  function asserts(line: string): boolean {
    const extracted = extractFile(compiled, {
      root: ".",
      lang: "typescript",
      file: "tests/probe.test.ts",
      relPath: "tests/probe.test.ts",
      source: `it("probe", () => {\n  ${line}\n});\n`,
    });
    if (extracted === null) throw new Error("expected the probe to yield a node");
    return extracted.assertsValue;
  }

  test("takes a value assertion in each of the three dialects", () => {
    expect(asserts('expect(total).toBe("12.50 EUR");')).toBe(true);
    expect(asserts('strictEqual(total, "12.50 EUR");')).toBe(true);
    expect(asserts('assert.deepStrictEqual(order, { id: "42" });')).toBe(true);
    expect(asserts('expect(total).to.equal("12.50 EUR");')).toBe(true);
  });

  test("takes chai's four spellings of one assertion, because it matches the tail of the chain", () => {
    // `.to.`, `.to.not.`, `.not.to.` and `.should.` are one assertion written four ways, and a term
    // anchored on the head of the chain takes one of the four. Chai's own documentation writes the
    // negation as `.to.not.`, so a suite in negative assertions used to score entirely blind.
    expect(asserts("expect(total).to.equal(1250);")).toBe(true);
    expect(asserts("expect(total).to.not.equal(0);")).toBe(true);
    expect(asserts("expect(total).not.to.equal(0);")).toBe(true);
    expect(asserts("total.should.equal(1250);")).toBe(true);
    expect(asserts("total.should.not.equal(0);")).toBe(true);
    expect(asserts("expect(lines).to.have.lengthOf(3);")).toBe(true);
    expect(asserts("expect(lines).to.have.length(3);")).toBe(true);
  });

  test("does not take a liveness check in any dialect", () => {
    // The direction that matters: each of these runs the code and looks at nothing it computed, so
    // a flow whose only test is one of them must stay BLIND rather than read as covered.
    expect(asserts("expect(order).toBeDefined();")).toBe(false);
    expect(asserts("expect(fetchOrder).toBeInstanceOf(Function);")).toBe(false);
    expect(asserts("expect(client.fetchOrder).toHaveBeenCalled();")).toBe(false);
    expect(asserts('expect(client).to.have.property("fetchOrder");')).toBe(false);
    expect(asserts("expect(fetchOrder).to.exist;")).toBe(false);
    expect(asserts('expect(typeof fetchOrder).toBe("function");')).toBe(false);
    expect(asserts("assert.ok(fetchOrder);")).toBe(false);
    expect(asserts("expect(fetchOrder).toBeTruthy();")).toBe(false);
  });

  test("does not take an ordinary string method for chai's matcher of the same name", () => {
    // `.match(` is the one chain tail that collides with a method every JavaScript file uses, so it
    // is the one taken by its head instead. A test file that only greps a string asserts nothing.
    expect(asserts("const found = body.match(/total/);")).toBe(false);
    expect(asserts("expect(body).to.match(/total: 12.50/);")).toBe(true);
    expect(asserts("expect(body).to.not.match(/error/);")).toBe(true);
  });

  test("leaves the liveness exclusion defeated by a line break, which is a stated limit", () => {
    // Pinned as data rather than left in prose: php's exclusions stop at an opening parenthesis and
    // are immune to formatting, while this one names a whole argument and a formatter that wraps
    // the line past its print width walks straight through it. docs/04-language-packs.md says so;
    // this is what saying so costs. Closing it turns this red on purpose.
    expect(asserts('expect(typeof fetchOrder).toBe(\n    "function",\n  );')).toBe(true);
  });

  test("counts a test by every convention the dialects it reads are written in", () => {
    // Terms are only ever consulted for a file the pack already calls a test, so a dialect added to
    // assertionTerms without its naming convention here is a dialect the pack cannot score. Worse
    // than silent: an unrecognized spec file consumes the module it tests like production code, so
    // the flow that holds it reports that no test reaches it at all.
    //
    // One row per declared entry, and the count is asserted, because a review measured this list
    // and found four of its entries exercised by nothing at all: an entry nothing reaches can be
    // deleted or mistyped for free, which is how the convention half of a dialect goes missing in
    // the first place.
    const declared = loadPack("typescript").tests.paths;
    const matches = declared.map(compileTestPath);
    const isTest = (relPath: string): boolean => matches.some((match) => match(relPath));

    expect(declared).toHaveLength(15);
    for (const relPath of [
      "tests/orders.test.ts",
      "test/orders.js",
      "src/__tests__/orders.js",
      "src/screens/OrderScreen.test.ts",
      "src/screens/OrderScreen.test.tsx",
      "src/browser/analytics.test.js",
      "src/browser/widget.test.jsx",
      "src/browser/instrument.test.mjs",
      "src/browser/legacy.test.cjs",
      "src/screens/CartScreen.spec.ts",
      "src/screens/CartScreen.spec.tsx",
      "src/browser/analytics.spec.js",
      "src/browser/widget.spec.jsx",
      "src/browser/instrument.spec.mjs",
      "src/browser/legacy.spec.cjs",
    ]) {
      expect(isTest(relPath), relPath).toBe(true);
    }

    expect(isTest("src/screens/CartScreen.ts")).toBe(false);
    expect(isTest("src/testing/helpers.ts")).toBe(false);
    expect(isTest("src/latest/orders.ts")).toBe(false);
  });

  test("removes the liveness spelling in either quote, not only the one the corpus writes", () => {
    // The corpus writes double quotes, so the single-quoted exclusion was carried by nothing and a
    // review deleted it with the suite green. Both spellings are ordinary output of an ordinary
    // formatter, so both have to be load-bearing.
    expect(asserts("expect(typeof fetchOrder).toBe('function');")).toBe(false);
    expect(asserts('expect(typeof fetchOrder).toEqual("function");')).toBe(false);
    expect(asserts("expect(typeof fetchOrder).toEqual('function');")).toBe(false);
  });

  test("carries no term that another term already covers", () => {
    // A structural guard rather than a behavioural one, and the only defence the 40-odd spellings
    // nobody wrote a line of source for have. A term that contains another is dead weight: the
    // shorter one already qualifies every file the longer one would, so the longer one is a rule
    // that can never be the reason for an answer, and a future widening pass adding one would get
    // no signal at all.
    const terms = loadPack("typescript").tests.assertionTerms;

    expect(new Set(terms).size).toBe(terms.length);
    for (const term of terms) {
      const covered = terms.filter((other) => other !== term && term.includes(other));
      expect(covered, `${term} is already covered by ${covered.join(", ")}`).toEqual([]);
    }
  });
});
