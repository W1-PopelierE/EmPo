import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createMcpForge } from "../../src/adapters/forge/mcp";
import { verifyPullRequest } from "../../src/adapters/host-input";
import { run } from "../../src/engine/git";
import { EmpoError } from "../../src/errors";
import { type HostPullRequest, hostPullRequestSchema } from "../../src/schema/host-payload.schema";

/**
 * The forge that reads what an agent host fetched. Two things are worth proving about it, and they
 * are the two the design rests on.
 *
 * The diff is git's, not the payload's: `getDiff` is checked against a real checkout, because a
 * payload that carried its own diff would be a model's account of a change reviewed as if it were
 * the change. And the capability set is read off the payload rather than off the adapter's kind, so
 * a `comments` key that is absent and one that is an empty array produce different sets. Everything
 * else here is a mapping, tested against the shape the schema hands over.
 */

let repo: string;

function git(args: string[]): string {
  const result = run(repo, "git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
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

const RAW = {
  id: "412",
  title: "Charge VAT on renewals",
  author: "sam",
  sourceBranch: "feature",
  baseBranch: "main",
  description: "Fixes the renewal invoice total.",
  url: "https://bitbucket.org/acme/platform/pull-requests/412",
};

/** Through the schema rather than hand-built, so a test never asserts on a shape zod would refuse. */
function payload(overrides: Record<string, unknown> = {}): HostPullRequest {
  return hostPullRequestSchema.parse({ ...RAW, ...overrides });
}

/**
 * The adapter for the tests that never touch git. The refs are stated rather than verified, because
 * standing up a checkout to prove a comment list maps is a slow suite for nothing.
 */
function forgeWith(overrides: Record<string, unknown> = {}, host: string | null = "bitbucket") {
  const refs = { baseRef: "main", headRef: "feature" };
  return createMcpForge(repo, { payload: payload(overrides), verified: refs, host });
}

/**
 * The adapter as `review.ts` builds it: the payload, and the refs the gate actually resolved. Every
 * diff test goes through this rather than stating the refs, because which spelling verification
 * hands over is precisely what the diff depends on.
 */
function verifiedForge(root: string, overrides: Record<string, unknown> = {}) {
  const pr = payload(overrides);
  const result = verifyPullRequest(root, pr, pr.id);
  if (!result.ok) throw new Error(`the payload did not verify: ${result.problems.join(", ")}`);
  return createMcpForge(root, { payload: pr, verified: result.value, host: "bitbucket" });
}

/** A checkout with `main` and a `feature` branch that changed one line of it. */
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
  git(["checkout", "-b", "feature"]);
  write("price.ts", "export const rate = 2;\n");
  git(["commit", "-am", "raise the rate"]);
  git(["checkout", "main"]);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "empo-mcp-forge-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("createMcpForge capabilities", () => {
  test("declares pr and diff, and never post", () => {
    // No post: writing back needs the connector, which is the one thing the CLI does not have.
    expect([...forgeWith().capabilities].sort()).toEqual(["diff", "pr"]);
  });

  test("declares comments only when the payload carries the key", () => {
    expect(forgeWith().capabilities.has("comments")).toBe(false);
    expect(forgeWith({ comments: [] }).capabilities.has("comments")).toBe(true);
  });

  test("tells an empty comment list apart from a list that was never fetched", () => {
    // The distinction the whole optional field exists for: one means the pull request has no
    // comments, the other means nobody looked, and the report has to say which.
    const fetched = forgeWith({ comments: [] });
    const notFetched = forgeWith();

    expect(fetched.listComments("412")).toEqual([]);
    expect(notFetched.listComments("412")).toEqual([]);
    expect(fetched.capabilities.has("comments")).toBe(true);
    expect(notFetched.capabilities.has("comments")).toBe(false);
  });

  test("declares ci only when the payload carries the key", () => {
    expect(forgeWith().capabilities.has("ci")).toBe(false);
    expect(forgeWith({ ci: { state: "passed" } }).capabilities.has("ci")).toBe(true);
  });

  test("is the mcp kind whatever host the config named, since nothing branches on the name", () => {
    expect(forgeWith({}, "gitlab").kind).toBe("mcp");
    expect(forgeWith({}, null).kind).toBe("mcp");
  });
});

describe("createMcpForge getPr", () => {
  test("hands back every field the review needs, base branch included", () => {
    expect(forgeWith().getPr("412")).toEqual({
      id: "412",
      title: "Charge VAT on renewals",
      author: "sam",
      sourceBranch: "feature",
      baseBranch: "main",
      description: "Fixes the renewal invoice total.",
      url: "https://bitbucket.org/acme/platform/pull-requests/412",
    });
  });

  test("carries no comments or ci, which travel through their own methods", () => {
    const pr = forgeWith({ comments: [{ author: "ada", body: "hi" }], ci: { state: "passed" } });

    expect(Object.keys(pr.getPr("412") ?? {}).sort()).toEqual([
      "author",
      "baseBranch",
      "description",
      "id",
      "sourceBranch",
      "title",
      "url",
    ]);
  });
});

describe("createMcpForge getDiff", () => {
  beforeEach(initRepo);

  test("computes the diff from git rather than taking one from the payload", () => {
    // The point of the design: the metadata came from a model, the diff never did.
    const diff = verifiedForge(repo).getDiff("412");

    expect(diff).toContain("price.ts");
    expect(diff).toContain("-export const rate = 1;");
    expect(diff).toContain("+export const rate = 2;");
  });

  test("diffs the two branches the payload named, not the working tree", () => {
    write("price.ts", "export const rate = 99;\n");

    expect(verifiedForge(repo).getDiff("412")).not.toContain("99");
  });

  test("diffs the refs verification handed over, not the payload's branch names", () => {
    // A pull request opened from another machine leaves origin/<branch> here and no local branch of
    // that name. Re-deriving "pushed" from the payload would ask git for a ref that does not exist.
    git(["update-ref", "refs/remotes/origin/pushed", git(["rev-parse", "feature"])]);
    git(["branch", "-D", "feature"]);

    expect(verifiedForge(repo, { sourceBranch: "pushed" }).getDiff("412")).toContain(
      "+export const rate = 2;",
    );
  });

  test("fails with exit code 3 naming the refs it was given, and claims nothing about why", () => {
    // The refs resolved when the payload was checked; this is a different moment, and anything the
    // error said about the cause would be a claim nothing here established.
    const forge = createMcpForge(repo, {
      payload: payload(),
      verified: { baseRef: "main", headRef: "gone-since" },
      host: "bitbucket",
    });

    const error = expectEmpoError(3, () => forge.getDiff("412"));

    expect(error.message).toContain("main...gone-since");
    expect(error.details.join("\n")).not.toContain("common ancestor");
    expect(error.details.join("\n")).not.toContain("unshallow");
  });

  test("fails with exit code 3, naming both refs, when the two branches share no history", () => {
    git(["checkout", "--orphan", "unrelated"]);
    git(["rm", "-rf", "."]);
    write("other.ts", "export const other = 1;\n");
    git(["add", "."]);
    git(["commit", "-m", "unrelated root"]);

    const error = expectEmpoError(3, () =>
      verifiedForge(repo, { sourceBranch: "unrelated" }).getDiff("412"),
    );

    expect(error.message).toContain("main...unrelated");
  });
});

describe("an origin and a clone, which is the shape every real review has", () => {
  /**
   * The regression test for the bug this design nearly shipped: verification accepted a branch that
   * only exists as `origin/<branch>`, and the diff then asked git for the bare name. Nothing but a
   * second repository reproduces it, because a branch is only remote-only when there is a remote.
   */
  const dirs: string[] = [];

  function makeDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function gitIn(dir: string, args: string[]): void {
    const result = run(dir, "git", args);
    if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  /**
   * A clone over a local path, made against a git that refuses one. `protocol.file.allow=never` is
   * what a machine hardened after CVE-2022-39253 carries, and corporate and CI images set it, so
   * without the `-c` this spec dies in setup rather than on the remote-only branch it is about.
   * Only the command line beats a config file, which makes that one flag the whole defence, and the
   * hostile config is written here so that deleting the flag goes red where somebody sees it.
   * GIT_CONFIG_GLOBAL replaces the machine's global config wholesale, so it is set around this call
   * alone and restored: cloning a local path needs no identity, credential or rewrite rule.
   */
  function cloneLocal(parent: string, origin: string, target: string): void {
    const home = makeDir("empo-mcp-hardened-");
    writeFileSync(join(home, "gitconfig"), '[protocol "file"]\n\tallow = never\n');
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
    try {
      gitIn(parent, ["-c", "protocol.file.allow=always", "clone", origin, target]);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("verifies and diffs a branch this checkout has never had a local name for", () => {
    const origin = makeDir("empo-mcp-origin-");
    gitIn(origin, ["init", "-b", "main"]);
    gitIn(origin, ["config", "user.email", "empo@example.test"]);
    gitIn(origin, ["config", "user.name", "EmPo Test"]);
    gitIn(origin, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(origin, "price.ts"), "export const rate = 1;\n");
    gitIn(origin, ["add", "."]);
    gitIn(origin, ["commit", "-m", "base"]);
    gitIn(origin, ["checkout", "-b", "feature"]);
    writeFileSync(join(origin, "price.ts"), "export const rate = 2;\n");
    gitIn(origin, ["commit", "-am", "raise the rate"]);
    gitIn(origin, ["checkout", "main"]);

    const parent = makeDir("empo-mcp-clone-");
    cloneLocal(parent, origin, "checkout");
    const clone = join(parent, "checkout");

    // The precondition that makes this the real shape: "feature" is not a ref in the clone.
    expect(run(clone, "git", ["rev-parse", "--verify", "feature^{commit}"]).ok).toBe(false);

    expect(verifiedForge(clone).getDiff("412")).toContain("+export const rate = 2;");
  });
});

describe("createMcpForge listComments", () => {
  test("maps a top-level comment with no anchor", () => {
    const forge = forgeWith({ comments: [{ author: "ada", body: "Rebased." }] });

    expect(forge.listComments("412")).toEqual([
      { author: "ada", body: "Rebased.", file: null, line: null },
    ]);
  });

  test("keeps an inline comment's file and line, in the order the host listed them", () => {
    const forge = forgeWith({
      comments: [
        { author: "ada", body: "Check the rounding.", file: "price.ts", line: 42 },
        { author: "sam", body: "Done." },
      ],
    });

    expect(forge.listComments("412").map((comment) => comment.author)).toEqual(["ada", "sam"]);
    expect(forge.listComments("412")[0]).toEqual({
      author: "ada",
      body: "Check the rounding.",
      file: "price.ts",
      line: 42,
    });
  });
});

describe("createMcpForge getCiResult", () => {
  test("is unknown, and says so, when the host supplied no CI result", () => {
    // Never rounded up to passed (doc 07 invariant 1): the review reads this instead of running
    // the suite, so an unreported pipeline is a thing the report states rather than assumes.
    const ci = forgeWith().getCiResult("412");

    expect(ci.state).toBe("unknown");
    expect(ci.detail).toContain("no CI result was supplied");
  });

  test("is unknown, not passed, when the host supplied a state it could not determine", () => {
    expect(forgeWith({ ci: { state: "unknown" } }).getCiResult("412").state).toBe("unknown");
  });

  test("passes the host's result through, detail included", () => {
    const ci = forgeWith({ ci: { state: "failed", detail: "phpstan failed" } }).getCiResult("412");

    expect(ci).toEqual({ state: "failed", detail: "phpstan failed" });
  });

  test("defaults only the detail, so a passing pipeline stays a passing pipeline", () => {
    expect(forgeWith({ ci: { state: "passed" } }).getCiResult("412")).toEqual({
      state: "passed",
      detail: "",
    });
  });
});

describe("createMcpForge posting", () => {
  test("fails with exit code 3 on every mutating call, naming the host it cannot reach", () => {
    const forge = forgeWith();

    for (const error of [
      expectEmpoError(3, () => forge.comment("412", "a finding")),
      expectEmpoError(3, () => forge.approve("412")),
      expectEmpoError(3, () => forge.requestChanges("412", "not yet")),
    ]) {
      expect(error.message).toContain("bitbucket");
    }
  });

  test("says mcp when no host was named, rather than printing an empty name", () => {
    const forge = forgeWith({}, null);

    expect(expectEmpoError(3, () => forge.approve("412")).message).toContain("mcp");
  });
});

describe("createMcpForge without a payload", () => {
  const empty = () => createMcpForge(repo, { payload: null, verified: null, host: "bitbucket" });

  test("still declares pr and diff, so a review can never quietly report on nothing", () => {
    // Unreachable by construction. Declaring no diff would have the review skip the diff and
    // produce findings about nothing at all, which is worse than the throw below.
    expect([...empty().capabilities].sort()).toEqual(["diff", "pr"]);
  });

  test("throws rather than inventing a pull request or an empty diff", () => {
    const forge = empty();

    expectEmpoError(3, () => forge.getPr("412"));
    expectEmpoError(3, () => forge.getDiff("412"));
    expectEmpoError(3, () => forge.listComments("412"));
    expectEmpoError(3, () => forge.getCiResult("412"));
  });
});
