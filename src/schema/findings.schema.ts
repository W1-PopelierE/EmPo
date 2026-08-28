import { z } from "zod";
import type { ReviewFinding } from "../discipline/findings";
import { parseOrThrow } from "../errors";

/**
 * The runtime validator for a findings file (docs/07-review-discipline.md step 5). An agent writes
 * this file and hands it back to the CLI, which makes it untrusted input in exactly the way a
 * pack.json is: the gate that drops unverified findings is worthless if the input reaching it can
 * be any shape at all. A finding with no anchor, or with an empty claim, is refused here rather
 * than checked and mysteriously dropped later.
 */

/** Non-empty once trimmed: a title of three spaces is a missing title, not a title. */
const text = z.string().trim().min(1);

export const citationSchema = z.object({
  /** Repo-relative. Containment inside the read root is enforced at check time, not here. */
  file: text,
  line: z.number().int().positive(),
  anchor: text,
});

export const findingSchema = z.object({
  id: text,
  kind: z.enum(["diff", "impact", "coverage"]),
  severity: z.enum(["blocker", "major", "minor", "question"]),
  title: text,
  claim: text,
  citation: citationSchema,
  /** The diff line that introduced or broke this. Required: a finding the pull request did not
   * cause is not this pull request's finding. */
  introducedBy: citationSchema,
  supporting: z.array(citationSchema).optional(),
  suggestion: text.optional(),
});

export const findingsFileSchema = z.object({
  findings: z.array(findingSchema),
});

export type FindingsFile = z.infer<typeof findingsFileSchema>;

/** Validate an already-parsed findings value. Throws a config error (exit 2) with every issue. */
export function parseFindingsFile(raw: unknown, source: string): ReviewFinding[] {
  return parseOrThrow(findingsFileSchema, raw, source, "EmPo findings file").findings;
}

/** The JSON Schema editors validate against. Generated, never hand-written. */
export function findingsJsonSchema(): unknown {
  return z.toJSONSchema(findingsFileSchema, { io: "input" });
}
