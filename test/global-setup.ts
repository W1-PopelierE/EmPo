import { fileURLToPath } from "node:url";
import { indexCommand } from "../src/commands/index";
import { EmpoError } from "../src/errors";

/**
 * Builds the acme fixture's generated graph once, before any test file runs.
 *
 * Twelve test files copy fixtures/acme-platform, and four of them read .empo/generated/graph.json
 * out of their copy: commands/doctor, commands/hook, engine/health and engine/proposal. The root
 * .gitignore ignores every .empo/generated directory, so that artifact is untracked and does not
 * exist in a fresh clone. It was only there on a developer's machine because some earlier local run
 * happened to leave it behind, and inheriting it failed two different ways. Absent, 59 tests across
 * those four files fail, every one of them on a graph.json that is not there. Left over from before
 * the php pack moved to 1.2.0, 8 tests fail across commands/doctor, commands/hook and engine/health,
 * because the pack-drift check correctly reports drift against a stale artifact where those specs
 * assert none. Both counts are measured rather than remembered: delete the artifact, or rewrite the
 * php version it records, and run each of the twelve files with this global setup taken out of the
 * config.
 *
 * The other eight files that copy the fixture survive either state, and none of the three ways they
 * do it generalises to a file somebody adds next. commands/index, commands/query, commands/review
 * and engine/scaffold delete .empo/generated from their copy and reindex it. commands/init deletes
 * the whole .empo and has `empo init` build its own. commands/check deletes it and never reindexes,
 * because the gate it tests reads the spines and the staged diff rather than the graph, and
 * commands/update and commands/verify inherit the copy and never look at the graph in it.
 *
 * This is one central build rather than four more copies of the defensive delete and reindex,
 * because the defence has to be remembered by every test file that is ever added and this does not.
 * It also fixes the second failure by construction: the graph is rebuilt from the packs as they
 * exist in this working tree, so a future pack version bump cannot leave a stale artifact behind to
 * break a suite that has nothing to do with packs.
 *
 * It calls the real `indexCommand`, the same entry point `empo index` runs, so the fixture is left
 * in exactly the state a developer running that command by hand would produce. Nothing is deleted:
 * indexing overwrites both files it owns, which makes this safe to run on every suite.
 */

const fixture = fileURLToPath(new URL("../fixtures/acme-platform", import.meta.url));

export function setup(): void {
  // Indexing prints a report meant for a person at a terminal, and a dozen lines of it before every
  // test run is noise. Dropped rather than held: this capture used to keep the lines so a failure
  // could quote them, and that report is empty for every failure that reaches the catch below.
  // `indexCommand` runs loadConfig, buildGraph and serializeGraph before its first console.log
  // (src/commands/index.ts), so a missing or invalid config, a pack that will not load and a build
  // that throws all fail with nothing printed yet. Quoting an empty list said nothing and implied
  // there had been output worth reading.
  const log = console.log;
  console.log = () => {};

  try {
    indexCommand(fixture);
  } catch (error) {
    // Failing here is worth a loud, self-explaining stop. The alternative is every fixture-copying
    // spec failing later with "No graph found", which points at the tests rather than at this.
    //
    // The error's own words are what carries the diagnosis, and for a EmpoError that means its
    // details as well as its message. Those are where the actionable half lives: "No EmPo config
    // found" does not say where it looked, and "config is not a valid EmPo config" does not name the
    // field, while the details of both do (engine/config.ts). `cause` is kept for the stack, which
    // is the only thing left that this message does not already say.
    const details = error instanceof EmpoError ? error.details : [];
    throw new Error(
      [
        `Could not build the test fixture graph in ${fixture}.`,
        "The suite indexes it once up front, because .empo/generated is gitignored and so is",
        "absent in a fresh clone. Until this succeeds, every spec that copies the fixture fails.",
        `${(error as Error).message}`,
        ...details,
      ].join("\n"),
      { cause: error },
    );
  } finally {
    console.log = log;
  }
}
