import { describe, expect, test } from "vitest";
import type { ChangedFile, ChangedHunk } from "../../src/engine/diff";
import { page } from "../../src/web/page";
import { anchored, esc, highlight, hunkRows } from "../../src/web/render";

/**
 * The page's four pieces of real logic. They live in a module so they can be run here and are
 * serialised into the page from there, which is why the last test in this file checks that the page
 * still carries them: a rename that silently stopped inlining them would leave a page whose diff
 * panel throws on the first snapshot, and no test on the string alone would notice.
 */
function hunk(parts: Partial<ChangedHunk>): ChangedHunk {
  return {
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    added: [],
    removed: [],
    context: [],
    ...parts,
  };
}

describe("hunkRows", () => {
  test("puts the context back between the removals and the additions", () => {
    const rows = hunkRows(
      hunk({
        oldStart: 12,
        oldLines: 3,
        newStart: 12,
        newLines: 4,
        removed: [{ line: 13, text: "  const vat = 2;" }],
        added: [
          { line: 13, text: "  const vat = 3;" },
          { line: 14, text: "  const fee = 4;" },
        ],
        context: [
          { oldLine: 12, newLine: 12, text: "  const base = 1;" },
          { oldLine: 14, newLine: 15, text: "  return base;" },
        ],
      }),
    );

    expect(rows).toEqual([
      { kind: "context", oldLine: 12, newLine: 12, text: "  const base = 1;" },
      { kind: "del", oldLine: 13, newLine: null, text: "  const vat = 2;" },
      { kind: "add", oldLine: null, newLine: 13, text: "  const vat = 3;" },
      { kind: "add", oldLine: null, newLine: 14, text: "  const fee = 4;" },
      { kind: "context", oldLine: 14, newLine: 15, text: "  return base;" },
    ]);
  });

  test("keeps every changed line when the hunk has no context at all", () => {
    const rows = hunkRows(
      hunk({
        removed: [{ line: 1, text: "old" }],
        added: [{ line: 1, text: "new" }],
      }),
    );

    expect(rows.map((row) => row.kind)).toEqual(["del", "add"]);
  });

  test("orders two change blocks separated by context", () => {
    const rows = hunkRows(
      hunk({
        removed: [
          { line: 1, text: "a" },
          { line: 3, text: "c" },
        ],
        added: [
          { line: 1, text: "A" },
          { line: 3, text: "C" },
        ],
        context: [{ oldLine: 2, newLine: 2, text: "b" }],
      }),
    );

    expect(rows.map((row) => row.text)).toEqual(["a", "A", "b", "c", "C"]);
  });
});

describe("esc", () => {
  test("replaces the four characters that can end an attribute or open a tag", () => {
    expect(esc("&")).toBe("&amp;");
    expect(esc("<")).toBe("&lt;");
    expect(esc(">")).toBe("&gt;");
    expect(esc('"')).toBe("&quot;");
  });

  test("escapes the ampersand first, so an escape is not escaped twice", () => {
    // The other order writes `&lt;` and then rewrites its own `&` into `&amp;lt;`, which shows the
    // reader the escape rather than the bracket it stands for.
    expect(esc("<")).not.toContain("&amp;");
    expect(esc("&lt;")).toBe("&amp;lt;");
  });

  test("leaves the apostrophe alone, which every attribute in the page is built to survive", () => {
    // Not an oversight: page.ts double-quotes every attribute it writes. A single-quoted one added
    // later has to add `'` to esc() in the same change.
    expect(esc("it's")).toBe("it's");
  });

  test("renders a missing field as nothing rather than as the word null", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc("")).toBe("");
  });

  test("defangs a closing script tag out of a diff line", () => {
    const out = esc('const end = "</script><img src=x onerror=alert(1)>";');

    expect(out).not.toContain("<");
    expect(out).toContain("&lt;/script&gt;");
  });
});

/** Every case below is a line out of a TypeScript file, which is what the page colours. */
const colour = (text: string) => highlight(text, "src/x.ts");

describe("highlight", () => {
  test("leaves escaped markup escaped and adds only spans", () => {
    // The input is what `esc()` produced, so a diff line holding a closing script tag arrives here
    // already defanged. Nothing in the output may put a raw `<` back into it except this file's own
    // spans, which is the page's entire XSS story now that it renders every line of a diff.
    const escaped = "const end = &quot;&lt;/script&gt;&quot;;";
    const out = highlight(escaped, "src/x.ts");

    expect(out).toContain("&lt;/script&gt;");
    expect(out.replace(/<\/?span[^>]*>/g, "")).toBe(escaped);
  });

  test("colours a keyword, a number, a string and a comment", () => {
    const out = colour("const n = 42; // a note");

    expect(out).toContain('<span class="k">const</span>');
    expect(out).toContain('<span class="n">42</span>');
    expect(out).toContain('<span class="c">// a note</span>');
    expect(colour("&quot;hi&quot;")).toBe('<span class="s">&quot;hi&quot;</span>');
  });

  test("does not read a comment inside a string", () => {
    expect(colour("&quot;http://x&quot;")).toBe('<span class="s">&quot;http://x&quot;</span>');
  });

  test("does not colour a keyword that is part of a longer word", () => {
    expect(colour("constant")).toBe("constant");
  });

  test("returns an empty line unchanged", () => {
    expect(colour("")).toBe("");
  });

  test("leaves a prose file alone", () => {
    // A markdown diff is full of "for", "while" and "of" in sentences. Colouring them turns a
    // documentation change into confetti and tells the reader nothing.
    expect(highlight("a note for the reader", "docs/06-cli.md")).toBe("a note for the reader");
  });

  test("reads a jsdoc continuation line as a comment", () => {
    expect(highlight(" * this is prose", "src/x.ts")).toBe(
      '<span class="c"> * this is prose</span>',
    );
  });
});

/** A file of the diff carrying the hunks under test; the counts are what `anchored` never reads. */
function file(parts: Partial<ChangedFile>): ChangedFile {
  return {
    path: "src/x.ts",
    oldPath: null,
    status: "modified",
    hunks: [],
    addedCount: 0,
    removedCount: 0,
    isBinary: false,
    ...parts,
  };
}

describe("anchored", () => {
  const changed = file({ hunks: [hunk({ newStart: 12, newLines: 3 })] });

  test("anchors a line the hunk covers", () => {
    expect(anchored(changed, 12)).toBe(true);
    expect(anchored(changed, 14)).toBe(true);
  });

  test("does not anchor a line outside every hunk's range", () => {
    // 15 is the first line past a hunk starting at 12 and three lines long, and a finding there has
    // nowhere in the diff to scroll to.
    expect(anchored(changed, 11)).toBe(false);
    expect(anchored(changed, 15)).toBe(false);
  });

  test("does not anchor a file the diff never touched", () => {
    expect(anchored(undefined, 12)).toBe(false);
  });

  test("does not anchor a binary file, which has no lines to land on", () => {
    expect(
      anchored(file({ isBinary: true, hunks: [hunk({ newStart: 12, newLines: 3 })] }), 12),
    ).toBe(false);
  });
});

describe("page", () => {
  test("inlines every render function under the names its script calls", () => {
    const html = page();

    expect(html).toContain("const esc =");
    expect(html).toContain("const hunkRows =");
    expect(html).toContain("const highlight =");
    expect(html).toContain("const anchored =");
    expect(html).toContain("hunkRows(hunk)");
    expect(html).toContain("highlight(esc(r.text), path)");
  });

  // The page's own script is a template string, so nothing typechecks it and a stray bracket in it
  // ships as a blank viewer. Parsing it is the cheapest thing that catches that; `Function` compiles
  // without running, so the `connect()` at the end of the script is never called here.
  test("ships a script that parses", () => {
    const script = page().split("<script>")[1]?.split("</script>")[0] ?? "";

    expect(script).not.toBe("");
    expect(() => new Function(script)).not.toThrow();
  });
});
