import { z } from "zod";
import { configError } from "../errors";
import { flowDefinitionSchema } from "./flows.schema";
import { spineFileSchema } from "./spine.schema";

/**
 * The runtime validator for the proposal an agent writes in step 5 of `empo init` (docs/06-cli.md).
 * The CLI prints a brief, a model answers into this file, and the gate in engine/proposal.ts decides
 * from it what reaches `.empo/`. That is the same two-phase shape `empo review` uses, so this file is
 * untrusted input in exactly the way a findings file is: a gate that judges a proposal is worthless
 * if what reaches it can be any shape at all.
 *
 * Strict, for the reason a spine file is strict, plus one this file adds. A spine is hand-written by
 * a human who can see the file they broke; a proposal is written by an agent from a doc and then
 * applied by a machine, so a misspelt key that is silently dropped becomes a flow with no label or a
 * spine with no guarded globs, and the human approving the diff has no way to see what went missing.
 * An unrecognized key is therefore refused with the key named.
 *
 * Both halves are the schemas they will be written as, imported rather than restated. A proposal
 * validated against a copy of the spine schema would be a second definition of what a spine is, and
 * the two would drift apart in the direction that lets a proposal pass here and fail at load.
 */

/**
 * The flow definition of flows.schema.ts, tightened to refuse an unknown key. flows.json itself is
 * hand-edited and non-strict; this is the generated end of the same shape, where nobody proofreads.
 */
const proposedFlowSchema = z.strictObject(flowDefinitionSchema.shape);

export const proposalFileSchema = z.strictObject({
  version: z.literal(1),
  /** Keyed by flow name, the same key flows.json uses. Empty is legal: a repo may have no journeys. */
  flows: z.record(z.string().min(1), proposedFlowSchema).default({}),
  /**
   * Full spines, not sketches. docs/08 asks an agent for the skeleton (hops and traps from the code)
   * and a human for the invariants, and the schema already allows exactly that: every list defaults
   * to empty, so a spine proposing only hops is valid without a second, laxer shape existing.
   */
  spines: z.array(spineFileSchema).default([]),
});

export type ProposalFile = z.infer<typeof proposalFileSchema>;

/** Validate an already-parsed proposal value. Throws a config error (exit 2) with every issue. */
export function parseProposalFile(raw: unknown, source: string): ProposalFile {
  const result = proposalFileSchema.safeParse(raw);
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  throw configError(`${source} is not a valid EmPo proposal`, details);
}

/** The JSON Schema editors validate against. Generated, never hand-written. */
export function proposalJsonSchema(): unknown {
  return z.toJSONSchema(proposalFileSchema, { io: "input" });
}
