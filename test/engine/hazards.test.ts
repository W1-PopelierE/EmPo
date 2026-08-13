import { describe, expect, test } from "vitest";
import {
  type CompiledHazards,
  compileHazards,
  declaresDeferral,
  findEnclosedDispatches,
} from "../../src/engine/hazards";
import type { CommentSyntax, Pack, PackHazards } from "../../src/schema/types";

/**
 * A hazard is a queued job dispatched from inside a database transaction without waiting for the
 * commit. This module only walks pack-declared markers, so every marker below is invented for these
 * tests and none of it teaches the engine a language.
 *
 * Sources are arrays of lines joined on a newline rather than template literals, because every
 * assertion here is about a line number and an array makes the number countable.
 */

const hazards: PackHazards = {
  transactions: [
    { pattern: "DB::transaction\\s*\\(", extent: "balanced", open: "{", close: "}" },
    {
      pattern: "DB::beginTransaction\\(\\)",
      extent: "span",
      endPattern: "DB::commit\\(\\)",
    },
  ],
  dispatches: [{ pattern: "dispatch\\(new ([A-Za-z]+)", job: 1 }],
  deferAtSite: ["->afterCommit\\("],
  deferAtDeclaration: ["\\$afterCommit\\s*=\\s*true"],
};

/**
 * The quote declarations the statement walk steps over. Spelled out here rather than loaded from a
 * real pack, so these tests describe the engine and not somebody's pack.json. `comments` is passed
 * separately because a pack that declares none is a case the walk has to handle: no string syntax
 * means nothing to skip, not a crash.
 */
const comments: CommentSyntax = {
  line: ["//"],
  block: [["/*", "*/"]],
  stringQuotes: ["'", '"'],
  stringEscape: "\\",
};

function packWith(block?: PackHazards): Pack {
  return {
    name: "fixture",
    version: "0.0.0",
    match: { extensions: [".php"] },
    node: { id: { strategy: "module-path" }, kindRules: [] },
    comments,
    edges: {},
    produces: [],
    consumes: [],
    tests: { paths: [], assertionTerms: [], assertionExcludes: [] },
    hazards: block,
  };
}

/** The compiled block, with the null case asserted separately so every other test can be direct. */
function compiled(block: PackHazards = hazards): CompiledHazards {
  const result = compileHazards(packWith(block));
  if (result === null) throw new Error("expected the fixture pack to declare hazards");
  return result;
}

function source(...lines: string[]): string {
  return lines.join("\n");
}

describe("compileHazards", () => {
  test("returns null when the pack declares no hazards block", () => {
    expect(compileHazards(packWith())).toBeNull();
  });

  test("compiles a declared but empty block, because found none is not nobody looked", () => {
    const empty = compileHazards(
      packWith({ transactions: [], dispatches: [], deferAtSite: [], deferAtDeclaration: [] }),
    );

    expect(empty).not.toBeNull();
    expect(findEnclosedDispatches(empty as CompiledHazards, "dispatch(new SendInvoice);")).toEqual(
      [],
    );
  });

  test("drops a balanced rule with no delimiter pair rather than enclosing the whole file", () => {
    // The pack schema rejects this shape at load, so only a hand-built pack reaches it. Dropping
    // is the safe direction: counting nothing would report every dispatch in the file.
    const lame = compiled({
      transactions: [{ pattern: "DB::transaction\\s*\\(", extent: "balanced" }],
      dispatches: hazards.dispatches,
      deferAtSite: [],
      deferAtDeclaration: [],
    });

    const text = source("<?php", "DB::transaction(function () {", "dispatch(new SendInvoice);");

    expect(findEnclosedDispatches(lame, text)).toEqual([]);
  });
});

describe("findEnclosedDispatches, balanced extents", () => {
  test("reports a dispatch inside a closure transaction", () => {
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      "    dispatch(new SendInvoice);",
      "});",
    );

    expect(findEnclosedDispatches(compiled(), text)).toEqual([
      { job: "SendInvoice", line: 3, transactionLine: 2, deferredAtSite: false },
    ]);
  });

  test("leaves the same dispatch alone once it sits after the closure", () => {
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      "    $order->markPaid();",
      "});",
      "dispatch(new SendInvoice);",
    );

    expect(findEnclosedDispatches(compiled(), text)).toEqual([]);
  });

  test("counts nested delimiters, including a balanced pair inside a string literal", () => {
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      "    if ($order->isPaid()) {",
      "        $note = 'closes with } and reopens with {';",
      "        dispatch(new SendInvoice);",
      "    }",
      "});",
      "dispatch(new SendReceipt);",
    );

    expect(findEnclosedDispatches(compiled(), text)).toEqual([
      { job: "SendInvoice", line: 5, transactionLine: 2, deferredAtSite: false },
    ]);
  });

  test("names the innermost transaction when two of them enclose one dispatch", () => {
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      "    DB::transaction(function () {",
      "        dispatch(new SendInvoice);",
      "    });",
      "});",
    );

    expect(findEnclosedDispatches(compiled(), text)).toEqual([
      { job: "SendInvoice", line: 4, transactionLine: 3, deferredAtSite: false },
    ]);
  });

  test("runs an unbalanced transaction to the end of the file", () => {
    // An unclosed transaction is the worse hazard, not a reason to report nothing.
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      "    dispatch(new SendInvoice);",
      "",
    );

    expect(findEnclosedDispatches(compiled(), text)).toEqual([
      { job: "SendInvoice", line: 3, transactionLine: 2, deferredAtSite: false },
    ]);
  });

  test("runs to the end of the file when no open delimiter follows the opener at all", () => {
    const text = source("<?php", "DB::transaction(", "dispatch(new SendInvoice);");

    expect(findEnclosedDispatches(compiled(), text)).toEqual([
      { job: "SendInvoice", line: 3, transactionLine: 2, deferredAtSite: false },
    ]);
  });
});

describe("findEnclosedDispatches, span extents", () => {
  test("reports a dispatch between the opener and the commit", () => {
    const text = source(
      "<?php",
      "DB::beginTransaction();",
      "$order->markPaid();",
      "dispatch(new SendInvoice);",
      "DB::commit();",
    );

    expect(findEnclosedDispatches(compiled(), text)).toEqual([
      { job: "SendInvoice", line: 4, transactionLine: 2, deferredAtSite: false },
    ]);
  });

  test("leaves a dispatch after the commit alone", () => {
    const text = source(
      "<?php",
      "DB::beginTransaction();",
      "$order->markPaid();",
      "DB::commit();",
      "dispatch(new SendInvoice);",
    );

    expect(findEnclosedDispatches(compiled(), text)).toEqual([]);
  });

  test("runs to the end of the file when the commit never arrives", () => {
    const text = source("<?php", "DB::beginTransaction();", "dispatch(new SendInvoice);");

    expect(findEnclosedDispatches(compiled(), text)).toEqual([
      { job: "SendInvoice", line: 3, transactionLine: 2, deferredAtSite: false },
    ]);
  });
});

describe("findEnclosedDispatches, deferral at the site", () => {
  test("a chained afterCommit on the next line still belongs to the dispatch's statement", () => {
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      "    dispatch(new SendInvoice)",
      "        ->afterCommit();",
      "});",
    );

    expect(findEnclosedDispatches(compiled(), text)).toEqual([
      { job: "SendInvoice", line: 3, transactionLine: 2, deferredAtSite: true },
    ]);
  });

  test("a defer marker on the following statement does not defer this dispatch", () => {
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      "    dispatch(new SendInvoice);",
      "    $mailer->afterCommit();",
      "});",
    );

    expect(findEnclosedDispatches(compiled(), text)).toEqual([
      { job: "SendInvoice", line: 3, transactionLine: 2, deferredAtSite: false },
    ]);
  });

  test("falls back to the dispatch's own line when the file holds no statement terminator", () => {
    // The documented bound: with no `;` anywhere, the statement ends at the end of its line, so a
    // chained marker on the next line is not seen. That is the conservative answer for a language
    // with no terminator, which should carry its deferral in deferAtDeclaration instead.
    const text = source(
      "DB::transaction(function () {",
      "    dispatch(new SendInvoice)",
      "        ->afterCommit()",
      "})",
    );

    expect(findEnclosedDispatches(compiled(), text)).toEqual([
      { job: "SendInvoice", line: 2, transactionLine: 1, deferredAtSite: false },
    ]);
  });
});

describe("findEnclosedDispatches, a static-method dispatch spelling", () => {
  /**
   * The other common way a pack writes a dispatch rule: the job leads the call instead of following
   * a constructor, and the capture holds the name as written, qualified or not. It is here because
   * the statement rule is what decides whether the wrapped chain form is seen, and that answer must
   * hold for both spellings and not just the one the rest of this file uses.
   */
  const statik: PackHazards = {
    transactions: hazards.transactions,
    dispatches: [{ pattern: "([A-Za-z\\\\]+)::dispatch\\(", job: 1 }],
    deferAtSite: ["->\\s*afterCommit\\(\\s*\\)"],
    deferAtDeclaration: [],
  };

  test("sees a wrapped afterCommit chain, and captures the name as written", () => {
    const text = source(
      "<?php",
      "DB::transaction(function () use ($order) {",
      "    ProcessOrder::dispatch($order)",
      "        ->afterCommit();",
      "    \\Acme\\Jobs\\SendInvoice::dispatch($order);",
      "});",
    );

    expect(findEnclosedDispatches(compiled(statik), text)).toEqual([
      { job: "ProcessOrder", line: 3, transactionLine: 2, deferredAtSite: true },
      { job: "\\Acme\\Jobs\\SendInvoice", line: 5, transactionLine: 2, deferredAtSite: false },
    ]);
  });

  test("a terminator inside a string argument does not end the statement", () => {
    // The statement walk steps over string literals using the pack's own quote declarations, so
    // the `;` inside the argument is not mistaken for the end of the statement. Without that, the
    // chained marker would be cut off and this would be reported as a hazard against code that
    // already waits for the commit, which is a fabricated finding.
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      '    ProcessOrder::dispatch("hello; world")->afterCommit();',
      "});",
    );

    expect(findEnclosedDispatches(compiled(statik), text)).toEqual([
      { job: "ProcessOrder", line: 3, transactionLine: 2, deferredAtSite: true },
    ]);
  });

  test("an escaped quote inside that argument does not end the string early", () => {
    // The escape character is pack-declared too. Reading the `\"` as the closing quote would put
    // the walk back into code inside the literal, where the `;` ends the statement and the hazard
    // is fabricated again.
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      '    ProcessOrder::dispatch("say \\"hi\\"; then go")',
      "        ->afterCommit();",
      "});",
    );

    expect(findEnclosedDispatches(compiled(statik), text)).toEqual([
      { job: "ProcessOrder", line: 3, transactionLine: 2, deferredAtSite: true },
    ]);
  });

  test("falls back to the raw scan when the pack declares no string syntax", () => {
    // The degenerate case, and the reason the skip is a no-op rather than a special case: a pack
    // with no comments block has no quotes to step over, so the walk behaves exactly as it did
    // before the skip existed and takes the first `;` it sees, inside the literal.
    // Spread rather than a defaulted parameter: passing `undefined` to a parameter that has a
    // default selects the default, so the pack would have kept its quotes and this test would have
    // asserted the opposite of what it names.
    const bare = compileHazards({ ...packWith(statik), comments: undefined });
    if (bare === null) throw new Error("expected the fixture pack to declare hazards");
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      '    ProcessOrder::dispatch("hello; world")->afterCommit();',
      "});",
    );

    expect(findEnclosedDispatches(bare, text)).toEqual([
      { job: "ProcessOrder", line: 3, transactionLine: 2, deferredAtSite: false },
    ]);
  });

  test("a defer marker on the next statement is still not this dispatch's, past a string", () => {
    // The skip must not swallow the boundary itself: the real `;` after the literal still ends the
    // statement, so the marker below it belongs to the next one.
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      '    ProcessOrder::dispatch("hello; world");',
      "    $mailer->afterCommit();",
      "});",
    );

    expect(findEnclosedDispatches(compiled(statik), text)).toEqual([
      { job: "ProcessOrder", line: 3, transactionLine: 2, deferredAtSite: false },
    ]);
  });
});

describe("findEnclosedDispatches, order and repeatability", () => {
  test("orders by line, then by job", () => {
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      "    dispatch(new Zeta); dispatch(new Alpha);",
      "    dispatch(new Beta);",
      "});",
    );

    expect(findEnclosedDispatches(compiled(), text).map((site) => site.job)).toEqual([
      "Alpha",
      "Zeta",
      "Beta",
    ]);
  });

  test("answers the same question the same way twice, across two files", () => {
    // The compiled regexes are shared, so a leftover lastIndex would make the second answer depend
    // on the first. Determinism is a hard requirement here (docs/05-graph-model.md).
    const one = compiled();
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      "    dispatch(new Alpha);",
      "    dispatch(new Beta);",
      "});",
    );
    const other = source("<?php", "DB::beginTransaction();", "dispatch(new Gamma);");

    const first = findEnclosedDispatches(one, text);
    findEnclosedDispatches(one, other);
    const second = findEnclosedDispatches(one, text);

    expect(second).toEqual(first);
    expect(first.map((site) => site.job)).toEqual(["Alpha", "Beta"]);
  });
});

describe("findEnclosedDispatches, the string-literal blind spot", () => {
  test("a transaction opener inside a string literal opens an extent anyway", () => {
    // KNOWN LIMITATION, asserted rather than wished away. engine/mask.ts masks comments and
    // deliberately never masks string contents (mask.ts:12-14), because the string edge family and
    // every route path live inside them. So this dispatch is reported as enclosed by a transaction
    // that no database ever opened. Fixing it needs a lexer the engine does not own.
    const text = source("<?php", "$sql = 'DB::transaction(function () {';", "dispatch(new Ghost);");

    expect(findEnclosedDispatches(compiled(), text)).toEqual([
      { job: "Ghost", line: 3, transactionLine: 2, deferredAtSite: false },
    ]);
  });

  test("a lone closing delimiter inside a string ends a real extent early", () => {
    // The same limitation in the other direction, and the more dangerous one: this hides a real
    // hazard rather than inventing one.
    const text = source(
      "<?php",
      "DB::transaction(function () {",
      "    $note = 'the closing } of the block';",
      "    dispatch(new SendInvoice);",
      "});",
    );

    expect(findEnclosedDispatches(compiled(), text)).toEqual([]);
  });
});

describe("declaresDeferral", () => {
  test("is true when the job's own file declares that its dispatches wait", () => {
    const text = source(
      "<?php",
      "class SendInvoice implements ShouldQueue",
      "{",
      "    public $afterCommit = true;",
      "}",
    );

    expect(declaresDeferral(compiled(), text)).toBe(true);
  });

  test("is false when it does not", () => {
    const text = source("<?php", "class SendInvoice implements ShouldQueue", "{", "}");

    expect(declaresDeferral(compiled(), text)).toBe(false);
  });

  test("is false when the pack declares no declaration-side markers", () => {
    const none = compiled({
      transactions: hazards.transactions,
      dispatches: hazards.dispatches,
      deferAtSite: [],
      deferAtDeclaration: [],
    });

    expect(declaresDeferral(none, "public $afterCommit = true;")).toBe(false);
  });
});
