import { describe, expect, test } from "vitest";
import { maskComments } from "../../src/engine/mask";
import type { CommentSyntax } from "../../src/schema/types";

/**
 * The mask blanks comments before any pack rule runs, so a class name or a route inside a comment
 * never becomes an edge. It replaces with spaces rather than removing, because every line number
 * downstream is computed from an offset into this string.
 */

const php: CommentSyntax = {
  line: ["//"],
  block: [["/*", "*/"]],
  stringQuotes: ["'", '"'],
  stringEscape: "\\",
};

/**
 * The typescript pack's syntax, spelled out here rather than loaded, so these tests describe the
 * masker and not the pack. It carries two things php does not: the html block pair, because a Vue
 * SFC's `<template>` is html and that is where an SFC hides a dead import, and `multilineQuotes`,
 * because JavaScript's `'` and `"` may not hold a raw newline and only its backtick may.
 */
const typescript: CommentSyntax = {
  line: ["//"],
  block: [
    ["/*", "*/"],
    ["<!--", "-->"],
  ],
  stringQuotes: ["'", '"', "`"],
  multilineQuotes: ["`"],
  stringEscape: "\\",
};

describe("maskComments", () => {
  test("leaves the source untouched when the pack declares no comment syntax", () => {
    const source = "// Route::post('api/v1/ghost');\n";

    expect(maskComments(source, undefined)).toBe(source);
  });

  test("blanks a line comment and keeps every offset after it valid", () => {
    const source = "$a = 1;\n// Route::post('api/v1/ghost');\n$b = 2;\n";

    const masked = maskComments(source, php);

    expect(masked).toHaveLength(source.length);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
    expect(masked).toContain("$a = 1;");
    expect(masked).toContain("$b = 2;");
    expect(masked).not.toContain("Route::post");
  });

  test("blanks a block comment across lines without losing the newlines", () => {
    const source = "$a = 1;\n/*\n\\Acme\\Models\\Payment::create();\n*/\n$b = 2;\n";

    const masked = maskComments(source, php);

    expect(masked).toHaveLength(source.length);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
    expect(masked).not.toContain("Payment");
    // The statement after the comment still reports its own line.
    expect(masked.split("\n")[4]).toBe("$b = 2;");
  });

  test("does not start a comment inside a string literal", () => {
    // A masker with no string awareness would blank the rest of this line and lose the route.
    const source = "$base = 'https://acme.test';\nRoute::post('api/v1/orders', 'store');\n";

    const masked = maskComments(source, php);

    expect(masked).toContain("'https://acme.test'");
    expect(masked).toContain("Route::post('api/v1/orders', 'store')");
  });

  test("keeps string contents intact, because the string edge family reads them", () => {
    const source = "$map = ['order' => 'Acme\\Observers\\OrderObserver'];\n";

    expect(maskComments(source, php)).toBe(source);
  });

  test("does not end a string on an escaped quote", () => {
    const source = "$a = 'it\\'s here'; // \\Acme\\Models\\Ghost::create();\n$b = 2;\n";

    const masked = maskComments(source, php);

    expect(masked).toContain("$a = 'it\\'s here';");
    expect(masked).not.toContain("Ghost");
    expect(masked).toContain("$b = 2;");
  });

  test("masks an unterminated block comment to the end of the file", () => {
    const source = "$a = 1;\n/* \\Acme\\Models\\Ghost::create();\nstill inside\n";

    const masked = maskComments(source, php);

    expect(masked).toHaveLength(source.length);
    expect(masked).not.toContain("Ghost");
    expect(masked).not.toContain("still inside");
  });

  test("does not treat a comment marker as a comment when it opens inside a block comment", () => {
    const source = "/* // nested \\Acme\\Models\\Ghost */\n$a = 1;\n";

    const masked = maskComments(source, php);

    expect(masked).not.toContain("Ghost");
    expect(masked).toContain("$a = 1;");
  });

  test("treats a quote that never closes as punctuation, not as the start of a string", () => {
    // A quote with no closer anywhere after it cannot have opened a string: that is a syntax error
    // in every language a pack can describe. Skipping to the end of the file on it is the worst
    // outcome available, because nothing after it is masked and every commented-out class name in
    // the rest of the file becomes an edge. This is language-neutral and applies to php too.
    const source = "$title = 'it\\'s here;\n// \\Acme\\Models\\Ghost::create();\n$b = 2;\n";

    const masked = maskComments(source, php);

    expect(masked).not.toContain("Ghost");
    expect(masked).toContain("$b = 2;");
  });
});

/**
 * A Vue single-file component is the case that made both of the rules below necessary. It is one
 * file holding two languages: `<script setup lang="ts">` is TypeScript, and `<template>` is html,
 * where `//` is not a comment, `<!-- -->` is, and an apostrophe is prose rather than a quote.
 */
describe("maskComments over a single-file component", () => {
  test("blanks an html comment, which is the only comment syntax a template has", () => {
    // Without the html pair the import below is read as an import: it is line-anchored, it names a
    // module that exists, and nothing else on its line says it is dead. That is a false edge whose
    // citation points at a comment, which is the exact failure the mask exists to prevent.
    const source =
      "<template>\n  <!--\n  import { PriceRow } from './PriceRow';\n  -->\n</template>\n";

    const masked = maskComments(source, typescript);

    expect(masked).toHaveLength(source.length);
    expect(masked).not.toContain("PriceRow");
    expect(masked).toContain("<template>");
  });

  test("does not let one apostrophe in template prose unmask the rest of the file", () => {
    // "Don't" is prose, not a quote. Read as one it pairs with the next real `'` in the file, which
    // is the opening quote of a genuine import, and from there every boundary is off by one: the
    // html comment sits inside a "string" and survives, and so does the dead import in it. One
    // apostrophe in one line of copy would otherwise disable masking for the whole component.
    const source = [
      "<template>",
      "  <p>Don't lose the cart</p>",
      "  <!--",
      "  import { PriceRow } from '../components/PriceRow';",
      "  -->",
      "</template>",
      "",
      '<script setup lang="ts">',
      "import { formatMoney } from '../shared/money';",
      "</script>",
      "",
    ].join("\n");

    const masked = maskComments(source, typescript);

    expect(masked).not.toContain("PriceRow");
    // And the real import, three lines below the apostrophe, is still there to be read.
    expect(masked).toContain("import { formatMoney } from '../shared/money';");
  });

  test("still lets the one quote the pack calls multiline hold a newline", () => {
    // The whole point of declaring the subset rather than banning newlines outright: a template
    // literal spans lines legally, and a `//` inside one is part of the string, not a comment.
    const source = "const help = `\n  https://acme.test/help\n`;\nimport { a } from './a';\n";

    const masked = maskComments(source, typescript);

    expect(masked).toBe(source);
  });

  test("keeps every quote spanning lines for a pack that declares no multiline subset", () => {
    // php means the opposite of JavaScript here, and it says so by saying nothing. A masker that
    // made the JavaScript rule the default would start cutting php strings at the newline and
    // blanking their contents, which the string edge family reads.
    const source = "$sql = 'SELECT *\n-- FROM \\Acme\\Models\\Order\n';\n$b = 2;\n";

    expect(maskComments(source, php)).toBe(source);
  });
});
