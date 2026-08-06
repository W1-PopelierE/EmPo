import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createForge } from "../../src/adapters/forge/create";
import { parseComments, parsePrJson, rollupState } from "../../src/adapters/forge/github";
import { createLocalForge } from "../../src/adapters/forge/local";
import type { ForgeKind } from "../../src/adapters/forge/types";
import { run } from "../../src/engine/git";
import { EmpoError } from "../../src/errors";
import { configSchema, type EmpoConfig } from "../../src/schema/config.schema";
import { hostPullRequestSchema } from "../../src/schema/host-payload.schema";

/**
 * The github half of this file never touches the network: everything that interprets what gh said
 * is a pure function, and it is tested against the JSON gh actually prints. The local half needs a
 * real git repository, because the thing worth proving about it is that it produces a real diff.
 *
 * Both halves run against a throwaway repo under the system temp directory, so a test can dirty a
 * checkout without making the next one lie.
 */

let repo: string;

function git(args: string[]): void {
  const result = run(repo, "git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function write(name: string, contents: string): void {
  writeFileSync(join(repo, name), contents);
}

function expectEmpoError(exitCode: number, act: () => unknown): EmpoError {
  try {
    act();
    return expect.unreachable(`expected a EmpoError with exit code ${exitCode}`);
  } catch (error) {
    expect(error).toBeInstanceOf(EmpoError);
    expect((error as EmpoError).exitCode).toBe(exitCode);
    return error as EmpoError;
  }
}

function configWith(forge?: {
  kind: ForgeKind;
  repo?: string;
  workspace?: string;
  host?: string;
}): EmpoConfig {
  return configSchema.parse({
    version: 1,
    roots: [{ path: ".", lang: "typescript" }],
    packs: { typescript: {} },
    ...(forge === undefined ? {} : { adapters: { forge } }),
  });
}

/**
 * A PATH with nothing on it, so "is gh installed" has one answer on every machine. Without this the
 * degradation test would only test the machine it happened to run on.
 */
function withoutPath<T>(act: () => T): T {
  const path = process.env.PATH;
  process.env.PATH = join(repo, "no-executables-here");
  try {
    return act();
  } finally {
    process.env.PATH = path;
  }
}

/**
 * The opposite fixture: a PATH where `gh --version` succeeds, and nothing else exists.
 *
 * Every other call echoes the arguments it was handed, which is what makes the flags the adapter
 * builds observable at all. The adapter is a closure over one gh invocation and exposes the
 * repository it was given nowhere else, so without this the only honest thing a test could assert
 * about `--repo` is that constructing the adapter did not throw. `getDiff` returns gh's stdout
 * verbatim, so the argument line comes straight back out of the contract, and a test can assert the
 * slug that was actually passed rather than that something was passed.
 */
function withFakeGh<T>(act: () => T): T {
  const path = process.env.PATH;
  const bin = join(repo, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    "#!/bin/sh\nif [ \"$1\" = '--version' ]; then echo 'gh version 2.0.0'; else echo \"$*\"; fi\n",
    { mode: 0o755 },
  );
  process.env.PATH = bin;
  try {
    return act();
  } finally {
    process.env.PATH = path;
  }
}

/**
 * A checkout with one commit on `main`. Only the local forge needs one, so it is not in the
 * top-level setup: a dozen git subprocesses per test to check a JSON mapping is a slow suite for
 * nothing, and a slow suite gets run less often.
 */
function initRepo(): void {
  git(["init"]);
  // Named rather than inherited: init.defaultBranch is a per-machine setting, and these tests name
  // the base ref they diff against.
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["config", "user.email", "empo@example.test"]);
  git(["config", "user.name", "EmPo Test"]);
  git(["config", "commit.gpgsign", "false"]);
  write("price.ts", "export const rate = 1;\n");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "empo-forge-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("createLocalForge", () => {
  beforeEach(initRepo);

  test("declares diff and nothing else, so the review knows what it could not check", () => {
    const forge = createLocalForge(repo, { base: "main", standsInFor: null });

    expect(forge.kind).toBe("local");
    expect([...forge.capabilities]).toEqual(["diff"]);
  });

  test("diffs the working tree against the base, uncommitted work included", () => {
    git(["checkout", "-b", "feature"]);
    write("price.ts", "export const rate = 2;\n");

    const diff = createLocalForge(repo, { base: "main", standsInFor: null }).getDiff("");

    expect(diff).toContain("price.ts");
    expect(diff).toContain("-export const rate = 1;");
    expect(diff).toContain("+export const rate = 2;");
  });

  test("sees a committed change on the branch too", () => {
    git(["checkout", "-b", "feature"]);
    write("vat.ts", "export const vat = 0.21;\n");
    git(["add", "."]);
    git(["commit", "-m", "add vat"]);

    expect(createLocalForge(repo, { base: "main", standsInFor: null }).getDiff("")).toContain(
      "vat.ts",
    );
  });

  test("returns an empty diff when the branch matches the base", () => {
    expect(createLocalForge(repo, { base: "main", standsInFor: null }).getDiff("")).toBe("");
  });

  test("fails with exit code 2 on a base ref that does not resolve, naming it and --base", () => {
    const error = expectEmpoError(2, () =>
      createLocalForge(repo, { base: "no-such-branch", standsInFor: null }).getDiff(""),
    );

    expect(error.message).toContain("no-such-branch");
    expect(error.details.join("\n")).toContain("--base");
  });

  test("builds without touching git, so it can be the fallback for a bad base", () => {
    // Constructing must not throw: createForge builds this adapter as the degradation path, and a
    // constructor that validated the base would turn a degraded review into a failed one.
    expect(() =>
      createLocalForge(repo, { base: "no-such-branch", standsInFor: null }),
    ).not.toThrow();
  });

  test("has no pull request and does not invent one", () => {
    expect(createLocalForge(repo, { base: "main", standsInFor: null }).getPr("1")).toBeNull();
  });

  test("reports CI as unknown rather than as a passing pipeline", () => {
    const ci = createLocalForge(repo, { base: "main", standsInFor: null }).getCiResult("1");

    expect(ci.state).toBe("unknown");
    expect(ci.detail).toContain("no forge is configured");
  });

  test("does not say a forge is unconfigured when it is standing in for one", () => {
    // The defect this pins: every path in createForge but one reaches this adapter with a forge
    // sitting in config, and all of them used to print "no forge is configured", which sends a
    // reader to write a config file they already have.
    const ci = createLocalForge(repo, {
      base: "main",
      standsInFor: { kind: "github", host: null, subjectIsPullRequest: true },
    }).getCiResult("1");

    expect(ci.state).toBe("unknown");
    expect(ci.detail).not.toContain("no forge is configured");
    expect(ci.detail).toContain("github");
  });

  test("does not claim a CI run exists when no pull request was named", () => {
    // The commonest review of all, the working diff, and the sentence above is wrong for it: with
    // no pull request there is no pipeline, so "CI was not read" reports something that existed and
    // went unlooked-at, and sends an agent to find it. Two facts, two sentences.
    const ci = createLocalForge(repo, {
      base: "main",
      standsInFor: { kind: "github", host: null, subjectIsPullRequest: false },
    }).getCiResult("");

    expect(ci.detail).toContain("no pull request was named");
    expect(ci.detail).toContain("no CI run to read");
    expect(ci.detail).not.toContain("was not read on this run");
  });

  test("names the host rather than the kind when config named one", () => {
    const ci = createLocalForge(repo, {
      base: "main",
      standsInFor: { kind: "mcp", host: "bitbucket", subjectIsPullRequest: true },
    }).getCiResult("1");

    expect(ci.detail).toContain("bitbucket");
    expect(ci.detail).not.toContain("mcp");
  });

  test("keeps a configured local forge apart from no forge at all", () => {
    // The same rule doctor follows for kind null against kind "local": one is a silence and the
    // other is somebody's statement, so they may not print the same sentence.
    const ci = createLocalForge(repo, {
      base: "main",
      standsInFor: { kind: "local", host: null, subjectIsPullRequest: true },
    }).getCiResult("1");

    expect(ci.detail).toContain("contacts no host");
    expect(ci.detail).not.toContain("no forge is configured");
  });

  test("does not tell a local forge that declares a host that it has none", () => {
    // forgeSchema puts `host` on every kind, so { "kind": "local", "host": "bitbucket" } parses.
    // Saying "the local forge has no host" to its author would be this same defect one config away,
    // so the sentence is about what the adapter does rather than about what the config holds.
    const ci = createLocalForge(repo, {
      base: "main",
      standsInFor: { kind: "local", host: "bitbucket", subjectIsPullRequest: false },
    }).getCiResult("");

    expect(ci.detail).toContain("contacts no host");
    expect(ci.detail).not.toContain("has no host");
  });

  test("lists no comments", () => {
    expect(createLocalForge(repo, { base: "main", standsInFor: null }).listComments("1")).toEqual(
      [],
    );
  });

  test("fails with exit code 2 on every mutating call, because it has nowhere to post", () => {
    const forge = createLocalForge(repo, { base: "main", standsInFor: null });

    expectEmpoError(2, () => forge.comment("1", "a finding"));
    expectEmpoError(2, () => forge.approve("1"));
    expectEmpoError(2, () => forge.requestChanges("1", "not yet"));
  });
});

describe("parsePrJson", () => {
  const raw = JSON.stringify({
    number: 412,
    title: "Charge VAT on renewals",
    author: { login: "sam" },
    headRefName: "PLAT-1234-vat-on-renewals",
    baseRefName: "release/2026-08",
    body: "Fixes the renewal invoice total.",
    url: "https://github.com/acme/platform/pull/412",
  });

  test("maps every field the review needs, base branch included", () => {
    const pr = parsePrJson(raw, "412");

    expect(pr).toEqual({
      id: "412",
      title: "Charge VAT on renewals",
      author: "sam",
      sourceBranch: "PLAT-1234-vat-on-renewals",
      baseBranch: "release/2026-08",
      description: "Fixes the renewal invoice total.",
      url: "https://github.com/acme/platform/pull/412",
    });
  });

  test("falls back to the requested id when gh omits the number", () => {
    const withoutNumber = JSON.stringify({ ...JSON.parse(raw), number: undefined });

    expect(parsePrJson(withoutNumber, "412").id).toBe("412");
  });

  test("names a deleted author rather than crashing on the missing login", () => {
    const orphaned = JSON.stringify({ ...JSON.parse(raw), author: null });

    expect(parsePrJson(orphaned, "412").author).toBe("unknown");
  });

  test("fails with exit code 3 on malformed JSON", () => {
    expectEmpoError(3, () => parsePrJson("not json at all", "412"));
    expectEmpoError(3, () => parsePrJson("", "412"));
    expectEmpoError(3, () => parsePrJson("[1,2,3]", "412"));
  });

  test("fails with exit code 3 when the base branch is missing", () => {
    // A guessed base is worse than no review: it floods a stacked PR with the parent's findings.
    const noBase = JSON.stringify({ ...JSON.parse(raw), baseRefName: undefined });

    const error = expectEmpoError(3, () => parsePrJson(noBase, "412"));

    expect(error.message).toContain("base branch");
  });

  test("fails with exit code 3 when the source branch is missing", () => {
    const noHead = JSON.stringify({ ...JSON.parse(raw), headRefName: "" });

    expectEmpoError(3, () => parsePrJson(noHead, "412"));
  });
});

describe("parseComments", () => {
  test("reads issue comments and review bodies as one conversation, in order", () => {
    const raw = JSON.stringify({
      comments: [{ author: { login: "sam" }, body: "Rebased." }],
      reviews: [{ author: { login: "ada" }, body: "Check the rounding.", state: "COMMENTED" }],
    });

    expect(parseComments(raw)).toEqual([
      { author: "sam", body: "Rebased.", file: null, line: null },
      { author: "ada", body: "Check the rounding.", file: null, line: null },
    ]);
  });

  test("anchors nothing, because gh pr view carries no line to anchor to", () => {
    const raw = JSON.stringify({ comments: [{ author: { login: "sam" }, body: "here" }] });

    expect(parseComments(raw)[0]?.file).toBeNull();
    expect(parseComments(raw)[0]?.line).toBeNull();
  });

  test("drops a bare approval, which has no body to duplicate", () => {
    const raw = JSON.stringify({
      comments: [],
      reviews: [
        { author: { login: "ada" }, body: "", state: "APPROVED" },
        { author: { login: "ada" }, body: "   ", state: "APPROVED" },
      ],
    });

    expect(parseComments(raw)).toEqual([]);
  });

  test("returns none rather than throwing, on malformed JSON or an unexpected shape", () => {
    // A comment list is a nicety: losing it means the review may repeat someone, not that it lies.
    expect(parseComments("not json")).toEqual([]);
    expect(parseComments("{}")).toEqual([]);
    expect(parseComments(JSON.stringify({ comments: "nope", reviews: 7 }))).toEqual([]);
  });
});

describe("rollupState", () => {
  const rollup = (checks: unknown[]): string => JSON.stringify({ statusCheckRollup: checks });

  test("passes when every check is success, neutral or skipped", () => {
    const raw = rollup([
      { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "NEUTRAL" },
      { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "SKIPPED" },
    ]);

    const ci = rollupState(raw);

    expect(ci.state).toBe("passed");
    expect(ci.detail).toContain("3 checks");
  });

  test("reads the StatusContext shape as well as the CheckRun shape", () => {
    const raw = rollup([{ __typename: "StatusContext", context: "ci/jenkins", state: "SUCCESS" }]);

    expect(rollupState(raw)).toEqual({
      state: "passed",
      detail: "1 check reported success, neutral or skipped",
    });
  });

  test("fails and names the failing checks when anything failed or errored", () => {
    const raw = rollup([
      { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "phpstan", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "StatusContext", context: "ci/deploy", state: "ERROR" },
    ]);

    const ci = rollupState(raw);

    expect(ci.state).toBe("failed");
    expect(ci.detail).toContain("phpstan");
    expect(ci.detail).toContain("ci/deploy");
    expect(ci.detail).toContain("2 checks of 3");
  });

  test("fails rather than pends when one check failed while another is still running", () => {
    const raw = rollup([
      { __typename: "CheckRun", name: "unit", status: "IN_PROGRESS", conclusion: null },
      { __typename: "CheckRun", name: "phpstan", status: "COMPLETED", conclusion: "FAILURE" },
    ]);

    expect(rollupState(raw).state).toBe("failed");
  });

  test("pends on a check that has not completed and so has no conclusion yet", () => {
    const raw = rollup([
      { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null },
      { __typename: "CheckRun", name: "deploy", status: "QUEUED", conclusion: null },
      { __typename: "StatusContext", context: "ci/jenkins", state: "PENDING" },
    ]);

    const ci = rollupState(raw);

    expect(ci.state).toBe("pending");
    expect(ci.detail).toContain("3 checks of 4");
  });

  test("is unknown with no checks reported, rather than passed by default", () => {
    expect(rollupState(rollup([]))).toEqual({ state: "unknown", detail: "no checks reported" });
    expect(rollupState(JSON.stringify({}))).toEqual({
      state: "unknown",
      detail: "no checks reported",
    });
  });

  test("is unknown, and says which state it saw, for a conclusion outside the three buckets", () => {
    // A cancelled run is not a green pipeline. Rounding it up to passed is the one mistake here
    // that would make a review claim CI checked something it did not.
    const raw = rollup([
      { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "CANCELLED" },
    ]);

    const ci = rollupState(raw);

    expect(ci.state).toBe("unknown");
    expect(ci.detail).toContain("e2e (CANCELLED)");
  });

  test("is unknown on malformed JSON, so a broken checks call never fails a review", () => {
    const ci = rollupState("not json");

    expect(ci.state).toBe("unknown");
    expect(ci.detail).toContain("not JSON");
  });
});

describe("createForge", () => {
  test("gives the local forge, and no note, when no adapters are configured", () => {
    const { adapter, note } = createForge(configWith(), repo, { base: "main", pr: "412" });

    expect(adapter.kind).toBe("local");
    expect(note).toBeNull();
  });

  /**
   * One rule, checked before the kind, because it is true of every kind: no pull request id means
   * no pull request, so the configured forge is not consulted at all. The alternative was a guard
   * per adapter, and the guard that was missing is what made `empo review` in a github repository
   * run `gh pr diff local` and die on a pull request nobody had named.
   */
  test.each(["github", "mcp"] as const)(
    "gives the local forge, naming %s and the base, when no pull request was named",
    (kind) => {
      const { adapter, note } = withFakeGh(() =>
        createForge(configWith({ kind, repo: "acme/platform" }), repo, {
          base: "main",
          pr: undefined,
        }),
      );

      expect(adapter.kind).toBe("local");
      expect(note).toContain("no pull request was named");
      expect(note).toContain(kind);
      expect(note).toContain("main");
    },
  );

  test("names the mcp host, not the transport, when no pull request was named", () => {
    const { note } = createForge(configWith({ kind: "mcp", host: "bitbucket" }), repo, {
      base: "main",
      pr: undefined,
    });

    expect(note).toContain("bitbucket");
    expect(note).not.toContain("mcp forge");
  });

  /**
   * The CI line on every path that hands back the local adapter, which is the half the unit tests
   * above `createLocalForge` cannot reach.
   *
   * A review measured the gap and it was wide: with only the note pinned, `standsInFor` could be
   * built on the one path a spec walked and left null on the other four, or have its `host` dropped,
   * with the whole suite green. Those four paths are precisely what the change was for, so each gets
   * a row. The assertion is on the sentence rather than on the field, because the sentence is what
   * an agent reads.
   */
  test.each([
    {
      what: "a github forge with no gh on PATH",
      forge: { kind: "github", repo: "acme/platform" } as const,
      pr: "412",
      gh: false,
      expected: "the github forge was not consulted on this run, so CI was not read",
    },
    {
      what: "an mcp forge whose host has fetched nothing",
      forge: { kind: "mcp", host: "bitbucket" } as const,
      pr: "412",
      gh: false,
      expected: "the bitbucket forge was not consulted on this run, so CI was not read",
    },
    {
      what: "a github forge with no pull request named",
      forge: { kind: "github", repo: "acme/platform" } as const,
      pr: undefined,
      gh: true,
      expected: "no pull request was named, so there is no CI run to read",
    },
    {
      what: "a forge configured local",
      forge: { kind: "local" } as const,
      pr: "412",
      gh: false,
      expected: "the local forge contacts no host, so CI was not consulted",
    },
  ])("tells the truth about CI on the path taken by $what", ({ forge, pr, gh, expected }) => {
    const build = () => createForge(configWith(forge), repo, { base: "main", pr });
    const { adapter } = gh ? withFakeGh(build) : withoutPath(build);

    expect(adapter.kind).toBe("local");
    expect(adapter.getCiResult(pr ?? "").detail).toBe(expected);
  });

  test("gives no forge at all the one sentence that may say so", () => {
    const { adapter } = createForge(configWith(), repo, { base: "main", pr: "412" });

    expect(adapter.getCiResult("412").detail).toBe(
      "no forge is configured, so CI was not consulted",
    );
  });

  test("gives the local forge, and still no note, when local is configured and nothing was named", () => {
    // Nothing degraded here: local is what was asked for and local is what ran.
    const { adapter, note } = createForge(configWith({ kind: "local" }), repo, {
      base: "main",
      pr: undefined,
    });

    expect(adapter.kind).toBe("local");
    expect(note).toBeNull();
  });

  test("gives the local forge, and no note, when local is configured on purpose", () => {
    const { adapter, note } = createForge(configWith({ kind: "local" }), repo, {
      base: "main",
      pr: "412",
    });

    expect(adapter.kind).toBe("local");
    expect(note).toBeNull();
  });

  /**
   * These two rows used to be `kind: "bitbucket"` and `kind: "gitlab"`, pinning that a host EmPo
   * did not implement degraded with a note. Those kinds are gone, folded into `mcp`, but the
   * behaviour they pinned did not go anywhere: a forge that cannot answer still has to degrade to
   * the local diff and still has to say so. So the same two hosts stay, as the `host` string, and
   * the assertion that the note names the base is carried over unchanged, because a note that says
   * only what was missing leaves the reader not knowing what they are about to read findings about.
   */
  test.each(["bitbucket", "gitlab"])(
    "degrades to local, naming %s and the base, when the host has fetched no pull request",
    (host) => {
      const { adapter, note } = createForge(configWith({ kind: "mcp", host }), repo, {
        base: "main",
        pr: "412",
      });

      expect(adapter.kind).toBe("local");
      expect(note).toContain(host);
      expect(note).toContain("no");
      // The note has to say what was reviewed instead, not only what was missing.
      expect(note).toContain("main");
    },
  );

  test("says the payload is there and unused when a fetched one was not passed to this run", () => {
    // The two mistakes have different fixes: fetch it, against point --pr at what you fetched. A
    // note that gave the wrong one sends the reader looking in the wrong place.
    const payloadPath = join(repo, "pull-request.json");
    writeFileSync(payloadPath, "{}");

    const { adapter, note } = createForge(configWith({ kind: "mcp", host: "bitbucket" }), repo, {
      base: "main",
      pr: "412",
      payloadPath,
    });

    expect(adapter.kind).toBe("local");
    expect(note).toContain(payloadPath);
    expect(note).toContain("main");
  });

  test("reads nothing and validates nothing while degrading past an unreadable payload", () => {
    // Same rule the local forge is pinned to above: this is the degradation path itself, so a
    // factory that parsed the file would turn a degraded review into a failed one. The file here
    // is not JSON at all, and building must still not throw.
    const payloadPath = join(repo, "pull-request.json");
    writeFileSync(payloadPath, "{ not json");

    expect(() =>
      createForge(configWith({ kind: "mcp", host: "bitbucket" }), repo, {
        base: "main",
        pr: "412",
        payloadPath,
      }),
    ).not.toThrow();
  });

  test("uses the mcp forge, with no note, once a checked payload is handed over", () => {
    const { adapter, note } = createForge(configWith({ kind: "mcp", host: "bitbucket" }), repo, {
      base: "main",
      pr: "412",
      pullRequest: {
        payload: hostPullRequestSchema.parse({
          id: "412",
          title: "Charge VAT on renewals",
          author: "Sam Okonkwo",
          sourceBranch: "PLAT-1234-vat",
          baseBranch: "main",
          description: "",
          url: "https://bitbucket.org/acme/platform/pull-requests/412",
        }),
        verified: { baseRef: "main", headRef: "origin/PLAT-1234-vat" },
      },
    });

    expect(adapter.kind).toBe("mcp");
    expect(note).toBeNull();
    // Declared from what the payload holds: neither comments nor ci was fetched, so neither is
    // claimed, and the review reports both as unchecked rather than as empty.
    expect([...adapter.capabilities].sort()).toEqual(["diff", "pr"]);
  });

  test("degrades to local, with a note, when gh is not on PATH", () => {
    const { adapter, note } = withoutPath(() =>
      createForge(configWith({ kind: "github" }), repo, { base: "develop", pr: "412" }),
    );

    expect(adapter.kind).toBe("local");
    expect(note).toContain("gh is not on PATH");
    expect(note).toContain("develop");
  });

  test("uses github when gh is on PATH", () => {
    const { adapter, note } = withFakeGh(() =>
      createForge(configWith({ kind: "github", repo: "acme/platform" }), repo, {
        base: "main",
        pr: "412",
      }),
    );

    expect(adapter.kind).toBe("github");
    expect(note).toBeNull();
    expect([...adapter.capabilities].sort()).toEqual(["ci", "comments", "diff", "post", "pr"]);
  });

  /**
   * The slug that reaches gh, asserted as the string it is. Config keeps the workspace and the repo
   * apart because every Bitbucket call wants them separate, and `gh --repo` wants them joined; the
   * test above passes a repo already in `OWNER/REPO` form with no workspace, which is the one shape
   * for which joining is a no-op, so it would stay green with the joining removed. This is the shape
   * that would not: `empo review 412` against a github repository detected from its origin remote
   * died on `expected the "[HOST/]OWNER/REPO" format` before it fetched anything, because the
   * adapter was handed the bare repo name and gh has no way to guess the owner from it.
   *
   * Asserted through the whole gh argument line rather than through the slug alone, because the
   * position of `--repo` is part of the same promise: it goes last so it applies to every subcommand
   * shape without reordering their arguments.
   */
  test("hands github the workspace and the repo joined into one OWNER/REPO slug", () => {
    // Both the construction and the call sit inside the fixture, because it restores PATH on the
    // way out and gh is resolved when the diff is fetched rather than when the adapter is built.
    const diff = withFakeGh(() => {
      const { adapter } = createForge(
        configWith({ kind: "github", workspace: "acme", repo: "platform" }),
        repo,
        { base: "main", pr: "412" },
      );

      return adapter.getDiff("412");
    });

    expect(diff).toBe("pr diff 412 --repo acme/platform");
  });

  test("leaves --repo off altogether when the config names no repository", () => {
    // The other half of the same decision, and the reason it is a decision: there is no repo to
    // name, so the flag is omitted rather than passed empty. gh then infers the repository from the
    // working directory, which is the right answer here, and `--repo ""` is not.
    const diff = withFakeGh(() => {
      const { adapter } = createForge(configWith({ kind: "github" }), repo, {
        base: "main",
        pr: "412",
      });

      return adapter.getDiff("412");
    });

    expect(diff).toBe("pr diff 412");
  });
});
