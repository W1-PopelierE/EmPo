import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { runPackFixtures } from "../../src/commands/pack";
import { compilePack, extractFile } from "../../src/engine/extractor";
import { fixturesDir } from "../../src/engine/pack-loader";

/**
 * This is the gate docs/04-language-packs.md sets for every pack: run the rules over a synthetic
 * corpus and diff against the checked-in snapshot. `empo pack test php` runs the same code.
 */
describe("php pack", () => {
  const { pack, actual } = runPackFixtures("php");
  const expected = JSON.parse(readFileSync(`${fixturesDir("php")}/expected.json`, "utf8"));

  test("loads with its declared identity", () => {
    expect(pack.name).toBe("php");
    expect(pack.version).toBe("1.9.0");
  });

  test("reproduces the expected nodes", () => {
    expect(actual.nodes).toEqual(expected.nodes);
  });

  test("reproduces the expected edges", () => {
    expect(actual.edges).toEqual(expected.edges);
  });

  test("separates a value assertion from a test that only proves the route answered", () => {
    // Named rather than left to the whole-file snapshot, because `empo pack test php --update`
    // rewrites that snapshot to whatever the code did, and this pair is the entire reason the two
    // fixture files exist. A red here means the term list moved; go read docs/04's `tests` section
    // before making it green.
    const assertsValue = (file: string): boolean => {
      const node = actual.nodes.find((candidate) => candidate.file === file);
      expect(node, `${file} is missing from the php fixture corpus`).toBeDefined();
      return node?.assertsValue ?? false;
    };

    // Only ->assertStatus(200) and ->assertNotFound(): the "asserts HTTP 200" case docs/04 excludes.
    expect(assertsValue("tests/Feature/ShipmentStatusTest.php")).toBe(false);
    // Pest, classless, expect(...)->toBe(: a value assertion in the dialect PHPUnit terms cannot see.
    expect(assertsValue("tests/Feature/RefundTest.php")).toBe(true);
    // PHPUnit assertEquals, so the pack must still read the dialect it always read.
    expect(assertsValue("tests/Feature/OrderTest.php")).toBe(true);
    // Every assertion in it is assertTrue( wrapped around a reflection predicate: the term is one
    // the pack carries, and only the argument says the file claims nothing about a value. Named
    // here for the same reason the three above are. Its only other pin in the corpus is
    // expected.json, which `empo pack test php --update` rewrites wholesale to whatever the code
    // just did, so without this line the file could be deleted, or score true, and the corpus would
    // agree with either.
    expect(assertsValue("tests/Feature/LivenessTest.php")).toBe(false);
  });

  /**
   * The assertion verdict, taken from the real matcher on the real pack: `pack` is what
   * `loadPack("php")` returned, and `extractFile` is the same code the build runs. Nothing here
   * builds a `tests` object by hand, and that is the point. This repo has a scar from a
   * `multilineQuotes` field that was added to pack.json and to the type but not to the schema:
   * zod stripped it at load, the feature did nothing, and its unit tests stayed green because they
   * handed the engine a hand-built syntax object the loader would never have produced. Drop
   * `assertionExcludes` from src/schema/pack.schema.ts and every case below dies, because the
   * matcher reduces over a field that is suddenly undefined.
   */
  const compiled = compilePack(pack);

  function assertsValueOf(body: string): boolean {
    const relPath = "tests/Feature/CaseTest.php";
    const source = `<?php\n\nnamespace Acme\\Tests\\Feature;\n\nclass CaseTest\n{\n${body}\n}\n`;
    const extracted = extractFile(compiled, {
      root: ".",
      lang: "php",
      file: relPath,
      relPath,
      source,
    });
    if (extracted === null) throw new Error("the php pack yielded no node for the case file");
    expect(extracted.isTest, "the case file must land under the pack's tests.paths").toBe(true);
    return extracted.assertsValue;
  }

  test("carries the exclusions from pack.json through the loader to the matcher", () => {
    // Read off the loaded pack rather than the file, because the gap the scar records is exactly
    // between the two. A red means pack.json declares exclusions the schema does not name, so zod
    // dropped them and every verdict below is being decided by the terms alone.
    expect(pack.tests.assertionExcludes).toContain("assertTrue(method_exists(");
    expect(pack.tests.assertionTerms).toContain("assertTrue(");
  });

  test("subtracts each reflection predicate in both its positive and its negated spelling", () => {
    // assertFalse(interface_exists(...)) says exactly what assertTrue(interface_exists(...)) says,
    // and the list had the second without the first, so one of the pair scored a value assertion on
    // the strength of which way round the author wrote it. Derived from the list rather than typed
    // out, so a predicate added to one half and forgotten in the other comes back red here.
    const excludes = pack.tests.assertionExcludes;
    const predicates = excludes
      .filter((entry) => entry.startsWith("assertTrue("))
      .map((entry) => entry.slice("assertTrue(".length));

    expect(predicates.length).toBeGreaterThan(0);
    for (const predicate of predicates) {
      expect(excludes, `${predicate} is subtracted only in its positive spelling`).toContain(
        `assertFalse(${predicate}`,
      );
    }
    for (const entry of excludes.filter((candidate) => candidate.startsWith("assertFalse("))) {
      const predicate = entry.slice("assertFalse(".length);
      expect(excludes, `${predicate} is subtracted only in its negated spelling`).toContain(
        `assertTrue(${predicate}`,
      );
    }
  });

  test("subtracts an existence check on every kind of declaration this pack can name", () => {
    // The symmetry test above enforces that a predicate present in one spelling is present in the
    // other, and nothing more: a predicate missing from both halves is never enumerated, so it turns
    // nothing red. That is how trait_exists( and enum_exists( sat outside the list while `trait` and
    // `enum` were first-class declarations in this pack's own namePattern, and an
    // assertTrue(enum_exists(...)) scored its file as asserting a value while asserting only that
    // code exists.
    //
    // So the declaration half is derived from namePattern rather than typed out: whatever the id
    // rule can name, PHP has an `<x>_exists` predicate for, and the exclusion list has to cover it
    // in both spellings. A declaration keyword added to that pattern with no matching exclusion
    // comes back red here, which is the review this list needs and not one anybody would remember
    // to run. Every case runs the real matcher, so a verdict is what the engine returns and not what
    // the list looks like.
    const declarations = pack.node.id.namePattern?.match(/\(\?:([a-z|]+)\)/)?.[1]?.split("|") ?? [];
    expect(
      declarations,
      "no declaration keywords could be read off the pack's namePattern",
    ).toContain("class");

    for (const declaration of declarations) {
      for (const spelling of ["assertTrue", "assertFalse"]) {
        const call = `$this->${spelling}(${declaration}_exists(Subject::class));`;
        expect(assertsValueOf(call), `${call} scores as a claim about a value`).toBe(false);
      }
    }

    // The rest of the family, which no pattern in this pack derives because these ask about a
    // member, a function or a callable rather than about a declaration. Typed out and pinned as a
    // set, because the omission this test exists to catch is precisely the one nobody wrote down.
    for (const call of [
      "$this->assertTrue(method_exists($controller, 'confirm'));",
      "$this->assertFalse(method_exists($controller, 'confirm'));",
      "$this->assertTrue(property_exists($order, 'paidAt'));",
      "$this->assertFalse(property_exists($order, 'paidAt'));",
      "$this->assertTrue(function_exists('order_total'));",
      "$this->assertFalse(function_exists('order_total'));",
      "$this->assertTrue(is_callable([$controller, 'confirm']));",
      "$this->assertFalse(is_callable([$controller, 'confirm']));",
    ]) {
      expect(assertsValueOf(call), `${call} scores as a claim about a value`).toBe(false);
    }
  });

  test("subtracts an inherited homonym under every receiver whose spelling PHP fixes", () => {
    // The reflection exclusions above are receiver-agnostic: assertTrue(method_exists( reaches
    // $this->, self:: and static:: alike, because the receiver sits left of the term and outside the
    // string. An exclusion that names the receiver does not, so it has to name all of them or the
    // same call scores differently depending on how the author spelled it. PHPUnit's assertJson is
    // final public static, so all five spellings below reach the identical method. Derived from the
    // list rather than typed out, so a receiver-anchored exclusion added in one spelling and
    // forgotten in the others comes back red here.
    //
    // These five are the closed part and not the whole problem. A receiver that is an identifier
    // somebody chose (`Assert as A`, a project's own base test class) cannot be enumerated at all,
    // which is why docs/04 calls this residue narrowed rather than closed, and why the case table
    // below pins the alias spelling as the false positive it still is.
    const receivers = ["$this->", "self::", "static::", "parent::", "Assert::"];
    const excludes = pack.tests.assertionExcludes;
    const methods = excludes
      .filter((entry) => entry.startsWith("$this->"))
      .map((entry) => entry.slice("$this->".length));

    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      for (const receiver of receivers) {
        expect(excludes, `${method} is subtracted only through some receivers`).toContain(
          `${receiver}${method}`,
        );
      }
    }
  });

  test("reads each PHP assertion dialect as the verdict its call site earns", () => {
    // A table of call sites, not a table of strings compared to the term list. The guard this
    // replaces compared bare tokens ("assertStatus") against terms that carry the arrow
    // ("->assertSee("), so `"assertStatus".includes("->assertStatus")` was false and re-adding the
    // exact term this PR removed left it green. Every row below runs the matcher, so a term that
    // comes back scores a real call and turns its row red.
    const cases: [call: string, assertsValue: boolean][] = [
      // PHPUnit, positive: the dialect the pack has always read.
      ["$this->assertSame(1250, $order->totalCents());", true],
      ["$this->assertEquals('paid', $order->status());", true],
      ["$this->assertTrue($order->isPaid());", true],
      ["$this->assertNull($order->cancelledAt());", true],
      ["$this->assertEmpty($order->refunds());", true],
      ["$this->assertCount(3, $order->lines());", true],
      ["$this->assertContains('paid', $order->statusHistory());", true],
      ["$this->assertStringContainsString('EUR 12.50', $invoice->render());", true],
      // The two terms deliberately written without their parenthesis, so that the row absorbs the
      // OrEqual sibling too. No sibling of either prefix claims less than the prefix does, which is
      // the check docs/04 asks for before leaving the parenthesis off.
      ["$this->assertGreaterThan(0, $order->totalCents());", true],
      ["$this->assertLessThan(1250, $order->discountCents());", true],
      ["$this->assertMatchesRegularExpression('/^ORD-\\d+$/', $order->reference());", true],
      // PHPUnit, negated. These went in with this change: "the refund did not happen" is as much a
      // claim about a value as "it did", and without them a whole test file could score blind.
      ["$this->assertNotNull($order->paidAt());", true],
      ["$this->assertNotEmpty($order->lines());", true],
      ["$this->assertNotSame($first, $second);", true],
      ["$this->assertStringNotContainsString('error', $body);", true],
      ["$this->assertNotEquals($original->totalCents(), $order->totalCents());", true],
      ["$this->assertNotContains('refunded', $order->statusHistory());", true],
      // PHPUnit reflection. Same term, and only the argument differs, which is why the pack names
      // the spelling to subtract instead of dropping assertTrue( and losing the three rows above.
      ["$this->assertTrue(method_exists($controller, 'confirm'));", false],
      ["$this->assertTrue(property_exists($order, 'paidAt'));", false],
      ["$this->assertTrue(is_callable([$controller, 'confirm']));", false],
      ["$this->assertFalse(class_exists(LegacyOrder::class));", false],
      // The two declarations the list forgot. `trait` and `enum` are as much a declaration to this
      // pack as `class` is, they sit in its namePattern next to it, and no entry reached them as a
      // substring, so `assertTrue(enum_exists(OrderStatus::class))` kept the assertTrue( term and
      // scored its file as claiming a value.
      ["$this->assertTrue(trait_exists(Billable::class));", false],
      ["$this->assertTrue(enum_exists(OrderStatus::class));", false],
      // The negated half of the same eight predicates. It ran two spellings short of the positive
      // half, so an interface check scored a value assertion written one way and not the other.
      ["$this->assertFalse(interface_exists(ShippableContract::class));", false],
      ["$this->assertFalse(trait_exists(LegacyBillable::class));", false],
      ["$this->assertFalse(enum_exists(LegacyStatus::class));", false],
      ["$this->assertFalse(is_callable([$controller, 'refund']));", false],
      // Pest, classless: a value assertion in a dialect no PHPUnit term can see.
      ["expect($order->totalCents())->toBe(1250);", true],
      ["expect($order->status())->toEqual('paid');", true],
      ["expect($order->lines())->toHaveCount(3);", true],
      ["expect(fn () => $order->refund())->toThrow(DomainException::class);", true],
      ["expect($order->isPaid())->toBeTrue();", true],
      ["expect($order->isRefunded())->toBeFalse();", true],
      ["expect($order->cancelledAt())->toBeNull();", true],
      ["expect($order->refunds())->toBeEmpty();", true],
      ["expect($order->reference())->toHaveLength(12);", true],
      ["expect($order->reference())->toMatch('/^ORD-\\d+$/');", true],
      ["expect($order->reference())->toStartWith('ORD-');", true],
      ["expect($invoice->filename())->toEndWith('.pdf');", true],
      ["expect($order->toArray())->toMatchArray(['total_cents' => 1250]);", true],
      ["expect($order->totalCents())->toBeGreaterThan(0);", true],
      ["expect($order->discountCents())->toBeLessThan(1250);", true],
      // ->toContain( is the term this change repaired by writing the parenthesis into it, and only
      // half of that repair is checkable from the type assertion it used to swallow. The row further
      // down proves it no longer reaches ->toContainOnlyInstancesOf(; this one proves it still
      // reaches the containment assertion it was added for, which is the half a deletion would take
      // silently. docs/04 pairs it with ->assertSee(: one claim about rendered output, two spellings.
      ["expect($receipt->render())->toContain('total: 12.50');", true],
      // Laravel HTTP liveness: the route answered, and nothing was claimed about what it answered.
      // "->assertStatus" scored 14 of 15 test files before it came out.
      ["$response->assertOk();", false],
      ["$response->assertStatus(200);", false],
      ["$response->assertRedirect('/orders');", false],
      ["$response->assertNotFound();", false],
      ["$response->assertSuccessful();", false],
      // Laravel, reading the response body or the row: a claim about a value, so these count.
      ["$response->assertJsonPath('data.status', 'paid');", true],
      ["$response->assertExactJson(['id' => 1, 'status' => 'paid']);", true],
      // The two commonest Laravel body assertions, and the reason they went in: a feature test whose
      // only claim is assertJson(['total_cents' => 1250]) claims a number, and without these terms
      // every flow reached only by such tests was reported blind.
      ["$response->assertJson(['total_cents' => 1250]);", true],
      ["$response->assertJsonFragment(['status' => 'paid']);", true],
      // The shape-only sibling, which must stay out: a letter follows assertJson in every one of
      // assertJsonStructure(, assertJsonCount( and assertJsonMissing(, so neither new term can reach
      // them. This row runs the matcher over the nearest one rather than reasoning about the string.
      ["$response->assertJsonStructure(['data' => ['status']]);", false],
      // The inherited homonym, which is a different method on a different receiver: PHPUnit's
      // Assert::assertJson(string $actual) takes one argument and asserts only that it parses as
      // JSON. Every Laravel test class extends PHPUnit's TestCase, so this spelling is in scope in
      // every file the pack reads, and it claims less than assertJsonStructure( on the row above.
      ["$this->assertJson($response->getContent());", false],
      ["self::assertJson($response->getContent());", false],
      ["static::assertJson($body);", false],
      ["parent::assertJson($body);", false],
      ["Assert::assertJson($body);", false],
      // The fully-qualified spelling costs no entry of its own: it ends in the string the row above
      // names, so subtracting `Assert::assertJson(` subtracts it too. Pinned because that is a fact
      // about substrings and not about PHP, and a future entry rewritten to anchor on the namespace
      // would lose it silently.
      ["\\PHPUnit\\Framework\\Assert::assertJson($body);", false],
      // The residue docs/04 records rather than claims to have fixed. `use PHPUnit\Framework\Assert
      // as A;` reaches the identical one-argument method through a receiver no pack can enumerate,
      // and the file scores as asserting a value while asserting only that a string parses. This row
      // pins a wrong answer on purpose, so that the doc's claim is checked rather than trusted. If a
      // later change closes it, this row goes red and docs/04's "narrowed, not closed" paragraph is
      // what to rewrite, not this expectation.
      ["A::assertJson($body);", true],
      ["$response->assertSee('Refunded');", true],
      ["$this->assertDatabaseHas('orders', ['status' => 'paid']);", true],
      ["$this->assertDatabaseMissing('refunds', ['order_id' => $order->id]);", true],
      // The rest of the Laravel response surface the pack takes, each pinned in the spelling that
      // carries a value. Every one of these has a value-free spelling a test could have been written
      // in: ->assertViewHas('total') names a key and claims nothing about it, ->assertHeader('ETag')
      // says a header was sent. The term is a substring, so it cannot tell the two apart. The
      // rows pin what the term is for, not the weakest thing it will match.
      ["$response->assertViewHas('total', 1250);", true],
      ["$response->assertHeader('Content-Disposition', 'attachment; filename=invoice.pdf');", true],
      ["$response->assertSessionHasErrors(['email' => 'The email field is required.']);", true],
      // Livewire: assertSet and assertHasErrors name a value, assertSuccessful only says it drew.
      ["Livewire::test(OrderPanel::class)->assertSet('status', 'paid');", true],
      ["Livewire::test(OrderPanel::class)->assertHasErrors(['email']);", true],
      ["Livewire::test(OrderPanel::class)->assertHasFormErrors(['email' => 'required']);", true],
      ["Livewire::test(OrderPanel::class)->assertSuccessful();", false],
      // Type assertions: proving the shape is not proving the number, and every one of these is a
      // term-swallowing trap. ->toBe( must not reach ->toBeInstanceOf(, nor ->toContain( reach
      // ->toContainOnlyInstancesOf(, which is the bug docs/04 names.
      ["$this->assertInstanceOf(Order::class, $found);", false],
      ["expect($found)->toBeInstanceOf(Order::class);", false],
      ["expect($lines)->toContainOnlyInstancesOf(Line::class);", false],
      // No assertion at all: the test runs the code and claims nothing.
      ["$this->get('/orders');", false],
    ];

    for (const [call, expected] of cases) {
      expect(assertsValueOf(call), `${call} should assert a value: ${expected}`).toBe(expected);
    }
  });

  test("lets a real assertion stand next to a call the pack subtracts or ignores", () => {
    // The exclusions are removed from the source before the terms are matched, so the risk they
    // carry is over-reach: one reflection check must not blank a file that also asserts on a value.
    // Real test files hold both, so a red here means the field traded one wrong answer for another.
    const withReflection = [
      "$this->assertTrue(method_exists($controller, 'confirm'));",
      "$this->assertSame(1250, $order->totalCents());",
    ].join("\n");
    const withLiveness = [
      "$response->assertStatus(422);",
      "$response->assertJsonValidationErrors(['email']);",
    ].join("\n");
    // The two assertJson spellings in one file, which is the over-reach the receiver-anchored
    // exclusion could plausibly cause: removing $this->assertJson( must leave $response->assertJson(
    // standing, and it does, because neither string is a substring of the other.
    const withBothJsonSpellings = [
      "$this->assertJson($response->getContent());",
      "$response->assertJson(['total_cents' => 1250]);",
    ].join("\n");

    expect(assertsValueOf(withReflection)).toBe(true);
    expect(assertsValueOf(withLiveness)).toBe(true);
    expect(assertsValueOf(withBothJsonSpellings)).toBe(true);
  });

  test("declares no assertion term that swallows another term or a type assertion", () => {
    // ->toContain once shipped without its parenthesis and matched ->toContainOnlyInstancesOf(,
    // which asserts a type and not a value: the exact trap docs/04 names around toBeDefined(.
    const terms = pack.tests.assertionTerms;
    expect(new Set(terms).size).toBe(terms.length);

    // The liveness family sits here with the type assertions because it is the same trap wearing the
    // other coat, and it is the one this pack actually fell into: ->assertStatus qualified 14 of 15
    // test files while claiming nothing about a value. A term reaching one of
    // these re-admits that whole family, so the list a future addition is checked against has to
    // name them. assertJson( and assertJsonFragment( went in under exactly this guard.
    //
    // What this guard cannot check is a term that is only weak under some receivers, so the entries
    // below are all whole call spellings and none of them carries a receiver. $this->assertJson( is
    // deliberately absent: assertJson( does match it, and it is meant to, because the answer there
    // is an assertionExcludes entry and not a narrower term. The test above pins that instead.
    const mustNotMatch = [
      "->toContainOnlyInstancesOf(",
      "->toBeInstanceOf(",
      "assertInstanceOf(",
      "->toBeDefined(",
      "->assertStatus(",
      "->assertOk(",
      "->assertSuccessful(",
      "->assertRedirect(",
      "->assertJsonStructure(",
      "->assertViewIs(",
      "->toBeTruthy(",
    ];

    for (const term of terms) {
      for (const typeAssertion of mustNotMatch) {
        expect(typeAssertion.includes(term), `${term} matches ${typeAssertion}`).toBe(false);
      }
      for (const other of terms) {
        if (other === term) continue;
        expect(other.includes(term), `${term} makes ${other} unreachable`).toBe(false);
      }
    }
  });

  /**
   * The blade-to-class edge, named rather than left to the whole-file snapshot for the reason the
   * assertion pair above is named: `empo pack test php --update` rewrites expected.json to whatever
   * the code just did, so a regression that changed the answer would rewrite its own evidence.
   *
   * Before this family existed a view-component class wrapping every block on every public page
   * came out with fan-in 1, and the single edge was its own unit test, so it read as test-only
   * code. That is the answer these rows exist to keep fixed.
   */
  describe("template edges from a blade tag to the component class", () => {
    const VIEW = "resources/views/orders/show.blade.php";

    function templateTargets(): string[] {
      return actual.edges
        .filter((edge) => edge.kind === "template" && edge.from === VIEW)
        .map((edge) => edge.to)
        .sort();
    }

    test("resolves the plain, the dotted and both livewire spellings", () => {
      expect(templateTargets()).toEqual([
        // @livewire('order-panel'), the directive spelling that predates the tag.
        "Acme\\Livewire\\OrderPanel",
        // <livewire:order-status />, the tag spelling.
        "Acme\\Livewire\\OrderStatus",
        // <x-layout.app-shell>, so last-dot-segment ran before pascal-case.
        "Acme\\View\\Components\\Layout\\AppShell",
        // <x-price-badge />, the plain kebab-cased form.
        "Acme\\View\\Components\\PriceBadge",
        // @extends('layouts.app') and @include('orders.row'): the `view` strategy, which is the
        // only thing here whose target is a template rather than a class.
        "resources/views/layouts/app.blade.php",
        "resources/views/orders/row.blade.php",
      ]);
    });

    test("names no class whose tag sits inside a blade comment", () => {
      // LegacyBadge is a real node and its tag is written only inside {{-- --}}. An edge to it
      // would be a phantom coupling citing a comment, which is the one failure engine/mask.ts
      // exists to prevent and the reason this change could not ship without its masking half.
      expect(actual.edges.some((edge) => edge.to.endsWith("LegacyBadge"))).toBe(false);
    });

    test("refuses the tag whose short name two components share", () => {
      // <x-forms.text-input> folds to TextInput and so does <x-fields.text-input>, so the strategy
      // resolves neither. Ranked as a cost worth measuring rather than a bug:
      // guessing would put a wrong file:line in front of a reader.
      expect(actual.edges.some((edge) => edge.to.endsWith("TextInput"))).toBe(false);
    });

    test("cites the line the tag is on, in the file that wrote it", () => {
      const badge = actual.edges.find(
        (edge) => edge.to === "Acme\\View\\Components\\PriceBadge" && edge.from === VIEW,
      );

      expect(badge?.evidence).toEqual({ file: VIEW, line: 30 });
    });
  });

  /**
   * The direction the graph could not express at all until the `view` strategy landed: every
   * template edge ran out of a blade file and none ran into one, so a change to a controller never
   * reported the page it renders. Measured on a real Laravel repository, 69 blade files on one
   * journey had zero incoming edges.
   */
  describe("view edges into a template", () => {
    function viewTargets(from: string): string[] {
      return actual.edges
        .filter((edge) => edge.kind === "template" && edge.from === from)
        .map((edge) => edge.to)
        .sort();
    }

    test("runs an edge from the controller that renders a view to the blade file", () => {
      expect(viewTargets("Acme\\Http\\Controllers\\OrderController")).toEqual([
        "resources/views/orders/show.blade.php",
      ]);
    });

    test("reads the facade spelling and refuses every near-miss beside it", () => {
      // ReceiptController holds one real render and five things shaped like one, so a single
      // assertion holds all four lookbehinds in place. `\View::make('layouts.app')` resolves.
      // `$mail->view(...)` is a method on somebody's object; `TextView::make(...)` is a class whose
      // name merely ends in the facade's; and `Acme\View::make(...)`, `Acme\Route::view(...)` and
      // `Acme\view(...)` name this application's own class and function rather than Laravel's,
      // since the framework's are reachable unqualified or behind the one leading separator that
      // means the global namespace.
      //
      // What the last of those costs is the fully-qualified inline facade,
      // `Illuminate\Support\Facades\View::make(...)`, which real code writes as a `use` plus a bare
      // `View::make(...)`. A missed edge is the acceptable direction here and an invented one is
      // not, which is the same trade every refusal in this pack makes.
      expect(viewTargets("Acme\\Http\\Controllers\\ReceiptController")).toEqual([
        "resources/views/layouts/app.blade.php",
      ]);
    });

    test("runs an edge from a route file straight to the template it renders", () => {
      // `Route::view('/layout-preview', 'layouts.app')`: the view name is the SECOND argument, so
      // the global `view(` rule refuses the line (its lookbehind excludes `:`) and a rule of its
      // own reads it. Capturing the first argument would have named the URL, which is a lookup
      // that resolves to nothing and reports a loss nobody can repair.
      expect(viewTargets("routes/api.php")).toEqual(["resources/views/layouts/app.blade.php"]);
    });

    test("counts the view name no file in the corpus carries", () => {
      // @include('orders.archived'). A strategy that can silently resolve nothing is not one
      // anybody can call proven, so the miss is a number rather than an absence.
      const template = actual.names.find((record) => record.family === "template");

      expect(template?.unknown).toBe(1);
    });
  });

  test("selects its blade comment syntax through the compound extension, not through .php", () => {
    // The load-bearing half, watched rather than reasoned about. Re-extract the same blade file
    // with commentsByExtension removed from the loaded pack: the {{-- --}} pair is then unknown,
    // the commented-out tag is read as source, and LegacyBadge gains an edge citing a comment.
    // A red here means commentSyntaxFor stopped matching the longest dotted suffix, and the blade
    // masking is doing nothing while every test above still passes.
    const relPath = "resources/views/orders/show.blade.php";
    const source = readFileSync(`${fixturesDir("php")}/src/${relPath}`, "utf8");
    const scanned = { root: ".", lang: "php", file: relPath, relPath, source };

    const masked = extractFile(compiled, scanned);
    const unmasked = extractFile(compilePack({ ...pack, commentsByExtension: undefined }), scanned);

    expect(masked?.captures.map((capture) => capture.groups[1])).not.toContain("LegacyBadge");
    expect(unmasked?.captures.map((capture) => capture.groups[1])).toContain("LegacyBadge");
  });

  test("drops edges to classes that are not in the graph", () => {
    // routes/api.php imports Illuminate\Support\Facades\Route, which no node provides.
    expect(actual.edges.some((edge) => edge.to.startsWith("Illuminate"))).toBe(false);
  });

  test("marks every kind Laravel reaches by convention as framework-resolved", () => {
    // These are the kinds a fan-in of zero says nothing about: a view rendered by name, a migration
    // the runner discovers, a policy found by its class name. Without the mark `empo query
    // --orphans` offers each of them as dead code (docs/06-cli.md).
    const resolvedBy = new Map(pack.node.kindRules.map((rule) => [rule.kind, rule.resolvedBy]));

    for (const kind of [
      "route-file",
      "view",
      "migration",
      "seeder",
      "factory",
      "config",
      "bootstrap",
      "policy",
      "command",
      "livewire",
    ]) {
      expect(resolvedBy.get(kind), `${kind} should be framework-resolved`).toBe("framework");
    }
  });

  test("marks the three kinds somebody outside the code arrives at, and no others", () => {
    // A second axis over the same rules, and it has to travel through the real `loadPack` to be
    // worth anything: a field the schema does not declare is stripped at load, and a stripped
    // `arrivedBy` does not error, it silently takes the route files back out of `empo init`'s
    // brief, which is the exact defect this field exists to fix. That is the `multilineQuotes`
    // scar one field over, so `pack` here is what the loader returned and never a literal.
    //
    // A request hits a route file, an operator runs a console command, a page mounts a Livewire
    // component. Every one of the three also carries `resolvedBy`, which is not a contradiction:
    // the framework reaches it AND a journey starts at it, and only the second axis says so.
    const arrivedBy = new Map(pack.node.kindRules.map((rule) => [rule.kind, rule.arrivedBy]));

    for (const kind of ["route-file", "command", "livewire"]) {
      expect(arrivedBy.get(kind), `${kind} should be arrived at by a user`).toBe("user");
    }

    // "and no others" is asserted over every remaining rule rather than over a list somebody typed,
    // because a list is where this claim quietly stops being true: the first version of this test
    // named seven kinds and left `model`, `job` and `class` uncovered, so marking any of the three
    // kept the whole suite green. `class` is the damaging one, since it is the default rule with no
    // glob, and marking it would rank every plain class in the repository as a place a journey
    // starts.
    const marked = new Set(["route-file", "command", "livewire"]);
    for (const rule of pack.node.kindRules) {
      if (marked.has(rule.kind)) continue;
      expect(rule.arrivedBy, `${rule.kind} is not where a journey starts`).toBeUndefined();
    }

    // The named half of the same claim, kept because it says which kinds this pack has opinions
    // about: a view is rendered by a controller the user already reached, a migration is run by a
    // deploy, a policy is consulted mid-request.
    for (const kind of [
      "view",
      "migration",
      "seeder",
      "factory",
      "config",
      "bootstrap",
      "policy",
    ]) {
      expect(arrivedBy.get(kind), `${kind} is not where a journey starts`).toBeUndefined();
    }
  });

  test("leaves the kinds a caller reaches through a real edge unmarked", () => {
    // A model is imported, a job is dispatched, a plain class is used. Each has a visible edge, so
    // a fan-in of zero on one of them is a genuine dead-code candidate and stays on the list.
    const resolvedBy = new Map(pack.node.kindRules.map((rule) => [rule.kind, rule.resolvedBy]));

    for (const kind of ["model", "job", "class"]) {
      expect(resolvedBy.get(kind), `${kind} should not be framework-resolved`).toBeUndefined();
    }
  });

  test("keeps the framework path globs ahead of the model, job and class rules", () => {
    // kindRules are first match. `class` has no glob and matches everything, so a rule added after
    // it would never fire, and `model` would swallow a policy if the two globs ever overlapped.
    const kinds = pack.node.kindRules.map((rule) => rule.kind);

    expect(kinds.indexOf("policy")).toBeLessThan(kinds.indexOf("class"));
    expect(kinds.indexOf("livewire")).toBeLessThan(kinds.indexOf("model"));
    expect(kinds.at(-1)).toBe("class");
  });

  test("is deterministic across runs", () => {
    const second = runPackFixtures("php");
    expect(JSON.stringify(second.actual)).toBe(JSON.stringify(actual));
  });
});
