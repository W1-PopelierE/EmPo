import { z } from "zod";
import { parseOrThrow } from "../errors";

/**
 * The runtime validator for a spine file, `.empo/spines/<name>.json` (docs/08-spines.md). A spine is
 * hand-curated by a human and read by a gate that can fail a commit, which makes it the one artifact
 * where a typo is expensive in both directions: a malformed spine that loads silently gates nothing,
 * and one that gates on an empty term list fails every change it sees. So every curation defect this
 * schema can name is refused at load time, with the spine file named in the error.
 *
 * Strict JSON, like config.json and flows.json. The example in docs/08 is annotated as jsonc for
 * readability; a real spine file carries no comments, and the `note` fields are where prose lives.
 */

/** Non-empty once trimmed: a title of three spaces is a missing title, not a title. */
const text = z.string().trim().min(1);

const line = z.number().int().positive();

/**
 * The same shape the review gate resolves (engine/citations.ts), on purpose: a spine's coordinate
 * and a finding's coordinate rot in exactly the same, visible way, and one checker answers both.
 */
export const spineCitationSchema = z.strictObject({
  /** Repo-relative. Containment inside the repo is enforced at check time, not here. */
  file: text,
  line,
  /** A distinctive substring expected at that line. This is what makes the line checkable. */
  anchor: text,
});

/**
 * An anchor on a hop is required, not optional. A hop is a `file:line` a human reads to locate
 * themselves before changing anything, and a coordinate nothing can resolve is the exact fiction
 * `empo verify` exists to detect. The doc's own rule is "every `file:line` in a spine also carries
 * an anchor"; this is that rule made mechanical.
 */
export const spineHopSchema = z.strictObject({
  n: z.number().int().nonnegative(),
  title: text,
  /** The symbol the hop enters at, e.g. `PriceCalculator::total`. Prose, not resolved. */
  entry: text.optional(),
  file: text,
  line,
  anchor: text,
  note: text.optional(),
});

export const spineInvariantSchema = z.strictObject({
  /** A number in the doc's example; a string like "INV-3" is just as good a label. */
  id: z.union([z.number().int().nonnegative(), text]),
  statement: text,
  /**
   * Whether the check could run in the write path rather than in a nightly job. Recorded because the
   * best fix for an invariant is usually to move it earlier, and the judgement is the human's.
   */
  assertableAtWriteTime: z.boolean().default(false),
  /** An executable invariant beats a prose one, so cite it when the codebase already has one. */
  citation: spineCitationSchema.optional(),
});

export const spineTrapSchema = z.strictObject({
  what: text,
  file: text,
  line,
  anchor: text,
});

export const spineFileSchema = z
  .strictObject({
    version: z.literal(1),
    name: text,
    principle: text.optional(),
    hops: z.array(spineHopSchema).default([]),
    /** Repo-relative globs `empo check` watches. */
    guarded: z.array(text).default([]),
    /** What counts as a value assertion for this spine, narrower than the pack's language default. */
    assertionTerms: z.array(text).default([]),
    /**
     * Where such a line has to be added for it to count. Empty means anywhere in the diff that the
     * language pack calls a test, which is what every spine did before this field existed and is
     * what a spine that does not curate its tests still gets.
     */
    assertionPaths: z.array(text).default([]),
    invariants: z.array(spineInvariantSchema).default([]),
    traps: z.array(spineTrapSchema).default([]),
    flows: z.array(text).default([]),
    /** The flows that reach the chain and have no value-asserting test, human-confirmed. */
    unguardedFlows: z.array(text).default([]),
    /** Optional and domain-specific: the type a money spine's value travels in. */
    moneyType: z.strictObject({ class: text.optional(), note: text.optional() }).optional(),
  })
  .superRefine((spine, ctx) => {
    // A spine that guards files with nothing that counts as an assertion fails every change that
    // touches them, and a gate that can never pass is uninstalled within a day. This is the one
    // curation defect that turns the gate against itself, so it is refused rather than warned about.
    if (spine.guarded.length > 0 && spine.assertionTerms.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["assertionTerms"],
        message: "is empty while guarded is not: no change could ever satisfy this gate",
      });
    }

    // `hops` is the chain in order and `n` is the number a human cites it by ("hop 3 is the sole
    // funnel"). Let the two disagree and the two readings of the same spine disagree, so the array
    // order is required to be the numbering.
    for (let index = 1; index < spine.hops.length; index += 1) {
      const previous = spine.hops[index - 1];
      const hop = spine.hops[index];
      if (previous === undefined || hop === undefined) continue;
      if (hop.n <= previous.n) {
        ctx.addIssue({
          code: "custom",
          path: ["hops", index, "n"],
          message: `is ${hop.n}, which does not follow hop ${previous.n}: hops are listed in chain order`,
        });
      }
    }
  });

export type SpineFile = z.infer<typeof spineFileSchema>;
export type SpineHop = z.infer<typeof spineHopSchema>;
export type SpineInvariant = z.infer<typeof spineInvariantSchema>;
export type SpineTrap = z.infer<typeof spineTrapSchema>;

/** Validate an already-parsed spine value. Throws a config error (exit 2) with every issue. */
export function parseSpineFile(raw: unknown, source: string): SpineFile {
  return parseOrThrow(spineFileSchema, raw, source, "EmPo spine");
}

/** The JSON Schema editors validate against. Generated, never hand-written. */
export function spineJsonSchema(): unknown {
  return z.toJSONSchema(spineFileSchema, { io: "input" });
}
