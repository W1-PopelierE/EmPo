import { describe, expect, test } from "vitest";
import { createMcpTracker } from "../../src/adapters/tracker/mcp";
import { hostTicketSchema } from "../../src/schema/host-payload.schema";

/**
 * Payloads go through the schema rather than being hand-built, so a fixture that a real run would
 * refuse cannot pass here. That also pins the half of the contract this adapter cannot enforce on
 * its own: `criteria` staying optional. If it ever gained a `.default([])`, "the agent did not fetch
 * criteria" and "the ticket states none" would collapse into one value and the tests below would
 * still look green if they built their fixtures by hand.
 */
function payload(overrides: Record<string, unknown> = {}) {
  return hostTicketSchema.parse({
    key: "PLAT-1234",
    title: "Export times out",
    type: "bug",
    body: "- [ ] The export completes\n- [ ] A regression test covers the timeout",
    comments: [{ author: "ada", body: "Deferred the CSV header to another ticket." }],
    url: "https://acme.atlassian.net/browse/PLAT-1234",
    completed: false,
    ...overrides,
  });
}

function tracker(overrides: Partial<Parameters<typeof createMcpTracker>[0]> = {}) {
  return createMcpTracker({
    payload: payload(),
    keyPattern: undefined,
    host: "jira",
    ...overrides,
  });
}

describe("createMcpTracker", () => {
  test("maps the payload to the ticket when the key is the one asked for", () => {
    expect(tracker().getTicket("PLAT-1234")).toEqual({
      key: "PLAT-1234",
      title: "Export times out",
      type: "bug",
      body: "- [ ] The export completes\n- [ ] A regression test covers the timeout",
      criteria: ["The export completes", "A regression test covers the timeout"],
      comments: [{ author: "ada", body: "Deferred the CSV header to another ticket." }],
      url: "https://acme.atlassian.net/browse/PLAT-1234",
      completed: false,
    });
  });

  test("returns null for a payload that is a different ticket", () => {
    const adapter = tracker({ payload: payload({ key: "PLAT-1243" }) });

    expect(adapter.getTicket("PLAT-1234")).toBeNull();
  });

  test("returns null rather than the wrong ticket when only the case differs", () => {
    const adapter = tracker({ payload: payload({ key: "plat-1234" }) });

    expect(adapter.getTicket("PLAT-1234")).toBeNull();
  });

  test("returns null for every key when no payload was supplied", () => {
    expect(tracker({ payload: null }).getTicket("PLAT-1234")).toBeNull();
  });

  test("derives criteria from the body when the payload omits the field", () => {
    const adapter = tracker({
      payload: payload({
        criteria: undefined,
        body: "## Acceptance criteria\n\n- Admins can export",
      }),
    });

    expect(adapter.getTicket("PLAT-1234")?.criteria).toEqual(["Admins can export"]);
  });

  test("keeps an empty criteria array as the ticket stating none", () => {
    const adapter = tracker({
      payload: payload({ criteria: [], body: "## Acceptance criteria\n\n- Admins can export" }),
    });

    // Not the body's bullet: the agent looked and reported none, which is a fact of its own.
    expect(adapter.getTicket("PLAT-1234")?.criteria).toEqual([]);
  });

  test("uses the payload's criteria verbatim over anything the body implies", () => {
    const adapter = tracker({
      payload: payload({ criteria: ["The export completes under ten seconds"] }),
    });

    expect(adapter.getTicket("PLAT-1234")?.criteria).toEqual([
      "The export completes under ten seconds",
    ]);
  });

  test("carries the payload's type through without remapping it", () => {
    expect(tracker({ payload: payload({ type: "chore" }) }).getTicket("PLAT-1234")?.type).toBe(
      "chore",
    );
  });

  test("carries an explicit unknown type through, which grades neither", () => {
    // The adapter half of a rule the schema owns the other half of: an omitted `type` is refused
    // with the field named (test/schema/host-payload-schema.test.ts), so "I looked and could not
    // tell" has to arrive as this explicit value and never as a silence that defaulted here.
    const adapter = tracker({ payload: payload({ type: "unknown" }) });

    expect(adapter.getTicket("PLAT-1234")?.type).toBe("unknown");
  });

  test("passes the payload's comments through", () => {
    const adapter = tracker({
      payload: payload({ comments: [{ author: "bo", body: "scoped out" }] }),
    });

    expect(adapter.getTicket("PLAT-1234")?.comments).toEqual([
      { author: "bo", body: "scoped out" },
    ]);
  });

  test("maps an empty comment list through as empty, which is the agent saying it found none", () => {
    // The adapter half. The schema owns the other half, that an OMITTED `comments` is refused with
    // the field named (test/schema/host-payload-schema.test.ts), so an empty list reaching here is
    // always a claim someone made and never a silence that defaulted on the way in.
    const adapter = tracker({ payload: payload({ comments: [] }) });

    expect(adapter.getTicket("PLAT-1234")?.comments).toEqual([]);
  });

  test("never answers null, because the payload cannot say the agent did not look", () => {
    // `Ticket.comments` is nullable now, and this adapter is the one tracker that must never use
    // it. Null means a transport did not answer; here the schema requires the key, so the only two
    // states reachable are the two claims above. If this ever goes null the boundary has been
    // weakened, and an agent that skipped the fetch is being reported as one that could not.
    expect(
      tracker({ payload: payload({ comments: [] }) }).getTicket("PLAT-1234")?.comments,
    ).not.toBeNull();
    expect(tracker().getTicket("PLAT-1234")?.comments).not.toBeNull();
  });

  test("has no skip reason when a payload is present", () => {
    expect(tracker().skipReason).toBeNull();
  });

  test("names the host and says ticket-fit was not checked when no payload was supplied", () => {
    const reason = tracker({ payload: null }).skipReason;

    expect(reason).toContain("jira");
    expect(reason).toContain("acceptance criteria were not checked");
  });

  test("still says why when no host is configured", () => {
    const reason = tracker({ payload: null, host: null }).skipReason;

    expect(reason).toContain("acceptance criteria were not checked");
    expect(reason).not.toContain("null");
  });

  test("extracts a key with the cross-tracker default when config supplies no pattern", () => {
    const match = tracker().extractKey({
      branch: "feature/PLAT-1234-export",
      title: "PLAT-1234 add the export",
      body: "",
    });

    expect(match?.key).toBe("PLAT-1234");
    expect(match?.from).toBe("title");
  });

  test("honours a configured keyPattern", () => {
    const match = tracker({ keyPattern: "#\\d+" }).extractKey({
      branch: "fix/export",
      title: "issue #123 is fixed",
      body: "",
    });

    expect(match?.key).toBe("#123");
  });

  test("extracts a key even when no payload was supplied", () => {
    // The key is what the request block asks the agent to fetch, so extraction cannot depend on
    // already having the ticket.
    const adapter = tracker({ payload: null });

    expect(adapter.extractKey({ branch: "", title: "PLAT-1234", body: "" })?.key).toBe("PLAT-1234");
  });

  test("reports the kind as mcp whether or not a payload arrived", () => {
    expect(tracker().kind).toBe("mcp");
    expect(tracker({ payload: null }).kind).toBe("mcp");
  });
});
