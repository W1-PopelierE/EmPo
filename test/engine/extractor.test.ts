import { describe, expect, test } from "vitest";
import { compilePack, type ExtractedFile, extractFile } from "../../src/engine/extractor";
import type { ScannedFile } from "../../src/engine/scanner";
import type { Pack, SymbolRule } from "../../src/schema/types";

/**
 * Engine tests run on tiny inline packs and hand-made files, per the testing discipline in
 * docs/14-implementation-notes.md. test/packs/php.test.ts covers the same code end to end; these
 * pin one pack rule at a time.
 */

const basePack: Pack = {
  name: "inline",
  version: "1.0.0",
  match: { extensions: [".php"] },
  node: {
    id: {
      strategy: "fqcn",
      namespacePattern: "^namespace\\s+([A-Za-z0-9_\\\\]+)\\s*;",
      namePattern: "^class\\s+([A-Za-z0-9_]+)",
    },
    kindRules: [{ kind: "class" }],
  },
  edges: {},
  produces: [],
  consumes: [],
  tests: { paths: [], importsRule: "import", assertionTerms: [], assertionExcludes: [] },
};

/** The same pack, but keeping files that declare no class, the way php keeps a route file. */
const fallbackPack: Pack = {
  ...basePack,
  node: { ...basePack.node, id: { ...basePack.node.id, fallback: "path" } },
};

function withNode(pack: Pack, node: Pack["node"]): Pack {
  return { ...pack, node };
}

function file(relPath: string, source: string): ScannedFile {
  return { root: ".", lang: "php", file: relPath, relPath, source };
}

function extract(pack: Pack, scanned: ScannedFile): ExtractedFile {
  const extracted = extractFile(compilePack(pack), scanned);
  if (extracted === null) throw new Error(`expected ${scanned.relPath} to yield a node`);
  return extracted;
}

describe("node identity", () => {
  test("joins the namespace and the class name into a fully-qualified id", () => {
    const extracted = extract(
      basePack,
      file("app/Models/Order.php", "<?php\n\nnamespace Acme\\Models;\n\nclass Order\n{\n}\n"),
    );

    expect(extracted.id).toBe("Acme\\Models\\Order");
    expect(extracted.name).toBe("Order");
  });

  test("falls back to the path when the file declares no class and the pack asks for it", () => {
    const extracted = extract(
      fallbackPack,
      file("routes/api.php", "<?php\n\nRoute::get('/v1/orders', 'index');\n"),
    );

    expect(extracted.id).toBe("routes/api.php");
    expect(extracted.name).toBe("api");
  });

  test("yields no node when the file declares no class and the pack declares no fallback", () => {
    const scanned = file("routes/api.php", "<?php\n\nRoute::get('/v1/orders', 'index');\n");

    expect(extractFile(compilePack(basePack), scanned)).toBeNull();
  });
});

describe("kind rules", () => {
  const kindPack = withNode(basePack, {
    ...basePack.node,
    kindRules: [
      { kind: "model", pathGlob: "**/Models/**" },
      { kind: "job", contentPattern: "implements\\s+ShouldQueue" },
      { kind: "class" },
    ],
  });

  test("takes the first matching rule and treats a rule with no condition as the default", () => {
    const bothMatch = extract(
      kindPack,
      file(
        "app/Models/Order.php",
        "<?php\n\nnamespace Acme\\Models;\n\nclass Order implements ShouldQueue\n{\n}\n",
      ),
    );
    const neitherMatches = extract(
      kindPack,
      file("app/Support/Money.php", "<?php\n\nnamespace Acme\\Support;\n\nclass Money\n{\n}\n"),
    );

    expect(bothMatch.kind).toBe("model");
    expect(neitherMatches.kind).toBe("class");
  });

  test("tags by content alone when a rule declares only a contentPattern", () => {
    const contentPack = withNode(basePack, {
      ...basePack.node,
      kindRules: [{ kind: "job", contentPattern: "implements\\s+ShouldQueue" }, { kind: "class" }],
    });
    const queued = extract(
      contentPack,
      file(
        "app/Anywhere/SendInvoice.php",
        "<?php\n\nnamespace Acme\\Anywhere;\n\nclass SendInvoice implements ShouldQueue\n{\n}\n",
      ),
    );
    const plain = extract(
      contentPack,
      file("app/Anywhere/Plain.php", "<?php\n\nnamespace Acme\\Anywhere;\n\nclass Plain\n{\n}\n"),
    );

    expect(queued.kind).toBe("job");
    expect(plain.kind).toBe("class");
  });
});

describe("captures", () => {
  test("records the 1-based line each match starts on, first line and last line included", () => {
    const importPack: Pack = {
      ...fallbackPack,
      edges: { import: [{ pattern: "^use ([A-Za-z0-9_\\\\]+);", resolve: "fqcn" }] },
    };
    // No leading <?php and no trailing newline, so the first and the last capture sit on the
    // first and the last line of the source.
    const source = "use Acme\\First;\nclass Thing\n{\n}\nuse Acme\\Middle;\nuse Acme\\Last;";

    const extracted = extract(importPack, file("app/Thing.php", source));

    expect(extracted.captures.map((capture) => capture.groups[1])).toEqual([
      "Acme\\First",
      "Acme\\Middle",
      "Acme\\Last",
    ]);
    expect(extracted.captures.map((capture) => capture.line)).toEqual([1, 5, 6]);
  });
});

describe("comment syntax by extension", () => {
  // A pack whose default comments carry only the js block pair, with an html pair added for one
  // extension. A `<!--` in a file of any other extension must stay ordinary text, because reading
  // it as a comment opener with no closer blanks the rest of the file and every edge below it.
  const dualPack: Pack = {
    ...fallbackPack,
    match: { extensions: [".js", ".vue"] },
    comments: { line: ["//"], block: [["/*", "*/"]], stringQuotes: [] },
    commentsByExtension: {
      ".vue": {
        line: ["//"],
        block: [
          ["/*", "*/"],
          ["<!--", "-->"],
        ],
        stringQuotes: [],
      },
    },
    edges: { import: [{ pattern: "^use ([A-Za-z0-9_\\\\]+);", resolve: "fqcn" }] },
  };

  test("masks an html comment in a file whose extension declares one", () => {
    const source = "<!-- use Acme\\Hidden; -->\nuse Acme\\Real;\n";

    const extracted = extract(dualPack, file("Widget.vue", source));

    expect(extracted.captures.map((capture) => capture.groups[1])).toEqual(["Acme\\Real"]);
  });

  test("leaves `<!--` ordinary in a file whose extension does not, rather than eating the file", () => {
    // The bug this routing fixes: `<!--` on the .js side is not a comment opener, so the import
    // below it is still an import. A shared html pair would blank from `<!--` to the end.
    const source = "const ok = a <!--b;\nuse Acme\\Survivor;\n";

    const extracted = extract(dualPack, file("thing.js", source));

    expect(extracted.captures.map((capture) => capture.groups[1])).toEqual(["Acme\\Survivor"]);
  });

  // A compound extension is a real thing in several languages (card.blade.php, main.d.ts,
  // styles.module.css), and `posix.extname` answers only the last segment of one. Selecting the
  // longest declared dotted suffix instead is what lets a pack override a dialect that shares its
  // base extension with the language it is embedded in.
  const compoundPack: Pack = {
    ...fallbackPack,
    match: { extensions: [".php"] },
    comments: { line: ["//"], block: [["/*", "*/"]], stringQuotes: [] },
    commentsByExtension: {
      ".php": { line: ["//"], block: [["/*", "*/"]], stringQuotes: [] },
      ".blade.php": { line: [], block: [["{{--", "--}}"]], stringQuotes: [] },
    },
    // Deliberately unanchored, unlike dualPack's rule above. An anchored `^use` never matches a
    // `use` sitting behind a comment marker on the same line, so every case below would pass
    // whatever the masker did: the first draft of these three tests was green against the very
    // extname bug they exist to catch.
    edges: { import: [{ pattern: "use ([A-Za-z0-9_\\\\]+);", resolve: "fqcn" }] },
  };

  test("selects the longest declared dotted suffix, not the last extension segment", () => {
    // The whole point of the blade-to-class edge's masking half. Under `posix.extname` this file's
    // extension is ".php", so the ".blade.php" entry could never be selected, the `{{-- --}}` pair
    // would be unrecognized, and the commented-out line below would become an edge citing a
    // comment. Revert commentSyntaxFor to extname and this test goes red with two captures.
    const source = "{{-- use Acme\\Hidden; --}}\nuse Acme\\Real;\n";

    const extracted = extract(compoundPack, file("resources/views/card.blade.php", source));

    expect(extracted.captures.map((capture) => capture.groups[1])).toEqual(["Acme\\Real"]);
  });

  test("leaves a plain file of the same base extension on the shorter entry", () => {
    // The other half: ".blade.php" must not claim an ordinary .php file, or the language's own
    // comments stop being masked everywhere.
    const source = "// use Acme\\Hidden;\nuse Acme\\Real;\n";

    const extracted = extract(compoundPack, file("app/Models/Order.php", source));

    expect(extracted.captures.map((capture) => capture.groups[1])).toEqual(["Acme\\Real"]);
  });

  test("refuses a suffix that only matches inside another extension's letters", () => {
    // The leading dot in every key is what makes suffix comparison safe: "notblade.php" ends in
    // "blade.php" but not in ".blade.php", so the compound entry must not claim it. Without the
    // dot this file would be masked as blade and its `//` comment would survive as an edge.
    const source = "// use Acme\\Hidden;\nuse Acme\\Real;\n";

    const extracted = extract(compoundPack, file("app/notblade.php", source));

    expect(extracted.captures.map((capture) => capture.groups[1])).toEqual(["Acme\\Real"]);
  });
});

describe("edge rule normalizers", () => {
  // The capture the pack hands its resolve strategy, spelled as the call site writes it and as the
  // declaration writes it. Nothing named Blade, Laravel or PHP enters the engine: the engine holds
  // the verbs, the pack composes the sentence (docs/04-language-packs.md).
  function capture(edges: Pack["edges"], source: string): (string | undefined)[] {
    return extract(
      { ...fallbackPack, edges },
      file("resources/views/page.blade.php", source),
    ).captures.map((hit) => hit.groups[1]);
  }

  test("composes last-dot-segment then pascal-case into a class's own short name", () => {
    expect(
      capture(
        {
          template: [
            {
              pattern: "<x-([a-z0-9][A-Za-z0-9._-]*)",
              resolve: "short-name",
              normalize: ["last-dot-segment", "pascal-case"],
            },
          ],
        },
        "<x-price-badge />\n<x-forms.text-input />\n<x-layout.app-shell>\n",
      ),
    ).toEqual(["PriceBadge", "TextInput", "AppShell"]);
  });

  test("leaves a capture alone when the rule declares no normalizers", () => {
    // Every rule that shipped before this field existed has to behave exactly as it did, so the
    // default is the identity and not a guess about what the capture probably meant.
    expect(
      capture(
        { template: [{ pattern: "<x-([a-z0-9][A-Za-z0-9._-]*)", resolve: "short-name" }] },
        "<x-price-badge />\n",
      ),
    ).toEqual(["price-badge"]);
  });

  test("leaves group 0 as written, because no strategy reads it", () => {
    const extracted = extract(
      {
        ...fallbackPack,
        edges: {
          template: [
            {
              pattern: "<x-([a-z0-9][A-Za-z0-9._-]*)",
              resolve: "short-name",
              normalize: ["pascal-case"],
            },
          ],
        },
      },
      file("resources/views/page.blade.php", "<x-price-badge />\n"),
    );

    expect(extracted.captures[0]?.groups[0]).toBe("<x-price-badge");
    expect(extracted.captures[0]?.groups[1]).toBe("PriceBadge");
  });

  test("keeps a name that already arrives in PascalCase intact", () => {
    // pascal-case capitalizes each separated segment and touches nothing else, so it never
    // lowercases a word on a guess about where the boundary inside it was.
    expect(
      capture(
        {
          template: [
            {
              pattern: "<x-([A-Za-z0-9][A-Za-z0-9._-]*)",
              resolve: "short-name",
              normalize: ["last-dot-segment", "pascal-case"],
            },
          ],
        },
        "<x-TextInput />\n<x-Layout.AppShell />\n",
      ),
    ).toEqual(["TextInput", "AppShell"]);
  });
});

describe("test paths", () => {
  const testPack: Pack = { ...basePack, tests: { ...basePack.tests, paths: ["tests/"] } };

  test("marks a file under a declared test path, and only on a whole path segment", () => {
    const inTests = extract(
      testPack,
      file(
        "tests/Feature/OrderTest.php",
        "<?php\n\nnamespace Acme\\Tests\\Feature;\n\nclass OrderTest\n{\n}\n",
      ),
    );
    const merelyPrefixed = extract(
      testPack,
      file(
        "testsuite/OrderTest.php",
        "<?php\n\nnamespace Acme\\Testsuite;\n\nclass OrderTest\n{\n}\n",
      ),
    );

    expect(inTests.isTest).toBe(true);
    expect(merelyPrefixed.isTest).toBe(false);
  });
});

describe("value assertions", () => {
  // One term that is a value assertion or a liveness assertion depending on its argument, which a
  // substring cannot see, plus a second term so a subtraction can be shown not to take the file
  // down with it. `class_exists(` is declared as a term on purpose: it sits inside one of the
  // exclusions, and the engine subtracts before it matches, so it must not be reachable from there.
  const assertPack: Pack = {
    ...basePack,
    tests: {
      paths: ["tests/"],
      importsRule: "import",
      assertionTerms: ["assertTrue(", "assertSame(", "class_exists("],
      assertionExcludes: ["assertTrue(method_exists(", "assertTrue(class_exists("],
    },
  };

  /** One test class holding `body`, so the verdict comes from the same path a real file takes. */
  function phpTest(body: string): ExtractedFile {
    return extract(
      assertPack,
      file(
        "tests/Feature/OrderTest.php",
        `<?php\n\nnamespace Acme\\Tests\\Feature;\n\nclass OrderTest\n{\n${body}\n}\n`,
      ),
    );
  }

  test("counts a term whose argument is a real call as a value assertion", () => {
    // Nothing is subtracted here, so this is the behaviour the field must leave untouched. A red
    // means the exclusions are being applied too widely and every assertTrue( has stopped counting.
    expect(phpTest("$this->assertTrue($order->isPaid());").assertsValue).toBe(true);
  });

  test("does not count the same term when the pack names the spelling to subtract", () => {
    // The regression that made this field exist: `assertTrue(method_exists(...))` proves a method
    // is declared, not that it computes anything, and it is the whole reason a real repo scored
    // 14 of 15 test files as asserting on a value. A red means the subtraction stopped firing.
    expect(phpTest("$this->assertTrue(method_exists($controller, 'confirm'));").assertsValue).toBe(
      false,
    );
  });

  test("leaves a term unreachable when it only occurs inside an exclusion", () => {
    // `class_exists(` is a declared term, but the only occurrence sits inside the subtracted
    // `assertTrue(class_exists(`. Removing rather than matching around is what makes that hold: a
    // red here means an excluded call can be re-admitted by any other term that shares its text.
    const reflected = phpTest("$this->assertTrue(class_exists(LegacyOrder::class));");

    expect(reflected.assertsValue).toBe(false);
  });

  test("subtracts only the excluded occurrence, not the rest of the file", () => {
    // A file usually holds both. If a single reflection check could disqualify the file, the field
    // would trade one wrong answer for another, so the genuine assertion below still has to win.
    const both = phpTest(
      "$this->assertTrue(method_exists($controller, 'confirm'));\n$this->assertSame(1250, $order->totalCents());",
    );

    expect(both.assertsValue).toBe(true);
  });

  test("says nothing about a file that is not a test", () => {
    // assertsValue is gated on isTest, so a helper outside tests/ that happens to hold the token
    // is not a covering test. Without the gate it would count toward the blind-flow computation.
    const helper = extract(
      assertPack,
      file(
        "app/Support/Assertions.php",
        "<?php\n\nnamespace Acme\\Support;\n\nclass Assertions\n{\n$this->assertSame(1, 1);\n}\n",
      ),
    );

    expect(helper.isTest).toBe(false);
    expect(helper.assertsValue).toBe(false);
  });
});

describe("symbol rules", () => {
  test("assembles the key from the template and normalizes each part first", () => {
    const routePack: Pack = {
      ...fallbackPack,
      produces: [
        {
          symbol: "http-route",
          pattern: "Route::(get|post)\\(\\s*'([^']+)'",
          map: { method: 1, path: 2 },
          key: "{method} {path}",
          normalize: { method: ["upper"], path: ["strip-leading-slash"] },
        },
      ],
    };

    const extracted = extract(
      routePack,
      file("routes/api.php", "<?php\n\nRoute::post('/v1/orders', 'store');\n"),
    );

    expect(extracted.produces).toEqual([{ symbol: "http-route", key: "POST v1/orders", line: 3 }]);
  });

  test("joins the parts in map order when the rule declares no key template", () => {
    const routePack: Pack = {
      ...fallbackPack,
      produces: [
        {
          symbol: "http-route",
          // Declared path first, so a key in map order differs from one in capture-group order.
          pattern: "Route::(get|post)\\(\\s*'([^']+)'",
          map: { path: 2, method: 1 },
        },
      ],
    };

    const extracted = extract(
      routePack,
      file("routes/api.php", "<?php\n\nRoute::post('/v1/orders', 'store');\n"),
    );

    expect(extracted.produces).toEqual([{ symbol: "http-route", key: "/v1/orders post", line: 3 }]);
  });

  test("produces a symbol from the file path when the rule is a pathPattern, not source", () => {
    // An Inertia page's name is where it sits, not anything written in it, so the rule reads the
    // path. apps/web/src/Pages/Auth/Login.vue produces the page "Auth/Login", which is the key
    // the controller's Inertia::render('Auth/Login') consumes from source on the other side.
    const pagePack: Pack = {
      ...fallbackPack,
      match: { extensions: [".vue"] },
      produces: [
        {
          symbol: "inertia-page",
          pathPattern: "(?:^|/)Pages/(.+)\\.vue$",
          map: { page: 1 },
          key: "{page}",
        },
      ],
    };

    // The source names no page. The identity is the path, and the anchor is line 1 by rule.
    const extracted = extract(
      pagePack,
      file("apps/web/src/Pages/Auth/Login.vue", "<template>Login</template>"),
    );

    expect(extracted.produces).toEqual([{ symbol: "inertia-page", key: "Auth/Login", line: 1 }]);
  });

  test("produces nothing from a path a pathPattern does not match", () => {
    const pagePack: Pack = {
      ...fallbackPack,
      match: { extensions: [".vue"] },
      produces: [
        { symbol: "inertia-page", pathPattern: "(?:^|/)Pages/(.+)\\.vue$", map: { page: 1 } },
      ],
    };

    // A component, not under Pages/, is not a page and produces no page name.
    const extracted = extract(
      pagePack,
      file("apps/web/src/Components/Button.vue", "<template>x</template>"),
    );

    expect(extracted.produces).toEqual([]);
  });

  test("sorts the symbol refs by symbol, then key, then line", () => {
    // Declared so that source order, rule order and sorted order all differ.
    const rules: SymbolRule[] = [
      {
        symbol: "http-route",
        pattern: "Route::(get)\\(\\s*'([^']+)'",
        map: { method: 1, path: 2 },
        key: "{method} {path}",
      },
      { symbol: "event", pattern: "emit\\('([^']+)'\\)", map: { name: 1 }, key: "{name}" },
      { symbol: "event", pattern: "fire\\('([^']+)'\\)", map: { name: 1 }, key: "{name}" },
    ];
    const sortPack: Pack = { ...fallbackPack, produces: rules, consumes: rules };
    const source = [
      "Route::get('/b', 'b');",
      "Route::get('/a', 'a');",
      "fire('order.paid');",
      "emit('order.paid');",
      "emit('alpha');",
    ].join("\n");

    const extracted = extract(sortPack, file("routes/api.php", source));

    const sorted = [
      { symbol: "event", key: "alpha", line: 5 },
      { symbol: "event", key: "order.paid", line: 3 },
      { symbol: "event", key: "order.paid", line: 4 },
      { symbol: "http-route", key: "get /a", line: 2 },
      { symbol: "http-route", key: "get /b", line: 1 },
    ];
    expect(extracted.produces).toEqual(sorted);
    expect(extracted.consumes).toEqual(sorted);
  });

  test("orders keys by code unit, so the sort does not depend on the machine's locale", () => {
    // localeCompare would order these alpha, Beta, Zulu, and it orders them differently again
    // under another ICU locale. graph.json has to be byte-identical across machines
    // (docs/05-graph-model.md), so every sort in the engine compares code units.
    const sortPack: Pack = {
      ...fallbackPack,
      produces: [
        { symbol: "event", pattern: "emit\\('([^']+)'\\)", map: { name: 1 }, key: "{name}" },
      ],
    };
    const source = ["emit('alpha');", "emit('Beta');", "emit('Zulu');"].join("\n");

    const extracted = extract(sortPack, file("routes/api.php", source));

    expect(extracted.produces.map((ref) => ref.key)).toEqual(["Beta", "Zulu", "alpha"]);
  });
});
