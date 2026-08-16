import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createTracker } from "../../src/adapters/tracker/create";
import { parseCriteria } from "../../src/adapters/tracker/criteria";
import {
  createGithubIssuesTracker,
  parseIssueJson,
} from "../../src/adapters/tracker/github-issues";
import { extractKeyFrom } from "../../src/adapters/tracker/key";
import type { KeySource } from "../../src/adapters/tracker/types";
import { EmpoError } from "../../src/errors";
import { configSchema } from "../../src/schema/config.schema";
import { hostTicketSchema } from "../../src/schema/host-payload.schema";

function source(parts: Partial<KeySource>): KeySource {
  return { branch: "", title: "", body: "", ...parts };
}

function config(adapters?: unknown): ReturnType<typeof configSchema.parse> {
  return configSchema.parse({
    version: 1,
    roots: [{ path: "apps/api", lang: "php" }],
    packs: { php: { version: "^1" } },
    ...(adapters === undefined ? {} : { adapters }),
  });
}

describe("extractKeyFrom", () => {
  test("prefers the title over the branch, because branch names carry typos", () => {
    const match = extractKeyFrom(
      source({ branch: "feature/PLAT-1234-add-export", title: "PLAT-1234 add the export" }),
    );

    expect(match).toEqual({
      key: "PLAT-1234",
      from: "title",
      branchKey: "PLAT-1234",
      disagrees: false,
    });
  });

  test("reports both keys and disagrees when the branch names another ticket", () => {
    const match = extractKeyFrom(
      source({ branch: "feature/PLAT-1243-add-export", title: "PLAT-1234 add the export" }),
    );

    expect(match?.key).toBe("PLAT-1234");
    expect(match?.branchKey).toBe("PLAT-1243");
    expect(match?.disagrees).toBe(true);
  });

  test("falls back to the body when neither title nor branch carries a key", () => {
    const match = extractKeyFrom(
      source({ branch: "fix/the-export", title: "Add the export", body: "Closes ENG-42." }),
    );

    expect(match).toEqual({ key: "ENG-42", from: "body", branchKey: null, disagrees: false });
  });

  test("uses the branch key when only the branch carries one", () => {
    const match = extractKeyFrom(source({ branch: "feature/ENG-42-export", title: "Add export" }));

    expect(match?.from).toBe("branch");
    expect(match?.disagrees).toBe(false);
  });

  test("returns null when nothing carries a key", () => {
    expect(extractKeyFrom(source({ branch: "fix/export", title: "Add the export" }))).toBeNull();
  });

  test("honours a custom pattern", () => {
    const match = extractKeyFrom(source({ title: "issue #123 is fixed" }), "#\\d+");

    expect(match?.key).toBe("#123");
  });

  test("throws a config error naming a pattern that does not compile", () => {
    try {
      extractKeyFrom(source({ title: "PLAT-1234" }), "[A-Z");
      expect.unreachable("expected a config error");
    } catch (error) {
      expect(error).toBeInstanceOf(EmpoError);
      expect((error as EmpoError).exitCode).toBe(2);
      expect((error as EmpoError).message).toContain("[A-Z");
    }
  });
});

describe("parseCriteria", () => {
  test("reads markdown checkboxes anywhere in the body, in source order", () => {
    const body = [
      "Some context first.",
      "",
      "- [ ] The export button is visible to admins",
      "- [x] The CSV has a header row",
      "* [ ] The download is named by date",
    ].join("\n");

    expect(parseCriteria(body)).toEqual([
      "The export button is visible to admins",
      "The CSV has a header row",
      "The download is named by date",
    ]);
  });

  test("reads the list under an acceptance criteria heading", () => {
    const body = ["## Acceptance criteria", "", "- Admins can export", "- Members cannot"].join(
      "\n",
    );

    expect(parseCriteria(body)).toEqual(["Admins can export", "Members cannot"]);
  });

  test("stops the section at the next heading", () => {
    const body = [
      "## Requirements",
      "- Admins can export",
      "",
      "## Notes",
      "- Ship behind a flag",
    ].join("\n");

    expect(parseCriteria(body)).toEqual(["Admins can export"]);
  });

  test("falls back to the non-empty lines of the section when it has no list", () => {
    const body = ["# Definition of done", "", "The export completes under ten seconds.", ""].join(
      "\n",
    );

    expect(parseCriteria(body)).toEqual(["The export completes under ten seconds."]);
  });

  test("returns an empty list when the ticket states no criteria", () => {
    expect(parseCriteria("Please make the export faster. It times out for big teams.")).toEqual([]);
  });

  test("returns an empty list for an empty body", () => {
    expect(parseCriteria("")).toEqual([]);
  });
});

describe("parseIssueJson", () => {
  function issue(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      number: 123,
      title: "Export times out",
      body: "- [ ] The export completes\n- [ ] A regression test covers the timeout",
      state: "OPEN",
      url: "https://github.com/acme/api/issues/123",
      labels: [{ name: "bug" }],
      comments: [{ author: { login: "ada" }, body: "Deferred the CSV header to another ticket." }],
      ...overrides,
    });
  }

  test("maps an open bug with its criteria and comments", () => {
    const ticket = parseIssueJson(issue());

    expect(ticket).toEqual({
      key: "#123",
      title: "Export times out",
      type: "bug",
      body: "- [ ] The export completes\n- [ ] A regression test covers the timeout",
      criteria: ["The export completes", "A regression test covers the timeout"],
      comments: [{ author: "ada", body: "Deferred the CSV header to another ticket." }],
      url: "https://github.com/acme/api/issues/123",
      completed: false,
    });
  });

  test("maps a closed state to completed", () => {
    expect(parseIssueJson(issue({ state: "CLOSED" }))?.completed).toBe(true);
  });

  test.each([
    [["Bug"], "bug"],
    [["kind/bug"], "bug"],
    [["feature"], "feature"],
    [["enhancement"], "feature"],
    [["chore"], "chore"],
    [["refactor"], "chore"],
    [["docs"], "chore"],
    [["needs-triage"], "unknown"],
    [[], "unknown"],
  ])("maps labels %j to type %s", (labels, expected) => {
    const raw = issue({ labels: labels.map((name) => ({ name })) });

    expect(parseIssueJson(raw)?.type).toBe(expected);
  });

  test("prefers bug when an issue carries both bug and enhancement", () => {
    const raw = issue({ labels: [{ name: "enhancement" }, { name: "bug" }] });

    expect(parseIssueJson(raw)?.type).toBe("bug");
  });

  test("returns null on malformed JSON rather than throwing", () => {
    expect(parseIssueJson("{ not json")).toBeNull();
  });

  test("returns null when the payload has no issue number", () => {
    expect(parseIssueJson(JSON.stringify({ title: "Export times out" }))).toBeNull();
  });

  test("tolerates missing optional fields", () => {
    // What this protects is the degradation: a partial answer from `gh` still produces a ticket
    // rather than a throw or a null, because a review has real impact and coverage findings to give
    // without a complete issue. `comments` is the one field where the missing key is a fact of its
    // own and it is asserted separately below.
    const ticket = parseIssueJson(JSON.stringify({ number: 7 }));

    expect(ticket?.key).toBe("#7");
    expect(ticket?.criteria).toEqual([]);
    expect(ticket?.type).toBe("unknown");
  });

  test("reports comments as not fetched when the response carries no comments key", () => {
    // `comments` is asked for by name in the --json call, so a response without it is gh not having
    // answered rather than an issue nobody commented on. `[]` here would read as "nothing was
    // scoped out" and license exactly the finding a fetched list would have withdrawn.
    const ticket = parseIssueJson(issue({ comments: undefined }));

    expect(ticket?.comments).toBeNull();
  });

  test("keeps an empty comment list as the issue carrying none", () => {
    // The other half of the pair, and the one that must not collapse into the null above: somebody
    // looked and there is nothing there, which is a statement the report prints as such.
    expect(parseIssueJson(issue({ comments: [] }))?.comments).toEqual([]);
  });

  test("reports comments as not fetched when the key is there but is not a list", () => {
    expect(parseIssueJson(issue({ comments: 3 }))?.comments).toBeNull();
  });
});

/**
 * The wiring, not the mapping. `parseIssueJson` above is a pure function and a pin on it is not a
 * pin on the call that feeds it: an adapter able to say "not fetched" is worth nothing if the path
 * from `gh` to the ticket defaults the null away on the way through. So this runs the real adapter
 * against a real subprocess, with a `gh` that answers an issue with no `comments` key.
 */
describe("createGithubIssuesTracker over a real gh", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A `gh` on PATH that answers `issue view` with this JSON and fails everything else. It reads its
   * own `--json` field list first, the way the real one does, and drops `comments` from the answer
   * when the adapter did not ask for it. Without that the fetched cases would pass on an adapter
   * that stopped requesting the field, and the null this whole change is about would be
   * manufactured by the request rather than found in the response.
   */
  function withGh<T>(issue: Record<string, unknown>, act: (repoRoot: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "empo-tracker-gh-"));
    dirs.push(dir);
    const issueJson = join(dir, "issue.json");
    const unaskedJson = join(dir, "issue-without-comments.json");
    writeFileSync(issueJson, JSON.stringify(issue));
    writeFileSync(unaskedJson, JSON.stringify({ ...issue, comments: undefined }));
    writeFileSync(
      join(dir, "gh"),
      `${[
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi',
        'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
        '  case "$5" in',
        `    *comments*) cat ${issueJson}; exit 0;;`,
        `    *) cat ${unaskedJson}; exit 0;;`,
        "  esac",
        "fi",
        "exit 1",
      ].join("\n")}\n`,
      { mode: 0o755 },
    );

    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path ?? ""}`;
    try {
      return act(dir);
    } finally {
      process.env.PATH = path;
    }
  }

  function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      number: 123,
      title: "Export times out",
      body: "- [ ] The export completes",
      state: "OPEN",
      url: "https://github.com/acme/api/issues/123",
      labels: [{ name: "bug" }],
      comments: [{ author: { login: "ada" }, body: "Deferred the CSV header." }],
      ...overrides,
    };
  }

  test("carries a not-fetched comment list all the way out of getTicket", () => {
    const ticket = withGh(issue({ comments: undefined }), (repoRoot) =>
      createGithubIssuesTracker(repoRoot, {}).getTicket("#123"),
    );

    expect(ticket?.key).toBe("#123");
    expect(ticket?.comments).toBeNull();
  });

  test("carries a fetched-and-empty list out as empty", () => {
    const ticket = withGh(issue({ comments: [] }), (repoRoot) =>
      createGithubIssuesTracker(repoRoot, {}).getTicket("#123"),
    );

    expect(ticket?.comments).toEqual([]);
  });

  test("carries a fetched list out with its comments", () => {
    const ticket = withGh(issue(), (repoRoot) =>
      createGithubIssuesTracker(repoRoot, {}).getTicket("#123"),
    );

    expect(ticket?.comments).toEqual([{ author: "ada", body: "Deferred the CSV header." }]);
  });

  test("asks gh for the comments field by name, which is what makes the two above different", () => {
    // The stub answers without `comments` when the request did not name it, so an adapter that
    // stopped asking would report every issue's comments as unfetched and be believed. Both fetched
    // cases above turn red then; this one says why in one line rather than leaving the next reader
    // to work it out from two failures.
    const ticket = withGh(issue({ comments: [] }), (repoRoot) =>
      createGithubIssuesTracker(repoRoot, {}).getTicket("#123"),
    );

    expect(ticket?.comments).not.toBeNull();
  });
});

describe("createTracker", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A `gh` on PATH that answers `issue view` with the argument line it was handed, as the issue
   * title. The tracker is a closure over one gh invocation and exposes the repository it was given
   * nowhere else, so without this the only honest thing a test could assert about `--repo` is that
   * building the tracker did not throw.
   */
  function withEchoingGh<T>(act: (repoRoot: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "empo-tracker-slug-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "gh"),
      `${[
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi',
        'printf \'{"number":123,"title":"%s"}\\n\' "$*"',
      ].join("\n")}\n`,
      { mode: 0o755 },
    );

    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path ?? ""}`;
    try {
      return act(dir);
    } finally {
      process.env.PATH = path;
    }
  }

  /**
   * The slug that reaches gh, asserted as the string it is. Config keeps the workspace and the repo
   * apart because every Bitbucket call wants them separate, and `gh --repo` wants them joined
   * (forge/types.ts). The forge side was fixed for exactly that; the tracker kept falling back to
   * the bare `forge.repo`, so a github-issues tracker with no `project` of its own ran
   * `gh issue view --repo EmPo` and died on `expected the "[HOST/]OWNER/REPO" format` before it
   * fetched anything, leaving every review it ran silently ungraded on ticket fit.
   */
  test("joins the github forge's workspace and repo into the slug the tracker fetches with", () => {
    const title = withEchoingGh((repoRoot) => {
      const { adapter } = createTracker(
        config({
          forge: { kind: "github", workspace: "W1-PopelierE", repo: "EmPo" },
          tracker: { kind: "github-issues" },
        }),
        repoRoot,
      );

      return adapter.getTicket("#123")?.title;
    });

    expect(title).toContain("--repo W1-PopelierE/EmPo");
  });

  test("gives the none adapter with a stated reason when no tracker is configured", () => {
    const { adapter, note } = createTracker(config(), "/repo");

    expect(adapter.kind).toBe("none");
    expect(adapter.skipReason).not.toBeNull();
    expect(note).toBeNull();
    expect(adapter.extractKey({ branch: "feature/PLAT-1234", title: "", body: "" })).toBeNull();
    expect(adapter.getTicket("PLAT-1234")).toBeNull();
  });

  test('treats an explicit "none" kind the same way', () => {
    const { adapter, note } = createTracker(config({ tracker: { kind: "none" } }), "/repo");

    expect(adapter.kind).toBe("none");
    expect(note).toBeNull();
  });

  /**
   * These three rows used to be `kind: "jira"`, `"asana"` and `"linear"`, pinning that a tracker
   * EmPo did not implement said so rather than letting the review read as though ticket-fit had
   * passed. Those kinds are gone, folded into `mcp`, and the guarantee is not: a tracker with no
   * ticket in hand still has to name the system and still has to say what was not graded.
   *
   * What moved is where the sentence is carried. It used to be the selection's `note`, printed once
   * at the top of a run; it is now the adapter's `skipReason`, which is what the report's own ticket
   * section prints ("ticket-fit not graded: ..."). That is the stronger of the two places, and
   * carrying it in both would print one sentence twice in one brief. The assertions follow it there
   * rather than being dropped for having moved.
   */
  test.each(["jira", "asana", "linear"])(
    "says plainly that no %s ticket was supplied and that criteria went unchecked",
    (host) => {
      const { adapter, note } = createTracker(config({ tracker: { kind: "mcp", host } }), "/repo");

      // The configured adapter is the one in use, so there is nothing degraded to report as a note.
      expect(adapter.kind).toBe("mcp");
      expect(note).toBeNull();
      expect(adapter.skipReason).toContain(host);
      expect(adapter.skipReason).toContain("not checked");
      expect(adapter.getTicket("PLAT-1234")).toBeNull();
    },
  );

  test("uses the mcp tracker, with no skip reason, once a ticket is handed over", () => {
    const payload = hostTicketSchema.parse({
      key: "PLAT-1234",
      title: "Charge VAT on renewals",
      type: "bug",
      body: "- [ ] The renewal invoice totals include VAT",
      url: "https://acme.atlassian.net/browse/PLAT-1234",
      completed: false,
      comments: [],
    });

    const { adapter, note } = createTracker(
      config({ tracker: { kind: "mcp", host: "jira" } }),
      "/repo",
      {
        payload,
      },
    );

    expect(adapter.kind).toBe("mcp");
    expect(note).toBeNull();
    expect(adapter.skipReason).toBeNull();
    expect(adapter.getTicket("PLAT-1234")?.criteria).toEqual([
      "The renewal invoice totals include VAT",
    ]);
  });

  test("honours the configured key pattern, so the key convention stays config", () => {
    const { adapter } = createTracker(
      config({ tracker: { kind: "mcp", host: "linear", keyPattern: "ENG-\\d+" } }),
      "/repo",
    );

    expect(adapter.extractKey({ branch: "", title: "ENG-42 add export", body: "" })?.key).toBe(
      "ENG-42",
    );
    expect(adapter.extractKey({ branch: "", title: "PLAT-1234 add export", body: "" })).toBeNull();
  });

  test("reads no file and runs no subprocess while building either way", () => {
    // The factory is the degradation path, so it has to be safe to call in a repository that is not
    // there at all. A constructor that went looking for the payload would turn a review that could
    // still report impact and coverage into a failed command.
    expect(() =>
      createTracker(config({ tracker: { kind: "mcp", host: "jira" } }), "/no/such/repo"),
    ).not.toThrow();
  });
});
