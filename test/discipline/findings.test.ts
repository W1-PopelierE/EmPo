import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { gateFindings, type ReviewFinding } from "../../src/discipline/findings";
import { type ChangedFile, parseDiff } from "../../src/engine/diff";

/**
 * The gate is the product's promise: nothing reaches the author that was not checked against the
 * source. So the cases that matter most here are the ones where a finding looks right. A perfect
 * citation under a hedged claim still dies, and a plausible claim over an invented anchor still
 * dies, because either one is an assertion nobody verified.
 */

let root: string;

function write(relPath: string, lines: string[]): void {
  const target = join(root, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${lines.join("\n")}\n`);
}

const CALCULATOR = [
  "<?php",
  "",
  "class PriceCalculator",
  "{",
  "    public function total(): int",
  "    {",
  "        $total = $gross - $discount;",
  "        return $total;",
  "    }",
  "}",
];

const ORDER = ["<?php", "", "class Order", "{", "    public function total(): int", "}"];

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "F1",
    kind: "diff",
    severity: "major",
    title: "Discount is applied before tax, reversing the documented order",
    claim:
      "total() subtracts the discount from the gross amount, so a taxed line is discounted twice.",
    citation: {
      file: "app/PriceCalculator.php",
      line: 7,
      anchor: "$total = $gross - $discount;",
    },
    // The same line for a `diff` finding: the change is the defect. An `impact` finding overrides
    // it with the hunk whose reach got that far.
    introducedBy: {
      file: "app/PriceCalculator.php",
      line: 7,
      anchor: "$total = $gross - $discount;",
    },
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "empo-gate-"));
  write("app/PriceCalculator.php", CALCULATOR);
  write("app/Order.php", ORDER);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("gateFindings", () => {
  test("keeps a finding whose citation resolves and whose claim asserts", () => {
    const { kept, dropped } = gateFindings(root, [finding()]);

    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.corrected).toBe(false);
    expect(kept[0]?.citation.line).toBe(7);
  });

  test("drops a finding whose anchor is not in the file it cites", () => {
    const fabricated = finding({
      claim: "total() rounds the tax with floor(), losing a cent on every line.",
      citation: { file: "app/PriceCalculator.php", line: 7, anchor: "$tax = floor($net * 0.21);" },
    });

    const { kept, dropped } = gateFindings(root, [fabricated]);

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toBe("citation-unverified");
    expect(dropped[0]?.detail.join("\n")).toContain("nowhere in app/PriceCalculator.php");
  });

  test("drops a hedged claim even though its citation is perfect", () => {
    // The gate is not a citation checker with extra steps: a verified line under a guess is still
    // a guess, and docs/07 forbids it reaching the author.
    const hedged = finding({
      claim: "total() probably subtracts the discount before tax, which may break the kiosk flow.",
    });

    const { kept, dropped } = gateFindings(root, [hedged]);

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toBe("forbidden-phrasing");
    expect(dropped[0]?.detail).toHaveLength(2);
    expect(dropped[0]?.detail[0]).toContain("probably");
    expect(dropped[0]?.detail[1]).toContain("may break");
  });

  test("keeps a moved citation, corrected to the line the anchor is really on", () => {
    const drifted = finding({
      citation: {
        file: "app/PriceCalculator.php",
        line: 5,
        anchor: "$total = $gross - $discount;",
      },
    });

    const { kept } = gateFindings(root, [drifted]);

    expect(kept[0]?.corrected).toBe(true);
    expect(kept[0]?.citation.line).toBe(7);
    // The finding as authored is preserved, so the report can show what the agent originally wrote.
    expect(kept[0]?.finding.citation.line).toBe(5);
  });

  test("collapses two findings on the same line, keeping the earlier id", () => {
    const manual = finding({ id: "F1" });
    const automated = finding({
      id: "F2",
      severity: "blocker",
      title: "Discount ordering",
      claim: "The discount is subtracted from the gross amount on this line.",
    });

    const { kept, dropped } = gateFindings(root, [automated, manual]);

    expect(kept.map((entry) => entry.finding.id)).toEqual(["F1"]);
    expect(dropped[0]?.finding.id).toBe("F2");
    expect(dropped[0]?.reason).toBe("duplicate");
    expect(dropped[0]?.detail.join("\n")).toContain("app/PriceCalculator.php:7");
  });

  // A dropped finding used to claim its line before it was checked, so a fabricated or hedged
  // finding that sorted first took a real one down with it as a "duplicate". That inverts the whole
  // product: the gate exists to drop claims nobody checked, never to swallow one that was.
  test("a finding dropped for its citation does not shadow a real one on the same line", () => {
    const fabricated = finding({
      id: "F1",
      citation: { file: "app/PriceCalculator.php", line: 7, anchor: "$total = $gross * $vat;" },
    });
    const real = finding({ id: "F2" });

    const { kept, dropped } = gateFindings(root, [fabricated, real]);

    expect(kept.map((entry) => entry.finding.id)).toEqual(["F2"]);
    expect(dropped.map((entry) => entry.reason)).toEqual(["citation-unverified"]);
  });

  test("a finding dropped for hedging does not shadow a well-stated one on the same line", () => {
    const hedged = finding({
      id: "F1",
      claim: "total() probably subtracts the discount from the gross amount.",
    });
    const stated = finding({ id: "F2" });

    const { kept, dropped } = gateFindings(root, [hedged, stated]);

    expect(kept.map((entry) => entry.finding.id)).toEqual(["F2"]);
    expect(dropped.map((entry) => entry.reason)).toEqual(["forbidden-phrasing"]);
  });

  // Two sources landing on one line is the duplicate docs/07 step 5 means. A defect and a missing
  // test on that same line are two different claims, and collapsing them loses one of them.
  test("keeps two findings of different kinds that cite one line", () => {
    const defect = finding({ id: "F1", kind: "diff" });
    const gap = finding({
      id: "F2",
      kind: "coverage",
      title: "No test asserts the discounted total",
      claim: "No test in the suite reads the value this line computes.",
    });

    const { kept, dropped } = gateFindings(root, [defect, gap]);

    expect(kept.map((entry) => entry.finding.id)).toEqual(["F1", "F2"]);
    expect(dropped).toEqual([]);
  });

  test("gives the same result whatever order the findings arrive in", () => {
    const findings = [
      finding({ id: "F1", severity: "minor" }),
      finding({
        id: "F2",
        severity: "blocker",
        citation: { file: "app/Order.php", line: 5, anchor: "public function total(): int" },
      }),
      finding({ id: "F3", severity: "major", claim: "This may break the kiosk flow." }),
      finding({
        id: "F4",
        severity: "major",
        citation: { file: "app/Order.php", line: 3, anchor: "class Order" },
      }),
    ];

    const forwards = gateFindings(root, findings);
    const backwards = gateFindings(root, [...findings].reverse());

    expect(forwards).toEqual(backwards);
    // Blocker first, then the two majors by file and line; F3 is hedged and never made it.
    expect(forwards.kept.map((entry) => entry.finding.id)).toEqual(["F2", "F4", "F1"]);
    expect(forwards.dropped.map((entry) => entry.finding.id)).toEqual(["F3"]);
  });

  test("sorts what was dropped by id, whatever the reason", () => {
    const findings = [
      finding({ id: "F3", claim: "The refund job could break." }),
      finding({
        id: "F1",
        citation: { file: "app/Ghost.php", line: 2, anchor: "class Ghost" },
      }),
      finding({
        id: "F2",
        citation: { file: "app/Order.php", line: 5, anchor: "public function save(): void" },
      }),
    ];

    const { dropped } = gateFindings(root, findings);

    expect(dropped.map((entry) => [entry.finding.id, entry.reason])).toEqual([
      ["F1", "citation-unverified"],
      ["F2", "citation-unverified"],
      ["F3", "forbidden-phrasing"],
    ]);
  });

  test("reports a supporting citation that did not resolve without killing the finding", () => {
    const supported = finding({
      supporting: [
        { file: "app/Order.php", line: 3, anchor: "public function total(): int" },
        { file: "app/Ghost.php", line: 1, anchor: "class Ghost" },
      ],
    });

    const { kept } = gateFindings(root, [supported]);

    expect(kept).toHaveLength(1);
    expect(kept[0]?.supporting[0]?.status).toBe("moved");
    expect(kept[0]?.supporting[0]?.citation.line).toBe(5);
    expect(kept[0]?.supporting[0]?.corrected).toBe(true);
    expect(kept[0]?.supporting[1]?.status).toBe("missing-file");
    expect(kept[0]?.supporting[1]?.note).toContain("app/Ghost.php");
  });

  test("does not lint the suggestion, which is allowed to be tentative", () => {
    const suggested = finding({
      suggestion:
        "Applying the discount to the net amount probably fixes this; it may break nothing else.",
    });

    expect(gateFindings(root, [suggested]).kept).toHaveLength(1);
  });

  test("drops a citation that escapes the read root before it can be read", () => {
    const escaping = finding({
      citation: { file: "../PriceCalculator.php", line: 7, anchor: "$total = $gross - $discount;" },
    });

    const { kept, dropped } = gateFindings(root, [escaping]);

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toBe("citation-unverified");
    expect(dropped[0]?.detail[0]).toContain("escapes the read root");
  });
});

/**
 * The pull request is the subject of the review, so a finding has to name the diff line that caused
 * it. Everything else is a defect the branch inherited: real, and not this author's to fix.
 */
describe("gateFindings against the diff", () => {
  /** Touches lines 6..8 of PriceCalculator, so line 7 is inside the hunk and line 3 is not. */
  const CHANGED: ChangedFile[] = parseDiff(
    [
      "diff --git a/app/PriceCalculator.php b/app/PriceCalculator.php",
      "--- a/app/PriceCalculator.php",
      "+++ b/app/PriceCalculator.php",
      "@@ -6,3 +6,3 @@",
      "    {",
      "-        $total = $gross;",
      "+        $total = $gross - $discount;",
      "        return $total;",
      "",
    ].join("\n"),
  );

  test("keeps a finding whose introducedBy lands inside a hunk", () => {
    const { kept, dropped } = gateFindings(root, [finding()], CHANGED);

    expect(dropped).toEqual([]);
    expect(kept.map((entry) => entry.finding.id)).toEqual(["F1"]);
  });

  test("drops a finding introduced in a file this diff never touched", () => {
    const inherited = finding({
      introducedBy: { file: "app/Order.php", line: 3, anchor: "class Order" },
    });

    const { kept, dropped } = gateFindings(root, [inherited], CHANGED);

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toBe("not-introduced");
    expect(dropped[0]?.detail[0]).toContain("app/Order.php:3 is outside every hunk");
  });

  test("drops a finding introduced on an untouched line of a file that did change", () => {
    // File-level containment would keep this one, which is the bug: the class declaration is three
    // lines above the hunk and nothing this branch wrote reaches it.
    const inherited = finding({
      introducedBy: { file: "app/PriceCalculator.php", line: 3, anchor: "class PriceCalculator" },
    });

    const { kept, dropped } = gateFindings(root, [inherited], CHANGED);

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toBe("not-introduced");
    expect(dropped[0]?.detail[0]).toContain("app/PriceCalculator.php:3 is outside every hunk");
  });

  test("measures containment on the line the anchor is really on, not the one it was given", () => {
    const drifted = finding({
      // Cited on line 3, which is outside the hunk; the anchor itself sits on line 7, inside it.
      introducedBy: {
        file: "app/PriceCalculator.php",
        line: 3,
        anchor: "$total = $gross - $discount;",
      },
    });

    const { kept } = gateFindings(root, [drifted], CHANGED);

    expect(kept).toHaveLength(1);
    // Reported on the line containment was measured on, not the one the agent guessed.
    expect(kept[0]?.introducedBy.line).toBe(7);
    expect(kept[0]?.finding.introducedBy.line).toBe(3);
  });

  test("drops a finding whose introducedBy anchor is nowhere in the file", () => {
    const invented = finding({
      introducedBy: {
        file: "app/PriceCalculator.php",
        line: 7,
        anchor: "$total = $gross * $vat;",
      },
    });

    const { kept, dropped } = gateFindings(root, [invented], CHANGED);

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toBe("not-introduced");
    expect(dropped[0]?.detail[0]).toContain("nowhere in app/PriceCalculator.php");
  });

  // The citation is checked first, so a finding that is both uncited and uncaused is reported as
  // uncited: the citation is the ground the claim stands on.
  test("reports a finding with neither a citation nor an origin as uncited", () => {
    const neither = finding({
      citation: { file: "app/PriceCalculator.php", line: 7, anchor: "$tax = floor($net);" },
      introducedBy: { file: "app/PriceCalculator.php", line: 7, anchor: "$vat = $net * 0.21;" },
    });

    expect(gateFindings(root, [neither], CHANGED).dropped[0]?.reason).toBe("citation-unverified");
  });

  // The half `introducedBy` alone cannot hold: it says what caused the defect, and an agent that
  // wants an inherited one reported has only to name a hunk in the same file. The kind says where
  // the finding stands, and the gate holds it to that from the other end.
  test("drops a diff finding that stands on a line outside every hunk", () => {
    const inherited = finding({
      // Real source, real cause on line 7. But the claim itself rests on the class declaration,
      // which this branch never wrote.
      citation: { file: "app/PriceCalculator.php", line: 3, anchor: "class PriceCalculator" },
    });

    const { kept, dropped } = gateFindings(root, [inherited], CHANGED);

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toBe("cited-outside-diff");
    expect(dropped[0]?.detail[0]).toContain("app/PriceCalculator.php:3 is outside every hunk");
    expect(dropped[0]?.detail[1]).toContain("maintenance line");
  });

  test("drops a coverage finding that stands outside the diff, like a diff finding", () => {
    const inherited = finding({
      kind: "coverage",
      title: "No test asserts the class is constructible",
      claim: "No test in the suite constructs PriceCalculator.",
      citation: { file: "app/PriceCalculator.php", line: 3, anchor: "class PriceCalculator" },
    });

    expect(gateFindings(root, [inherited], CHANGED).dropped[0]?.reason).toBe("cited-outside-diff");
  });

  test("measures the citation's scope on the line the anchor is really on", () => {
    const drifted = finding({
      // Cited on line 3, which is outside the hunk; the anchor sits on line 7, inside it.
      citation: {
        file: "app/PriceCalculator.php",
        line: 3,
        anchor: "$total = $gross - $discount;",
      },
    });

    expect(gateFindings(root, [drifted], CHANGED).kept).toHaveLength(1);
  });

  test("keeps an impact finding standing outside the diff, caused by a line inside it", () => {
    const impact = finding({
      kind: "impact",
      title: "Order::total() is now called with a discounted gross",
      claim: "Order::total() declares an int return, which the calculator's new subtraction feeds.",
      citation: { file: "app/Order.php", line: 5, anchor: "public function total(): int" },
    });

    const { kept, dropped } = gateFindings(root, [impact], CHANGED);

    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  // Relabelling is the escape the first rule would otherwise leave open: `impact` is the one kind
  // allowed out of the diff, so an inherited defect wearing it would sail through.
  test("drops an impact finding that stands on a line inside a hunk", () => {
    const mislabelled = finding({ kind: "impact" });

    const { kept, dropped } = gateFindings(root, [mislabelled], CHANGED);

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toBe("cited-inside-diff");
    expect(dropped[0]?.detail[1]).toContain('kind "diff"');
  });

  test("skips containment when there is no diff, and still checks the anchor", () => {
    const inherited = finding({
      introducedBy: { file: "app/Order.php", line: 3, anchor: "class Order" },
    });
    const invented = finding({
      id: "F2",
      citation: { file: "app/Order.php", line: 3, anchor: "class Order" },
      introducedBy: { file: "app/Order.php", line: 3, anchor: "class Invoice" },
    });

    const outside = finding({
      id: "F3",
      // Outside every hunk, but there are no hunks to be outside of.
      citation: { file: "app/PriceCalculator.php", line: 3, anchor: "class PriceCalculator" },
      introducedBy: { file: "app/PriceCalculator.php", line: 3, anchor: "class PriceCalculator" },
    });

    const { kept, dropped } = gateFindings(root, [inherited, invented, outside], null);

    expect(kept.map((entry) => entry.finding.id)).toEqual(["F3", "F1"]);
    expect(dropped.map((entry) => [entry.finding.id, entry.reason])).toEqual([
      ["F2", "not-introduced"],
    ]);
    // Without the diff the removed side was never looked at, so the note does not say it was.
    expect(dropped[0]?.detail[1]).not.toContain("removed");
  });
});

/**
 * A deletion is how a pull request breaks a consumer without leaving anything in the new file to
 * cite. The diff still carries the removed text, so it is the source of record for a line the
 * branch took away, and attributing to it is checked rather than assumed.
 */
describe("gateFindings against a line the diff deleted", () => {
  /** Deletes app/Legacy.php whole, and one line out of a file that survives. */
  const DELETIONS: ChangedFile[] = parseDiff(
    [
      "diff --git a/app/Legacy.php b/app/Legacy.php",
      "deleted file mode 100644",
      "--- a/app/Legacy.php",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-<?php",
      "-",
      "-class Legacy {}",
      "diff --git a/app/Order.php b/app/Order.php",
      "--- a/app/Order.php",
      "+++ b/app/Order.php",
      "@@ -40,2 +40,1 @@",
      "-    public function subtotal(): int",
      "     public function total(): int",
      "",
    ].join("\n"),
  );

  /** The consumer that broke. It is untouched by the diff, which is what makes it an impact. */
  const impact = (introducedBy: ReviewFinding["introducedBy"]): ReviewFinding =>
    finding({
      kind: "impact",
      citation: { file: "app/Order.php", line: 5, anchor: "public function total(): int" },
      introducedBy,
    });

  test("keeps a finding introduced by the deletion of a whole file", () => {
    const { kept, dropped } = gateFindings(
      root,
      // Cited a line off, as a reviewer reading a diff will: the answer is the line it resolved to.
      [impact({ file: "app/Legacy.php", line: 9, anchor: "class Legacy {}" })],
      DELETIONS,
    );

    expect(dropped).toEqual([]);
    // The old-side coordinate, and the flag that says the file is gone from the branch.
    expect(kept[0]?.introducedBy.line).toBe(3);
    expect(kept[0]?.introducedByDeleted).toBe(true);
  });

  test("keeps a finding introduced by a line deleted from a file that survives", () => {
    const { kept } = gateFindings(
      root,
      [impact({ file: "app/Order.php", line: 5, anchor: "public function subtotal(): int" })],
      DELETIONS,
    );

    // 40 is where the diff removed it. 5 is what the finding said, and is not the answer.
    expect(kept[0]?.introducedBy.line).toBe(40);
    expect(kept[0]?.introducedByDeleted).toBe(true);
  });

  test("drops a finding whose anchor is in neither the branch nor the removed lines", () => {
    const { kept, dropped } = gateFindings(
      root,
      [impact({ file: "app/Legacy.php", line: 3, anchor: "class Invented {}" })],
      DELETIONS,
    );

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toBe("not-introduced");
    expect(dropped[0]?.detail[1]).toContain("nor among the lines this diff removed");
  });

  // The anchor of a deleted line often recurs in the file it was deleted from, and then it resolves
  // perfectly well somewhere it was never cited. Attributed by containment alone, the deletion this
  // pull request made would be reported back to the author as a defect it inherited.
  test("keeps a deleted line whose text also survives elsewhere in the same file", () => {
    const recurring = impact({
      file: "app/PriceCalculator.php",
      line: 40,
      anchor: "return $total;",
    });
    const removedElsewhere: ChangedFile[] = parseDiff(
      [
        "diff --git a/app/PriceCalculator.php b/app/PriceCalculator.php",
        "--- a/app/PriceCalculator.php",
        "+++ b/app/PriceCalculator.php",
        "@@ -40,2 +40,1 @@",
        "-        return $total;",
        "    }",
        "",
      ].join("\n"),
    );

    // Line 8 of the branch file reads the same, which is where the anchor resolves.
    const { kept, dropped } = gateFindings(root, [recurring], removedElsewhere);

    expect(dropped).toEqual([]);
    expect(kept[0]?.introducedByDeleted).toBe(true);
    expect(kept[0]?.introducedBy.line).toBe(40);
  });

  test("names a deleted line at the path it lived at, not the one the branch uses", () => {
    const renamed: ChangedFile[] = parseDiff(
      [
        "diff --git a/app/Legacy.php b/app/Modern.php",
        "rename from app/Legacy.php",
        "rename to app/Modern.php",
        "--- a/app/Legacy.php",
        "+++ b/app/Modern.php",
        "@@ -10,2 +10,1 @@",
        "-    public function subtotal(): int",
        "    }",
        "",
      ].join("\n"),
    );

    // Cited at the new name, which is what the diff header shows a reviewer.
    const { kept } = gateFindings(
      root,
      [impact({ file: "app/Modern.php", line: 10, anchor: "public function subtotal(): int" })],
      renamed,
    );

    // Both halves come from the base, or the pair points at no tree at all.
    expect(kept[0]?.introducedBy).toMatchObject({ file: "app/Legacy.php", line: 10 });
    expect(kept[0]?.introducedByDeleted).toBe(true);
  });

  test("marks a line that survives as not deleted, though its text was deleted elsewhere", () => {
    const CHANGED: ChangedFile[] = parseDiff(
      [
        "diff --git a/app/PriceCalculator.php b/app/PriceCalculator.php",
        "--- a/app/PriceCalculator.php",
        "+++ b/app/PriceCalculator.php",
        "@@ -6,3 +6,3 @@",
        "    {",
        "-        $total = $gross;",
        "+        $total = $gross - $discount;",
        "        return $total;",
        "",
      ].join("\n"),
    );

    // The anchor matches the removed line as well as the surviving one it is cited on. The
    // surviving one wins, because it is where the finding says the defect is.
    const cited = finding({
      citation: { file: "app/PriceCalculator.php", line: 7, anchor: "$total = $gross" },
      introducedBy: { file: "app/PriceCalculator.php", line: 7, anchor: "$total = $gross" },
    });

    expect(gateFindings(root, [cited], CHANGED).kept[0]?.introducedByDeleted).toBe(false);
  });
});
