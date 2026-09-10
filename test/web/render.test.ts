import { describe, expect, test } from "vitest";
import type { ChangedHunk } from "../../src/engine/diff";
import { page } from "../../src/web/page";
import { highlight, hunkRows } from "../../src/web/render";

/**
 * The page's two pieces of real logic. They live in a module so they can be run here and are
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

describe("highlight", () => {
  test("leaves escaped markup escaped and adds only spans", () => {
    // The input is what `esc()` produced, so a diff line holding a closing script tag arrives here
    // already defanged. Nothing in the output may put a raw `<` back into it except this file's own
    // spans, which is the page's entire XSS story now that it renders every line of a diff.
    const escaped = "const end = &quot;&lt;/script&gt;&quot;;";
    const out = highlight(escaped);

    expect(out).toContain("&lt;/script&gt;");
    expect(out.replace(/<\/?span[^>]*>/g, "")).toBe(escaped);
  });

  test("colours a keyword, a number, a string and a comment", () => {
    const out = highlight("const n = 42; // a note");

    expect(out).toContain('<span class="k">const</span>');
    expect(out).toContain('<span class="n">42</span>');
    expect(out).toContain('<span class="c">// a note</span>');
    expect(highlight("&quot;hi&quot;")).toBe('<span class="s">&quot;hi&quot;</span>');
  });

  test("does not read a comment inside a string", () => {
    expect(highlight("&quot;http://x&quot;")).toBe('<span class="s">&quot;http://x&quot;</span>');
  });

  test("does not colour a keyword that is part of a longer word", () => {
    expect(highlight("constant")).toBe("constant");
  });

  test("returns an empty line unchanged", () => {
    expect(highlight("")).toBe("");
  });
});

describe("page", () => {
  test("inlines both render functions under the names its script calls", () => {
    const html = page();

    expect(html).toContain("const hunkRows =");
    expect(html).toContain("const highlight =");
    expect(html).toContain("hunkRows(hunk)");
  });
});
