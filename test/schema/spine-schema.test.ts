import { describe, expect, test } from "vitest";
import { EmpoError } from "../../src/errors";
import { parseSpineFile, spineJsonSchema } from "../../src/schema/spine.schema";

/**
 * A spine is hand-written by a human and read by a gate that can fail a commit, so it is the one
 * artifact where a typo costs in both directions: a malformed spine gates nothing, and a spine that
 * guards files with no assertion terms fails every change it sees. Each case below is a defect the
 * file can carry while still being valid JSON, and every one of them has to be refused at load time
 * with the spine named, rather than surfacing later as a gate nobody can satisfy.
 */

const SOURCE = ".empo/spines/money.json";

/** The whole of a legal spine: a chain nobody has gated yet is still a spine. */
const minimal = { version: 1, name: "money" };

function hop(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    n,
    title: `hop ${n}`,
    file: "app/Libraries/Price/PriceCalculator.php",
    line: 10 + n,
    anchor: "$total = $gross - $discount;",
    ...overrides,
  };
}

/** The details of the thrown config error, which is where the offending path lands. */
function issues(raw: unknown): string {
  try {
    parseSpineFile(raw, SOURCE);
    return expect.unreachable("expected a config error");
  } catch (error) {
    expect(error).toBeInstanceOf(EmpoError);
    expect((error as EmpoError).exitCode).toBe(2);
    expect((error as EmpoError).message).toContain(SOURCE);
    return (error as EmpoError).details.join("\n");
  }
}

describe("parseSpineFile", () => {
  test("reads a spine that states only its version and name, and fills every list in empty", () => {
    const spine = parseSpineFile(minimal, SOURCE);

    expect(spine).toEqual({
      version: 1,
      name: "money",
      hops: [],
      guarded: [],
      assertionTerms: [],
      assertionPaths: [],
      invariants: [],
      traps: [],
      flows: [],
      unguardedFlows: [],
    });
    expect(spine.principle).toBeUndefined();
    expect(spine.moneyType).toBeUndefined();
  });

  test("treats an invariant as not assertable at write time unless the human said so", () => {
    // Moving a check into the write path is a judgement, so the schema never assumes it was made.
    const spine = parseSpineFile(
      { ...minimal, invariants: [{ id: 1, statement: "A claim item never outlives its claim" }] },
      SOURCE,
    );

    expect(spine.invariants[0]?.assertableAtWriteTime).toBe(false);
  });

  test("keeps every field of a fully curated spine, since the file is the human's own words", () => {
    const full = {
      version: 1,
      name: "money",
      principle: "Money is decided once, in cents, and every consumer reads that decision.",
      hops: [
        hop(0, { title: "price resolution", entry: "PriceCalculator::total", note: "the funnel" }),
        hop(1, { title: "claim item write", file: "app/Models/ClaimItem.php", line: 88 }),
      ],
      guarded: ["app/Libraries/Price/**", "app/Models/ClaimItem.php"],
      assertionTerms: ["assertSame", "assertEqualsWithDelta"],
      assertionPaths: ["tests/Feature/Price/**", "tests/Unit/MoneyTest.php"],
      invariants: [
        {
          id: 1,
          statement: "The sum of claim item amounts equals the claim total",
          assertableAtWriteTime: true,
          citation: { file: "app/Models/Claim.php", line: 120, anchor: "public function total()" },
        },
        { id: "INV-2", statement: "A refund never exceeds what was charged" },
      ],
      traps: [
        {
          what: "Discount is applied to gross, not net",
          file: "app/Libraries/Price/PriceCalculator.php",
          line: 42,
          anchor: "$total = $gross - $discount;",
        },
      ],
      flows: ["checkout", "refunds"],
      unguardedFlows: ["refunds"],
      moneyType: { class: "Acme\\Support\\Money", note: "integer cents, never a float" },
    };

    expect(parseSpineFile(full, SOURCE)).toEqual({
      ...full,
      invariants: [full.invariants[0], { ...full.invariants[1], assertableAtWriteTime: false }],
    });
  });

  test("rejects a spine with no version, since an unversioned file cannot be read forward", () => {
    const { version, ...unversioned } = minimal;

    expect(version).toBe(1);
    expect(issues(unversioned)).toContain("version");
  });

  test("rejects a version this loader was never written for", () => {
    expect(issues({ ...minimal, version: 2 })).toContain("version");
  });

  test("rejects a spine with no name, because every message about it names it", () => {
    expect(issues({ version: 1 })).toContain("name");
  });

  test("rejects a hop with no anchor, since a coordinate nothing can resolve is the fiction verify exists to catch", () => {
    const { anchor, ...anchorless } = hop(0);

    expect(anchor).toBeDefined();
    expect(issues({ ...minimal, hops: [anchorless] })).toContain("hops.0.anchor");
  });

  test("rejects line 0, since a file's first line is 1", () => {
    expect(issues({ ...minimal, hops: [hop(0, { line: 0 })] })).toContain("hops.0.line");
  });

  test("rejects a negative line", () => {
    expect(issues({ ...minimal, hops: [hop(0, { line: -3 })] })).toContain("hops.0.line");
  });

  test("rejects a fractional line number", () => {
    expect(issues({ ...minimal, hops: [hop(0, { line: 4.5 })] })).toContain("hops.0.line");
  });

  test("rejects an anchor that is only whitespace, since it quotes no source at all", () => {
    expect(issues({ ...minimal, hops: [hop(0, { anchor: "   " })] })).toContain("hops.0.anchor");
  });

  test("rejects a trap with no file to point at", () => {
    const trap = { what: "Rounds twice", line: 42, anchor: "round($total)" };

    expect(issues({ ...minimal, traps: [trap] })).toContain("traps.0.file");
  });

  test("refuses guarded globs with no assertion terms, since no change could ever satisfy that gate", () => {
    const detail = issues({ ...minimal, guarded: ["app/Libraries/Price/**"] });

    expect(detail).toContain("assertionTerms");
  });

  test("accepts a spine that guards nothing and asserts nothing, because mapping a chain is not gating it", () => {
    const spine = parseSpineFile({ ...minimal, hops: [hop(0)] }, SOURCE);

    expect(spine.guarded).toEqual([]);
    expect(spine.assertionTerms).toEqual([]);
  });

  test("refuses hops whose numbering disagrees with the order they are listed in", () => {
    // A human cites "hop 2" by reading down the list, so the two readings have to be one reading.
    const detail = issues({ ...minimal, hops: [hop(0), hop(2), hop(1)] });

    expect(detail).toContain("hops.2.n");
  });

  test("refuses two hops that claim the same number", () => {
    expect(issues({ ...minimal, hops: [hop(0), hop(0)] })).toContain("hops.1.n");
  });

  test("accepts hop numbers that ascend with gaps, since ascending is the rule and not contiguity", () => {
    // Renumbering the whole chain to delete one hop is the kind of churn that stops people curating.
    expect(
      parseSpineFile({ ...minimal, hops: [hop(0), hop(1), hop(2)] }, SOURCE).hops,
    ).toHaveLength(3);
    expect(
      parseSpineFile({ ...minimal, hops: [hop(1), hop(5), hop(9)] }, SOURCE).hops,
    ).toHaveLength(3);
  });

  test("refuses an unrecognized key instead of dropping it, and names the key", () => {
    // The field names are camelCase, and a reader that forgives `unguarded_flows` accepts a spine
    // that guards nothing and says nothing about it. A hand-written artifact needs a loud reader:
    // this is the one defect where silence looks exactly like success.
    const detail = issues({ ...minimal, unguarded_flows: ["refunds"] });

    expect(detail).toContain("unguarded_flows");
  });

  test("refuses an unrecognized key inside a hop as readily as at the top level", () => {
    expect(issues({ ...minimal, hops: [hop(0, { ancor: "typo" })] })).toContain("ancor");
  });

  test("labels an invariant by a number or by a string, whichever the curator prefers", () => {
    const spine = parseSpineFile(
      {
        ...minimal,
        invariants: [
          { id: 3, statement: "Every charge has a ledger line" },
          { id: "INV-3", statement: "Every ledger line has a charge" },
        ],
      },
      SOURCE,
    );

    expect(spine.invariants.map((invariant) => invariant.id)).toEqual([3, "INV-3"]);
  });
});

describe("spineJsonSchema", () => {
  test("generates the editor schema even though the spine carries curation refinements", () => {
    // The refinements live in a superRefine, which is the part of a zod schema that has no JSON
    // Schema spelling. Editors still have to get a schema, so generation must not break on them.
    const schema = spineJsonSchema() as {
      properties: Record<string, unknown>;
      additionalProperties?: unknown;
    };

    expect(Object.keys(schema.properties)).toContain("hops");
    expect(Object.keys(schema.properties)).toContain("assertionTerms");
    // The editor-facing half of strictness. Without this an editor autocompletes a misspelled key
    // happily and the loader refuses the file later, which is the worst of both readings.
    expect(schema.additionalProperties).toBe(false);
  });
});
