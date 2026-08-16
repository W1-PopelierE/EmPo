import { describe, expect, test } from "vitest";
import { type ChangedFile, parseDiff } from "../../src/engine/diff";
import { guardSpines, guardsPath, matchesPattern, testFileMatcher } from "../../src/engine/guard";
import { loadPack } from "../../src/engine/pack-loader";
import type { LoadedSpine } from "../../src/engine/spines";
import { configSchema, type EmpoConfig } from "../../src/schema/config.schema";
import type { Pack } from "../../src/schema/pack.schema";
import { parseSpineFile } from "../../src/schema/spine.schema";

/**
 * The commit gate reads two artifacts and nothing else: a diff and a spine. So every case here
 * builds its diff as unified diff text and runs it through the real parser, rather than hand-writing
 * hunks: a `ChangedFile` a human assembled can hold a line number no diff would ever produce, and
 * the gate's whole value is that it agrees with what git staged. Spines go through the schema for
 * the same reason, so a spine used in a test is always a spine `empo check` could have loaded.
 */

/** One file's worth of unified diff. `body` is hunk headers and their lines, verbatim. */
function edit(path: string, ...body: string[]): string[] {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body];
}

/**
 * A file this change moves, written the way git writes a rename it detected: the two paths on the
 * header, `rename from`/`rename to` naming one each, and hunks for whatever edit rode along. Written
 * out rather than assembled, because the whole point of these cases is that the gate agrees with
 * what git records, and a hand-built `ChangedFile` could claim a rename git would never report.
 */
function rename(from: string, to: string, ...body: string[]): string[] {
  return [
    `diff --git a/${from} b/${to}`,
    "similarity index 96%",
    `rename from ${from}`,
    `rename to ${to}`,
    `--- a/${from}`,
    `+++ b/${to}`,
    ...body,
  ];
}

/** The same, for a file this change removes. `+++ /dev/null` is what makes it a deletion. */
function deletion(path: string, ...body: string[]): string[] {
  return [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    `--- a/${path}`,
    "+++ /dev/null",
    ...body,
  ];
}

/** The other half of a move git did not detect as one: a file with no old side. */
function addition(path: string, ...body: string[]): string[] {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    ...body,
  ];
}

/** One line per argument, because a diff is made of lines whose leading spaces are structure. */
function changed(...lines: string[]): ChangedFile[] {
  return parseDiff(`${lines.join("\n")}\n`);
}

function spine(
  name: string,
  guarded: string[],
  assertionTerms: string[],
  assertionPaths: string[] = [],
): LoadedSpine {
  const path = `.empo/spines/${name}.json`;
  return {
    spine: parseSpineFile({ version: 1, name, guarded, assertionTerms, assertionPaths }, path),
    path,
  };
}

const CALCULATOR = "apps/api/app/Libraries/Price/PriceCalculator.php";
const ORDER_TEST = "apps/api/tests/Feature/OrderTest.php";
const MONEY_TRAIT = "apps/api/app/Testing/AssertsMoney.php";

/** The gate's own idea of a test tree, stood in for so these cases never load a pack. */
const isTest = (path: string) => path.startsWith("apps/api/tests/");

/** A one-line edit to the money code, carrying nothing that could count as an assertion. */
const calculatorEdit = edit(
  CALCULATOR,
  "@@ -20,2 +20,2 @@ public function total(): int",
  "-        return $this->base;",
  "+        return $this->base + $this->vat;",
);

/** An assertion term added to production code. Realistic, and not a test by any pack's rule. */
const helperWithAssertion = edit(
  MONEY_TRAIT,
  "@@ -12 +12,2 @@ trait AssertsMoney",
  "     public function assertMoney(int $expected, int $actual): void {",
  "+        $this->assertSame($expected, $actual);",
);

/**
 * A test file with nothing to do with the guarded chain, in the same test tree. This is the
 * measurement's own shape: a theme test that imports nothing from
 * pricing and is named by no spine, whose added assertion used to satisfy the pricing gate.
 */
const UNRELATED_TEST = "apps/api/tests/Unit/ThemeTest.php";

/** The proof the pricing chain actually wants, added where the pricing spine keeps its tests. */
const assertionInOrderTest = edit(
  ORDER_TEST,
  "@@ -14 +14,2 @@ public function test_total(): void",
  "         $order = $this->order();",
  "+        $this->assertSame(1210, $order->total());",
);

/** The same term, added to a test about something else entirely. Real, and no evidence here. */
const assertionInUnrelatedTest = edit(
  UNRELATED_TEST,
  "@@ -8 +8,2 @@ public function test_theme(): void",
  "         $theme = $this->theme();",
  "+        $this->assertSame('dark', $theme->name());",
);

/** Outside the guarded tree, and the destination every move in these cases uses. */
const MOVED_CALCULATOR = "apps/api/app/Support/PriceCalculator.php";

/** The rounding change that rode along with the move in the measurement this pins. */
const ROUNDING_HUNK = [
  "@@ -20,2 +20,2 @@ public function total(): int",
  "-        return (int) floor($this->base * 1.21);",
  "+        return (int) round($this->base * 1.21);",
];

const pricing = spine("pricing", ["apps/api/app/Libraries/Price/**"], ["assertSame", "cents"]);

/** The same spine, curated one step further: it names the test files that speak for its chain. */
const scopedPricing = spine(
  "pricing",
  ["apps/api/app/Libraries/Price/**"],
  ["assertSame", "cents"],
  ["apps/api/tests/Feature/OrderTest.php"],
);

describe("matchesPattern", () => {
  test("matches every file under a globstar, however deep", () => {
    const pattern = "apps/api/app/Libraries/Price/**";

    expect(matchesPattern(CALCULATOR, pattern)).toBe(true);
    expect(matchesPattern("apps/api/app/Libraries/Price/Nested/Deep.php", pattern)).toBe(true);
  });

  test("matches only itself when the pattern is one exact file", () => {
    const pattern = "apps/api/app/Models/Order.php";

    expect(matchesPattern("apps/api/app/Models/Order.php", pattern)).toBe(true);
    expect(matchesPattern("apps/api/app/Models/OrderLine.php", pattern)).toBe(false);
  });

  test("guards the whole subtree of a bare directory, and not its name-alike neighbours", () => {
    // The trap the directory rule exists to avoid in both directions. Without the rule a spine
    // naming a folder would guard nothing at all, silently; with a naive startsWith it would also
    // guard PriceOther.php, which is a different file that nobody put on the chain.
    const pattern = "apps/api/app/Libraries/Price";

    expect(matchesPattern(CALCULATOR, pattern)).toBe(true);
    expect(matchesPattern("apps/api/app/Libraries/PriceOther.php", pattern)).toBe(false);
  });

  test("reads a trailing slash as no slash at all", () => {
    // A human writes a directory both ways, and a gate that only honours one of them fails open.
    expect(matchesPattern("apps/api/app/Models/Order.php", "apps/api/app/Models/")).toBe(true);
    expect(matchesPattern("apps/api/app/Models/Order.php", "apps/api/app/Models")).toBe(true);
  });

  test("matches nothing when the pattern is empty or only slashes", () => {
    // Both clean down to nothing, and "nothing" must not become "the whole repository".
    expect(matchesPattern(CALCULATOR, "")).toBe(false);
    expect(matchesPattern(CALCULATOR, "/")).toBe(false);
    expect(matchesPattern(CALCULATOR, "///")).toBe(false);
  });

  test("does not let a single star cross a path separator", () => {
    expect(matchesPattern("apps/api/Kernel.php", "apps/api/*.php")).toBe(true);
    expect(matchesPattern("apps/api/app/X.php", "apps/api/*.php")).toBe(false);
  });

  test("guards a dotfile through the glob form exactly as the directory form does", () => {
    // The regression this pins: picomatch skips dot-names by default, so the glob form used to
    // guard config/app.php and wave config/.env through while the bare directory guarded both.
    // Two spellings of one intent answering differently is bad anywhere; in a gate it failed open,
    // and .env is precisely the file whose change moves a number.
    const config = "apps/api/config";

    for (const pattern of [`${config}/**`, config]) {
      expect(matchesPattern(`${config}/app.php`, pattern)).toBe(true);
      expect(matchesPattern(`${config}/.env`, pattern)).toBe(true);
      expect(matchesPattern(`${config}/.secrets/keys.php`, pattern)).toBe(true);
    }
  });

  test("guards a dot-directory a spine names outright", () => {
    // A repository really does put chain-relevant files under a dot-directory, and a spine that
    // names one has said what it means as plainly as it can.
    expect(matchesPattern(".platform/hooks/deploy.sh", ".platform/**")).toBe(true);
    expect(matchesPattern(".platform/hooks/deploy.sh", ".platform")).toBe(true);
  });
});

describe("guardsPath", () => {
  /**
   * Thin over `matchesPattern`, so these cases pin what a caller depends on rather than the
   * matching again: that every entry in `guarded` is consulted, that an empty list claims nothing,
   * and that the dot rule survives the wrapper. Three surfaces ask it (the gate, the pre-edit hook,
   * `empo review`'s spine section) and a caller that answered differently from the gate would be
   * naming a spine `empo check` will not fire on, or staying silent about one it will.
   */
  test("consults every guarded entry, whichever of the three spellings claims the path", () => {
    const mixed = spine(
      "pricing",
      ["apps/api/app/Libraries/Price/**", "apps/api/app/Models/Order.php", "apps/api/config"],
      ["assertSame"],
    ).spine;

    expect(guardsPath(mixed, CALCULATOR)).toBe(true);
    expect(guardsPath(mixed, "apps/api/app/Models/Order.php")).toBe(true);
    expect(guardsPath(mixed, "apps/api/config/pricing.php")).toBe(true);
    expect(guardsPath(mixed, "apps/mobile/src/screens/Cart.tsx")).toBe(false);
  });

  test("claims nothing when the spine guards nothing", () => {
    // The map-only spine `empo check` reports separately. An empty list is "no gate here", and the
    // one reading it must never widen to "everything", which would put every changed file on a
    // chain nobody curated.
    const mapOnly = spine("checkout", [], []).spine;

    expect(guardsPath(mapOnly, CALCULATOR)).toBe(false);
    expect(guardsPath(mapOnly, "apps/api/app/Models/Order.php")).toBe(false);
  });

  test("inherits the dot rule, so a dotfile under a guarded directory is guarded", () => {
    // Pinned at this level and not only on matchesPattern, because this is the property the callers
    // rest on and a caller that matched with picomatch's defaults would answer false here while the
    // gate answered true. It failed in the one direction a gate may never fail, letting a change
    // through, and .env is exactly the file whose change moves a number.
    const config = spine("config", ["apps/api/config/**", ".platform"], ["assertSame"]).spine;

    expect(guardsPath(config, "apps/api/config/.env")).toBe(true);
    expect(guardsPath(config, "apps/api/config/.secrets/keys.php")).toBe(true);
    expect(guardsPath(config, ".platform/hooks/deploy.sh")).toBe(true);
  });
});

describe("guardSpines", () => {
  test("passes a spine whose guarded globs match nothing in the change", () => {
    const files = changed(
      ...edit(
        "apps/mobile/src/screens/Cart.tsx",
        "@@ -3 +3 @@",
        "-const label = 'cart';",
        "+const label = 'basket';",
      ),
    );

    expect(guardSpines([pricing], files, isTest)).toEqual([
      {
        name: "pricing",
        path: ".empo/spines/pricing.json",
        guards: true,
        termsWanted: ["assertSame", "cents"],
        pathsWanted: [],
        touched: [],
        assertions: [],
        passed: true,
      },
    ]);
  });

  test("gates nothing when the spine guards nothing", () => {
    // A spine can be a map with no gate on it, which is the common case. It must report that it
    // guards nothing rather than pass silently, so `empo check` can say the gate did not run.
    const mapOnly = spine("checkout", [], []);

    const verdict = guardSpines([mapOnly], changed(...calculatorEdit), isTest)[0];

    expect(verdict?.guards).toBe(false);
    expect(verdict?.touched).toEqual([]);
    expect(verdict?.passed).toBe(true);
  });

  test("fails when a guarded file changes and no assertion line is added", () => {
    const verdict = guardSpines([pricing], changed(...calculatorEdit), isTest)[0];

    expect(verdict?.passed).toBe(false);
    expect(verdict?.touched).toEqual([{ path: CALCULATOR, movedTo: null }]);
    expect(verdict?.assertions).toEqual([]);
  });

  test("passes on an added assertion line, and reports where an author can open it", () => {
    const files = changed(
      ...calculatorEdit,
      ...edit(
        ORDER_TEST,
        "@@ -30 +30,2 @@ public function test_total(): void",
        "         $order = $this->order();",
        "+        $this->assertSame(1200, $order->total());",
      ),
    );

    const verdict = guardSpines([pricing], files, isTest)[0];

    expect(verdict?.passed).toBe(true);
    expect(verdict?.touched).toEqual([{ path: CALCULATOR, movedTo: null }]);
    // The line number is the one in the new file, because that is the line the author opens, and
    // the text is trimmed so a message can print it inline whatever the file's indentation is.
    expect(verdict?.assertions).toEqual([
      {
        file: ORDER_TEST,
        line: 31,
        term: "assertSame",
        text: "$this->assertSame(1200, $order->total());",
      },
    ]);
  });

  test("does not count an assertion term added outside a test file", () => {
    // A trait under app/ that tests use is still not a test: counting it would let the gate be
    // satisfied by production code that merely mentions the word.
    const files = changed(...calculatorEdit, ...helperWithAssertion);

    const verdict = guardSpines([pricing], files, isTest)[0];

    expect(verdict?.passed).toBe(false);
    expect(verdict?.assertions).toEqual([]);
  });

  test("is satisfied by an unrelated test where the spine names no assertionPaths", () => {
    // Not the behaviour anybody wants, and pinned deliberately, because it is the default every
    // spine written before `assertionPaths` existed still gets and the two cases below are only
    // meaningful against it. The gate prints the file the assertion came from, so a human reading
    // the output can see it is unrelated; nothing mechanical can, and that is what the next case
    // buys. Measured on a real gate.
    const files = changed(...calculatorEdit, ...assertionInUnrelatedTest);

    const verdict = guardSpines([pricing], files, isTest)[0];

    expect(verdict?.passed).toBe(true);
    expect(verdict?.assertions).toMatchObject([{ file: UNRELATED_TEST, term: "assertSame" }]);
  });

  test("does not count an assertion added outside the test files the spine names", () => {
    // The same diff as the case above and the opposite verdict, which is the whole of what the
    // field buys: the theme test is a real test, its assertion is real, and it is not evidence
    // about a rounding change in the money calculator.
    const files = changed(...calculatorEdit, ...assertionInUnrelatedTest);

    const verdict = guardSpines([scopedPricing], files, isTest)[0];

    expect(verdict?.passed).toBe(false);
    expect(verdict?.assertions).toEqual([]);
  });

  test("counts an assertion added inside them", () => {
    // The control, and it has to be here: a scope that never lets anything through is a gate no
    // change can satisfy, which is the one curation defect the schema refuses outright elsewhere.
    const files = changed(...calculatorEdit, ...assertionInOrderTest);

    const verdict = guardSpines([scopedPricing], files, isTest)[0];

    expect(verdict?.passed).toBe(true);
    expect(verdict?.assertions).toMatchObject([{ file: ORDER_TEST, term: "assertSame" }]);
  });

  test("narrows the pack's answer about a test file and never widens it", () => {
    // The direction the whole field turns on. `assertionPaths` intersects the pack's `tests.paths`
    // rather than replacing it, so a spine naming a file the pack does not call a test gets nothing
    // from it: a sloppy or over-wide scope costs its author a gate that is hard to satisfy, never
    // one that waves a change through. The trait here is exactly that shape, production code under
    // app/ that tests use, and the spine names it outright.
    //
    // This one is green against the behaviour before `assertionPaths` existed, because the pack
    // rule excluded the trait then too. What turns it red is the other reading of the field, where
    // a spine's paths replace the pack's answer instead of intersecting it, and that is the edit it
    // is here to stop. Watched red under exactly that mutation.
    const wide = spine(
      "pricing",
      ["apps/api/app/Libraries/Price/**"],
      ["assertSame"],
      [MONEY_TRAIT, "apps/api/tests/**"],
    );
    const files = changed(...calculatorEdit, ...helperWithAssertion);

    const verdict = guardSpines([wide], files, isTest)[0];

    expect(verdict?.passed).toBe(false);
    expect(verdict?.assertions).toEqual([]);
  });

  test("scopes a spine that names paths even where no pack could answer what a test is", () => {
    // The degraded mode meets the field: with no matcher the gate counts a term anywhere in the
    // diff, and a spine that named its own files has still said something the gate can honour. The
    // same diff passes unscoped (the case further down) and fails here.
    const files = changed(...calculatorEdit, ...helperWithAssertion);

    const verdict = guardSpines([scopedPricing], files, null)[0];

    expect(verdict?.passed).toBe(false);
    expect(verdict?.assertions).toEqual([]);
  });

  test("reads a spine's paths in the three forms a guarded pattern is written in", () => {
    // One field, one matcher (`matchesPattern`), so a human writing a directory or an exact file
    // here gets what they get in `guarded`. Written as three spines rather than one list, because
    // a single spine naming all three would pass on whichever form matched first. Red when the
    // scope is matched as an exact path, which is the shortcut this field invites.
    const forms = [
      "apps/api/tests/Feature/OrderTest.php",
      "apps/api/tests/Feature",
      "apps/api/tests/**/Order*.php",
    ];
    const files = changed(...calculatorEdit, ...assertionInOrderTest);

    for (const form of forms) {
      const scoped = spine("pricing", ["apps/api/app/Libraries/Price/**"], ["assertSame"], [form]);

      expect(guardSpines([scoped], files, isTest)[0]?.passed, form).toBe(true);
    }
  });

  test("judges each spine on its own scope, so one can fail while another passes", () => {
    // Two spines guarding the same file and the same diff, differing only in whether they curate
    // their tests. A scope is per spine, never a mode the whole gate runs in, so the answer has to
    // be able to split like this.
    const files = changed(...calculatorEdit, ...assertionInUnrelatedTest);

    const verdicts = guardSpines([pricing, scopedPricing], files, isTest);

    expect(verdicts.map((verdict) => verdict.passed)).toEqual([true, false]);
  });

  test("counts a term the pack would have subtracted, because a spine's list is hand-written", () => {
    // The gate matches a spine's terms with nothing removed first, while engine/extractor.ts
    // subtracts the pack's `assertionExcludes` before it looks. `assertTrue(method_exists(` is in
    // that exclusion list, so this exact added line proves nothing to the graph and is proof here.
    // That is the intended split and not a leak: a pack's list runs unattended over every test file
    // in a repository, a spine's list is three tokens a human wrote for one chain and can edit. The
    // exclusion is read off the installed pack rather than assumed, because the claim is about two
    // real rules disagreeing, and a test that only asserted `includes` would still pass on a day the
    // pack stopped excluding anything and there was nothing left to diverge.
    const liveness = "$this->assertTrue(method_exists($order, 'confirm'));";
    const excludes = loadPack("php").tests.assertionExcludes;
    expect(excludes.some((exclusion) => liveness.includes(exclusion))).toBe(true);

    const guarded = spine("pricing", ["apps/api/app/Libraries/Price/**"], ["assertTrue"]);
    const files = changed(
      ...calculatorEdit,
      ...edit(
        ORDER_TEST,
        "@@ -30 +30,2 @@ public function test_confirm(): void",
        "         $order = $this->order();",
        `+        ${liveness}`,
      ),
    );

    const verdict = guardSpines([guarded], files, isTest)[0];

    expect(verdict?.passed).toBe(true);
    expect(verdict?.assertions).toEqual([
      { file: ORDER_TEST, line: 31, term: "assertTrue", text: liveness },
    ]);
  });

  test("counts every changed file when no matcher is available", () => {
    // The degraded mode: with no pack declaring a test path there is no honest way to tell a test
    // from anything else, so the gate weakens rather than failing every guarded change. Same diff
    // as the case above, opposite verdict, which is the whole difference the null carries.
    const files = changed(...calculatorEdit, ...helperWithAssertion);

    const verdict = guardSpines([pricing], files, null)[0];

    expect(verdict?.passed).toBe(true);
    expect(verdict?.assertions).toMatchObject([{ file: MONEY_TRAIT, term: "assertSame" }]);
  });

  test("does not count an assertion line the change deletes", () => {
    // Deleting an assertion is the opposite of adding one, and a substring match that ignored the
    // marker would read this change as evidence for itself.
    const files = changed(
      ...calculatorEdit,
      ...edit(
        ORDER_TEST,
        "@@ -30,2 +30 @@ public function test_total(): void",
        "         $order = $this->order();",
        "-        $this->assertSame(1200, $order->total());",
      ),
    );

    const verdict = guardSpines([pricing], files, isTest)[0];

    expect(verdict?.passed).toBe(false);
    expect(verdict?.assertions).toEqual([]);
  });

  test("does not count an assertion that was already there as context", () => {
    // An assertion written last month is evidence about the change that added it. Reusing it here
    // would let any edit to the chain pass as long as some test nearby already asserted something.
    const files = changed(
      ...calculatorEdit,
      ...edit(
        ORDER_TEST,
        "@@ -30,2 +30,3 @@ public function test_total(): void",
        "         $this->assertSame(1200, $order->total());",
        "+        $order->refresh();",
        "         $this->assertTrue(true);",
      ),
    );

    const verdict = guardSpines([pricing], files, isTest)[0];

    expect(verdict?.passed).toBe(false);
    expect(verdict?.assertions).toEqual([]);
  });

  test("counts a deleted guarded file as touched", () => {
    // Removing a file from the chain is a change to the chain, and the loudest kind.
    const files = changed(
      ...deletion(CALCULATOR, "@@ -1,2 +0,0 @@", "-<?php", "-class PriceCalculator {}"),
    );

    expect(files[0]?.status).toBe("deleted");

    const verdict = guardSpines([pricing], files, isTest)[0];

    expect(verdict?.touched).toEqual([{ path: CALCULATOR, movedTo: null }]);
    expect(verdict?.passed).toBe(false);
  });

  test("counts a guarded file renamed out of the guarded tree, and names where it went", () => {
    // The measured defect. git records `git mv` out of a guarded
    // tree as a rename, so the only guarded spelling is the old path, and a gate reading `file.path`
    // alone printed "touched none of its guarded files" and exited 0 while the rounding of a guarded
    // money calculation changed in that same commit.
    const files = changed(...rename(CALCULATOR, MOVED_CALCULATOR, ...ROUNDING_HUNK));

    expect(files[0]?.status).toBe("renamed");

    const verdict = guardSpines([pricing], files, isTest)[0];

    expect(verdict?.touched).toEqual([{ path: CALCULATOR, movedTo: MOVED_CALCULATOR }]);
    expect(verdict?.passed).toBe(false);
  });

  test("catches the same move written past git's similarity threshold, and reports it identically", () => {
    // The other half of the measurement, and the reason it was called an inversion: rewrite the file
    // enough and git records delete + add instead of a rename, the delete half carries the old path,
    // and the gate fired where it had waved the *smaller* edit through. Both spellings of one move
    // now fail, which is the whole point; they differ only in what git could tell the gate, so the
    // delete half reports no destination rather than inventing one.
    const files = changed(
      ...addition(MOVED_CALCULATOR, "@@ -0,0 +1,2 @@", "+<?php", "+class PriceCalculator {}"),
      ...deletion(CALCULATOR, "@@ -1,2 +0,0 @@", "-<?php", "-class PriceCalculator {}"),
    );

    const verdict = guardSpines([pricing], files, isTest)[0];

    expect(verdict?.touched).toEqual([{ path: CALCULATOR, movedTo: null }]);
    expect(verdict?.passed).toBe(false);
  });

  test("reports a rename inside the guarded tree once, under the name the author now opens", () => {
    // Both spellings are guarded here, so the file must not be counted twice, and the useful name is
    // the new one: nothing moved out, and that is where the file is to be read.
    const renamed = "apps/api/app/Libraries/Price/Calculator.php";
    const files = changed(...rename(CALCULATOR, renamed, ...ROUNDING_HUNK));

    const verdict = guardSpines([pricing], files, isTest)[0];

    expect(verdict?.touched).toEqual([{ path: renamed, movedTo: null }]);
    expect(verdict?.passed).toBe(false);
  });

  test("guards a file renamed into the guarded tree from this commit on", () => {
    // The direction that always worked, pinned because the fix consults both spellings and could
    // have made this one report the unguarded old path instead of the guarded new one.
    const files = changed(...rename(MOVED_CALCULATOR, CALCULATOR, ...ROUNDING_HUNK));

    const verdict = guardSpines([pricing], files, isTest)[0];

    expect(verdict?.touched).toEqual([{ path: CALCULATOR, movedTo: null }]);
    expect(verdict?.passed).toBe(false);
  });

  test("lets a move out of the guarded tree pass once an assertion is added with it", () => {
    // The fix makes a move gateable, not ungateable: the way out is the same as for any other change
    // to the chain, so a move done properly still commits.
    const files = changed(
      ...rename(CALCULATOR, MOVED_CALCULATOR, ...ROUNDING_HUNK),
      ...edit(
        ORDER_TEST,
        "@@ -30 +30,2 @@ public function test_total(): void",
        "         $order = $this->order();",
        "+        $this->assertSame(1210, $order->total());",
      ),
    );

    const verdict = guardSpines([pricing], files, isTest)[0];

    expect(verdict?.touched).toEqual([{ path: CALCULATOR, movedTo: MOVED_CALCULATOR }]);
    expect(verdict?.passed).toBe(true);
  });

  test("claims neither side of a rename that never touches the guarded tree", () => {
    // The control on the widened rule: consulting a second path must not widen what is guarded.
    const files = changed(
      ...rename("apps/mobile/src/screens/Cart.tsx", "apps/mobile/src/screens/Basket.tsx"),
    );

    const verdict = guardSpines([pricing], files, isTest)[0];

    expect(verdict?.touched).toEqual([]);
    expect(verdict?.passed).toBe(true);
  });

  test("carries the spine's own paths on the verdict, so a failure can name them too", () => {
    // Same reason as the terms below: an author held to a scope has to be able to read it off the
    // failure, and all three surfaces that print it (the gate, the pre-commit denial, the review
    // brief) render this one field rather than reopening the spine.
    const files = changed(...calculatorEdit);

    expect(guardSpines([scopedPricing], files, isTest)[0]?.pathsWanted).toEqual([
      "apps/api/tests/Feature/OrderTest.php",
    ]);
    expect(guardSpines([pricing], files, isTest)[0]?.pathsWanted).toEqual([]);
  });

  test("carries the spine's own terms on the verdict, so a failure can name them", () => {
    const narrow = spine("money", ["apps/api/app/Libraries/Price"], ["->assertMoney("]);

    const verdict = guardSpines([narrow], changed(...calculatorEdit), isTest)[0];

    expect(verdict?.termsWanted).toEqual(["->assertMoney("]);
    expect(verdict?.passed).toBe(false);
  });

  test("reports a line matching two terms once, as the first term declared", () => {
    // Declared order decides, not the order the terms fall in the line: "cents" is declared first
    // and written last, and the message a failing gate prints has to be the same on every rerun.
    const both = spine("pricing", ["apps/api/app/Libraries/Price"], ["cents", "assertSame"]);
    const files = changed(
      ...calculatorEdit,
      ...edit(
        ORDER_TEST,
        "@@ -30 +30,2 @@ public function test_total(): void",
        "         $order = $this->order();",
        "+        $this->assertSame(1200, $order->cents);",
      ),
    );

    const verdict = guardSpines([both], files, isTest)[0];

    expect(verdict?.assertions).toEqual([
      {
        file: ORDER_TEST,
        line: 31,
        term: "cents",
        text: "$this->assertSame(1200, $order->cents);",
      },
    ]);
  });

  test("sorts the assertion hits by file and then by line", () => {
    const unitTest = "apps/api/tests/Unit/CalculatorTest.php";
    const files = changed(
      ...calculatorEdit,
      // The two hunks are written high line first, because nothing downstream reorders hunks and
      // the sort has to be this function's own work rather than a property of the input.
      ...edit(
        ORDER_TEST,
        "@@ -40 +40,2 @@ public function test_vat(): void",
        "         $order = $this->order();",
        "+        $this->assertSame(300, $order->vat());",
        "@@ -10 +10,2 @@ public function test_total(): void",
        "         $order = $this->order();",
        "+        $this->assertSame(1200, $order->total());",
      ),
      ...edit(
        unitTest,
        "@@ -5 +5,2 @@ public function test_base(): void",
        "         $calculator = new PriceCalculator();",
        "+        $this->assertSame(1000, $calculator->base());",
      ),
    );

    // Reversed, so the order the parser left them in cannot be what makes this pass.
    const verdict = guardSpines([pricing], [...files].reverse(), isTest)[0];

    expect(verdict?.assertions.map((hit) => [hit.file, hit.line])).toEqual([
      [ORDER_TEST, 11],
      [ORDER_TEST, 41],
      [unitTest, 6],
    ]);
  });

  test("judges each spine on its own terms, so one can fail while another passes", () => {
    const orders = spine("orders", ["apps/api/app/Models/Order.php"], ["assertSame"]);
    const money = spine("money", ["apps/api/app/Libraries/Price"], ["->assertMoney("]);
    const files = changed(
      ...calculatorEdit,
      ...edit(
        "apps/api/app/Models/Order.php",
        "@@ -8 +8 @@",
        "-    protected $casts = [];",
        "+    protected $casts = ['total' => 'int'];",
      ),
      ...edit(
        ORDER_TEST,
        "@@ -30 +30,2 @@ public function test_total(): void",
        "         $order = $this->order();",
        "+        $this->assertSame(1200, $order->total());",
      ),
    );

    const verdicts = guardSpines([orders, money], files, isTest);

    expect(verdicts.map((verdict) => [verdict.name, verdict.passed])).toEqual([
      ["orders", true],
      ["money", false],
    ]);
    expect(verdicts[1]?.touched).toEqual([{ path: CALCULATOR, movedTo: null }]);
  });
});

describe("testFileMatcher", () => {
  /** The matcher reads `tests.paths` and nothing else, so that is all the stub pack carries. */
  function loader(paths: Record<string, string[]>): (lang: string) => Pack {
    return (lang) => ({ tests: { paths: paths[lang] ?? [] } }) as unknown as Pack;
  }

  function config(...roots: { path: string; lang: string }[]): EmpoConfig {
    return configSchema.parse({
      version: 1,
      roots,
      packs: Object.fromEntries(roots.map((root) => [root.lang, {}])),
    });
  }

  function matcherOf(
    empoConfig: EmpoConfig,
    load: (lang: string) => Pack,
  ): (path: string) => boolean {
    const matcher = testFileMatcher(empoConfig, load);
    if (matcher === null) throw new Error("expected a matcher, got the degraded mode");
    return matcher;
  }

  test("returns null when no installed pack declares a single test path", () => {
    // Null is "EmPo cannot tell", not "nothing is a test". Collapse the two and the gate fails
    // every guarded change on a repository whose pack simply left tests.paths empty.
    expect(
      testFileMatcher(config({ path: "apps/api", lang: "php" }), loader({ php: [] })),
    ).toBeNull();
  });

  test("strips the root prefix before the pack's directory rule sees the path", () => {
    // The pack says "tests/", relative to its own root; the gate is handed a repo-relative path.
    const matches = matcherOf(
      config({ path: "apps/api", lang: "php" }),
      loader({ php: ["tests/"] }),
    );

    expect(matches("apps/api/tests/Feature/OrderTest.php")).toBe(true);
    expect(matches("apps/api/app/Models/Order.php")).toBe(false);
    // Outside every declared root, so the bare word "tests" in the path decides nothing.
    expect(matches("apps/mobile/tests/OrderScreen.test.tsx")).toBe(false);
  });

  test("honours a glob as readily as a directory prefix", () => {
    // Both are real conventions: PHP puts its tests in one tree, TypeScript colocates them.
    const matches = matcherOf(
      config({ path: "apps/api", lang: "php" }, { path: "apps/mobile", lang: "typescript" }),
      loader({ php: ["tests/"], typescript: ["**/*.test.tsx"] }),
    );

    expect(matches("apps/mobile/src/x/y.test.tsx")).toBe(true);
    expect(matches("apps/mobile/src/x/y.tsx")).toBe(false);
    expect(matches("apps/api/tests/Feature/OrderTest.php")).toBe(true);
  });

  test('strips nothing for a root of ".", the single-root repository', () => {
    const matches = matcherOf(config({ path: ".", lang: "php" }), loader({ php: ["tests/"] }));

    expect(matches("tests/Feature/OrderTest.php")).toBe(true);
    expect(matches("app/Models/Order.php")).toBe(false);
  });
});
