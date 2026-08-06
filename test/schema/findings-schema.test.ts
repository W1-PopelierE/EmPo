import { describe, expect, test } from "vitest";
import { EmpoError } from "../../src/errors";
import { findingsJsonSchema, parseFindingsFile } from "../../src/schema/findings.schema";

/**
 * The findings file is written by an agent and handed back to the CLI, so it is untrusted input
 * like any other. Each case below is a way the shape can be wrong such that the gate would
 * otherwise check something that is not there, and every one of them has to fail loudly at the
 * boundary, naming the field, rather than quietly one layer in.
 */

const valid = {
  findings: [
    {
      id: "F1",
      kind: "diff",
      severity: "major",
      title: "Discount is applied before tax, reversing the documented order",
      claim:
        "PriceCalculator::total() subtracts the discount from the gross amount, so a taxed line is discounted twice.",
      citation: {
        file: "apps/api/app/Libraries/Price/PriceCalculator.php",
        line: 42,
        anchor: "$total = $gross - $discount;",
      },
      supporting: [
        { file: "apps/api/app/Models/Order.php", line: 12, anchor: "public function total(): int" },
      ],
      suggestion: "Apply the discount to the net amount, after tax.",
    },
  ],
};

/** The details of the thrown config error, which is where a field name lands (see engine/config.ts). */
function issues(raw: unknown): string {
  try {
    parseFindingsFile(raw, ".empo/findings.json");
    return expect.unreachable("expected a config error");
  } catch (error) {
    expect(error).toBeInstanceOf(EmpoError);
    expect((error as EmpoError).exitCode).toBe(2);
    expect((error as EmpoError).message).toContain(".empo/findings.json");
    return (error as EmpoError).details.join("\n");
  }
}

function withFinding(overrides: Record<string, unknown>): unknown {
  return { findings: [{ ...valid.findings[0], ...overrides }] };
}

describe("parseFindingsFile", () => {
  test("parses the documented shape and hands back the findings", () => {
    const findings = parseFindingsFile(valid, ".empo/findings.json");

    expect(findings).toHaveLength(1);
    expect(findings[0]?.citation.line).toBe(42);
    expect(findings[0]?.supporting?.[0]?.anchor).toBe("public function total(): int");
    expect(findings[0]?.suggestion).toContain("after tax");
  });

  test("accepts a review that found nothing", () => {
    expect(parseFindingsFile({ findings: [] }, ".empo/findings.json")).toEqual([]);
  });

  test("accepts a finding with no supporting citations and no suggestion", () => {
    const { supporting, suggestion, ...bare } = valid.findings[0] ?? {};
    expect(supporting).toBeDefined();
    expect(suggestion).toBeDefined();

    expect(parseFindingsFile({ findings: [bare] }, ".empo/findings.json")).toHaveLength(1);
  });

  test("rejects a citation with no anchor, naming the field", () => {
    const detail = issues(
      withFinding({ citation: { file: "apps/api/app/Models/Order.php", line: 12 } }),
    );

    expect(detail).toContain("findings.0.citation.anchor");
  });

  test("rejects an empty claim, naming the field", () => {
    expect(issues(withFinding({ claim: "" }))).toContain("findings.0.claim");
  });

  test("rejects a claim that is only whitespace, since it says nothing either", () => {
    expect(issues(withFinding({ claim: "   " }))).toContain("findings.0.claim");
  });

  test("rejects a severity outside the four the report knows how to order", () => {
    const detail = issues(withFinding({ severity: "critical" }));

    expect(detail).toContain("findings.0.severity");
    expect(detail).toContain("blocker");
  });

  test("rejects a kind outside the three the discipline produces", () => {
    expect(issues(withFinding({ kind: "style" }))).toContain("findings.0.kind");
  });

  test("rejects line 0, since a file's first line is 1", () => {
    const detail = issues(
      withFinding({
        citation: { file: "apps/api/app/Models/Order.php", line: 0, anchor: "class Order" },
      }),
    );

    expect(detail).toContain("findings.0.citation.line");
  });

  test("rejects a fractional line number", () => {
    const detail = issues(
      withFinding({
        citation: { file: "apps/api/app/Models/Order.php", line: 4.5, anchor: "class Order" },
      }),
    );

    expect(detail).toContain("findings.0.citation.line");
  });

  test("rejects a root that is an array rather than the documented object", () => {
    expect(issues([valid.findings[0]])).toContain("expected object");
  });

  test("rejects a findings key that is not an array", () => {
    expect(issues({ findings: valid.findings[0] })).toContain("findings");
  });
});

describe("findingsJsonSchema", () => {
  test("generates the editor schema from the validator rather than restating it", () => {
    const schema = findingsJsonSchema() as {
      properties: {
        findings: { items: { properties: Record<string, unknown>; required: string[] } };
      };
    };
    const finding = schema.properties.findings.items;

    expect(Object.keys(finding.properties).sort()).toEqual([
      "citation",
      "claim",
      "id",
      "kind",
      "severity",
      "suggestion",
      "supporting",
      "title",
    ]);
    expect(finding.required).not.toContain("supporting");
    expect(finding.required).toContain("citation");
  });
});
