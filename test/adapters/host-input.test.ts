import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  readHostPullRequest,
  readHostTicket,
  verifyPullRequest,
} from "../../src/adapters/host-input";
import { run } from "../../src/engine/git";
import type { HostPullRequest } from "../../src/schema/host-payload.schema";

/**
 * The gate that decides whether a payload an agent wrote is about this repository at all.
 *
 * Everything here runs against a real throwaway git checkout, because the thing worth proving is
 * exactly the thing a fixture would fake away: that a branch name a model invented resolves to
 * nothing and stops the review. The cases about a remote use a second local repository as `origin`,
 * over a file path, so a real clone is exercised without a network.
 */

let repo: string;
const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(dir: string, args: string[]): string {
  const result = run(dir, "git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * A clone over a local path, made against a git that refuses one. `protocol.file.allow=never` is
 * what a machine hardened after CVE-2022-39253 carries, and corporate and CI images set it, so
 * without the `-c` the spec below dies in setup rather than on the behaviour it is about. Only the
 * command line beats a config file, which makes that one flag the whole defence.
 *
 * The hostile config is written here rather than waited for, because a defence nothing exercises is
 * one the next edit deletes and nobody sees go red. GIT_CONFIG_GLOBAL replaces the machine's global
 * config wholesale, so it is set around this call alone and restored: a clone of a local path needs
 * no identity, no credential and no rewrite rule.
 */
function cloneLocal(parent: string, args: string[]): void {
  const home = makeDir("empo-host-input-hardened-");
  writeFileSync(join(home, "gitconfig"), '[protocol "file"]\n\tallow = never\n');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
  try {
    git(parent, ["-c", "protocol.file.allow=always", "clone", ...args]);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
}

/** A checkout with one commit on `main` and a `feature` branch off it. */
function initRepo(dir: string): void {
  git(dir, ["init"]);
  // Named rather than inherited: init.defaultBranch is a per-machine setting, and these tests name
  // the base ref they diff against.
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(dir, ["config", "user.email", "empo@example.test"]);
  git(dir, ["config", "user.name", "EmPo Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "price.ts"), "export const rate = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
}

function addBranch(dir: string, branch: string, contents: string): void {
  git(dir, ["checkout", "-b", branch]);
  writeFileSync(join(dir, "price.ts"), contents);
  git(dir, ["commit", "-am", `work on ${branch}`]);
  git(dir, ["checkout", "main"]);
}

function payloadFile(name: string, contents: unknown): string {
  const path = join(repo, name);
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

/**
 * The problems of a read or a verification that was expected to fail, joined, so a test can look
 * for one line. One helper for both because both report the same way, deliberately.
 */
function problemsOf(result: { ok: true } | { ok: false; problems: string[] }): string {
  if (result.ok) return expect.unreachable("expected the payload to be refused");
  return result.problems.join("\n");
}

const PULL_REQUEST = {
  id: "412",
  title: "Charge VAT on renewals",
  author: "sam",
  sourceBranch: "feature",
  baseBranch: "main",
  description: "Fixes the renewal invoice total.",
  url: "https://bitbucket.org/acme/platform/pull-requests/412",
};

function parsed(overrides: Partial<HostPullRequest> = {}): HostPullRequest {
  const read = readHostPullRequest(payloadFile("pr.json", { ...PULL_REQUEST, ...overrides }));
  if (!read.ok) throw new Error(`fixture payload is not valid: ${read.problems.join(", ")}`);
  return read.value;
}

/**
 * Only the gate needs a checkout, so the git setup is not in the top-level hook: a dozen git
 * subprocesses per test to prove a file reader reads a file is a slow suite for nothing, and a slow
 * suite gets run less often.
 */
function withBranches(): void {
  initRepo(repo);
  addBranch(repo, "feature", "export const rate = 2;\n");
}

beforeEach(() => {
  repo = makeDir("empo-host-input-");
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readHostPullRequest", () => {
  test("reads the documented payload and hands it back", () => {
    const read = readHostPullRequest(payloadFile("pr.json", PULL_REQUEST));

    expect(read.ok).toBe(true);
    expect(read.ok && read.value.baseBranch).toBe("main");
  });

  test("reports the missing file by path rather than throwing", () => {
    const path = join(repo, "never-written.json");

    expect(problemsOf(readHostPullRequest(path))).toContain(path);
  });

  test("reports invalid JSON by path, so the agent knows which file it truncated", () => {
    const problems = problemsOf(readHostPullRequest(payloadFile("pr.json", '{"id": "412",')));

    expect(problems).toContain("pr.json");
    expect(problems).toContain("JSON");
  });

  test("refuses an unrecognized key, naming it, rather than dropping it", () => {
    // The failure this catches: an agent that wrote `targetBranch` would otherwise have its base
    // branch silently ignored, and the review would run against a base nobody chose.
    const problems = problemsOf(
      readHostPullRequest(payloadFile("pr.json", { ...PULL_REQUEST, targetBranch: "main" })),
    );

    expect(problems).toContain("targetBranch");
  });

  test("names every problem at once, so one re-fetch can fix all of them", () => {
    const read = readHostPullRequest(
      payloadFile("pr.json", { ...PULL_REQUEST, id: "", sourceBranch: "" }),
    );

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.problems.length).toBe(2);
    expect(problemsOf(read)).toContain("id");
    expect(problemsOf(read)).toContain("sourceBranch");
  });
});

const TICKET = {
  key: "PLAT-1234",
  title: "Renewal invoices omit VAT",
  type: "unknown",
  body: "The renewal total is charged net.",
  comments: [],
  url: "https://acme.atlassian.net/browse/PLAT-1234",
  completed: false,
};

describe("readHostTicket", () => {
  test("reads the documented payload and leaves criteria, the one optional field, absent", () => {
    const read = readHostTicket(payloadFile("ticket.json", TICKET));

    expect(read.ok).toBe(true);
    expect(read.ok && read.value.type).toBe("unknown");
    expect(read.ok && read.value.criteria).toBeUndefined();
  });

  test("refuses a ticket with no comments key, naming it", () => {
    const { comments, ...withoutComments } = TICKET;
    expect(comments).toBeDefined();

    expect(problemsOf(readHostTicket(payloadFile("ticket.json", withoutComments)))).toContain(
      "comments",
    );
  });

  test("reports a missing file rather than an absent ticket", () => {
    // Not the same as a ticket with no criteria: the report has to be able to say it was not read.
    expect(problemsOf(readHostTicket(join(repo, "nothing.json")))).toContain("nothing.json");
  });

  test("refuses an unrecognized key, naming it", () => {
    const problems = problemsOf(
      readHostTicket(payloadFile("ticket.json", { ...TICKET, state: "open" })),
    );

    expect(problems).toContain("state");
  });
});

describe("verifyPullRequest", () => {
  beforeEach(withBranches);

  test("hands back the refs to diff when both branches are in this checkout", () => {
    expect(verifyPullRequest(repo, parsed(), "412")).toEqual({
      ok: true,
      value: { baseRef: "main", headRef: "feature" },
    });
  });

  test("hands back the remote-tracking spelling when that is the one that resolved", () => {
    // The load-bearing case, and the one a caller must not re-derive: a pull request's branch is
    // usually only origin/<branch> here, and "feature" alone is not a ref git would accept.
    git(repo, ["update-ref", "refs/remotes/origin/pushed", git(repo, ["rev-parse", "feature"])]);

    expect(verifyPullRequest(repo, parsed({ sourceBranch: "pushed" }), "412")).toEqual({
      ok: true,
      value: { baseRef: "main", headRef: "origin/pushed" },
    });
  });

  test("prefers the local branch when a branch and its remote-tracking ref both exist", () => {
    // They can point at different commits, and the local one is what the reviewer is looking at.
    git(repo, ["update-ref", "refs/remotes/origin/feature", git(repo, ["rev-parse", "main"])]);

    expect(verifyPullRequest(repo, parsed(), "412")).toEqual({
      ok: true,
      value: { baseRef: "main", headRef: "feature" },
    });
  });

  test("refuses a payload for a different pull request, naming both ids", () => {
    const problems = problemsOf(verifyPullRequest(repo, parsed(), "413"));

    expect(problems).toContain("412");
    expect(problems).toContain("413");
  });

  test("refuses a source branch that does not exist here, naming it", () => {
    // This is the case that makes the whole design acceptable: a pull request a model invented has
    // a plausible branch name, and a plausible branch name resolves to nothing in git.
    const result = verifyPullRequest(repo, parsed({ sourceBranch: "PLAT-1234-vat" }), "412");

    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toContain("PLAT-1234-vat");
    expect(problemsOf(result)).toContain("source branch");
  });

  test("names both causes of an unresolved branch, since neither can be ruled out from here", () => {
    // Whether the branch exists on the remote is a question only the network answers, and the gate
    // does not ask it. Naming one cause would be a diagnosis nothing established.
    const problems = problemsOf(
      verifyPullRequest(repo, parsed({ baseBranch: "release/1" }), "412"),
    );

    expect(problems).toContain("has not fetched it");
    expect(problems).toContain("is not a branch");
  });

  test("refuses a base branch that does not exist here, naming it", () => {
    const result = verifyPullRequest(repo, parsed({ baseBranch: "release/2026-08" }), "412");

    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toContain("release/2026-08");
    expect(problemsOf(result)).toContain("base branch");
  });

  test("names every problem at once rather than stopping at the first", () => {
    const result = verifyPullRequest(
      repo,
      parsed({ id: "9", sourceBranch: "invented", baseBranch: "also-invented" }),
      "412",
    );

    expect(result.ok === false && result.problems).toHaveLength(3);
  });

  test("never fetches, so a branch on the remote and not in this clone is reported", () => {
    // A gate that mutated the checkout to make itself pass would not be a gate. Fetching is the
    // caller's to do, and "you have not fetched this" is the thing the review needs told.
    const origin = makeDir("empo-host-input-origin-");
    initRepo(origin);
    const clone = makeDir("empo-host-input-clone-");
    cloneLocal(clone, ["--single-branch", "--branch", "main", origin, "checkout"]);
    const checkout = join(clone, "checkout");
    addBranch(origin, "pushed-later", "export const rate = 3;\n");

    const result = verifyPullRequest(checkout, parsed({ sourceBranch: "pushed-later" }), "412");

    expect(problemsOf(result)).toContain("pushed-later");
    // And the repository is left exactly as it was found: no new ref, fetched or otherwise.
    expect(run(checkout, "git", ["rev-parse", "--verify", "FETCH_HEAD"]).ok).toBe(false);
    expect(run(checkout, "git", ["rev-parse", "--verify", "origin/pushed-later"]).ok).toBe(false);
  });

  test("reports a problem rather than throwing when the directory is not a git checkout", () => {
    const bare = makeDir("empo-host-input-nogit-");

    expect(problemsOf(verifyPullRequest(bare, parsed(), "412"))).toContain("does not resolve");
  });
});

describe("verifyPullRequest headSha", () => {
  beforeEach(withBranches);

  function headOf(branch: string): string {
    return git(repo, ["rev-parse", branch]);
  }

  test("accepts an abbreviated sha that prefixes the full one git resolved", () => {
    // Bitbucket reports 12 characters and git resolves 40. An equality check would report staleness
    // on every Bitbucket payload ever written, and would then be deleted for crying wolf.
    const abbreviated = headOf("feature").slice(0, 12);

    expect(verifyPullRequest(repo, parsed({ headSha: abbreviated }), "412").ok).toBe(true);
  });

  test("accepts a full sha, and one whose case differs", () => {
    expect(verifyPullRequest(repo, parsed({ headSha: headOf("feature") }), "412").ok).toBe(true);
    expect(
      verifyPullRequest(repo, parsed({ headSha: headOf("feature").toUpperCase() }), "412").ok,
    ).toBe(true);
  });

  test("reports a sha that is a real commit here but not the branch head", () => {
    // A payload written against an older push looks perfect: every branch name resolves. The sha is
    // the only thing that says the review is about to read code the pull request does not contain.
    const result = verifyPullRequest(repo, parsed({ headSha: headOf("main") }), "412");

    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toContain(headOf("main"));
  });

  test("names both causes of a mismatch, since only one of them is the agent's fault", () => {
    const problems = problemsOf(
      verifyPullRequest(repo, parsed({ headSha: "0".repeat(40) }), "412"),
    );

    expect(problems).toContain("has not fetched the newer commit");
    expect(problems).toContain("written against an older push");
  });

  test("says nothing at all when the host supplied no head sha", () => {
    expect(verifyPullRequest(repo, parsed(), "412").ok).toBe(true);
  });

  test("refuses an empty head sha rather than letting it prefix-match every commit", () => {
    // "" is a prefix of every sha there is, so a permissive check would pass and report nothing.
    expect(verifyPullRequest(repo, parsed({ headSha: "" }), "412").ok).toBe(false);
  });

  test("checks the sha against the ref that resolved, not the payload's branch name", () => {
    git(repo, ["update-ref", "refs/remotes/origin/pushed", headOf("feature")]);

    const matching = parsed({ sourceBranch: "pushed", headSha: headOf("feature").slice(0, 12) });
    const stale = parsed({ sourceBranch: "pushed", headSha: headOf("main") });

    expect(verifyPullRequest(repo, matching, "412").ok).toBe(true);
    expect(verifyPullRequest(repo, stale, "412").ok).toBe(false);
  });
});
