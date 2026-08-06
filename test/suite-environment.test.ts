import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { run } from "../src/engine/git";

/**
 * The suite's own environment, pinned the way a command is.
 *
 * Most of this repository's tests drive real git against real throwaway repositories, which is the
 * decision that makes them worth having and is also what puts the developer's machine inside the
 * inputs. Two parts of that machine change the result rather than crashing, and both were found by
 * reading rather than by a red run:
 *
 * - a global `core.hooksPath` fires the developer's own hooks inside every temp repository the
 *   suite creates, and every `commit()` helper here reports that as `git commit failed`;
 * - a `$TMPDIR` inside a checkout gives every `mkdtempSync` directory a work tree, so the specs
 *   that say "not a git checkout" quietly test something else.
 *
 * `vitest.config.ts` answers both centrally, in `gitEnvironment`, because per-spec fixes have to be
 * remembered by every file that shells out to git next and three of the twelve files affected are
 * ones a given session may not be allowed to touch. This file is what makes that answer a tested
 * claim instead of a comment in a config: it is the only place that builds the hostile condition on
 * purpose and asserts the suite survives it.
 */

const temps: string[] = [];

/** Enough identity to commit on a machine that has configured none, and no signing key. */
const IDENTITY = [
  "-c",
  "user.email=empo@example.com",
  "-c",
  "user.name=EmPo Test",
  "-c",
  "commit.gpgsign=false",
];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A repository with one file staged and nothing committed yet, ready for one commit to be tried. */
function stagedRepo(): string {
  const repo = scratch("empo-env-repo-");
  expect(run(repo, "git", ["init", "-q", "-b", "main"]).ok).toBe(true);
  writeFileSync(join(repo, "a.txt"), "a\n");
  expect(run(repo, "git", ["add", "-A"]).ok).toBe(true);
  return repo;
}

/** A hooks directory holding one `pre-commit` that refuses every commit, as a lint runner would. */
function refusingHooks(): string {
  const hooks = scratch("empo-env-hooks-");
  const script = join(hooks, "pre-commit");
  writeFileSync(script, "#!/bin/sh\necho 'the developer hook refuses this commit' >&2\nexit 1\n");
  chmodSync(script, 0o755);
  return hooks;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the developer's git hooks", () => {
  test("do not run inside a throwaway repository, whatever the global config says", () => {
    const hooks = refusingHooks();
    const config = join(scratch("empo-env-config-"), "gitconfig");
    writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);

    // The hook has to be a working one, or the assertion below passes on a dud and this file
    // reports that the suite is protected on a machine where nothing was ever pointed at it. `-c`
    // outranks everything, including the override vitest.config.ts puts in the environment, so this
    // is the one way to make the hook fire from in here.
    const forced = run(stagedRepo(), "git", [
      "-c",
      `core.hooksPath=${hooks}`,
      ...IDENTITY,
      "commit",
      "-m",
      "forced",
    ]);
    expect(forced.ok).toBe(false);
    expect(forced.stderr).toContain("the developer hook refuses this commit");

    // The same hook, now reached the way a real machine reaches it: through the global config, with
    // nothing on the command line about hooks at all. This is every commit() helper in the suite.
    const commit = run(stagedRepo(), "git", [...IDENTITY, "commit", "-m", "the fixture"]);
    expect(commit.ok, `the developer's pre-commit hook ran: ${commit.stderr}`).toBe(true);
  });
});

describe("a throwaway directory", () => {
  test("is outside every git work tree, so a spec that says so is telling the truth", () => {
    // git walks *up*, so this is a fact about $TMPDIR and not about the directory. On a machine
    // where the temp root sits inside a checkout, which `TMPDIR=$HOME/tmp` plus a dotfiles
    // repository at `$HOME` produces, this is the assertion that goes red instead of four specs
    // elsewhere silently indexing against somebody's dotfiles.
    const dir = scratch("empo-env-plain-");

    const toplevel = run(dir, "git", ["rev-parse", "--show-toplevel"]);
    expect(toplevel.ok, `git answered ${toplevel.stdout}`).toBe(false);
    expect(run(dir, "git", ["rev-parse", "HEAD"]).ok).toBe(false);
  });

  test("is covered by the ceiling vitest.config.ts sets, which is the only pinnable half", () => {
    // The two cases either side of this one pass with `GIT_CEILING_DIRECTORIES` removed, and that
    // is not a gap in them: the ceiling changes nothing on a machine whose temp root is outside
    // every checkout, which is every machine the suite is green on. Its effect is visible only on
    // the machine it exists to protect, so deleting it from the config would go unnoticed here and
    // break somebody else. What can be asserted from inside is the contract rather than the effect,
    // and it is worth the one line: the variable reaches the workers, and it names the temp root
    // these tests actually build under.
    expect(process.env.GIT_CEILING_DIRECTORIES ?? "").toContain(tmpdir());
  });

  test("is still allowed to become a repository, which is the other half of the suite", () => {
    // The instrument that stops the walk up must not stop the walk at all. Half the suite builds a
    // real repository under the temp root and expects git to find it from inside.
    const repo = stagedRepo();
    const nested = join(repo, "src", "deep");
    mkdirSync(nested, { recursive: true });

    const toplevel = run(nested, "git", ["rev-parse", "--show-toplevel"]);
    expect(toplevel.ok).toBe(true);
    expect(run(repo, "git", [...IDENTITY, "commit", "-m", "one"]).ok).toBe(true);
  });
});
