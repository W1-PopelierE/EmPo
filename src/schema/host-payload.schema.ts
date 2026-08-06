import { z } from "zod";

/**
 * The runtime validators for the two files an agent host writes for the `mcp` adapters
 * (docs/09-adapters.md). EmPo makes no model call and cannot reach an MCP server, whose connectors
 * authenticate interactively against the host and not against a CLI. So the agent running the
 * review fetches the pull request and the ticket with the tools it already has, writes them here,
 * and re-runs `empo review` pointing at the files.
 *
 * That makes these the most untrusted input the tool reads. A findings file is at least written
 * about a diff EmPo handed over; a payload can describe a pull request that never existed. This
 * file refuses what is malformed. Refusing what is fictional is the other half of the answer and
 * lives in `src/adapters/host-input.ts`, which checks the payload against real git.
 *
 * Two rules run through every field here, and both exist because the writer is an agent.
 *
 * `z.strictObject`, for the reason recorded in the step 7 lessons: a plain zod object drops an
 * unknown key, so a misspelled field would be silently replaced by its default and nobody would be
 * told which one. An unrecognized key is refused with the key named instead.
 *
 * And almost nothing is defaulted. A field whose absence cannot be told apart from a legitimate
 * value is required rather than defaulted, because every absence here is a mapping failure and a
 * default forgives it in silence. Requiring the key costs the writer nothing, since it can always
 * write `""`, and an explicit empty string is a statement where an omission is a silence.
 */

/**
 * A string and not a number, which is load-bearing rather than incidental. An Asana task gid is 16
 * digits, past Number.MAX_SAFE_INTEGER, so a payload that wrote one unquoted would be rounded by
 * JSON.parse into the id of a neighbouring object, and nothing downstream would look broken.
 */
const identifier = z.string().min(1);

/**
 * `sourceBranch` and `baseBranch` are required and non-empty for the reason `parsePrJson` already
 * gives at src/adapters/forge/github.ts:110: the base decides what "the diff" even means for a
 * stacked PR, and a review against a guessed base is worse than a review that did not run.
 */
export const hostPullRequestSchema = z.strictObject({
  id: identifier,
  title: z.string(),
  author: z.string(),
  sourceBranch: z.string().min(1),
  baseBranch: z.string().min(1),
  /**
   * Required though it may be empty. A pull request with no description is legitimate and common,
   * so `""` has to mean "this one has none" and not double as "the agent did not map this field".
   */
  description: z.string(),
  url: z.string(),
  /**
   * The head commit the host reported, so a payload written against an older push is caught.
   * Optional because not every host supplies one, and abbreviated by some hosts that do.
   */
  headSha: z.string().optional(),
  /**
   * Optional, where the ticket's `comments` below is required, and the asymmetry is deliberate
   * rather than an oversight: this side can express absence honestly and that side cannot. The
   * forge adapter declares the `comments` capability from whether this key is present, so an absent
   * list survives into a report that says the comments were not read. Do not make them match.
   */
  comments: z
    .array(
      z.strictObject({
        author: z.string(),
        body: z.string(),
        /** Repo-relative path for an inline comment, null for a top-level one. */
        file: z.string().nullable().default(null),
        line: z.number().int().positive().nullable().default(null),
      }),
    )
    .optional(),
  ci: z
    .strictObject({
      state: z.enum(["passed", "failed", "pending", "unknown"]),
      detail: z.string().default(""),
    })
    .optional(),
});

export const hostTicketSchema = z.strictObject({
  key: identifier,
  title: z.string(),
  /**
   * Required, so the writer has to say `"unknown"` rather than leave the key out. "I looked and
   * could not tell" and "I did not map this field" are different facts, and only the first of them
   * should be quiet.
   */
  type: z.enum(["bug", "feature", "chore", "unknown"]),
  body: z.string(),
  /**
   * Absent means "derive them from the body with criteria.ts", which is what every shipped tracker
   * does. An empty array means "the ticket states none", which is a fact worth keeping.
   */
  criteria: z.array(z.string()).optional(),
  /**
   * Required, where the pull request's `comments` above is optional, and the asymmetry is deliberate
   * rather than an oversight. tracker/types.ts says what ticket comments are for, which is that an
   * author may have deferred a sub-item and step 6 must not flag what a comment retracted. An empty
   * list reads as "nobody scoped anything out", so an unfetched list licenses exactly the finding a
   * fetched one would have withdrawn, which is a false positive manufactured out of an absence.
   *
   * `Ticket.comments` is nullable now, so this side could express "not fetched" and deliberately
   * does not. The payload is written by an agent that can be asked to go and look, and making the
   * absence expressible here would make not looking the cheapest thing to write. Writing `[]`
   * without looking is a claim somebody can be shown to be wrong about, where omitting the key is a
   * silence nobody can see. The nullable field downstream is for a transport that did not answer,
   * which is a fact about the tracker rather than a choice the writer of a payload gets to make.
   */
  comments: z.array(z.strictObject({ author: z.string(), body: z.string() })),
  url: z.string(),
  completed: z.boolean(),
});

export type HostPullRequest = z.infer<typeof hostPullRequestSchema>;
export type HostTicket = z.infer<typeof hostTicketSchema>;

/** The JSON Schema editors validate against. Generated, never hand-written. */
export function hostPullRequestJsonSchema(): unknown {
  return z.toJSONSchema(hostPullRequestSchema, { io: "input" });
}

/** The JSON Schema editors validate against. Generated, never hand-written. */
export function hostTicketJsonSchema(): unknown {
  return z.toJSONSchema(hostTicketSchema, { io: "input" });
}
