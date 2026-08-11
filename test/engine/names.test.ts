import { describe, expect, test } from "vitest";
import { mergeNames, nameLines, tallyNames } from "../../src/engine/names";
import type { AmbiguousName, NameOutcome, NameResolution } from "../../src/schema/types";

/**
 * The name-resolution tally and the one sentence every surface prints it in.
 *
 * The defect this module exists to end was silence: a duplicate basename removed every edge to that
 * name and nothing said so — no warning, doctor OK. So the tests below are mostly about arithmetic
 * that has to be right for the sentence to be worth reading (a count per reference, not per name),
 * an order that has to be total (or `graph.json` stops being byte-comparable, which is what
 * `empo index --check` is), and a set of exact user-visible strings.
 *
 * Inputs are hand-built plain data. A `NameOutcome` has four fields and all four decide something,
 * so nothing here is filler: `family` buckets, `name` keys the ambiguity table, `outcome` picks the
 * counter, and `candidates` is the breadth an ambiguous name is reported with.
 */

function outcome(
  family: NameOutcome["family"],
  name: string,
  verdict: NameOutcome["outcome"],
  candidates: number,
): NameOutcome {
  return { family, name, outcome: verdict, candidates };
}

/** A resolved reference: exactly one node carries the name, which is what `candidates: 1` says. */
function resolved(family: NameOutcome["family"], name: string): NameOutcome {
  return outcome(family, name, "resolved", 1);
}

/** An ambiguous reference: `candidates` is how many nodes carry the name, never fewer than two. */
function ambiguous(family: NameOutcome["family"], name: string, candidates: number): NameOutcome {
  return outcome(family, name, "ambiguous", candidates);
}

/** A whole family record, so a test can state the numbers it cares about and zero the rest. */
function report(
  family: NameResolution["family"],
  counts: Partial<Omit<NameResolution, "family">> = {},
): NameResolution {
  return {
    family,
    resolved: counts.resolved ?? 0,
    unknown: counts.unknown ?? 0,
    ambiguous: counts.ambiguous ?? 0,
    wrongKind: counts.wrongKind ?? 0,
    local: counts.local ?? 0,
    vendor: counts.vendor ?? 0,
    ambiguousNames: counts.ambiguousNames ?? [],
  };
}

function named(name: string, nodes: number, references: number): AmbiguousName {
  return { name, nodes, references };
}

describe("tallyNames", () => {
  test("folds every outcome of a family into one record, and orders the records by family", () => {
    // One record per family is what the renderer prints one line per, and the order has to come
    // from the family name rather than from the order the extractors happened to run in: the
    // records reach `graph.json`, and `empo index --check` compares that file byte for byte.
    const tally = tallyNames([
      outcome("template", "OrderTable", "unknown", 0),
      resolved("import", "./calculator"),
      outcome("hook", "useOrders", "wrong-kind", 1),
      resolved("import", "./formatter"),
      outcome("fqcn", "App\\Orders\\Calculator", "unknown", 0),
    ]);

    expect(tally).toEqual([
      report("fqcn", { unknown: 1 }),
      report("hook", { wrongKind: 1 }),
      report("import", { resolved: 2 }),
      report("template", { unknown: 1 }),
    ]);
  });

  test("counts every reference, not every distinct name", () => {
    // The number answers "what did this family's rules do with what they found", and a name written
    // forty times that resolves is forty couplings. Counting distinct names instead would report 1
    // here and make a heavily-used component indistinguishable from a one-off.
    const tally = tallyNames(Array.from({ length: 40 }, () => resolved("template", "OrderCard")));

    expect(tally).toEqual([report("template", { resolved: 40 })]);
  });

  test("counts every refusal of the same name too, and names it once", () => {
    // The two cuts live side by side on purpose: `ambiguous` is the edges lost (per reference) and
    // `ambiguousNames` is the renames that would give them back (per name). Collapsing either into
    // the other loses one of the two questions a reader asks.
    const tally = tallyNames([
      ambiguous("template", "OrderTable", 3),
      ambiguous("template", "OrderTable", 3),
      ambiguous("template", "OrderTable", 3),
    ]);

    expect(tally).toEqual([
      report("template", { ambiguous: 3, ambiguousNames: [named("OrderTable", 3, 3)] }),
    ]);
  });

  test("names only the ambiguous refusals, summing references and taking the widest breadth", () => {
    // `unknown` is a vendor component and `wrong-kind` is a rule's own `targetKinds` doing its job;
    // neither is a rename anyone can make, so neither belongs on the actionable list. The breadth of
    // a name is a max and not a sum, because it is one fact about the index, observed twice.
    const tally = tallyNames([
      ambiguous("template", "OrderTable", 3),
      outcome("template", "x-slot", "unknown", 0),
      ambiguous("template", "OrderTable", 4),
      outcome("template", "Calculator", "wrong-kind", 1),
      resolved("template", "InvoiceCard"),
    ]);

    expect(tally).toEqual([
      report("template", {
        resolved: 1,
        unknown: 1,
        ambiguous: 2,
        wrongKind: 1,
        ambiguousNames: [named("OrderTable", 4, 2)],
      }),
    ]);
  });

  test("orders the named ambiguities by references first, so the costliest repair reads first", () => {
    // Cost before breadth: a name read twelve times across three files loses more edges than a name
    // read twice across nine, and the reader is looking for the rename with the best return.
    const tally = tallyNames([
      ...Array.from({ length: 2 }, () => ambiguous("template", "Wide", 9)),
      ...Array.from({ length: 12 }, () => ambiguous("template", "Costly", 3)),
    ]);

    expect(tally[0]?.ambiguousNames).toEqual([named("Costly", 3, 12), named("Wide", 9, 2)]);
  });

  test("breaks a tie in references on breadth, widest first", () => {
    // Equal cost, so the second question is how much of the tree the name is smeared across: the
    // one in nine files is the bigger structural problem and the one worth reading first.
    const tally = tallyNames([
      ambiguous("template", "Narrow", 2),
      ambiguous("template", "Narrow", 2),
      ambiguous("template", "Wide", 9),
      ambiguous("template", "Wide", 9),
    ]);

    expect(tally[0]?.ambiguousNames).toEqual([named("Wide", 9, 2), named("Narrow", 2, 2)]);
  });

  test("breaks a full tie on the name, so the same input always emits the same bytes", () => {
    // The name tiebreak is not a preference, it is what makes the order total. Two names that cost
    // exactly the same must land the same way whatever order the extractors produced them in, or
    // `graph.json` differs between two runs of the same repository and `empo index --check` fails
    // on a repository nobody changed. Feeding the same set in two orders pins that.
    const forwards = tallyNames([
      ambiguous("template", "Alpha", 3),
      ambiguous("template", "Beta", 3),
      ambiguous("template", "Gamma", 3),
    ]);
    const backwards = tallyNames([
      ambiguous("template", "Gamma", 3),
      ambiguous("template", "Beta", 3),
      ambiguous("template", "Alpha", 3),
    ]);

    expect(forwards[0]?.ambiguousNames).toEqual([
      named("Alpha", 3, 1),
      named("Beta", 3, 1),
      named("Gamma", 3, 1),
    ]);
    expect(backwards).toEqual(forwards);
  });

  test("reports no families at all when no rule read a name", () => {
    // The empty array is a fact and not a missing one: it is what tells the renderer to say "no rule
    // in these packs resolves a name" rather than "no run has counted them".
    expect(tallyNames([])).toEqual([]);
  });
});

describe("mergeNames", () => {
  test("sums each family's counts across roots", () => {
    // A reference read under one root and a reference read under another are two references, so
    // every counter adds. The families are still one record each and still ordered by name.
    const merged = mergeNames([
      report("template", { resolved: 12, unknown: 2, ambiguous: 5, wrongKind: 1 }),
      report("import", { resolved: 30 }),
      report("template", { resolved: 9, unknown: 1, ambiguous: 4, wrongKind: 3 }),
    ]);

    expect(merged).toEqual([
      report("import", { resolved: 30 }),
      report("template", { resolved: 21, unknown: 3, ambiguous: 9, wrongKind: 4 }),
    ]);
  });

  test("takes the widest breadth of a name ambiguous under two roots, and sums its references", () => {
    // The asymmetry is the point. References are events and add. Candidate counts are a property of
    // one root's index, so 3 files under the api root and 4 under the web root is a reader who will
    // open an index and find 4 — not 7. Summing would report more files than any single refusal ever
    // weighed, and would send them looking for three files that do not exist.
    const merged = mergeNames([
      report("template", { ambiguous: 12, ambiguousNames: [named("OrderTable", 3, 12)] }),
      report("template", { ambiguous: 5, ambiguousNames: [named("OrderTable", 4, 5)] }),
    ]);

    expect(merged).toEqual([
      report("template", { ambiguous: 17, ambiguousNames: [named("OrderTable", 4, 17)] }),
    ]);
  });

  test("keeps a family that only one root reported", () => {
    // A PHP root and a JS root do not read the same families, and the merge is the only place the
    // two meet. Dropping the family nobody else mentioned would delete the whole tally of a root.
    const merged = mergeNames([
      report("fqcn", { resolved: 8, ambiguous: 1, ambiguousNames: [named("Calculator", 2, 1)] }),
      report("hook", { resolved: 4 }),
    ]);

    expect(merged).toEqual([
      report("fqcn", { resolved: 8, ambiguous: 1, ambiguousNames: [named("Calculator", 2, 1)] }),
      report("hook", { resolved: 4 }),
    ]);
  });

  test("emits the same records whatever order the roots were merged in", () => {
    // Roots are walked in whatever order the config lists them and, once concurrency enters, in
    // whatever order they finish. None of that may reach `graph.json`, so the merge has to be
    // commutative in its output — both in the family order and in the named-ambiguity order.
    const roots = [
      report("template", {
        resolved: 3,
        ambiguous: 4,
        ambiguousNames: [named("Beta", 2, 4)],
      }),
      report("import", { resolved: 7 }),
      report("template", {
        resolved: 1,
        ambiguous: 4,
        ambiguousNames: [named("Alpha", 5, 4)],
      }),
    ];

    const forwards = mergeNames(roots);
    const backwards = mergeNames([...roots].reverse());

    expect(forwards).toEqual([
      report("import", { resolved: 7 }),
      report("template", {
        resolved: 4,
        ambiguous: 8,
        ambiguousNames: [named("Alpha", 5, 4), named("Beta", 2, 4)],
      }),
    ]);
    expect(backwards).toEqual(forwards);
  });

  test("merges nothing into nothing", () => {
    // A run over roots that read no names at all still has to say "counted, found nothing" rather
    // than "not counted", which is the empty array and not null.
    expect(mergeNames([])).toEqual([]);
  });
});

describe("nameLines", () => {
  test("says no run has counted, without claiming which run is missing", () => {
    // Null is "nobody counted", and two states reach it: there is no readable graph, or there is
    // one that was built before schema 5 and holds no `names` key at all. The flows line beside
    // this one can say "unknown until the graph is built" because only the first state reaches its
    // null; this one cannot, and saying it would tell the reader of a perfectly readable graph to
    // build the graph they are looking at. So the sentence names the repair, which is the same for
    // both, and leaves which state it is to the graph and drift lines above, which have said.
    expect(nameLines(null)).toEqual([
      "names      unknown, no run has counted them (run empo index)",
    ]);
  });

  test("says the packs resolve no names when the tally is empty, in different words", () => {
    // These two are the whole reason the field is nullable rather than just an array. "We have not
    // looked" and "we looked and no rule in these packs resolves by name" send a reader to two
    // different places — one to `empo index`, the other to their pack's rules — and a renderer that
    // collapsed them into one sentence would undo the change it is rendering.
    const unknown = nameLines(null);
    const none = nameLines([]);

    expect(none).toEqual(["names      no name-resolving rule read a name here"]);
    expect(none).not.toEqual(unknown);
  });

  test("prints the denominator and nothing else for a family that refused nothing", () => {
    // The denominator prints on every run, including the good one: `41 of 41 resolved` and
    // `0 of 53 resolved` are opposite results and only the total separates them. But three "0 ..."
    // clauses hung off every healthy family is the noise that gets the line skimmed past, so the
    // zeros stay silent — the denominator has already stated them.
    expect(nameLines([report("template", { resolved: 41 })])).toEqual([
      "names      template 41 of 41 resolved",
    ]);
  });

  test("adds a clause per non-zero refusal, ambiguous then in-no-node then wrong-kind", () => {
    // Ambiguous leads because it is the only one of the three that hides a coupling the repository
    // really has; the other two are the normal cost of reading a language with vendor components,
    // and a rule's own `targetKinds` doing what it was declared for.
    const lines = nameLines([
      report("import", { resolved: 5, unknown: 3, ambiguous: 2, wrongKind: 1 }),
    ]);

    expect(lines).toEqual([
      "names      import   5 of 11 resolved, 2 ambiguous, 3 in no node, 1 of the wrong kind",
    ]);
  });

  test("skips the clauses that are zero and keeps the rest in the same order", () => {
    // The clause list is built by omission, not by filtering a fixed string, so the case where the
    // middle one is present and the first is not has to be pinned separately: a stray comma or a
    // dropped clause only shows up here.
    const lines = nameLines([report("hook", { unknown: 2, wrongKind: 1 })]);

    expect(lines).toEqual([
      "names      hook     0 of 3 resolved, 2 in no node, 1 of the wrong kind",
    ]);
  });

  test("lists the ambiguous names under the family, indented to the label column", () => {
    // Eleven spaces, which is exactly the width of the `names      ` label, so the detail hangs
    // under the family it belongs to instead of reading as a second family. The names are what makes
    // the count actionable: `4 ambiguous` says the family is losing edges, this says which rename
    // gives them back. A name read once is "1 reference" and not "1 references" — a user-visible
    // line with a plural bug in it reads as a line nobody checked.
    const lines = nameLines([
      report("template", {
        resolved: 8,
        ambiguous: 4,
        ambiguousNames: [named("OrderTable", 3, 3), named("InvoiceRow", 2, 1)],
      }),
    ]);

    expect(lines).toEqual([
      "names      template 8 of 12 resolved, 4 ambiguous",
      '           "OrderTable" (3 files, 3 references), "InvoiceRow" (2 files, 1 reference)',
    ]);
  });

  test("names five and counts the rest", () => {
    // Past five the list stops being read, and the tail still has to carry the fact that there is
    // more — a silently truncated list is the same silence this module was written to end. Six names
    // is the boundary: five printed, one counted.
    const lines = nameLines([
      report("template", {
        ambiguous: 21,
        ambiguousNames: [
          named("Alpha", 2, 6),
          named("Beta", 2, 5),
          named("Gamma", 2, 4),
          named("Delta", 2, 3),
          named("Epsilon", 2, 2),
          named("Zeta", 2, 1),
        ],
      }),
    ]);

    expect(lines).toEqual([
      "names      template 0 of 21 resolved, 21 ambiguous",
      '           "Alpha" (2 files, 6 references), "Beta" (2 files, 5 references), "Gamma" (2 files, 4 references), "Delta" (2 files, 3 references), "Epsilon" (2 files, 2 references), and 1 more',
    ]);
  });

  test("counts every name past the fifth in the tail", () => {
    // The tail is a subtraction and not a flag, so a list twice the limit has to say how far past it
    // went. Seven names: five printed, two counted.
    const names = ["A", "B", "C", "D", "E", "F", "G"].map((name, index) =>
      named(name, 2, 10 - index),
    );
    const lines = nameLines([report("template", { ambiguous: 49, ambiguousNames: names })]);

    expect(lines[1]?.endsWith(", and 2 more")).toBe(true);
  });

  test("gives every family its own line, with the family name padded to one column", () => {
    // Several families print together on `empo index`, and the counts only compare at a glance if
    // they start at the same column. Nine characters is the longest family name plus a space, so
    // "hook" and "template" line up.
    const lines = nameLines([
      report("hook", { resolved: 4, unknown: 1 }),
      report("template", {
        resolved: 0,
        ambiguous: 53,
        ambiguousNames: [named("OrderTable", 40, 53)],
      }),
    ]);

    expect(lines).toEqual([
      "names      hook     4 of 5 resolved, 1 in no node",
      "names      template 0 of 53 resolved, 53 ambiguous",
      '           "OrderTable" (40 files, 53 references)',
    ]);
  });
});
