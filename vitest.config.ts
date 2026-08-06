import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Test runner configuration.
 *
 * `testTimeout` is raised well above vitest's 5000ms default on purpose. A large part of this suite
 * runs real git against real throwaway repositories rather than mocking it, which is deliberate and
 * is what makes those tests worth having: a fake git cannot disagree with us. The cost is that a
 * single test can spawn a dozen synchronous subprocesses, and vitest runs test files in parallel, so
 * under load the slowest of them drifted past five seconds and failed on time rather than on
 * behaviour.
 *
 * That failure mode is worse than slow tests. It is not reproducible, it moves between files as the
 * suite grows, and it teaches everyone to rerun until green, which is how a real failure gets
 * dismissed as flake. This project already learned the inverse lesson once, that concurrency exposed
 * a genuine defect, so the rule is to make the signal trustworthy and then believe it, never to
 * dismiss a red run and never to trust the first green one.
 *
 * `globalSetup` builds the acme fixture's generated graph before anything runs. That artifact is
 * gitignored, so the suite used to pass only on a machine where an earlier local run had left one
 * behind, which is the same untrustworthy signal by another route: green here, red in a fresh
 * clone. test/global-setup.ts argues the case in full.
 *
 * `env` is the third piece of the same argument and is explained in `gitEnvironment` below: running
 * real git makes the developer's own git environment part of the suite's input, and two parts of it
 * decide test outcomes.
 */

/**
 * The git environment every test worker runs under, so that a suite built on real git depends on
 * git's behaviour and not on the machine's git configuration.
 *
 * Both entries are answers to a wrong result rather than to a crash, which is why they are set
 * centrally: neither is something the next spec to shell out to git would remember to do, and one of
 * the files each protects may not be edited from the spec that needs it.
 *
 * **`core.hooksPath`.** A developer whose global config points it at a lint runner or a "no WIP
 * commits" check gets that hook fired inside every throwaway repository this suite creates, and
 * every `commit()` helper here reports it as `git commit failed`. Measured: 175 tests across 12
 * files, which is most of the suite going red at once for something no test touches. The override is
 * appended to whatever `GIT_CONFIG_COUNT` chain is already in the environment rather than replacing
 * it, so it wins over the global config, over the system config, over a repository's local config
 * and over an earlier entry in that same chain, and takes nothing else away. The path it names does
 * not exist, which is how git is told a directory holds no hooks.
 *
 * **`GIT_CEILING_DIRECTORIES`.** git walks *up* looking for a repository, so a `$TMPDIR` that itself
 * sits inside a checkout (`TMPDIR=$HOME/tmp` with a dotfiles repo at `$HOME` is the common one)
 * hands every `mkdtempSync` directory in this suite a real sha. Measured: 3 tests fail outright and
 * several more pass for a reason they do not state. The ceiling stops the walk at the temp root, so
 * a throwaway directory is outside every work tree the way the specs that use one say it is. It
 * stops the walk *above* the listed directory, so a temp repository the suite creates itself is
 * still found; git resolves symlinks in these entries by default, so a `$TMPDIR` behind one (macOS)
 * matches too. An existing value is kept after ours rather than dropped.
 *
 * Neither is a substitute for the other: hooks fire from config no matter where the repository is,
 * and discovery walks up no matter what the hooks say.
 */
function gitEnvironment(): Record<string, string> {
  const declared = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "", 10);
  const next = Number.isInteger(declared) && declared > 0 ? declared : 0;
  const ceilings = [tmpdir(), process.env.GIT_CEILING_DIRECTORIES].filter(
    (entry): entry is string => entry !== undefined && entry !== "",
  );

  return {
    GIT_CONFIG_COUNT: String(next + 1),
    [`GIT_CONFIG_KEY_${next}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${next}`]: join(tmpdir(), "empo-tests-no-git-hooks"),
    GIT_CEILING_DIRECTORIES: ceilings.join(":"),
  };
}

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    environment: "node",
    env: gitEnvironment(),
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
