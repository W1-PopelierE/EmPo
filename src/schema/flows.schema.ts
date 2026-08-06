import { z } from "zod";

/**
 * The runtime validator for flows.json (docs/05-graph-model.md). Human-owned and hand-edited, so it
 * is validated like any other untrusted input, with errors that name the flow that is wrong.
 */

export const flowDefinitionSchema = z.object({
  label: z.string().min(1).optional(),
  /**
   * Repo-relative path prefixes. A node belongs to the flow with the longest matching prefix,
   * except a test node, which belongs to no flow however well a prefix matches it.
   */
  paths: z.array(z.string().min(1)),
});

export const flowsFileSchema = z.object({
  version: z.literal(1),
  flows: z.record(z.string().min(1), flowDefinitionSchema).default({}),
});

export type FlowsFile = z.infer<typeof flowsFileSchema>;
