import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  doctorCommand,
  flowLine,
  forgeLine,
  hookLine,
  trackerLine,
} from "../../src/commands/doctor";
import { hookAnswer } from "../../src/commands/hook";
import { run } from "../../src/engine/git";
import { GRAPH_SCHEMA } from "../../src/engine/graph";
import type { ForgeHealth, Health, HookReport, TrackerHealth } from "../../src/engine/health";
import { healthReport } from "../../src/engine/health";
import { loadPack } from "../../src/engine/pack-loader";
import { EmpoError } from "../../src/errors";
import type { Graph } from "../../src/schema/types";

/**
 * `empo doctor`'s two renderers over one computation. Nothing here checks a fact: the facts are
 * pinned in test/engine/health.test.ts, and this file pins the surfaces.
 *
 * The prose half is asserted line for line rather than by fragment, because that block is the whole
 * interface for the person deciding whether to trust an answer, and splitting the command into a
 * computation and a renderer is exactly the kind of change that reworks a sentence by accident.
 *
 * The `--json` half exists for the SessionStart hook in docs/10-distribution.md, and its one rule is
 * that stdout holds exactly one document and nothing else. `empo check` once printed a valid
 * document followed by three lines of plain text, so it parsed as nothing at all at the moment a
 * machine reader most needed the answer, and it got in because one test pinned `--json`, another
 * pinned the failing path, and nothing pinned the two together. The last describe below is that
 * missing test: every case runs `--json` on a doctor that also exits 2.
 */

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

const GRAPH_PATH = ".empo/generated/graph.json";
const SPINES_DIR = ".empo/spines";
const CONFIG_PATH = ".empo/config.json";
const ROUTES_FILE = "apps/api/routes/api.php";
const CALCULATOR_FILE = "apps/api/app/Libraries/Price/PriceCalculator.php";

/** Hop 0's anchor, destroyed below to drift the fixture spine. */
const ROUTE_ANCHOR = "Route::post('/v1/orders'";

/**
 * The php pack as installed, read rather than written down: the drift line prints the version this
 * binary would load, and a literal here would be a sentence that was true until the next bump, which
 * is the exact class of stale answer the drift line exists to announce.
 */
const PHP_INSTALLED = loadPack("php").version;

/** A version no pack will carry, so the graph below is unambiguously built by an older one. */
const PHP_BEFORE = "0.0.1-before";

/**
 * The one case that builds a real checkout spawns git several times over. The 5s default is a limit
 * on a machine doing nothing else, and it does not get slower because something is wrong.
 */
const GIT_TIMEOUT = 30_000;

/** As much of the SessionStart answer as the one cross-surface test below reads. */
interface HookAnswer {
  hookSpecificOutput?: { additionalContext?: string };
}

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Recorded {
  /** One entry per console.log call, so "exactly one document" is a length and not a guess. */
  lines: string[];
  thrown: unknown;
}

function record(body: () => void): Recorded {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });

  let thrown: unknown;
  try {
    body();
  } catch (error) {
    thrown = error;
  } finally {
    log.mockRestore();
  }

  return { lines, thrown };
}

/** Everything the command printed, as the lines a terminal would show. */
function capture(body: () => void): string[] {
  const { lines, thrown } = record(body);
  if (thrown !== undefined) throw thrown;
  return lines.join("\n").split("\n");
}

/**
 * doctor prints its whole report and then fails, so a test that only caught the error would be blind
 * to the part that is read. Both halves come back from one run.
 */
function expectExit(exitCode: number, body: () => void): Recorded {
  const recorded = record(body);
  expect(recorded.thrown, `expected a EmpoError with exit code ${exitCode}`).toBeInstanceOf(
    EmpoError,
  );
  expect((recorded.thrown as EmpoError).exitCode).toBe(exitCode);
  return recorded;
}

function copyFixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "empo-doctor-"));
  cpSync(fixture, repo, { recursive: true });
  temps.push(repo);
  return repo;
}

function git(repo: string, args: string[]): string {
  const result = run(repo, "git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * A fixture copy that really is a checkout, with the graph repointed at its one commit, so the graph
 * line reads "current with HEAD" instead of the unknown distance every other test here gets.
 *
 * `copyFixture` is a directory and not a checkout, which is the cheapest way to reach the unknown
 * distance and is what nearly everything below wants. The drift cases are the exception: the whole
 * claim a drift line makes is that the age above it can be right and still not be the whole answer,
 * and under "distance from HEAD unknown" that claim is never actually made. The `-c` flags are so
 * this passes with no git identity and no signing key configured.
 */
function gitFixture(): { repo: string; head: string } {
  const repo = copyFixture();
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["add", "-A", "-f"]);
  git(repo, [
    "-c",
    "user.email=empo@example.com",
    "-c",
    "user.name=EmPo Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "the fixture",
  ]);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();

  // The graph on disk names a sha of *this* repository, which the throwaway knows nothing about, so
  // leaving it alone would only ever produce the unknown distance again.
  rewriteGraph(repo, (graph) => {
    graph.builtAgainst = head;
  });

  return { repo, head };
}

function graphOnDisk(repo: string): Graph {
  return JSON.parse(readFileSync(join(repo, GRAPH_PATH), "utf8")) as Graph;
}

function linesOf(repo: string, path: string): string[] {
  return readFileSync(join(repo, path), "utf8").split("\n");
}

/** The graph on disk, edited in place: the drift cases are a change to its recorded `packs`. */
function rewriteGraph(repo: string, change: (graph: Graph) => void): void {
  const path = join(repo, GRAPH_PATH);
  const graph = JSON.parse(readFileSync(path, "utf8")) as Graph;
  change(graph);
  writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`);
}

function rewriteConfig(repo: string, change: (config: Record<string, unknown>) => void): void {
  const path = join(repo, CONFIG_PATH);
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  change(config);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * A hook command nothing on any machine can satisfy: an absolute path under a directory that does
 * not exist, so no PATH entry and no local install of empo can accidentally answer for it, and the
 * shell reports 127 immediately. It still ends in `empo hook `, which is what makes the entry EmPo's
 * as far as `wiredHooks` is concerned (src/host/claude.ts).
 */
const MISSING_HOOK_COMMAND = "/empo-no-such-directory-4f21c/bin/empo hook session-start";

/**
 * One SessionStart entry wired the way `empo update` writes them, with the command the caller wants
 * probed. The timeout is short on purpose, so a machine that somehow does resolve a path meant to be
 * unresolvable still fails this fast rather than holding the suite for the host's ten second default.
 */
function wireHook(repo: string, command: string): void {
  mkdirSync(join(repo, ".claude"), { recursive: true });
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command, timeout: 5 }] }],
    },
  };
  writeFileSync(join(repo, ".claude/settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

/** The fixture with one real, wired, unrunnable hook: what a broken installation looks like. */
function wireMissingHook(repo: string): void {
  wireHook(repo, MISSING_HOOK_COMMAND);
}

/** Destroy hop 0's anchor, which drifts the fixture spine by one hard citation. */
function breakRoute(repo: string): void {
  const routes = linesOf(repo, ROUTES_FILE);
  const index = routes.findIndex((line) => line.includes(ROUTE_ANCHOR));
  expect(index, `no line of ${ROUTES_FILE} contains "${ROUTE_ANCHOR}"`).toBeGreaterThanOrEqual(0);
  routes[index] = "// the route that was here is gone";
  writeFileSync(join(repo, ROUTES_FILE), routes.join("\n"));
}

describe("doctor prose", () => {
  test("the whole report on a healthy repository, line for line", () => {
    const repo = copyFixture();
    const graph = graphOnDisk(repo);

    const lines = capture(() => {
      doctorCommand(repo);
    });

    // The copy is not a checkout, so the distance is unknown. Every other value is read back out of
    // the artifacts rather than written here.
    //
    // The absence of a `drift` line under the graph line is part of what this pins: the list is
    // exact, so a drift line printed on a healthy repository fails here. It is healthy because the
    // fixture graph records the pack versions installed beside it, and a red on the graph line's
    // neighbour means that stopped being true, so regenerate the fixture, do not delete the line.
    //
    // The two adapter lines are here because the fixture config declares no `adapters` section, and
    // that is the state they exist to say out loud: a repository reviewing its local diff and
    // grading no ticket-fit used to look identical to one whose adapters were working. Neither is a
    // finding, so this healthy report is the only place either state is ever stated, and both are
    // deterministic on any machine precisely because there is no configured adapter to probe for.
    expect(lines).toEqual([
      "",
      `config     ${join(repo, CONFIG_PATH)}`,
      "roots      apps/api (php), apps/mobile (typescript), apps/portal (typescript)",
      "packs      php, typescript",
      "bridges    2",
      "forge      not configured, so empo review reads the local diff",
      "tracker    not configured, so empo review grades no ticket-fit",
      // The fixture has no `.claude/` at all, so this is the none state, and it is here for the
      // reason the two adapter lines are: nothing else in a clean report mentions the hooks, and a
      // repository whose every hook is broken used to print exactly this same block. Nothing is
      // spawned to produce this line, because there is nothing wired to spawn.
      "hooks      none wired, so no session runs empo",
      "spines     1, 7 citations, every anchor resolves",
      `graph      built against ${graph.builtAgainst.slice(0, 7)}, distance from HEAD unknown, ${graph.stats.nodes} nodes, ${graph.stats.edges} edges`,
      // The fixture curates three flows over 15 non-test files and leaves 5 of them out: the route
      // file, the service provider, and three components no journey names. Stated as a fact and not
      // as a warning, which is the whole design (engine/health.ts), so the report still closes OK.
      "flows      3 defined, 5 of 15 non-test files claimed by none",
      // One line per family that read a bare name, and the denominator on both of them though
      // neither refused anything. That is the point of the block rather than an oversight: a family
      // reporting "0 of 53 resolved" and one reporting "41 of 41" are opposite results, and the
      // total is what separates them, so a number that only appeared in the bad case would be a
      // number nobody had learned to look for by the time it mattered. This fixture is clean, so it
      // is also the pin on what a clean one looks like: no refusal clauses, no names line under it.
      "names      hook     2 of 2 resolved",
      "names      template 1 of 1 resolved",
      "",
      "join http-route  2/3 consumed keys matched against 4 produced",
      '       no producer declares "GET v1/loyalty/points"',
      "join inertia-page  1/1 consumed keys matched against 1 produced",
      // The php pack's own join, run and matched nothing, because this fixture schedules nothing.
      // Printed anyway: a join that ran and found none is a different answer from one nobody ran,
      // which is the distinction every axis in this report keeps.
      "join scheduled-command  0/0 consumed keys matched against 0 produced",
      "",
      "OK  config is valid",
    ]);
  });

  test("no graph: the bridge block goes with it, since there is nothing to measure against", () => {
    const repo = copyFixture();
    rmSync(join(repo, ".empo/generated"), { recursive: true, force: true });

    const lines = capture(() => {
      doctorCommand(repo);
    });

    expect(lines).toContain("graph      not built yet (run empo index)");
    // The configured count still says there are bridges. What is gone is the match rate.
    expect(lines).toContain("bridges    2");
    expect(lines.some((line) => line.startsWith("join http-route"))).toBe(false);
    expect(lines.some((line) => line.startsWith("join inertia-page"))).toBe(false);
    // The flow count reads the graph, so with no graph it says so. It must never print a zero here:
    // "0 of 0 non-test files claimed by none" is the best possible answer over no data at all.
    expect(lines).toContain("flows      unknown until the graph is built");
    expect(lines.some((line) => line.startsWith("flows      0 defined"))).toBe(false);
  });

  test("the flow count sits under the graph line, which is what explains its unknown", () => {
    // Placement is the whole reason the unknown can be one short line: the state and the remedy are
    // already on the line above it. Asserted as an index pair rather than as membership, because a
    // line that drifts to the top of the block reads as an unknown with no reason given.
    const repo = copyFixture();
    rmSync(join(repo, ".empo/generated"), { recursive: true, force: true });

    const lines = capture(() => {
      doctorCommand(repo);
    });
    const graphAt = lines.indexOf("graph      not built yet (run empo index)");

    expect(graphAt).toBeGreaterThan(-1);
    expect(lines[graphAt + 1]).toBe("flows      unknown until the graph is built");
  });

  test("an unreadable graph is one line, not a failed command", () => {
    const repo = copyFixture();
    writeFileSync(join(repo, GRAPH_PATH), "{ this is not a graph\n");

    const lines = capture(() => {
      doctorCommand(repo);
    });

    expect(lines).toContain("graph      unreadable (run empo index to rebuild it)");
    expect(lines).toContain("flows      unknown until the graph is built");
    expect(lines).toContain("OK  config is valid");
  });

  test("valid JSON that is not a graph reads the same way, and does not crash the command", () => {
    const repo = copyFixture();
    writeFileSync(join(repo, GRAPH_PATH), "[]\n");

    const lines = capture(() => {
      doctorCommand(repo);
    });

    expect(lines).toContain("graph      unreadable (run empo index to rebuild it)");
    expect(lines).toContain("OK  config is valid");
  });

  test("no spines directory reads as none under the configured path", () => {
    const repo = copyFixture();
    rmSync(join(repo, SPINES_DIR), { recursive: true, force: true });

    expect(
      capture(() => {
        doctorCommand(repo);
      }),
    ).toContain("spines     none under .empo/spines");
  });

  test("a spine that will not parse reads as unreadable and exits 2", () => {
    const repo = copyFixture();
    writeFileSync(join(repo, SPINES_DIR, "pricing.json"), '{ "name": \n');

    const { lines } = expectExit(2, () => {
      doctorCommand(repo);
    });
    const printed = lines.join("\n").split("\n");

    expect(printed).toContain("spines     unreadable under .empo/spines");
    expect(printed.some((line) => line.startsWith("ERROR  "))).toBe(true);
    // Nothing claims the config is valid after an error.
    expect(printed.some((line) => line.includes("OK  config is valid"))).toBe(false);
  });

  test("a drifted spine says how far and names the command that repairs it", () => {
    const repo = copyFixture();
    breakRoute(repo);

    const lines = capture(() => {
      doctorCommand(repo);
    });

    expect(lines).toContain("spines     1, 7 citations, 1 drifted (run empo verify)");
    expect(lines).toContain('warn   spine "pricing" has drifted: 0 soft, 1 hard. Run empo verify.');
    // Drift is never an error here: `empo verify` is the command that exits 1 on it.
    expect(lines).toContain("OK  config is valid");
  });

  test("the OK line is separated from the findings, and closes the report when there are none", () => {
    const clean = copyFixture();
    const cleanLines = capture(() => {
      doctorCommand(clean);
    });

    const warned = copyFixture();
    breakRoute(warned);
    const warnedLines = capture(() => {
      doctorCommand(warned);
    });

    // With nothing to report the block above it is the last thing printed, and the OK follows it.
    expect(cleanLines.slice(-2)).toEqual(["", "OK  config is valid"]);
    expect(cleanLines.some((line) => line.startsWith("warn "))).toBe(false);

    // With something to report, the blank line comes between the last finding and the OK.
    expect(warnedLines.slice(-3)).toEqual([
      'warn   spine "pricing" has drifted: 0 soft, 1 hard. Run empo verify.',
      "",
      "OK  config is valid",
    ]);
  });

  test(
    "a moved pack prints a drift line under a graph line that says the graph is current",
    () => {
      // A real checkout, not the usual copy, and that is the whole point of this case. The claim the
      // drift line makes is that the age above it can be right and still not be the answer, and
      // under "distance from HEAD unknown" that claim is never made: the reader was already being
      // told the age was unknown. Here git says current with HEAD and is right, and the graph is
      // stale anyway, because a pack is data and moves without a tracked file moving.
      const { repo, head } = gitFixture();
      rewriteGraph(repo, (graph) => {
        graph.packs.php = PHP_BEFORE;
      });

      const lines = capture(() => {
        doctorCommand(repo);
      });

      expect(PHP_BEFORE).not.toBe(PHP_INSTALLED);
      const graphLine = lines.findIndex((line) => line.startsWith("graph      "));
      const graph = graphOnDisk(repo);

      // The two lines as a pair, in order, so neither the pairing nor either sentence can move
      // without this failing.
      expect(lines.slice(graphLine, graphLine + 2)).toEqual([
        `graph      built against ${head.slice(0, 7)}, current with HEAD, ${graph.stats.nodes} nodes, ${graph.stats.edges} edges`,
        `drift      graph built with php pack ${PHP_BEFORE}, ${PHP_INSTALLED} is installed (run empo index)`,
      ]);
    },
    GIT_TIMEOUT,
  );

  test("a graph an older empo wrote prints its own drift line, naming both schemas", () => {
    // The drift no pack version can record either: a TypeScript-only repository has one pack, so a
    // graph whose fields changed meaning under it had nothing at all to announce itself with.
    const repo = copyFixture();
    rewriteGraph(repo, (graph) => {
      graph.schema = 1;
    });

    const lines = capture(() => {
      doctorCommand(repo);
    });

    expect(lines).toContain(
      `drift      graph was written at schema 1, this empo writes schema ${GRAPH_SCHEMA} (run empo index)`,
    );
    // A stale graph is not a broken config, so doctor still closes with the OK line and exits 0.
    expect(lines).toContain("OK  config is valid");
  });

  test("the hook opens its drift note with the same clause this line prints", () => {
    // The two surfaces describe one state and only this clause is shared between them: doctor
    // closes it with "(run empo index)" inside the fixed-width column, the hook follows it with the
    // consequence and leaves the repair to the end of its note list. They are kept in step by hand,
    // and the last time the tails were edited the hook's grew a claim about which pack was older
    // that doctor never made and the data never carried. The schema clause beside it no longer has
    // this problem: both surfaces read it from `schemaDriftClause` in engine/graph.ts, which is where
    // this one belongs too. Until it moves there, this is what notices the two parting.
    const repo = copyFixture();
    rewriteGraph(repo, (graph) => {
      graph.packs.php = PHP_BEFORE;
    });
    const shared = `graph built with php pack ${PHP_BEFORE}, ${PHP_INSTALLED} is installed`;

    const lines = capture(() => {
      doctorCommand(repo);
    });
    const hooked = JSON.parse(
      hookAnswer("session-start", { cwd: repo }, { repo }) ?? "null",
    ) as HookAnswer;

    expect(lines).toContain(`drift      ${shared} (run empo index)`);
    expect(hooked.hookSpecificOutput?.additionalContext ?? "").toContain(`- ${shared}, so `);
  });

  test("a graph that never recorded a pack version says that, instead of naming one", () => {
    const repo = copyFixture();
    rewriteGraph(repo, (graph) => {
      graph.packs.php = null as unknown as string;
    });

    const lines = capture(() => {
      doctorCommand(repo);
    });

    // The one sentence the drift line has for an unknown. Printing "built with php pack undefined",
    // or picking a plausible version, would be the same stale answer in a more confident voice.
    expect(lines).toContain(
      `drift      graph does not record which php pack built it, ${PHP_INSTALLED} is installed (run empo index)`,
    );
  });

  test("a root that points nowhere prints an ERROR line and exits 2", () => {
    const repo = copyFixture();
    rewriteConfig(repo, (config) => {
      (config.roots as { path: string; lang: string }[]).push({ path: "apps/web", lang: "php" });
    });

    const { lines } = expectExit(2, () => {
      doctorCommand(repo);
    });

    expect(lines.join("\n").split("\n")).toContain(
      'ERROR  root "apps/web" points at a directory that does not exist',
    );
  });
});

/**
 * The two adapter lines, pinned through the renderers rather than through the command.
 *
 * `forgeLine` and `trackerLine` are exported for exactly this: two of their clauses are answers
 * about the machine the suite is running on ("gh on PATH", "origin is ..."), so a case that could
 * only reach them through `doctorCommand` would assert whether this developer happens to have `gh`
 * installed and whether a temp directory has an origin remote. Those cases are here, and the one
 * end-to-end case below is restricted to the states no probe can answer differently.
 *
 * The wording is pinned whole, not by fragment. These lines are the entire interface for somebody
 * asking why their review never graded a ticket, and every one of them ends in the consequence
 * rather than the state, because "tracker none" alone answers nothing for the reader who came with
 * that question.
 */
describe("doctor adapter lines", () => {
  /** A forge with everything absent, so each case below states only what it is about. */
  const noForge: ForgeHealth = { kind: null, host: null, slug: null, cli: null, remote: null };
  const noTracker: TrackerHealth = { kind: null, host: null, project: null, cli: null };

  test("a forge nobody configured says so, and says what happens instead", () => {
    expect(forgeLine(noForge)).toBe(
      "forge      not configured, so empo review reads the local diff",
    );
  });

  test("local is printed apart from not configured, though both read the local diff", () => {
    // The distinction the whole field exists for: one is a silence, which is also what a misspelled
    // `adapters` section leaves behind, and the other is somebody stating that there is no host.
    expect(forgeLine({ ...noForge, kind: "local" })).toBe(
      "forge      local, so empo review reads the local diff",
    );
  });

  test("a github forge whose origin agrees is one line: the slug, the CLI and the agreement", () => {
    expect(
      forgeLine({
        kind: "github",
        host: null,
        slug: "acme/platform",
        cli: { command: "gh", present: true },
        remote: { kind: "github", host: null, slug: "acme/platform", recognized: true },
      }),
    ).toBe("forge      github acme/platform, gh on PATH, origin agrees");
  });

  test("a github forge missing its CLI on a bitbucket origin states both problems in order", () => {
    // Both clauses on one line, and the remote named by its host rather than by its kind: "origin is
    // mcp acme/platform" would answer a question about a git remote with EmPo's own word for a host
    // it cannot reach.
    expect(
      forgeLine({
        kind: "github",
        host: null,
        slug: "acme/platform",
        cli: { command: "gh", present: false },
        remote: { kind: "mcp", host: "bitbucket", slug: "acme/platform", recognized: true },
      }),
    ).toBe("forge      github acme/platform, gh not on PATH, origin is bitbucket acme/platform");
  });

  test("an origin the report may not warn about is still printed beside the configured forge", () => {
    // `recognized: false` is a host detection only repeated back, and it is what a GitHub Enterprise
    // install and a proxied checkout both look like from here, so engine/health.ts raises no finding
    // on it. The renderer must not follow it into silence: a fact nobody warns about is exactly the
    // one the reader has to be shown, because nothing else in the report will mention it.
    expect(
      forgeLine({
        kind: "github",
        host: null,
        slug: "acme/platform",
        cli: { command: "gh", present: true },
        remote: { kind: "mcp", host: "github.acme.com", slug: "acme/platform", recognized: false },
      }),
    ).toBe("forge      github acme/platform, gh on PATH, origin is github.acme.com acme/platform");
  });

  test("an mcp forge names its host, needs no CLI, and stays silent about an unread origin", () => {
    // Three absences at once. `mcp` shells out to nothing, so there is no CLI clause; and the origin
    // clause is silent where git could not answer, because "origin agrees" about a remote nothing
    // read is the invented reassurance the whole block refuses.
    expect(
      forgeLine({ kind: "mcp", host: "bitbucket", slug: "acme/platform", cli: null, remote: null }),
    ).toBe("forge      mcp (bitbucket) acme/platform");
  });

  test("a tracker nobody configured says ticket-fit is graded by nobody", () => {
    expect(trackerLine(noTracker)).toBe(
      "tracker    not configured, so empo review grades no ticket-fit",
    );
  });

  test("tracker none reads as a decision, with the same consequence spelled out", () => {
    expect(trackerLine({ ...noTracker, kind: "none" })).toBe(
      "tracker    none, so empo review grades no ticket-fit",
    );
  });

  test("an mcp tracker names its host and its project, and no command", () => {
    expect(trackerLine({ kind: "mcp", host: "jira", project: "ACME", cli: null })).toBe(
      "tracker    mcp (jira), project ACME",
    );
  });

  test("a github-issues tracker names its project and whether the CLI it needs is there", () => {
    expect(
      trackerLine({
        kind: "github-issues",
        host: null,
        project: "acme/platform",
        cli: { command: "gh", present: true },
      }),
    ).toBe("tracker    github-issues, project acme/platform, gh on PATH");
  });

  test("the command prints both lines for a config that states no host and no tracker", () => {
    // The one end-to-end case, and it is deliberately the pair of states that reach no probe at all.
    // `doctorCommand` builds its report with the real `systemProbes`, so a case with a `github`
    // forge here would print "gh on PATH" or "gh not on PATH" depending on the machine, and would
    // ask git for an origin the temp directory does not have. `local` and `none` are the two the
    // engine answers without asking anything, so this is the same on every machine.
    const repo = copyFixture();
    rewriteConfig(repo, (config) => {
      config.adapters = { forge: { kind: "local" }, tracker: { kind: "none" } };
    });

    const lines = capture(() => {
      doctorCommand(repo);
    });

    expect(lines).toContain("forge      local, so empo review reads the local diff");
    expect(lines).toContain("tracker    none, so empo review grades no ticket-fit");
    // A configured adapter is not a finding, so the report still closes with the OK line.
    expect(lines).toContain("OK  config is valid");
  });
});

/**
 * The flow-coverage line, pinned through its renderer for the reason the adapter lines are: the
 * states worth reading are the unknown and the singular, and neither is reachable from the fixture.
 *
 * What it says is a fact and never a warning (engine/health.ts argues why), so the wording carries
 * no remedy and no verdict. It names the denominator instead, which is the rule `--blind` settled:
 * 5 unclaimed files out of 15 and out of 900 are different repositories.
 */
describe("doctor flow line", () => {
  test("the counts, with the denominator the unclaimed number is out of", () => {
    expect(flowLine({ defined: 8, files: 61, unclaimed: 7 })).toBe(
      "flows      8 defined, 7 of 61 non-test files claimed by none",
    );
  });

  test("one file is a file", () => {
    expect(flowLine({ defined: 1, files: 1, unclaimed: 1 })).toBe(
      "flows      1 defined, 1 of 1 non-test file claimed by none",
    );
  });

  test("a repository whose flows claim everything says zero, and that zero is earned", () => {
    expect(flowLine({ defined: 4, files: 20, unclaimed: 0 })).toBe(
      "flows      4 defined, 0 of 20 non-test files claimed by none",
    );
  });

  test("a repository that curates no flow at all reads as every file unclaimed", () => {
    expect(flowLine({ defined: 0, files: 20, unclaimed: 20 })).toBe(
      "flows      0 defined, 20 of 20 non-test files claimed by none",
    );
  });

  test("unknown is a sentence and never a zero", () => {
    // The one state that must not read as good news. Every field is null together, and each is
    // tested, because the type a `--json` reader parses permits them to differ.
    expect(flowLine({ defined: null, files: null, unclaimed: null })).toBe(
      "flows      unknown until the graph is built",
    );
    expect(flowLine({ defined: 2, files: null, unclaimed: null })).toBe(
      "flows      unknown until the graph is built",
    );
    expect(flowLine({ defined: 2, files: 10, unclaimed: null })).toBe(
      "flows      unknown until the graph is built",
    );
  });
});

/**
 * The hook line, pinned through its renderer for the reason the adapter lines are: every probed
 * state below is the result of really spawning a wired command, so a case that could only reach it
 * through `doctorCommand` would assert what this developer happens to have installed.
 *
 * What it must never do is restate a finding. Each broken hook already gets a warn line naming its
 * event, its command and its repair, so this line counts instead, and the count is the half the
 * findings cannot give: 2 warn lines are a mostly-working wiring at 2 of 9 and a repository
 * enforcing nothing at 2 of 2, and nothing else printed tells the two apart.
 */
describe("doctor hook line", () => {
  /** One entry, only as far as the line reads it: the count and the per-hook state. */
  function ran(state: HookReport["state"]): HookReport {
    return {
      event: "SessionStart",
      matcher: null,
      command: "empo hook session-start",
      state,
      exitCode: state === "ok" ? 0 : 127,
    };
  }

  test("no hook wired is a plain fact, with no command to run and nothing to fix", () => {
    // A Codex-only repository wires none of these and neither does one where `empo init` never ran,
    // so this states the consequence and stops. A remedy here would scold somebody for a choice.
    expect(hookLine({ state: "none", hooks: [] })).toBe(
      "hooks      none wired, so no session runs empo",
    );
  });

  test("wired but not run never reads as verified", () => {
    // The state `commands/hook.ts` reaches through `quietProbes`, and the one that must never read
    // as good news: these entries were listed off disk and nothing was executed, so "ran clean"
    // about any of them would be the verified answer the whole block exists to stop anybody assuming.
    expect(hookLine({ state: "unprobed", hooks: [ran("unprobed"), ran("unprobed")] })).toBe(
      "hooks      2 wired, not run",
    );
  });

  test("every wired hook running clean says so without a second count, and no remedy", () => {
    expect(hookLine({ state: "probed", hooks: [ran("ok"), ran("ok"), ran("ok")] })).toBe(
      "hooks      3 wired, all ran clean",
    );
  });

  test("one broken hook keeps the clean count beside it, which is what makes it readable", () => {
    // "1 broken" alone answers nothing: the reader cannot tell one of two from one of nine, and
    // those are a repository half enforcing and a repository nearly fine. The break itself is named
    // in the warn line below, never here.
    expect(hookLine({ state: "probed", hooks: [ran("ok"), ran("not-found"), ran("ok")] })).toBe(
      "hooks      3 wired, 2 ran clean, 1 broken (named below)",
    );
  });

  test("several broken hooks are one count, however differently each one failed", () => {
    // A timeout, a non-zero exit and a command nobody could find, and the line stays a count: the
    // three repairs are different and each is spelled out in its own warn line, so naming them
    // here would print every one of them twice.
    expect(
      hookLine({
        state: "probed",
        hooks: [ran("timeout"), ran("ok"), ran("failed"), ran("not-found")],
      }),
    ).toBe("hooks      4 wired, 1 ran clean, 3 broken (named below)");
  });

  test("a wired hook whose command does not exist: the line, the warning, and exit 0", () => {
    // The bug this block was built for, end to end. The hook fails open by design, so before this
    // line the repository below printed a clean report and a closing OK while enforcing nothing.
    // Saying so is the fix; the exit code is not, and this pins both halves of that in one run.
    //
    // The command is an absolute path under a directory that does not exist, so no PATH entry and
    // no local install on any machine can accidentally satisfy it, and the shell answers 127 at once.
    const repo = copyFixture();
    wireMissingHook(repo);

    const printed = capture(() => {
      doctorCommand(repo);
    });

    expect(printed).toContain("hooks      1 wired, 0 ran clean, 1 broken (named below)");
    // The finding is what says which hook and how to repair it, and the line above never repeats it.
    expect(printed).toContain(
      `warn   hook SessionStart runs "${MISSING_HOOK_COMMAND}", and that command could not be ` +
        "found, so this hook fails open on every SessionStart and enforces nothing. Install empo " +
        "where the command names it (npm run install:local) or fix the command in " +
        ".claude/settings.json.",
    );
    // The closing line is back, and it is not a contradiction: the config is valid, and the warning
    // above it is about the wiring around the config rather than about the config.
    expect(printed.some((line) => line.includes("OK  config is valid"))).toBe(true);
  });

  test("a repository whose every wired hook is unfindable still exits 0, which is what CI runs", () => {
    // The regression this level exists for, in the shape CI actually hits: ci.yml runs the built
    // binary's `doctor` on a machine that deliberately has no `empo` on PATH, and one step strips
    // PATH to /usr/bin:/bin on purpose to prove the binary carries its own Node. Every wired hook is
    // unfindable there by construction, no agent session runs there at all, and an error-level hook
    // finding made both steps permanently red over a gate nothing on that machine was ever going to
    // fire. `capture` rethrows, so this fails loudly rather than quietly if doctor throws again.
    const repo = copyFixture();
    wireMissingHook(repo);

    const printed = capture(() => {
      doctorCommand(repo);
    });

    expect(printed.some((line) => line.startsWith("warn   hook SessionStart"))).toBe(true);
    expect(printed.some((line) => line.startsWith("ERROR"))).toBe(false);
  });
});

/**
 * `--skip-hooks`, which is the one flag on this command that is about trust rather than output.
 *
 * Every other line doctor prints is a file read. The hook line is not: it hands each wired `command`
 * string to a shell, and ownership of an entry is its shape (`empo hook `) rather than a signature,
 * so a checkout decides what `empo doctor` executes on the machine that runs it. That is documented
 * behaviour and the host would run the same string at the next SessionStart, so the flag is not a
 * fix for it; what the flag buys is the ordering, because doctor is the command reached for *before*
 * a session and against a clone nobody has read.
 *
 * So the marker case below pins the executing half as deliberately as the skipping half. A test that
 * only asserted the flag works would leave the surprising fact unpinned, and the surprising fact is
 * the whole reason the flag exists.
 */
describe("doctor --skip-hooks", () => {
  test("the wired hooks are listed and not run, with no finding and no failure", () => {
    // The same repository that prints "1 wired, 0 ran clean, 1 broken (named below)" and a warn line
    // without the flag, so the two cases differ in exactly one thing.
    const repo = copyFixture();
    wireMissingHook(repo);

    const printed = capture(() => {
      doctorCommand(repo, { skipHooks: true });
    });

    expect(printed).toContain("hooks      1 wired, not run");
    // Nothing was observed, so nothing may be reported about it in either direction: no warning
    // about a hook nobody ran, and no "ran clean" either.
    expect(printed.some((line) => line.includes("hook SessionStart"))).toBe(false);
    expect(printed.some((line) => line.startsWith("warn "))).toBe(false);
    expect(printed.some((line) => line.includes("OK  config is valid"))).toBe(true);
  });

  test("a wired hook that appends a side effect runs it, and only --skip-hooks stops it", () => {
    // The security case, end to end, and the reason the flag was added.
    //
    // The command starts with an absolute path under a directory that does not exist, so its first
    // half is 127 on every machine and no local install can answer for it, and then `;` continues to
    // a `touch` in the throwaway directory. It still begins with `empo hook `, which is the whole of
    // the ownership test in src/host/claude.ts, so `wiredHooks` reports it as one of ours and doctor
    // hands the entire line to a shell.
    //
    // The first assertion pins behaviour nobody should be surprised by later: doctor really does
    // execute what the checkout says, and the marker is the proof. The second is the flag.
    const repo = copyFixture();
    const marker = join(repo, "doctor-executed-this.marker");
    wireHook(repo, `${MISSING_HOOK_COMMAND}; touch ${JSON.stringify(marker)}`);

    capture(() => {
      doctorCommand(repo);
    });
    expect(existsSync(marker), "doctor did not run the wired hook command").toBe(true);

    rmSync(marker);
    const printed = capture(() => {
      doctorCommand(repo, { skipHooks: true });
    });

    expect(existsSync(marker), "--skip-hooks ran the wired hook command anyway").toBe(false);
    expect(printed).toContain("hooks      1 wired, not run");
  });

  test("--skip-hooks under --json is still one document, and it says unprobed", () => {
    // The rule the whole `--json` surface has: exactly one document on stdout. A flag that changed
    // which probes run must not change that, and the state a machine reader parses is the same
    // "unprobed" the SessionStart hook already produces, not a new word for it.
    const repo = copyFixture();
    wireMissingHook(repo);

    const { lines, thrown } = record(() => {
      doctorCommand(repo, { json: true, skipHooks: true });
    });

    expect(thrown).toBeUndefined();
    expect(lines).toHaveLength(1);
    const health = JSON.parse(lines[0] ?? "") as Health;
    expect(health.hooks.state).toBe("unprobed");
    expect(health.hooks.hooks.map((hook) => hook.state)).toEqual(["unprobed"]);
    expect(health.findings).toEqual([]);
  });
});

describe("doctor --json", () => {
  test("stdout is exactly one document, and it is the health report", () => {
    const repo = copyFixture();

    const { lines, thrown } = record(() => {
      doctorCommand(repo, { json: true });
    });

    expect(thrown).toBeUndefined();
    // One console.log call, so nothing was printed before or after it. A fragment match would miss
    // a stray line; a length of one cannot.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(JSON.parse(JSON.stringify(healthReport(repo))));
  });

  test("no prose leaks in on any of the branches that print one", () => {
    const repos = [copyFixture(), copyFixture(), copyFixture(), copyFixture()];
    rmSync(join(repos[1] ?? "", ".empo/generated"), { recursive: true, force: true });
    rmSync(join(repos[2] ?? "", SPINES_DIR), { recursive: true, force: true });
    breakRoute(repos[3] ?? "");

    for (const repo of repos) {
      const { lines, thrown } = record(() => {
        doctorCommand(repo, { json: true });
      });

      expect(thrown).toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(() => JSON.parse(lines[0] ?? "")).not.toThrow();
    }
  });

  test("the document carries the adapters block, keys and all", () => {
    // The SessionStart hook and anything else machine-side reads this document and never the prose,
    // so a block that only the renderer knew about would be a fact the two surfaces disagree on.
    // `local` and `none` again, so the answer does not depend on this machine's PATH or remotes.
    const repo = copyFixture();
    rewriteConfig(repo, (config) => {
      config.adapters = { forge: { kind: "local" }, tracker: { kind: "none" } };
    });

    const { lines } = record(() => {
      doctorCommand(repo, { json: true });
    });

    expect(lines).toHaveLength(1);
    const health = JSON.parse(lines[0] ?? "");
    // Every key present and every unknown an explicit null, so a reader can take a field without
    // testing whether it exists first. JSON keeps a null and drops an undefined, which is how a
    // field could reach the prose and never reach a hook.
    expect(health.adapters).toEqual({
      forge: { kind: "local", host: null, slug: null, cli: null, remote: null },
      tracker: { kind: "none", host: null, project: null, cli: null },
    });
  });

  test("the document carries the hooks block, whole, in the state that spawns nothing", () => {
    // The block a machine reader gets, and the fixture wires no hook, so this is the none state and
    // no subprocess runs to produce it. A key the renderer knew about and the document did not
    // would be a fact the two surfaces disagree on, which is what this and the adapters case above
    // exist to stop.
    const repo = copyFixture();

    const { lines, thrown } = record(() => {
      doctorCommand(repo, { json: true });
    });

    expect(thrown).toBeUndefined();
    expect(lines).toHaveLength(1);
    const health = JSON.parse(lines[0] ?? "");
    expect(health.hooks).toEqual({ state: "none", hooks: [] });
  });

  test("the flow counts reach the document, and the unknown reaches it as null", () => {
    // The hook and everything else machine-side reads this document and never the prose. A zero
    // here would say "every file belongs to a flow" about a repository nobody counted, and JSON
    // keeps a null while it drops an undefined, so the key has to be present in both states.
    const built = copyFixture();
    const graph = graphOnDisk(built);

    const withGraph = JSON.parse(
      record(() => {
        doctorCommand(built, { json: true });
      }).lines[0] ?? "",
    );
    expect(withGraph.flows).toEqual({
      defined: Object.keys(graph.flows).length,
      files: new Set(graph.nodes.filter((node) => !node.isTest).map((node) => node.file)).size,
      unclaimed: 5,
    });

    const bare = copyFixture();
    rmSync(join(bare, ".empo/generated"), { recursive: true, force: true });
    const withoutGraph = JSON.parse(
      record(() => {
        doctorCommand(bare, { json: true });
      }).lines[0] ?? "",
    );
    expect(withoutGraph.flows).toEqual({ defined: null, files: null, unclaimed: null });
    expect(Object.hasOwn(withoutGraph.flows, "unclaimed")).toBe(true);
  });

  test("the warn branch and the closing OK line both stay out of the document", () => {
    const repo = copyFixture();
    mkdirSync(join(repo, "tools"), { recursive: true });
    writeFileSync(join(repo, "tools/release.sh"), "#!/bin/sh\n");

    const { lines } = record(() => {
      doctorCommand(repo, { json: true });
    });

    expect(lines).toHaveLength(1);
    const health = JSON.parse(lines[0] ?? "");
    expect(health.findings).toEqual([
      { level: "warn", message: 'directory "tools" is under no root, nothing in it is indexed' },
    ]);
    expect(lines[0]).not.toContain("OK  config is valid");
  });
});

/**
 * The pair the check defect got in through. `--json` and the failing path are asserted together in
 * every case here, because each one alone passes against a command that prints a document and then
 * three lines of plain text after it.
 */
describe("doctor --json when it also exits 2", () => {
  test("a bad root: exit 2, and stdout is still one parseable document", () => {
    const repo = copyFixture();
    rewriteConfig(repo, (config) => {
      (config.roots as { path: string; lang: string }[]).push({ path: "apps/web", lang: "php" });
    });

    const { lines } = expectExit(2, () => {
      doctorCommand(repo, { json: true });
    });

    expect(lines).toHaveLength(1);
    const health = JSON.parse(lines[0] ?? "");
    expect(health.ok).toBe(false);
    expect(health.findings).toContainEqual({
      level: "error",
      message: 'root "apps/web" points at a directory that does not exist',
    });
    // The error text goes to stderr in empo.ts, so none of it is on stdout beside the document.
    expect(lines[0]).not.toContain("config error(s)");
  });

  test("an unreadable spine: exit 2, and stdout is still one parseable document", () => {
    const repo = copyFixture();
    writeFileSync(join(repo, SPINES_DIR, "pricing.json"), '{ "name": \n');

    const { lines } = expectExit(2, () => {
      doctorCommand(repo, { json: true });
    });

    expect(lines).toHaveLength(1);
    const health = JSON.parse(lines[0] ?? "");
    expect(health.ok).toBe(false);
    expect(health.spines.state).toBe("unreadable");
  });

  test("errors and warnings together: one document, and it carries both", () => {
    const repo = copyFixture();
    mkdirSync(join(repo, "tools"), { recursive: true });
    writeFileSync(join(repo, "tools/release.sh"), "#!/bin/sh\n");
    rewriteConfig(repo, (config) => {
      (config.roots as { path: string; lang: string }[]).push({ path: "apps/web", lang: "php" });
    });
    const calculator = linesOf(repo, CALCULATOR_FILE);
    calculator.splice(1, 0, "// a line that pushes every anchor below it down by one");
    writeFileSync(join(repo, CALCULATOR_FILE), calculator.join("\n"));

    const { lines } = expectExit(2, () => {
      doctorCommand(repo, { json: true });
    });

    expect(lines).toHaveLength(1);
    const health = JSON.parse(lines[0] ?? "");
    expect(health.findings.map((finding: { level: string }) => finding.level)).toEqual([
      "error",
      "warn",
      "warn",
    ]);
    expect(health.spines.soft).toBe(2);
  });

  test("a missing config throws before anything reaches stdout", () => {
    const repo = mkdtempSync(join(tmpdir(), "empo-doctor-noconfig-"));
    temps.push(repo);

    const { lines } = expectExit(2, () => {
      doctorCommand(repo, { json: true });
    });

    // Nothing half-written: a hook reading this gets an empty stdout and a non-zero exit, which is
    // unambiguous, rather than a fragment of a document it has to guess about.
    expect(lines).toEqual([]);
  });
});
