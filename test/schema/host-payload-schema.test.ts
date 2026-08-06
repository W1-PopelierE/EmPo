import { describe, expect, test } from "vitest";
import type { z } from "zod";
import {
  hostPullRequestJsonSchema,
  hostPullRequestSchema,
  hostTicketJsonSchema,
  hostTicketSchema,
} from "../../src/schema/host-payload.schema";

/**
 * A payload is written by an agent host and handed back to the CLI, so it is untrusted input in the
 * same way a findings file is, with one difference that shapes every case below: the agent may have
 * been told the wrong field name, or may have invented one. A zod object would drop that key and
 * substitute the default, and the review would run on a payload nobody wrote. So the cases here are
 * mostly about what is refused and about which absences mean what, not about the happy path.
 */

const pullRequest = {
  id: "412",
  title: "Charge VAT on renewals",
  author: "sam",
  sourceBranch: "PLAT-1234-vat-on-renewals",
  baseBranch: "release/2026-08",
  description: "Fixes the renewal invoice total.",
  url: "https://bitbucket.org/acme/platform/pull-requests/412",
};

const ticket = {
  key: "PLAT-1234",
  title: "Renewal invoices omit VAT",
  type: "bug",
  body: "The renewal total is charged net.",
  criteria: ["A renewal invoice carries 21% VAT"],
  comments: [{ author: "ada", body: "Only for NL customers." }],
  url: "https://acme.atlassian.net/browse/PLAT-1234",
  completed: false,
};

/** Every issue as `path: message`, which is the shape host-input.ts prints them in. */
function issues(schema: z.ZodType, raw: unknown): string {
  const result = schema.safeParse(raw);
  if (result.success) return expect.unreachable("expected the payload to be refused");
  return result.error.issues
    .map((issue) => {
      const where = issue.path.join(".");
      return where ? `${where}: ${issue.message}` : issue.message;
    })
    .join("\n");
}

function withPr(overrides: Record<string, unknown>): unknown {
  return { ...pullRequest, ...overrides };
}

describe("hostPullRequestSchema", () => {
  test("parses the documented shape and keeps every field the review needs", () => {
    expect(hostPullRequestSchema.parse(pullRequest)).toEqual(pullRequest);
  });

  test("refuses a missing description, naming it, rather than defaulting it to empty", () => {
    // The pin the whole no-defaults rule exists for. An empty description is legitimate and common,
    // so `""` has to mean "this pull request has none". A default would collapse that into the same
    // value as "the agent never mapped the field", and a mapping bug would run the review in silence.
    const { description, ...withoutDescription } = pullRequest;
    expect(description).toBeDefined();

    expect(issues(hostPullRequestSchema, withoutDescription)).toContain("description");
  });

  test("accepts an empty description, which is a statement and not a silence", () => {
    expect(hostPullRequestSchema.parse(withPr({ description: "" })).description).toBe("");
  });

  test("refuses a missing url or author for the same reason", () => {
    const { url, ...withoutUrl } = pullRequest;
    const { author, ...withoutAuthor } = pullRequest;
    expect(url).toBeDefined();
    expect(author).toBeDefined();

    expect(issues(hostPullRequestSchema, withoutUrl)).toContain("url");
    expect(issues(hostPullRequestSchema, withoutAuthor)).toContain("author");
  });

  test("leaves headSha absent when the host does not report one", () => {
    expect(hostPullRequestSchema.parse(pullRequest).headSha).toBeUndefined();
  });

  test("keeps an abbreviated head sha verbatim, since some hosts report only twelve characters", () => {
    expect(hostPullRequestSchema.parse(withPr({ headSha: "ef4b99a5e5b1" })).headSha).toBe(
      "ef4b99a5e5b1",
    );
  });

  test("leaves comments absent when the agent did not fetch them, rather than defaulting to none", () => {
    // The whole reason `comments` is optional: absent has to stay distinguishable from empty, or
    // the adapter cannot declare the difference and the report cannot state it.
    expect(hostPullRequestSchema.parse(pullRequest).comments).toBeUndefined();
  });

  test("keeps an empty comment list as an empty list, which is a different fact", () => {
    expect(hostPullRequestSchema.parse(withPr({ comments: [] })).comments).toEqual([]);
  });

  test("anchors a comment at null when the host gave no file or line", () => {
    const parsed = hostPullRequestSchema.parse(
      withPr({ comments: [{ author: "ada", body: "Check the rounding." }] }),
    );

    expect(parsed.comments?.[0]).toEqual({
      author: "ada",
      body: "Check the rounding.",
      file: null,
      line: null,
    });
  });

  test("keeps an inline comment's file and line", () => {
    const parsed = hostPullRequestSchema.parse(
      withPr({ comments: [{ author: "ada", body: "here", file: "src/price.ts", line: 42 }] }),
    );

    expect(parsed.comments?.[0]?.file).toBe("src/price.ts");
    expect(parsed.comments?.[0]?.line).toBe(42);
  });

  test("leaves ci absent when the host reported no pipeline", () => {
    expect(hostPullRequestSchema.parse(pullRequest).ci).toBeUndefined();
  });

  test("defaults a ci detail but never a ci state", () => {
    expect(hostPullRequestSchema.parse(withPr({ ci: { state: "failed" } })).ci).toEqual({
      state: "failed",
      detail: "",
    });
    expect(issues(hostPullRequestSchema, withPr({ ci: { detail: "3 of 4" } }))).toContain(
      "ci.state",
    );
  });

  test("refuses an unrecognized key at the root, naming it", () => {
    // A zod object would drop this and review a payload with a guessed base. The key is named
    // because the agent's next move is to rename it, and it cannot rename what it was not told.
    const detail = issues(hostPullRequestSchema, withPr({ targetBranch: "main" }));

    expect(detail).toContain("targetBranch");
  });

  test("refuses an unrecognized key inside a comment, naming both the comment and the key", () => {
    const detail = issues(
      hostPullRequestSchema,
      withPr({ comments: [{ author: "ada", body: "here", path: "src/price.ts" }] }),
    );

    expect(detail).toContain("comments.0");
    expect(detail).toContain("path");
  });

  test("refuses an unrecognized key inside ci", () => {
    const detail = issues(hostPullRequestSchema, withPr({ ci: { state: "passed", url: "..." } }));

    expect(detail).toContain("ci");
    expect(detail).toContain("url");
  });

  test("refuses a missing or empty base branch, since the base decides what the diff is", () => {
    expect(issues(hostPullRequestSchema, withPr({ baseBranch: undefined }))).toContain(
      "baseBranch",
    );
    expect(issues(hostPullRequestSchema, withPr({ baseBranch: "" }))).toContain("baseBranch");
  });

  test("refuses a missing or empty source branch", () => {
    expect(issues(hostPullRequestSchema, withPr({ sourceBranch: undefined }))).toContain(
      "sourceBranch",
    );
    expect(issues(hostPullRequestSchema, withPr({ sourceBranch: "" }))).toContain("sourceBranch");
  });

  test("refuses an empty id, which nothing downstream could match against the requested one", () => {
    expect(issues(hostPullRequestSchema, withPr({ id: "" }))).toContain("id");
  });

  test("refuses a numeric id, which an agent writing a pull request number naturally emits", () => {
    expect(issues(hostPullRequestSchema, withPr({ id: 412 }))).toContain("id");
  });

  test("refuses a ci state outside the four the report knows how to say", () => {
    const detail = issues(hostPullRequestSchema, withPr({ ci: { state: "green" } }));

    expect(detail).toContain("ci.state");
    expect(detail).toContain("passed");
  });

  test("refuses a comment line of 0 or a fraction, since a file's first line is 1", () => {
    const line = (value: number): unknown =>
      withPr({ comments: [{ author: "ada", body: "here", file: "src/price.ts", line: value }] });

    expect(issues(hostPullRequestSchema, line(0))).toContain("comments.0.line");
    expect(issues(hostPullRequestSchema, line(4.5))).toContain("comments.0.line");
  });

  test("refuses a root that is an array rather than the documented object", () => {
    expect(issues(hostPullRequestSchema, [pullRequest])).toContain("object");
  });
});

describe("hostTicketSchema", () => {
  test("parses the documented shape", () => {
    expect(hostTicketSchema.parse(ticket)).toEqual(ticket);
  });

  test("refuses a missing type, naming it, rather than defaulting it to unknown", () => {
    // "I looked and could not tell" and "I did not map this field" are different facts, and only
    // the first should be quiet. The agent writes "unknown" to state the first.
    const { type, ...withoutType } = ticket;
    expect(type).toBeDefined();

    expect(issues(hostTicketSchema, withoutType)).toContain("type");
  });

  test("accepts an explicit unknown type, which is how the agent says it could not tell", () => {
    expect(hostTicketSchema.parse({ ...ticket, type: "unknown" }).type).toBe("unknown");
  });

  test("refuses every other field the review reads, when the key is missing", () => {
    for (const field of ["title", "body", "url", "completed"] as const) {
      const { [field]: removed, ...without } = ticket;
      expect(removed).toBeDefined();

      expect(issues(hostTicketSchema, without)).toContain(field);
    }
  });

  test("leaves criteria absent, so the tracker knows to derive them from the body", () => {
    const { criteria, ...withoutCriteria } = ticket;
    expect(criteria).toBeDefined();

    expect(hostTicketSchema.parse(withoutCriteria).criteria).toBeUndefined();
  });

  test("keeps an empty criteria list, which says the ticket states none", () => {
    expect(hostTicketSchema.parse({ ...ticket, criteria: [] }).criteria).toEqual([]);
  });

  test("refuses an omitted comments list, naming it, unlike the pull request side", () => {
    // The asymmetry is the point and must not be "fixed" into matching the forge. Ticket.comments
    // is nullable now, so this side could express "not fetched" and deliberately does not: the
    // payload is written by an agent that can be asked to go and look, and an expressible absence
    // makes not looking the cheapest thing to write. An unfetched list arriving as [] reads as
    // "nobody scoped anything out" and licenses the very finding a fetched comment would have
    // withdrawn. Requiring the key makes the agent state something it can be shown to be wrong
    // about; the nullable field downstream is for a transport that did not answer.
    const { comments, ...withoutComments } = ticket;
    expect(comments).toBeDefined();

    expect(issues(hostTicketSchema, withoutComments)).toContain("comments");
  });

  test("accepts an empty comments list, which is the agent saying it looked and found none", () => {
    expect(hostTicketSchema.parse({ ...ticket, comments: [] }).comments).toEqual([]);
  });

  test("refuses an unrecognized key, naming it", () => {
    expect(issues(hostTicketSchema, { ...ticket, acceptance: [] })).toContain("acceptance");
  });

  test("refuses an empty key, which no extracted key could match", () => {
    expect(issues(hostTicketSchema, { ...ticket, key: "" })).toContain("key");
  });

  test("refuses a numeric key, because an identifier is not a quantity", () => {
    // A key is opaque: nothing may arithmetic on it, and its digits have to survive a round trip
    // exactly. Today's Asana gids are 16 digits and sit below Number.MAX_SAFE_INTEGER, so a number
    // would still parse correctly, which is precisely why this is worth refusing now rather than
    // after it starts silently rounding. Past 2^53 an unquoted gid parses to a neighbouring task's
    // id, and the review then grades the pull request against the wrong acceptance criteria with
    // nothing anywhere looking broken. Refusing the type is the check; the length is the reason it
    // will matter later.
    expect(issues(hostTicketSchema, { ...ticket, key: 1234567890123456 })).toContain("key");
  });

  test("refuses a type outside the four the review grades against", () => {
    expect(issues(hostTicketSchema, { ...ticket, type: "task" })).toContain("type");
  });
});

describe("the generated editor schemas", () => {
  test("come from the validators rather than restating them", () => {
    const pr = hostPullRequestJsonSchema() as { properties: object; required: string[] };
    const issue = hostTicketJsonSchema() as { properties: object; required: string[] };

    expect(Object.keys(pr.properties).sort()).toEqual([
      "author",
      "baseBranch",
      "ci",
      "comments",
      "description",
      "headSha",
      "id",
      "sourceBranch",
      "title",
      "url",
    ]);
    // What the agent must supply, which is the list the request block has to name. Everything the
    // review reads is here; only what a host may genuinely not have is optional.
    expect(pr.required.sort()).toEqual([
      "author",
      "baseBranch",
      "description",
      "id",
      "sourceBranch",
      "title",
      "url",
    ]);
    // `comments` is required here and optional on the pull request, deliberately: see the schema.
    expect(issue.required.sort()).toEqual([
      "body",
      "comments",
      "completed",
      "key",
      "title",
      "type",
      "url",
    ]);
  });
});
