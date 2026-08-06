import type { HostTicket } from "../../schema/host-payload.schema";
import { parseCriteria } from "./criteria";
import { extractKeyFrom } from "./key";
import type { Ticket, TrackerAdapter } from "./types";

/**
 * The `mcp` tracker (docs/09-adapters.md). EmPo makes no model call and cannot reach an MCP server:
 * MCP is driven by the agent host, whose connectors authenticate interactively. So this adapter
 * fetches nothing. The agent running empo fetches the ticket with whatever tool it has, writes JSON
 * to a file, and re-runs empo pointing at that file; this adapter is the half that reads the
 * validated payload. One `mcp` kind covers Jira, Asana and Linear at once, and the CLI still holds
 * no token and runs no subprocess for any of them.
 *
 * What that trade costs is a second opinion. A `github-issues` ticket came from `gh`, this one came
 * from a model. The forge side answers that by checking the payload's branches against real git, so
 * an invented pull request fails on something the model does not control. A ticket has no such
 * anchor: nothing in the repository knows what PLAT-1234 says. The one check available here is
 * therefore the key, and it is not optional (see `getTicket`).
 */

export interface McpTrackerOptions {
  /** The validated payload, or null when the agent supplied none. Null is a skip, not an error. */
  payload: HostTicket | null;
  /** From config, exactly as every other tracker takes it. The key convention is never engine. */
  keyPattern: string | undefined;
  /**
   * The human-facing name of the system the payload came from ("jira", "linear"). Free text that
   * only ever reaches printed sentences: nothing here branches on it.
   */
  host: string | null;
}

export function createMcpTracker(options: McpTrackerOptions): TrackerAdapter {
  const { payload } = options;

  return {
    kind: "mcp",

    // A missing payload means ticket-fit was not graded, which is a different statement from "the
    // ticket listed no criteria". The report has to make that distinction or an author reads a
    // silent step 6 as a passed one.
    skipReason:
      payload === null
        ? `no ${options.host ?? "tracker"} ticket was supplied by the host, so acceptance criteria were not checked`
        : null,

    extractKey: (source) => extractKeyFrom(source, options.keyPattern),

    getTicket: (key) => {
      if (payload === null) return null;

      // The payload is only this ticket when it says so. An agent asked for PLAT-1234 can hand back
      // PLAT-1243, and grading the diff against another ticket's acceptance criteria produces
      // confident findings about work nobody asked for. Refusing costs a re-fetch; accepting costs
      // the review its credibility, which is the failure this whole design exists to prevent.
      if (payload.key !== key) return null;

      return toTicket(payload);
    },
  };
}

function toTicket(payload: HostTicket): Ticket {
  return {
    key: payload.key,
    title: payload.title,
    // No normalization here, unlike github-issues.ts, which maps free-form labels onto the
    // bug/feature/chore distinction step 6 acts on. The payload schema already constrains `type` to
    // exactly that vocabulary, so the mapping happened in the agent that fetched the ticket and
    // there is no host vocabulary left to translate. What that moves out of empo is the judgement:
    // an agent that reads a Jira Bug and writes "feature" produces a value the schema likes just as
    // much as the right one, and the review quietly stops expecting a regression test that
    // reproduces the defect. The schema requires the field rather than defaulting it, so "I looked
    // and could not tell" has to be written as `unknown` instead of arriving as a silence.
    type: payload.type,
    body: payload.body,
    // Absent and empty are different facts and must stay different. Absent means the agent did not
    // fetch criteria, so they are derived from the body the way every shipped tracker derives them.
    // `[]` means the agent looked and the ticket states none, which step 6 prints as a finding of
    // its own. Collapsing them would let a lazy fetch pass for a criteria-free ticket.
    criteria: payload.criteria ?? parseCriteria(payload.body),
    // Always a list here and never null, which is the payload boundary holding rather than a
    // shortcut in this mapping. `Ticket.comments` can now carry null for a tracker that did not
    // fetch them (types.ts), and the schema still requires the key so an agent cannot reach that
    // state by not looking: writing `[]` because you looked is a claim somebody can be shown to be
    // wrong about, where omitting the key is a silence nobody can see. The nullable field is for a
    // transport that genuinely did not answer, not a cheaper way for a writer to say nothing.
    //
    // The pull request payload keeps `comments` optional, deliberately, and that asymmetry is not a
    // mistake to correct: a forge declares a `comments` capability, so an absent list is already a
    // statement on that side before it reaches any adapter.
    comments: payload.comments,
    url: payload.url,
    completed: payload.completed,
  };
}
