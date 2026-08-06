import { describe, expect, test } from "vitest";
import { EmpoError } from "../../src/errors";
import { parseProposalFile, proposalJsonSchema } from "../../src/schema/proposal.schema";

/**
 * The proposal is the one file in EmPo an agent writes unsupervised: `empo init` prints a brief, a
 * model answers into this file, and the CLI decides from it what reaches `.empo/`. That makes every
 * defect here the same defect a spine file can carry, with one difference: nobody proofread it. A
 * misspelt key that is silently dropped becomes a flow with no label or a spine with no guarded
 * globs, and the human approving the diff has no way to see that anything went missing. So the file
 * is refused, with the key named, rather than quietly repaired.
 */

const SOURCE = "/tmp/empo-init/proposal.json";

/** A whole spine, valid on its own terms. The proposal reuses the spine schema rather than a copy. */
function spine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: "pricing",
    hops: [
      {
        n: 0,
        title: "total resolution",
        file: "apps/api/app/Libraries/Price/PriceCalculator.php",
        line: 13,
        anchor: "return $order->subtotal + $this->tax(",
      },
    ],
    ...overrides,
  };
}

/** The details of the thrown config error, which is where the offending path lands. */
function issues(raw: unknown): string {
  try {
    parseProposalFile(raw, SOURCE);
    return expect.unreachable("expected a config error");
  } catch (error) {
    expect(error).toBeInstanceOf(EmpoError);
    expect((error as EmpoError).exitCode).toBe(2);
    expect((error as EmpoError).message).toContain(SOURCE);
    return (error as EmpoError).details.join("\n");
  }
}

describe("parseProposalFile", () => {
  test("reads a proposal that states only its version, and fills both halves in empty", () => {
    const proposal = parseProposalFile({ version: 1 }, SOURCE);

    expect(proposal).toEqual({ version: 1, flows: {}, spines: [] });
  });

  test("reads a proposal that states both halves", () => {
    const proposal = parseProposalFile(
      {
        version: 1,
        flows: { orders: { label: "Place an order", paths: ["apps/api/app/Models"] } },
        spines: [spine()],
      },
      SOURCE,
    );

    expect(Object.keys(proposal.flows)).toEqual(["orders"]);
    expect(proposal.flows.orders?.paths).toEqual(["apps/api/app/Models"]);
    expect(proposal.spines).toHaveLength(1);
    // The spine schema's defaults apply through the proposal, because it is the same schema.
    expect(proposal.spines[0]?.guarded).toEqual([]);
    expect(proposal.spines[0]?.hops[0]?.anchor).toBe("return $order->subtotal + $this->tax(");
  });

  test("refuses an unrecognized top-level key by name rather than dropping it", () => {
    expect(issues({ version: 1, spine: [spine()] })).toContain('Unrecognized key: "spine"');
  });

  test("refuses an unrecognized key inside a proposed flow", () => {
    const raw = { version: 1, flows: { orders: { labl: "Place an order", paths: ["apps/api"] } } };

    expect(issues(raw)).toContain('flows.orders: Unrecognized key: "labl"');
  });

  test("refuses an unrecognized key inside a proposed spine, naming the spine's index", () => {
    const raw = { version: 1, spines: [spine({ unguarded_flows: ["checkout"] })] };

    expect(issues(raw)).toContain('spines.0: Unrecognized key: "unguarded_flows"');
  });

  test("carries the spine schema's own curation rules into the proposal", () => {
    // A gate no change could satisfy is refused for a proposed spine exactly as it is for one on
    // disk. Reusing the schema is what makes that automatic instead of remembered.
    const raw = { version: 1, spines: [spine({ guarded: ["apps/api/**"] })] };

    expect(issues(raw)).toContain("spines.0.assertionTerms");
  });

  test("refuses a flow that states no paths", () => {
    expect(issues({ version: 1, flows: { orders: { label: "Place an order" } } })).toContain(
      "flows.orders.paths",
    );
  });

  test("refuses a proposal that will not say what version it is", () => {
    expect(issues({ flows: {} })).toContain("version");
  });

  test("refuses a proposal that is not an object at all", () => {
    expect(issues([{ version: 1 }])).not.toBe("");
  });
});

describe("proposalJsonSchema", () => {
  test("generates a schema that describes both halves", () => {
    const schema = proposalJsonSchema() as {
      properties: Record<string, unknown>;
    };

    expect(Object.keys(schema.properties).sort()).toEqual(["flows", "spines", "version"]);
  });
});
