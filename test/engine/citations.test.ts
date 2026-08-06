import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Citation, checkCitation, checkCitations } from "../../src/engine/citations";

/**
 * The checker decides whether a finding is allowed to exist, so every case below is a way an agent
 * gets a citation wrong: the line drifted, the line never existed, the anchor was invented, the
 * path points somewhere the review was never given. Real files in a temp dir, because the thing
 * under test is precisely "was this checked against the source".
 */

let base: string;
let root: string;

function write(relPath: string, lines: string[]): void {
  const target = join(root, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${lines.join("\n")}\n`);
}

/** The file every case cites. Line 7 holds the anchor, and line 3 is its twin in the tie case. */
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

function cite(line: number, anchor: string, file = "app/PriceCalculator.php"): Citation {
  return { file, line, anchor };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "empo-citations-"));
  root = join(base, "repo");
  mkdirSync(root, { recursive: true });
  write("app/PriceCalculator.php", CALCULATOR);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("checkCitation", () => {
  test("verifies an anchor that is on the cited line", () => {
    const check = checkCitation(root, cite(7, "$total = $gross - $discount;"));

    expect(check.status).toBe("verified");
    expect(check.actualLine).toBeNull();
    expect(check.sourceLine).toBe("        $total = $gross - $discount;");
  });

  test("verifies across any difference in whitespace, since indentation is not evidence", () => {
    write("app/Spaced.php", ["<?php", "    $total   =    $gross  -  $discount;"]);

    const check = checkCitation(root, cite(2, "$total = $gross - $discount;", "app/Spaced.php"));

    expect(check.status).toBe("verified");
  });

  test("reports moved when the anchor is elsewhere in the file", () => {
    const check = checkCitation(root, cite(5, "$total = $gross - $discount;"));

    expect(check.status).toBe("moved");
    expect(check.actualLine).toBe(7);
    expect(check.sourceLine).toBe("        $total = $gross - $discount;");
    expect(check.note).toContain("app/PriceCalculator.php:7");
  });

  test("picks the match nearest the cited line, with a tie going to the lower line", () => {
    // The anchor sits on 3 and 7; citing 5 is two lines from each, so only the tie rule decides.
    write("app/Twice.php", [
      "<?php",
      "",
      "$total = $gross - $discount;",
      "",
      "// somewhere in between",
      "",
      "$total = $gross - $discount;",
    ]);

    const check = checkCitation(root, cite(5, "$total = $gross - $discount;", "app/Twice.php"));

    expect(check.status).toBe("moved");
    expect(check.actualLine).toBe(3);
  });

  test("drops an anchor that is nowhere in the file, and quotes what the cited line really says", () => {
    const check = checkCitation(root, cite(7, "$total = $net + $tax;"));

    expect(check.status).toBe("anchor-absent");
    expect(check.actualLine).toBeNull();
    expect(check.note).toContain("nowhere in app/PriceCalculator.php");
    expect(check.note).toContain("$total = $gross - $discount;");
  });

  test("still finds an anchor cited past the end of the file, and says the line does not exist", () => {
    const check = checkCitation(root, cite(94, "$total = $gross - $discount;"));

    expect(check.status).toBe("moved");
    expect(check.actualLine).toBe(7);
    expect(check.note).toContain("line 94 does not exist");
    expect(check.note).toContain("10 lines");
  });

  test("separates a line that does not exist from a line that says something else", () => {
    const check = checkCitation(root, cite(94, "$total = $net + $tax;"));

    expect(check.status).toBe("anchor-absent");
    expect(check.sourceLine).toBeNull();
    expect(check.note).toContain("line 94 does not exist");
  });

  test("drops a citation with an empty anchor, since it quotes no source at all", () => {
    const check = checkCitation(root, cite(7, "   "));

    expect(check.status).toBe("anchor-absent");
    expect(check.note).toContain("must quote the source it stands on");
  });

  test("reports a file that is not there as missing", () => {
    const check = checkCitation(root, cite(1, "class Gone", "app/Gone.php"));

    expect(check.status).toBe("missing-file");
    expect(check.sourceLine).toBeNull();
  });

  test("refuses an absolute path even when the file exists and the anchor is on the line", () => {
    const absolute = join(root, "app/PriceCalculator.php");

    const check = checkCitation(root, cite(7, "$total = $gross - $discount;", absolute));

    expect(check.status).toBe("missing-file");
    expect(check.sourceLine).toBeNull();
    expect(check.note).toContain("absolute path");
  });

  test("refuses a path that climbs out of the read root, and never reads it", () => {
    writeFileSync(join(base, "outside.txt"), "the anchor is right here\n");

    const check = checkCitation(root, cite(1, "the anchor is right here", "../outside.txt"));

    expect(check.status).toBe("missing-file");
    expect(check.sourceLine).toBeNull();
    expect(check.note).toContain("escapes the read root");
  });

  test("refuses a path that climbs out sideways through a directory that exists", () => {
    writeFileSync(join(base, "outside.txt"), "the anchor is right here\n");

    const check = checkCitation(root, cite(1, "the anchor is right here", "app/../../outside.txt"));

    expect(check.status).toBe("missing-file");
    expect(check.note).toContain("escapes the read root");
  });
});

describe("checkCitations", () => {
  test("returns one check per citation, in the order it was given them", () => {
    const checks = checkCitations(root, [
      cite(7, "$total = $gross - $discount;"),
      cite(1, "class Gone", "app/Gone.php"),
      cite(5, "$total = $gross - $discount;"),
    ]);

    expect(checks.map((check) => check.status)).toEqual(["verified", "missing-file", "moved"]);
  });
});
