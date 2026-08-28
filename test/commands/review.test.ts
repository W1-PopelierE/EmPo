import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { indexCommand } from "../../src/commands/index";
import {
  narrowToChangedLines,
  type ReviewOptions,
  reviewableFiles,
  reviewCommand,
} from "../../src/commands/review";
import type { ReviewFinding } from "../../src/discipline/findings";
import { reviewWorkflow } from "../../src/discipline/load";
import type { ChangedFile } from "../../src/engine/diff";
import { run } from "../../src/engine/git";
import { GRAPH_PATH, GRAPH_SCHEMA, graphPath, serializeGraph } from "../../src/engine/graph";
import { loadPack } from "../../src/engine/pack-loader";
import { EmpoError } from "../../src/errors";
import { buildProgram } from "../../src/program";
import type { Graph, GraphEdge, GraphNode } from "../../src/schema/types";

/**
 * `empo review` end to end: the brief in phase 1, the verification gate in phase 2.
 *
 * The acme fixture is not a repository of its own, it lives inside this one, so reviewing it in
 * place would diff EmPo. Every test therefore copies it to a throwaway git repository, commits it,
 * and dirties one file, which is the shape of the thing under review: a working diff against a base
 * ref. The graph is built rather than inherited, because `.empo/generated/` is gitignored here and
 * the fixture's copy of it is a local artefact a clean checkout does not have.
 *
 * Nothing here touches the network or needs `gh`: the fixture configures no adapters, so the forge
 * degrades to the local diff and the tracker to none, which is also case 4 below.
 */

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

const CALCULATOR = "Acme\\Libraries\\Price\\PriceCalculator";
const CALCULATOR_FILE = "apps/api/app/Libraries/Price/PriceCalculator.php";
const CHECKOUT_TEST_FILE = "apps/api/tests/Feature/CheckoutTest.php";
const ORDER_TEST_FILE = "apps/api/tests/Feature/OrderTest.php";

/**
 * Where phase 1 leaves the session a local review's phase 2 reads. Not exported, so the shape is
 * spelled out here: the readable id, then a digest of the resolved repository root, which is what
 * keeps two checkouts reviewed under the same id out of each other's scratch. Spelling it out is
 * also what lets afterEach remove a session a run threw before tearing down.
 */
function sessionDirOf(repoRoot: string, id = "local"): string {
  const digest = createHash("sha256").update(realpathSync(repoRoot)).digest("hex").slice(0, 8);
  return join(tmpdir(), "empo-review", `${id}-${digest}`);
}

function findingsPathOf(repoRoot: string): string {
  return join(sessionDirOf(repoRoot), "findings.json");
}

/** One line of the shipped workflow, distinctive enough that no line of the brief resembles it. */
const WORKFLOW_LINE =
  "Read the ticket, its description and every comment, before you open the diff.";

/**
 * The working-tree edit under review. PriceCalculator is the interesting file: it is a graph node
 * with fan-in, and it reaches the BLIND checkout flow. Written as lines so every citation below can
 * be located rather than counted by hand.
 */
const CHANGED_CALCULATOR = [
  "<?php",
  "",
  "namespace Acme\\Libraries\\Price;",
  "",
  "use Acme\\Models\\Order;",
  "",
  "class PriceCalculator",
  "{",
  "    private const TAX_RATE_BASIS_POINTS = 2100;",
  "",
  "    public function total(Order $order): int",
  "    {",
  "        return $order->subtotal + $this->tax($order->subtotal) - $this->discount($order);",
  "    }",
  "",
  "    private function discount(Order $order): int",
  "    {",
  "        return intdiv($order->subtotal, 10);",
  "    }",
  "",
  "    private function tax(int $subtotal): int",
  "    {",
  "        return intdiv($subtotal * self::TAX_RATE_BASIS_POINTS, 10000);",
  "    }",
  "}",
];

/**
 * The second repository's edit. It deliberately shares no anchor with CHANGED_CALCULATOR, so a
 * finding about the first repository resolved against this one is dropped as uncited. That is how
 * the collision test tells the two read roots apart by their content and not only by their path.
 */
const OTHER_CALCULATOR = [
  "<?php",
  "",
  "namespace Acme\\Libraries\\Price;",
  "",
  "use Acme\\Models\\Order;",
  "",
  "class PriceCalculator",
  "{",
  "    public function total(Order $order): int",
  "    {",
  "        return $order->subtotal;",
  "    }",
  "}",
];

let repo: string;
const repos: string[] = [];

/** `empo review 412 --pr-payload /tmp/x.json` to the argv commander would be handed. */
function argvOf(command: string): string[] {
  const parts = command.trim().split(/\s+/);
  // Drop the binary name. What is left is what `empo` itself parses.
  return parts[0] === "empo" ? parts.slice(1) : parts;
}

/**
 * Parse argv with the real program, and run none of it. Every action handler is replaced with a
 * no-op first, because the property under test is that commander accepts these arguments, not that
 * a review happens: leaving the handlers in would run a real review from inside an assertion.
 *
 * `exitOverride` so an unknown option throws where it would otherwise call process.exit and take
 * the test runner down with it.
 */
function parseArgv(argv: string[]): void {
  const program = buildProgram();
  program.exitOverride();
  for (const command of program.commands) {
    command.exitOverride();
    command.action(() => {});
  }
  program.parse(argv, { from: "user" });
}

/** Everything the command printed, joined, so a test can look for one line in it. */
function capture(run: () => void): string {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });

  try {
    run();
  } finally {
    log.mockRestore();
  }

  return lines.join("\n");
}

function expectEmpoError(exitCode: number, body: () => void): EmpoError {
  try {
    body();
    return expect.unreachable(`expected a EmpoError with exit code ${exitCode}`);
  } catch (error) {
    expect(error).toBeInstanceOf(EmpoError);
    expect((error as EmpoError).exitCode).toBe(exitCode);
    return error as EmpoError;
  }
}

function git(dir: string, args: string[]): void {
  const result = run(dir, "git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/**
 * A throwaway git repository holding the indexed fixture, committed. Every test needs one, and the
 * collision test needs two, which is the whole point: one machine, two checkouts, one review id.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-review-test-"));
  repos.push(dir);
  cpSync(fixture, dir, { recursive: true });
  rmSync(join(dir, ".empo/generated"), { recursive: true, force: true });
  capture(() => indexCommand(dir));

  git(dir, ["init", "-b", "main"]);
  // -f so a global gitignore excluding .empo/generated/, which a EmPo developer plausibly has, does
  // not decide what the diff can show.
  git(dir, ["add", "-A", "-f"]);
  commit(dir, "the fixture as it stands");
  return dir;
}

/** -c on every setting so this passes on a machine with no git identity and no gpg key. */
function commit(dir: string, message: string): void {
  git(dir, [
    "-c",
    "user.email=empo@example.com",
    "-c",
    "user.name=EmPo Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
}

/**
 * A real branch for the payload to name, because the whole point of the mcp gate is that the branch
 * names are checked against git rather than believed. A test whose branches did not exist would
 * only ever exercise the refusal.
 */
const PR_BRANCH = "PLAT-1234-vat";

/** The pull request id every mcp test uses, and the second session directory afterEach removes. */
const PR_ID = "412";

function makePullRequestBranch(dir: string): void {
  git(dir, ["checkout", "-q", "-b", PR_BRANCH]);
  writeCalculator(dir, CHANGED_CALCULATOR);
  // The one file, not -A: the adapters a test configures live in an uncommitted .empo/config.json,
  // and committing that here would carry it onto the branch and take it away again on checkout.
  git(dir, ["add", "-f", CALCULATOR_FILE]);
  commit(dir, "charge VAT on renewals");
  git(dir, ["checkout", "-q", "main"]);
}

/** Put adapters in the repository's config, which the fixture deliberately ships without. */
function configureAdapters(dir: string, adapters: unknown): void {
  const path = join(dir, ".empo/config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, `${JSON.stringify({ ...config, adapters }, null, 2)}\n`);
}

/**
 * A PATH with a `gh` on it that answers `--version` and fails every other call, prepended to the
 * real one so git still works. Both halves matter: the version call is what makes createForge pick
 * the github adapter rather than degrade past it, and the failure on everything else is what turns
 * "the review reached for gh" into a loud exit 3 instead of a quiet wrong answer.
 */
function withFakeGh<T>(dir: string, act: () => T): T {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\nexit 1\n',
    { mode: 0o755 },
  );

  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  try {
    return act();
  } finally {
    process.env.PATH = path;
  }
}

function writeCalculator(dir: string, lines: string[]): void {
  writeFileSync(join(dir, CALCULATOR_FILE), `${lines.join("\n")}\n`);
}

function changeCalculator(): void {
  writeCalculator(repo, CHANGED_CALCULATOR);
}

/** The real line of an anchor in the edited file, so a citation is never a hand-counted number. */
function lineOf(anchor: string): number {
  const index = CHANGED_CALCULATOR.findIndex((line) => line.includes(anchor));
  if (index === -1) throw new Error(`no line of the changed calculator contains "${anchor}"`);
  return index + 1;
}

function citation(anchor: string, line = lineOf(anchor)) {
  return { file: CALCULATOR_FILE, line, anchor };
}

const REAL_CLAIM =
  "PriceCalculator::total() subtracts the discount after the tax has been added, so a taxed " +
  "order is discounted on its gross amount.";
const FABRICATED_CLAIM =
  "PriceCalculator::total() rounds the gross amount to two decimals, which drops a cent from " +
  "every order.";
const HEDGED_CLAIM =
  "PriceCalculator::discount() probably rounds down, so an order of nine cents receives no " +
  "discount at all.";
const MOVED_CLAIM =
  "The tax rate is a compile-time constant of PriceCalculator, so no flow can hand it a rate.";

/**
 * Four findings against the edited file: one true, one standing on an anchor that is nowhere in the
 * file, one perfectly cited but hedged, and one whose anchor sits six lines from where it is cited.
 * Two of these must reach the author and two must not, which is the whole promise of the tool.
 */
function submittedFindings(): ReviewFinding[] {
  return [
    realFinding(),
    {
      id: "F2",
      kind: "diff",
      severity: "blocker",
      title: "Rounding drops a cent from every order",
      claim: FABRICATED_CLAIM,
      citation: citation("$total = round($gross, 2);", lineOf("intdiv($order->subtotal, 10)")),
      introducedBy: citation("return intdiv($order->subtotal, 10);"),
    },
    {
      id: "F3",
      kind: "diff",
      severity: "minor",
      title: "Discount rounds down below ten cents",
      claim: HEDGED_CLAIM,
      citation: citation("private function discount(Order $order): int"),
      introducedBy: citation("private function discount(Order $order): int"),
    },
    {
      id: "F4",
      kind: "diff",
      severity: "major",
      title: "Tax rate cannot vary per flow",
      claim: MOVED_CLAIM,
      // Cited six lines below where the constant really is: a drifted coordinate over real source,
      // which the gate repairs rather than drops.
      citation: citation("private const TAX_RATE_BASIS_POINTS = 2100;", movedLine()),
      // The constant itself is three lines above the diff. What made it this branch's problem is
      // the new call in total(), which is a changed line.
      introducedBy: citation("- $this->discount($order)"),
    },
  ];
}

/** The one true finding, on its own, so a gate can be judged by a single id surviving or not. */
function realFinding(): ReviewFinding {
  return {
    id: "F1",
    kind: "diff",
    severity: "major",
    title: "Discount is applied after tax, on the gross amount",
    claim: REAL_CLAIM,
    citation: citation("- $this->discount($order)"),
    introducedBy: citation("- $this->discount($order)"),
  };
}

function movedLine(): number {
  return lineOf("private const TAX_RATE_BASIS_POINTS = 2100;") + 6;
}

/** Phase 1 then phase 2, the way a real review runs: the gate reads the session the brief wrote. */
function gate(findings: ReviewFinding[], options: ReviewOptions = {}): string {
  capture(() => reviewCommand(repo, undefined, { workflow: false }));
  const path = findingsPathOf(repo);
  writeFileSync(path, `${JSON.stringify({ findings }, null, 2)}\n`);
  return capture(() => reviewCommand(repo, undefined, { ...options, findings: path }));
}

beforeEach(() => {
  repo = makeRepo();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of repos.splice(0)) {
    // Scratch lives outside the repository, so a run that threw before teardown would otherwise
    // hand the next test a session pointing at a read root that no longer exists. Its directory is
    // named after the resolved root, so it has to be worked out while the repository is still there.
    const sessions = [sessionDirOf(dir), sessionDirOf(dir, PR_ID)];
    // A pull request review leaves a detached worktree behind when it never reached its own
    // teardown, and git keeps an administrative entry for it that outlives the directory.
    for (const session of sessions) {
      const worktree = join(session, "worktree");
      if (existsSync(worktree)) run(dir, "git", ["worktree", "remove", "--force", worktree]);
    }
    rmSync(dir, { recursive: true, force: true });
    for (const session of sessions) rmSync(session, { recursive: true, force: true });
  }
});

describe("the brief", () => {
  test("names the changed node, its blast radius, and the blind flow it reaches", () => {
    changeCalculator();

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));

    // The changed file is mapped onto a graph node, not merely listed. This is the line that proves
    // the discipline layer stands on the graph rather than on a guess about the path.
    const row = printed
      .split("\n")
      .find((line) => line.trimStart().startsWith("modified") && line.includes(CALCULATOR_FILE));
    expect(row).toBeDefined();
    expect(row ?? "").toContain(CALCULATOR);

    expect(printed).toMatch(/fan-in [1-9]\d* direct, [1-9]\d* transitive/);
    expect(printed).toMatch(/flow checkout\s+BLIND/);
    expect(printed).toContain("BLIND checkout  a wrong result ships silently here");

    // The tests that reach the change, each graded by reading: checkout's test asserts nothing,
    // which is why the flow is blind.
    expect(printed).toContain(`${CHECKOUT_TEST_FILE}  ASSERTS NO VALUE`);
    expect(printed).toContain(`${ORDER_TEST_FILE}  asserts a value`);
  });

  test("names both ends of a symbol join, the way empo query does", () => {
    // This line was changed in the same commit that fixed `empo query`'s, for the same reason, and
    // was asserted by nothing: reverting it to the near end alone left the whole suite green. It is
    // executed by the brief above, since the changed calculator's radius holds both bridges, which
    // is the worst kind of unpinned line, one that runs on every review and is read by an agent.
    changeCalculator();

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));
    const row = printed.split("\n").find((line) => line.trimStart().startsWith("join http-route"));

    expect(row).toBeDefined();
    // Both ends and the separator word, the same three things the query pin holds.
    // The near end is one export of the client now, not the file: two of its functions call a route
    // the api declares and the row says which. `#` and not a bare path is the claim to notice.
    expect(row ?? "").toContain(
      "apps/mobile/src/api/client.ts#createOrder consumes apps/api/routes/api.php",
    );
    expect(row ?? "").toMatch(/named at apps\/mobile\/src\/api\/client\.ts:\d+$/);
  });

  test("never calls a flow no test reaches covered, which is the worse of the two bad answers", () => {
    // The summary line used to be built from `blind` alone, so a flow nothing reaches was counted
    // as "not blind" and the brief printed `flows touched 1, blind 0` under `every touched flow
    // has at least one test that asserts a value`. Three lines above it, the same command printed
    // `no test reaches this flow at all` about that same flow. The false line is the summary, and
    // the summary is what a reader carries into the review.
    //
    // The acme fixture's `admin` flow is reached by no test on purpose, and AdminController is the
    // node that is in it and in nothing else.
    writeFileSync(
      join(repo, "apps/api/app/Http/Controllers/AdminController.php"),
      `${readFileSync(join(repo, "apps/api/app/Http/Controllers/AdminController.php"), "utf8")}\n// touched\n`,
    );

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));

    expect(printed).toContain("flows touched  1, blind 0, reached by no test 1");
    expect(printed).toContain("NO TEST admin  no test reaches this flow at all");
    expect(printed).not.toContain("every touched flow has at least one test that asserts a value");
  });

  test("says every touched flow asserts only when every one of them is reached and asserting", () => {
    // The other half, so the fix cannot be "delete the sentence". `orders` is covered: reached, and
    // a reaching test asserts a value. Its controller is in no other flow.
    writeFileSync(
      join(repo, "apps/api/app/Http/Controllers/OrderController.php"),
      `${readFileSync(join(repo, "apps/api/app/Http/Controllers/OrderController.php"), "utf8")}\n// touched\n`,
    );

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));

    expect(printed).toContain("flows touched  1, blind 0, reached by no test 0");
    expect(printed).toContain("every touched flow has at least one test that asserts a value");
  });

  test("prints the shipped workflow by default and omits it under workflow: false", () => {
    changeCalculator();
    // Guards the constant: a reworded discipline should fail here, naming the line, rather than
    // silently turning the assertions below into assertions about nothing.
    expect(reviewWorkflow()).toContain(WORKFLOW_LINE);

    const withWorkflow = capture(() => reviewCommand(repo, undefined));
    const without = capture(() => reviewCommand(repo, undefined, { workflow: false }));

    expect(withWorkflow).toContain(WORKFLOW_LINE);
    expect(withWorkflow).toContain(reviewWorkflow());
    expect(without).not.toContain(WORKFLOW_LINE);
  });

  test("leaves machine-owned files out of the review and says that it did", () => {
    changeCalculator();
    // A team that commits the graph gets it back in the diff the moment anyone re-indexes, which is
    // exactly the case this filter exists for.
    capture(() => indexCommand(repo));

    const answer = JSON.parse(
      capture(() => reviewCommand(repo, undefined, { json: true, workflow: false })),
    );
    const paths = answer.files.map((file: { path: string }) => file.path);

    expect(paths).toContain(CALCULATOR_FILE);
    expect(paths).not.toContain(GRAPH_PATH);
    expect(answer.notes.join("\n")).toContain("machine-owned file(s) left out of the review");
    expect(answer.notes.join("\n")).toContain(GRAPH_PATH);
  });

  test("reviews a local diff with no forge and no tracker, and states both gaps", () => {
    changeCalculator();

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));

    expect(printed).toContain("local diff against main");
    expect(printed).toContain("forge      local");
    expect(printed).toContain("tracker    none");
    expect(printed).toContain("(your checkout)");
    // A skipped step is reported as skipped, with its reason: a report that omits ticket-fit reads
    // exactly like one that graded it and found nothing wrong.
    expect(printed).toContain(
      "ticket-fit not graded: no tracker is configured, so acceptance criteria were not checked",
    );
    expect(printed).toContain("no forge is configured, so CI was not consulted");
  });
});

/**
 * The regression this file existed without: the fixture configures no adapters, so `empo review`
 * with no argument never once ran the branch where a real forge is configured. It was broken.
 * `id` was `pr ?? "local"` and that id was handed to every forge call, so a github forge ran
 * `gh pr diff local` and the review died on a pull request nobody had named.
 */
describe("a review with no pull request argument", () => {
  test("reads the local diff without asking the configured forge about a pull request", () => {
    changeCalculator();
    configureAdapters(repo, { forge: { kind: "github", repo: "acme/platform" } });

    const printed = withFakeGh(repo, () =>
      capture(() => reviewCommand(repo, undefined, { workflow: false })),
    );

    expect(printed).toContain("local diff against main");
    expect(printed).toContain("forge      local");
  });

  test("says which configured forge went unconsulted, and what was reviewed instead", () => {
    changeCalculator();
    configureAdapters(repo, { forge: { kind: "github", repo: "acme/platform" } });

    const printed = withFakeGh(repo, () =>
      capture(() => reviewCommand(repo, undefined, { workflow: false })),
    );

    // A brief that prints "forge local" in a repository configured for github owes the reader the
    // reason, and the reason has to name what was read instead of the pull request.
    expect(printed).toContain("no pull request was named");
    expect(printed).toContain("github");
    expect(printed).toContain("main");
  });

  test("does not tell a configured repository that no forge is configured", () => {
    changeCalculator();
    configureAdapters(repo, { forge: { kind: "github", repo: "acme/platform" } });

    const printed = withFakeGh(repo, () =>
      capture(() => reviewCommand(repo, undefined, { workflow: false })),
    );

    // The whole of the defect: the note above says the github forge went unconsulted, and the CI
    // line a few lines below contradicted it. The reason they could disagree is that the CI line is
    // the local adapter's and the adapter knew nothing about the config it was standing in for.
    //
    // This review names no pull request, which is the commonest review there is, so the honest CI
    // line is not "the forge went unconsulted" either: there is no pipeline for a working diff, and
    // a line saying CI was not *read* sends the agent looking for one.
    expect(printed).not.toContain("no forge is configured, so CI was not consulted");
    expect(printed).toContain("no pull request was named, so there is no CI run to read");
  });

  test("names the mcp host rather than the kind, so the reader sees bitbucket not mcp", () => {
    changeCalculator();
    configureAdapters(repo, { forge: { kind: "mcp", host: "bitbucket" } });

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));

    expect(printed).toContain("bitbucket");
    expect(printed).toContain("forge      local");
    // No request block: a local diff needs no pull request payload, so asking for one would send
    // the agent to fetch something the review has no use for.
    expect(printed).not.toContain("empo needs the pull request");
  });
});

/**
 * The half of phase 0 the forge check cannot reach: a forge empo fetches with itself, beside a
 * tracker it cannot reach at all. `awaitingHostFetch` fires on the forge, so this combination
 * printed no request block and nothing ever asked for the ticket. One real review ran that way with
 * ticket-fit ungraded, and the report said so, which is why this was a gap and
 * not a defect: the tool stated the blind spot it had never been given a way to fill.
 */
describe("a github forge with a tracker only the agent can reach", () => {
  const PR_KEY = "PLAT-1234";

  function useGithubAndMcpTracker(tracker: unknown = { kind: "mcp", host: "linear" }): void {
    configureAdapters(repo, { forge: { kind: "github", repo: "acme/platform" }, tracker });
  }

  /**
   * A `gh` that answers `pr view --json number,title,...` with the pull request handed in, computes
   * `pr diff` off the repository's own branches, and fails everything else. Richer than
   * `withFakeGh` on purpose: this path is only reachable once empo has fetched a pull request
   * itself, which is the one thing a stub that fails every call cannot let it do. The diff comes
   * from real git rather than from a literal so that a review which gets past the ask reviews
   * something real, and so a test asserting the ask did *not* fire cannot pass on a crash.
   */
  function withScriptedGh<T>(dir: string, pr: Record<string, unknown>, act: () => T): T {
    const bin = join(dir, "scripted-bin");
    mkdirSync(bin, { recursive: true });
    const prJson = join(bin, "pr.json");
    writeFileSync(prJson, JSON.stringify(pr));
    writeFileSync(
      join(bin, "gh"),
      `${[
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi',
        'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
        '  case "$5" in',
        `    *number*) cat ${prJson}; exit 0;;`,
        "  esac",
        "fi",
        'if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then',
        `  exec git -C ${dir} diff main..${PR_BRANCH}`,
        "fi",
        "exit 1",
      ].join("\n")}\n`,
      { mode: 0o755 },
    );

    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      return act();
    } finally {
      process.env.PATH = path;
    }
  }

  function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      number: Number(PR_ID),
      title: `${PR_KEY} Charge VAT on renewals`,
      author: { login: "sokonkwo" },
      headRefName: PR_BRANCH,
      baseRefName: "main",
      body: "",
      url: `https://github.com/acme/platform/pull/${PR_ID}`,
      ...overrides,
    };
  }

  interface TicketRequestJson {
    awaiting: string;
    key: string;
    keyFrom: string;
    payloadPath: string;
    command: string;
    declineCommand: string;
    instructions: string;
  }

  test("asks for the one ticket the pull request names, by key", () => {
    useGithubAndMcpTracker();

    const printed = withScriptedGh(repo, pullRequest(), () =>
      capture(() => reviewCommand(repo, PR_ID, { workflow: false })),
    );

    // The whole point of asking after the fetch rather than before it: empo applied the pattern
    // itself, so the ask names one ticket instead of printing a regex and delegating the match.
    expect(printed).toContain(`names ticket ${PR_KEY}`);
    expect(printed).toContain(`empo review ${PR_ID} --ticket-payload`);
    expect(printed).not.toContain("Match this pattern against the title first");
  });

  test("prints the way out beside the way through, because a stop needs one", () => {
    // The key came from a real pull request, so empo knows a ticket is named. The tracker may still
    // not hold it, and without an exit that is not a payload the agent is asked again every re-run.
    useGithubAndMcpTracker();

    const printed = withScriptedGh(repo, pullRequest(), () =>
      capture(() => reviewCommand(repo, PR_ID, { workflow: false })),
    );

    expect(printed).toContain(`empo review ${PR_ID} --no-ticket`);
    expect(printed).toContain("Do");
    expect(printed).toContain("not invent a ticket to get past this");
  });

  test("carries the key, both commands and where the key came from into --json", () => {
    useGithubAndMcpTracker();

    const answer = JSON.parse(
      withScriptedGh(repo, pullRequest(), () =>
        capture(() => reviewCommand(repo, PR_ID, { workflow: false, json: true })),
      ),
    ) as TicketRequestJson;

    expect(answer.awaiting).toBe("ticket");
    expect(answer.key).toBe(PR_KEY);
    expect(answer.keyFrom).toBe("title");
    expect(answer.payloadPath).toContain("ticket.json");
    expect(answer.declineCommand).toBe(`empo review ${PR_ID} --no-ticket`);
    // Both commands have to be commands this program accepts, or the block is instructions to
    // nowhere. Same check the mcp block gets, for the same reason.
    expect(() => parseArgv(argvOf(answer.command))).not.toThrow();
    expect(() => parseArgv(argvOf(answer.declineCommand))).not.toThrow();
  });

  test("asks nothing when the pull request names no ticket", () => {
    // The ask is for one named ticket, so with no key there is nothing to name. Asking anyway would
    // stop every review on every repository whose branches do not carry keys.
    useGithubAndMcpTracker();
    makePullRequestBranch(repo);

    // `main` as the source branch because it is the one branch this repository has that carries no
    // key: the key is looked for in the title, the branch and the body, so all three have to be
    // clean or the test passes for the wrong reason.
    const printed = withScriptedGh(
      repo,
      pullRequest({ title: "Charge VAT on renewals", body: "", headRefName: "main" }),
      () => capture(() => reviewCommand(repo, PR_ID, { workflow: false })),
    );

    expect(printed).not.toContain("names ticket");
    expect(printed).not.toContain("--no-ticket");
  });

  test("asks nothing when the tracker is one empo can fetch with itself", () => {
    useGithubAndMcpTracker({ kind: "github-issues" });
    makePullRequestBranch(repo);

    const printed = withScriptedGh(repo, pullRequest(), () =>
      capture(() => reviewCommand(repo, PR_ID, { workflow: false })),
    );

    expect(printed).not.toContain("names ticket");
  });

  test("asks nothing when there is no tracker at all", () => {
    configureAdapters(repo, { forge: { kind: "github", repo: "acme/platform" } });
    makePullRequestBranch(repo);

    const printed = withScriptedGh(repo, pullRequest(), () =>
      capture(() => reviewCommand(repo, PR_ID, { workflow: false })),
    );

    expect(printed).not.toContain("names ticket");
  });

  test("--no-ticket runs the review and says the ticket was reported unfetchable", () => {
    // Distinct from "no ticket was supplied by the host", which is equally true of a review nobody
    // ever asked. This one says somebody looked. The review has to actually run, or the flag is a
    // way to make the command quiet rather than a way to answer it.
    useGithubAndMcpTracker();
    makePullRequestBranch(repo);
    changeCalculator();

    const printed = withScriptedGh(repo, pullRequest(), () =>
      capture(() => reviewCommand(repo, undefined, { workflow: false, ticket: false })),
    );

    expect(printed).toContain("ticket-fit not graded: --no-ticket");
    expect(printed).toContain("Nobody has read it, including this review.");
    expect(printed).toContain(CALCULATOR_FILE);
  });

  test("grades ticket-fit once the agent hands the named ticket back", () => {
    // The payoff, and the thing that was impossible before: a github forge with an mcp tracker
    // reaching step 6 with real acceptance criteria. Without this the round trip could be complete
    // and useless, asking for a ticket the second call then ignores.
    useGithubAndMcpTracker({ kind: "mcp", host: "linear", keyPattern: "PLAT-\\d+" });
    makePullRequestBranch(repo);
    const ticket = join(repo, "fetched-linear-ticket.json");
    writeFileSync(
      ticket,
      JSON.stringify({
        key: PR_KEY,
        title: "Renewal invoices are missing VAT",
        type: "bug",
        body: "- [ ] The renewal invoice total includes VAT",
        url: `https://linear.app/acme/issue/${PR_KEY}`,
        completed: false,
        comments: [],
      }),
    );

    const printed = withScriptedGh(repo, pullRequest(), () =>
      capture(() => reviewCommand(repo, PR_ID, { workflow: false, ticketPayload: ticket })),
    );

    expect(printed).toContain(`ticket     ${PR_KEY}  Renewal invoices are missing VAT`);
    expect(printed).toContain("1. The renewal invoice total includes VAT");
    expect(printed).not.toContain("names ticket");
  });

  test("says nothing about --no-ticket on a review that was never given the flag", () => {
    useGithubAndMcpTracker();
    changeCalculator();

    const printed = withScriptedGh(repo, pullRequest(), () =>
      capture(() => reviewCommand(repo, undefined, { workflow: false })),
    );

    expect(printed).not.toContain("--no-ticket");
    expect(printed).toContain("ticket-fit not graded: no linear ticket was supplied");
  });
});

/**
 * The mcp forge and tracker: empo cannot reach an MCP server, so the agent running the command
 * fetches, writes JSON, and runs the command again pointing at what it wrote. Phase 0 is the block
 * that states exactly what to fetch, and the flags are the way back in.
 */
describe("a pull request an agent host has to fetch", () => {
  const PAYLOAD_ID = PR_ID;

  function useMcp(tracker?: unknown): void {
    configureAdapters(repo, {
      forge: { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "platform" },
      ...(tracker === undefined ? {} : { tracker }),
    });
  }

  function prPayload(overrides: Record<string, unknown> = {}): string {
    const path = join(repo, "fetched-pull-request.json");
    writeFileSync(
      path,
      JSON.stringify({
        id: PAYLOAD_ID,
        title: `PLAT-1234 Charge VAT on renewals`,
        author: "Sam Okonkwo",
        sourceBranch: PR_BRANCH,
        baseBranch: "main",
        description: "",
        url: "https://bitbucket.org/acme/platform/pull-requests/412",
        ...overrides,
      }),
    );
    return path;
  }

  function ticketPayload(overrides: Record<string, unknown> = {}): string {
    const path = join(repo, "fetched-ticket.json");
    writeFileSync(
      path,
      JSON.stringify({
        key: "PLAT-1234",
        title: "Renewal invoices are missing VAT",
        type: "bug",
        body: "- [ ] The renewal invoice total includes VAT",
        url: "https://acme.atlassian.net/browse/PLAT-1234",
        completed: false,
        comments: [],
        ...overrides,
      }),
    );
    return path;
  }

  describe("phase 0, the request block", () => {
    test("names the file to write, every required field, and the command to run next", () => {
      useMcp();

      const printed = capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));

      const payloadPath = join(sessionDirOf(repo, PAYLOAD_ID), "pull-request.json");
      expect(printed).toContain(payloadPath);
      for (const field of [
        '"id"',
        '"title"',
        '"author"',
        '"sourceBranch"',
        '"baseBranch"',
        '"description"',
        '"url"',
      ]) {
        expect(printed).toContain(field);
      }
      expect(printed).toContain(`empo review ${PAYLOAD_ID} --pr-payload ${payloadPath}`);
    });

    test("does not review anything, because it has nothing to review yet", () => {
      useMcp();

      const printed = capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));

      expect(printed).not.toContain("changed files");
      expect(printed).not.toContain("blast radius");
    });

    test("creates the directory it tells the agent to write into", () => {
      // The session directory is made by isolate(), which is downstream of this return, so without
      // this the agent's first write fails on a path that does not exist.
      useMcp();

      capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));

      expect(existsSync(sessionDirOf(repo, PAYLOAD_ID))).toBe(true);
    });

    test("says what omitting each optional field means, rather than only that it is optional", () => {
      useMcp();

      const printed = capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));

      expect(printed).toContain("existing comments were not read");
      expect(printed).toContain("the pipeline was not checked");
      // The one that costs a review its credibility if the agent guesses.
      expect(printed).toContain("Never write");
      expect(printed).toContain('"passed"');
    });

    test("tells the agent not to fetch the diff, which it would otherwise do out of habit", () => {
      useMcp();

      const printed = capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));

      expect(printed).toContain("Do not fetch the diff");
      expect(printed).toContain("git");
    });

    test("carries the verified Bitbucket field mapping when the host is bitbucket", () => {
      useMcp();

      const printed = capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));

      expect(printed).toContain("author.display_name");
      expect(printed).toContain("source.branch.name");
      expect(printed).toContain("destination.branch.name");
      expect(printed).toContain("summary.raw");
      expect(printed).toContain("links.html.href");
      // The workspace and repo slugs come from config, so the agent has a complete call to make.
      expect(printed).toContain('"acme"');
      expect(printed).toContain('"platform"');
      // CI is genuinely unavailable on that surface, and the wrong fix is named so nobody tries it.
      expect(printed).toContain("Pipelines");
    });

    test("names no host's fields when the host is not one empo has confirmed", () => {
      configureAdapters(repo, { forge: { kind: "mcp", host: "gitlab" } });

      const printed = capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));

      expect(printed).toContain("your gitlab tool");
      expect(printed).not.toContain("destination.branch.name");
    });

    test("asks for the ticket in the same block, so one round trip answers both", () => {
      // The ticket key is extracted from the pull request, so asking separately would need three
      // invocations to review one pull request. The agent can apply the pattern itself.
      useMcp({ kind: "mcp", host: "jira", keyPattern: "PLAT-\\d+" });

      const printed = capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));

      const ticketPath = join(sessionDirOf(repo, PAYLOAD_ID), "ticket.json");
      expect(printed).toContain(ticketPath);
      expect(printed).toContain("PLAT-\\d+");
      expect(printed).toContain("jira");
      expect(printed).toContain(`--ticket-payload ${ticketPath}`);
      // And what to do when the pull request names no ticket at all.
      expect(printed).toContain("ticket-fit was not graded");
    });

    test("tells the agent to echo the matched key back, not the host's own identifier", () => {
      // The quietest failure in the design: getTicket matches payload.key against the key empo
      // extracted, so an Asana gid written into `key` never matches and the review reports the
      // ticket as not found, which reads as a missing ticket rather than a mis-filled payload.
      useMcp({ kind: "mcp", host: "asana", keyPattern: "PLAT-\\d+" });

      const printed = capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));

      expect(printed).toContain("Echo the matched key back");
      expect(printed).toContain("character for character");
      expect(printed).toContain("gid");
      // And where the host's own identifier is supposed to go instead.
      expect(printed).toContain('"url"');
      // The consequence, so an agent that reads the reason gets the rule right for other hosts too.
      expect(printed).toContain("reports the ticket as not found");
    });

    test("asks for the ticket's comments, and says why they are worth a second call", () => {
      useMcp({ kind: "mcp", host: "jira", keyPattern: "PLAT-\\d+" });

      const printed = capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));

      expect(printed).toContain('"comments" is required');
      // The reason, because an agent that understands it fetches them properly.
      expect(printed).toContain("scoped out");
      expect(printed).toContain("not to flag what a comment retracted");
      expect(printed).toContain("second call");
    });

    test("does not imply the ticket's comments rule applies to the pull request's", () => {
      // Two different decisions a screen apart in one block. The forge declares a `comments`
      // capability from whether the key is there, so an absent list survives into a report that
      // says they were not read; a Ticket has no way to carry "not fetched".
      useMcp({ kind: "mcp", host: "jira", keyPattern: "PLAT-\\d+" });

      const printed = capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));

      expect(printed).toContain("existing comments were not read");
      expect(printed).toContain("this is the one field where that differs from the pull");
    });

    test("asks for no ticket when the tracker is not one the host fetches for", () => {
      useMcp({ kind: "none" });

      const printed = capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));

      expect(printed).not.toContain("ticket.json");
      expect(printed).not.toContain("--ticket-payload");
    });

    test("stays machine-readable under --json, rather than putting prose on that stream", () => {
      // A caller that asked for JSON and piped it to a parser gets a parse error otherwise, which
      // is a worse answer than the one this block exists to give.
      useMcp({ kind: "mcp", host: "jira" });

      const answer = JSON.parse(
        capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false, json: true })),
      );

      expect(answer.awaiting).toBe("pull-request");
      expect(answer.payloadPath).toBe(join(sessionDirOf(repo, PAYLOAD_ID), "pull-request.json"));
      expect(answer.ticketPath).toBe(join(sessionDirOf(repo, PAYLOAD_ID), "ticket.json"));
      expect(answer.command).toContain(`empo review ${PAYLOAD_ID} --pr-payload `);
      expect(answer.instructions).toContain("Do not fetch the diff");
    });

    test("carries no ticket path under --json when no host fetches tickets here", () => {
      useMcp();

      const answer = JSON.parse(
        capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false, json: true })),
      );

      expect(answer.ticketPath).toBeNull();
    });

    /**
     * The command the block prints has to be a command the program accepts, and this is the only
     * assertion in the suite that checks it by running it rather than by matching text.
     *
     * It is worth more than it looks. Every other string this tool prints is read by something that
     * can adapt: a human skims past a stale flag, an agent reading prose infers what was meant. This
     * one line is copied literally by a machine, so a stale flag does not confuse a reader, it costs
     * the entire round trip, and it fails at the moment the agent has done everything right. It also
     * has a proven failure mode: the whole suite stayed green through a flag rename while the block
     * was still printing a name the program answered with "unknown option".
     *
     * Parsed against the real program from src/program.ts, and asserted on the property rather than
     * on the flag names, so the next rename cannot turn this into the next stale string.
     */
    test("prints a command the real CLI accepts, whatever the flags are currently called", () => {
      useMcp({ kind: "mcp", host: "jira", keyPattern: "PLAT-\\d+" });

      const answer = JSON.parse(
        capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false, json: true })),
      );

      expect(() => parseArgv(argvOf(answer.command))).not.toThrow();
    });

    test("prints a ticket payload flag that parses too, appended to that command", () => {
      // Printed on its own line to be appended, so it can go stale independently of the line above.
      useMcp({ kind: "mcp", host: "jira", keyPattern: "PLAT-\\d+" });

      const answer = JSON.parse(
        capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false, json: true })),
      );
      const printed = capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false }));
      const appended = (printed.match(/^\s*(--\S+)\s+(\S*ticket\.json)$/m) ?? []).slice(1);

      expect(appended).toHaveLength(2);
      expect(() => parseArgv([...argvOf(answer.command), ...appended])).not.toThrow();
    });

    test("that parse check has teeth: an option the program does not have throws", () => {
      // Without this, a parseArgv that quietly accepted anything would make both tests above pass
      // for a command that is complete nonsense.
      expect(() => parseArgv(["review", PAYLOAD_ID, "--definitely-not-an-option", "x"])).toThrow();
    });

    test("prints again, rather than failing, when --pr names a payload that is gone", () => {
      // A review takes its own session directory down when it finishes, so the second run of a
      // command that worked once finds its payload missing. The remedy is this block, not an error.
      useMcp();

      const printed = capture(() =>
        reviewCommand(repo, PAYLOAD_ID, { workflow: false, prPayload: join(repo, "nowhere.json") }),
      );

      expect(printed).toContain("names no file");
      expect(printed).toContain("empo cannot fetch pull request");
    });
  });

  describe("phase 1, once the payload is handed over", () => {
    test("reviews the pull request through the mcp forge", () => {
      useMcp();
      makePullRequestBranch(repo);

      const printed = capture(() =>
        reviewCommand(repo, PAYLOAD_ID, { workflow: false, prPayload: prPayload() }),
      );

      expect(printed).toContain(`pull request ${PAYLOAD_ID}`);
      expect(printed).toContain("forge      mcp");
      expect(printed).toContain("detached worktree");
      expect(printed).toContain(CALCULATOR_FILE);
      // Computed locally from the two branch names, never carried in the payload.
      expect(printed).toContain(CALCULATOR);
    });

    test("reports CI as unchecked rather than green when the payload omitted it", () => {
      useMcp();
      makePullRequestBranch(repo);

      const printed = capture(() =>
        reviewCommand(repo, PAYLOAD_ID, { workflow: false, prPayload: prPayload() }),
      );

      expect(printed).toContain("ci         unknown");
      expect(printed).not.toContain("ci         passed");
    });

    test("grades ticket-fit against the ticket the host fetched", () => {
      useMcp({ kind: "mcp", host: "jira", keyPattern: "PLAT-\\d+" });
      makePullRequestBranch(repo);

      const printed = capture(() =>
        reviewCommand(repo, PAYLOAD_ID, {
          workflow: false,
          prPayload: prPayload(),
          ticketPayload: ticketPayload(),
        }),
      );

      expect(printed).toContain("tracker    mcp");
      expect(printed).toContain("PLAT-1234");
      expect(printed).toContain("The renewal invoice total includes VAT");
    });

    test("states that ticket-fit was not graded when the host fetched no ticket", () => {
      useMcp({ kind: "mcp", host: "jira", keyPattern: "PLAT-\\d+" });
      makePullRequestBranch(repo);

      const printed = capture(() =>
        reviewCommand(repo, PAYLOAD_ID, { workflow: false, prPayload: prPayload() }),
      );

      // Not the same statement as "the ticket listed no criteria", and the report has to keep the
      // two apart or a silent step 6 reads as a passed one.
      expect(printed).toContain("ticket-fit not graded");
      expect(printed).toContain("jira");
    });

    test("discards a ticket payload for a different key rather than grading against it", () => {
      useMcp({ kind: "mcp", host: "jira", keyPattern: "PLAT-\\d+" });
      makePullRequestBranch(repo);

      const printed = capture(() =>
        reviewCommand(repo, PAYLOAD_ID, {
          workflow: false,
          prPayload: prPayload(),
          ticketPayload: ticketPayload({ key: "PLAT-9999", title: "Something else entirely" }),
        }),
      );

      expect(printed).not.toContain("Something else entirely");
      expect(printed).toContain("PLAT-1234 was not found by the tracker");
    });
  });

  describe("the gate on the payload itself", () => {
    test("refuses a payload for another pull request, with exit code 2 naming both ids", () => {
      useMcp();
      makePullRequestBranch(repo);

      const error = expectEmpoError(2, () =>
        capture(() =>
          reviewCommand(repo, PAYLOAD_ID, { workflow: false, prPayload: prPayload({ id: "413" }) }),
        ),
      );

      expect(error.details.join("\n")).toContain("413");
      expect(error.details.join("\n")).toContain(PAYLOAD_ID);
    });

    test("refuses a source branch that is nowhere in this repository, naming it", () => {
      // The check that catches an invented pull request: a branch name a model wrote out of the
      // shape of the ticket resolves to nothing here.
      useMcp();

      const error = expectEmpoError(2, () =>
        capture(() =>
          reviewCommand(repo, PAYLOAD_ID, {
            workflow: false,
            prPayload: prPayload({ sourceBranch: "feature/invented-by-a-model" }),
          }),
        ),
      );

      expect(error.details.join("\n")).toContain("feature/invented-by-a-model");
    });

    test("refuses an unrecognized key, with exit code 2 naming the key", () => {
      useMcp();
      makePullRequestBranch(repo);

      const error = expectEmpoError(2, () =>
        capture(() =>
          reviewCommand(repo, PAYLOAD_ID, {
            workflow: false,
            prPayload: prPayload({ sourceBrunch: PR_BRANCH }),
          }),
        ),
      );

      expect(error.details.join("\n")).toContain("sourceBrunch");
    });

    test("refuses --pr with no pull request named, because there is nothing to check it against", () => {
      useMcp();

      const error = expectEmpoError(2, () =>
        capture(() => reviewCommand(repo, undefined, { workflow: false, prPayload: prPayload() })),
      );

      expect(error.message).toContain("--pr-payload");
    });

    test("refuses --pr when the configured forge is one that would ignore it", () => {
      // A flag that is read, validated and then quietly unused teaches that empo consulted a file
      // it never opened, which is the same false model a flag that does nothing teaches.
      configureAdapters(repo, { forge: { kind: "github", repo: "acme/platform" } });

      const error = expectEmpoError(2, () =>
        capture(() => reviewCommand(repo, PAYLOAD_ID, { workflow: false, prPayload: prPayload() })),
      );

      expect(error.message).toContain("--pr-payload");
      expect(error.details.join("\n")).toContain("github");
    });

    test("refuses --ticket when the configured tracker is one that would ignore it", () => {
      useMcp({ kind: "github-issues" });
      makePullRequestBranch(repo);

      const error = expectEmpoError(2, () =>
        capture(() =>
          reviewCommand(repo, PAYLOAD_ID, {
            workflow: false,
            prPayload: prPayload(),
            ticketPayload: ticketPayload(),
          }),
        ),
      );

      expect(error.message).toContain("--ticket-payload");
      expect(error.details.join("\n")).toContain("github-issues");
    });

    test("refuses a ticket payload of the wrong shape, with exit code 2", () => {
      useMcp({ kind: "mcp", host: "jira" });
      makePullRequestBranch(repo);

      const error = expectEmpoError(2, () =>
        capture(() =>
          reviewCommand(repo, PAYLOAD_ID, {
            workflow: false,
            prPayload: prPayload(),
            ticketPayload: ticketPayload({ key: "" }),
          }),
        ),
      );

      expect(error.message).toContain("ticket payload");
    });
  });
});

/**
 * One field, three answers, on both surfaces. `[]` is a claim somebody made ("I read them and the
 * ticket carries none") and `null` is a silence ("nobody read them"), and step 6 is told not to
 * report as missing what a comment retracted, so a brief that collapses the two licenses exactly
 * the finding a fetched list would have withdrawn.
 *
 * The two fetched states arrive through an mcp tracker, whose payload schema requires the key and
 * so can state nothing else; the unfetched one arrives through a real `gh` answering an issue with
 * no `comments` field, which is the only way a shipped tracker reaches it. That split is the point:
 * a pin on the printer is not a pin on the wiring, and the third test drives the whole path from a
 * subprocess's answer to the printed line.
 */
describe("what the brief says about a ticket's comments", () => {
  const TICKET_KEY = "PLAT-1234";

  /** A local review reads the key off the branch, having no pull request title or body to read. */
  function onBranch(name: string): void {
    git(repo, ["checkout", "-q", "-b", name]);
    changeCalculator();
  }

  /** An mcp tracker plus the payload the agent would have written, with `comments` as given. */
  function withMcpTicket(comments: unknown): string {
    configureAdapters(repo, { tracker: { kind: "mcp", host: "jira" } });
    onBranch(`feature/${TICKET_KEY}-vat`);

    const path = join(repo, "fetched-comments-ticket.json");
    writeFileSync(
      path,
      JSON.stringify({
        key: TICKET_KEY,
        title: "Renewal invoices are missing VAT",
        type: "bug",
        body: "- [ ] The renewal invoice total includes VAT",
        url: `https://acme.atlassian.net/browse/${TICKET_KEY}`,
        completed: false,
        comments,
      }),
    );
    return path;
  }

  /**
   * A `gh` that answers `issue view` with this JSON and fails everything else, beside a
   * github-issues tracker and a branch carrying `#123`. The issue is handed over without a
   * `comments` key, which is the state the adapter has to report as unfetched rather than empty.
   */
  function withIssueGh<T>(issue: Record<string, unknown>, act: () => T): T {
    configureAdapters(repo, { tracker: { kind: "github-issues" } });
    onBranch("fix/#123-export");

    const bin = join(repo, "issue-bin");
    mkdirSync(bin, { recursive: true });
    const issueJson = join(bin, "issue.json");
    writeFileSync(issueJson, JSON.stringify(issue));
    writeFileSync(
      join(bin, "gh"),
      `${[
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi',
        `if [ "$1" = "issue" ] && [ "$2" = "view" ]; then cat ${issueJson}; exit 0; fi`,
        "exit 1",
      ].join("\n")}\n`,
      { mode: 0o755 },
    );

    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      return act();
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
      url: "https://github.com/acme/platform/issues/123",
      labels: [{ name: "bug" }],
      ...overrides,
    };
  }

  test("tells the reader to go and read a list that was fetched", () => {
    const ticket = withMcpTicket([
      { author: "ada", body: "The CSV header moved to another ticket" },
    ]);

    const printed = capture(() =>
      reviewCommand(repo, undefined, { workflow: false, ticketPayload: ticket }),
    );

    expect(printed).toContain("1 comment(s): read them, a sub-item may have been deferred");
    expect(printed).not.toContain("comments not fetched");
  });

  test("says the list was read and is empty, rather than saying nothing at all", () => {
    // The line that did not exist before: an empty list used to print nothing, which is the same
    // output an unfetched list produced. A reader could not tell the two apart on this surface.
    const ticket = withMcpTicket([]);

    const printed = capture(() =>
      reviewCommand(repo, undefined, { workflow: false, ticketPayload: ticket }),
    );

    expect(printed).toContain("no comments: they were read and the ticket carries none");
    expect(printed).not.toContain("comments not fetched");
    expect(printed).not.toContain("comment(s): read them");
  });

  test("says plainly that nobody read the comments when the tracker did not fetch them", () => {
    const printed = withIssueGh(issue(), () =>
      capture(() => reviewCommand(repo, undefined, { workflow: false })),
    );

    // The ticket itself was fetched, so this is not the skip reason wearing another hat.
    expect(printed).toContain("ticket     #123  Export times out");
    expect(printed).toContain("comments not fetched: nobody read them");
    expect(printed).toContain(
      "Do not report a criterion as missing on the strength of that silence",
    );
    expect(printed).not.toContain("no comments: they were read");
  });

  test("carries the fetched list into --json", () => {
    const ticket = withMcpTicket([
      { author: "ada", body: "The CSV header moved to another ticket" },
    ]);

    const answer = JSON.parse(
      capture(() =>
        reviewCommand(repo, undefined, { workflow: false, json: true, ticketPayload: ticket }),
      ),
    );

    expect(answer.ticket.comments).toEqual([
      { author: "ada", body: "The CSV header moved to another ticket" },
    ]);
  });

  test("carries a fetched-and-empty list into --json as an empty list", () => {
    const ticket = withMcpTicket([]);

    const answer = JSON.parse(
      capture(() =>
        reviewCommand(repo, undefined, { workflow: false, json: true, ticketPayload: ticket }),
      ),
    );

    expect(answer.ticket.comments).toEqual([]);
  });

  test("carries an unfetched list into --json as null, which JSON can hold and [] cannot", () => {
    // The second output surface, and the reason it needs no sibling key: the value itself is the
    // distinction, so nothing here has to be told about it beyond not defaulting the null away.
    const answer = JSON.parse(
      withIssueGh(issue(), () =>
        capture(() => reviewCommand(repo, undefined, { workflow: false, json: true })),
      ),
    );

    expect(answer.ticket.key).toBe("#123");
    expect(answer.ticket.comments).toBeNull();
  });
});

describe("the gate", () => {
  test("keeps what was checked and drops what was not", () => {
    changeCalculator();

    const answer = JSON.parse(gate(submittedFindings(), { json: true }));

    // F4 first: same severity as F1, and its corrected line sorts above F1's.
    expect(answer.kept.map((row: { finding: { id: string } }) => row.finding.id)).toEqual([
      "F4",
      "F1",
    ]);
    expect(
      answer.dropped.map((row: { finding: { id: string }; reason: string }) => [
        row.finding.id,
        row.reason,
      ]),
    ).toEqual([
      ["F2", "citation-unverified"],
      ["F3", "forbidden-phrasing"],
    ]);

    // The drifted coordinate is repaired to the line the anchor is really on, and the finding as
    // authored is preserved beside it.
    const moved = answer.kept[0];
    expect(moved.corrected).toBe(true);
    expect(moved.citation.line).toBe(lineOf("private const TAX_RATE_BASIS_POINTS = 2100;"));
    expect(moved.finding.citation.line).toBe(movedLine());
    expect(answer.kept[1].corrected).toBe(false);
  });

  test("reports the survivors and the drops to the author, and the dropped claims to nobody", () => {
    changeCalculator();

    const printed = gate(submittedFindings());

    expect(printed).toContain("2 of 4 survived verification against");
    expect(printed).toContain(REAL_CLAIM);
    expect(printed).toContain(MOVED_CLAIM);
    expect(printed).toContain(
      `${CALCULATOR_FILE}:${lineOf("private const TAX_RATE_BASIS_POINTS = 2100;")}` +
        "  (citation corrected: the anchor had moved)",
    );
    // The line the author has to open to see why this is theirs, printed beside every survivor.
    expect(printed).toContain(
      `introduced by: ${CALCULATOR_FILE}:${lineOf("- $this->discount($order)")}`,
    );

    expect(printed).toContain("dropped  2");
    expect(printed).toContain("F2  citation-unverified");
    expect(printed).toContain("F3  forbidden-phrasing");
    expect(printed).toContain(`anchor is nowhere in ${CALCULATOR_FILE}`);
    expect(printed).toContain('"probably"');

    // The point of the gate: neither dropped claim is anywhere in what the author reads.
    expect(printed).not.toContain(FABRICATED_CLAIM);
    expect(printed).not.toContain(HEDGED_CLAIM);
  });

  // The gate reads the diff phase 1 saved, so a finding blamed on a line the branch never touched
  // is dropped however true it is. Without this the review is an audit of the whole repository.
  test("drops a finding introduced on a line outside the diff", () => {
    changeCalculator();

    const inherited: ReviewFinding = {
      ...realFinding(),
      // The constant is three lines above the hunk: real source, untouched by this branch.
      introducedBy: citation("private const TAX_RATE_BASIS_POINTS = 2100;"),
    };
    const answer = JSON.parse(gate([inherited], { json: true }));

    expect(answer.kept).toEqual([]);
    expect(answer.dropped[0].reason).toBe("not-introduced");
    expect(answer.dropped[0].detail[0]).toContain(
      `${CALCULATOR_FILE}:${lineOf("private const TAX_RATE_BASIS_POINTS = 2100;")} is outside every hunk`,
    );
  });

  // A gate that silently stops checking reads exactly like one that checked and found nothing.
  test("says so, and keeps the finding, when the saved diff is gone", () => {
    changeCalculator();

    capture(() => reviewCommand(repo, undefined, { workflow: false }));
    const diffPath = join(sessionDirOf(repo), "pr-local.diff");
    expect(existsSync(diffPath)).toBe(true);
    rmSync(diffPath);

    const inherited: ReviewFinding = {
      ...realFinding(),
      introducedBy: citation("private const TAX_RATE_BASIS_POINTS = 2100;"),
    };
    writeFileSync(findingsPathOf(repo), `${JSON.stringify({ findings: [inherited] })}\n`);
    const answer = JSON.parse(
      capture(() => reviewCommand(repo, undefined, { findings: findingsPathOf(repo), json: true })),
    );

    expect(answer.kept.map((row: { finding: { id: string } }) => row.finding.id)).toEqual(["F1"]);
    expect(answer.notes.join("\n")).toContain("not checked against the changed lines");
  });

  // A deletion is the one change that leaves nothing in the branch to cite. Without the removed-side
  // lookup, a pull request that deletes a file and breaks its consumers could report nothing at all.
  test("keeps a finding introduced by a file this branch deleted", () => {
    changeCalculator();
    const deleted = "apps/api/app/Models/Order.php";
    const line = readFileSync(join(repo, deleted), "utf8").split("\n").indexOf("class Order") + 1;
    rmSync(join(repo, deleted));

    const printed = gate([
      {
        ...realFinding(),
        kind: "impact",
        // Cited on the calculator, which survives; caused by the model that no longer exists.
        introducedBy: { file: deleted, line, anchor: "class Order" },
      },
    ]);

    expect(printed).toContain("1 of 1 survived");
    expect(printed).toContain(
      `introduced by: ${deleted}:${line}  (deleted by this pull request; the line is in the base)`,
    );
  });

  test("is a no-op on an empty findings list", () => {
    changeCalculator();

    const printed = gate([]);

    expect(printed).toContain("0 of 0 survived verification against");
    expect(printed).toContain("dropped  0");
    expect(printed).toContain("none survived verification");
  });

  test("tears the session down once the findings have been gated", () => {
    changeCalculator();
    capture(() => reviewCommand(repo, undefined, { workflow: false }));
    expect(existsSync(sessionDirOf(repo))).toBe(true);

    writeFileSync(findingsPathOf(repo), `${JSON.stringify({ findings: [] })}\n`);
    capture(() => reviewCommand(repo, undefined, { findings: findingsPathOf(repo) }));

    expect(existsSync(sessionDirOf(repo))).toBe(false);
  });
});

/**
 * The spines section of the brief: layer 2's curated half, printed beside the generated half.
 *
 * It exists because the graph cannot say what must still be true once a change lands, nor what
 * nothing asserts, and a review that reports only reach reports half the risk. Three separate
 * reasons put a change on a spine and they are reported apart on purpose, so each case below drives
 * one of them rather than asserting that some spine was mentioned.
 *
 * The `pricing` spine of the acme fixture is the one to use throughout: it guards
 * `apps/api/app/Libraries/Price/**`, runs four hops through two files, lists exactly one invariant
 * with a citation and one without, and records `checkout` as a flow it knows nothing asserts. Every
 * asymmetry this section prints has a fixture that shows both halves.
 */
describe("the spines a change is on", () => {
  const SPINE_PATH = ".empo/spines/pricing.json";
  const CHECKOUT_CONTROLLER_FILE = "apps/api/app/Http/Controllers/CheckoutController.php";
  const API_ROUTES_FILE = "apps/api/routes/api.php";
  const ORDER_CONTROLLER_FILE = "apps/api/app/Http/Controllers/OrderController.php";
  const COMPOSER_FILE = "apps/api/composer.json";

  /**
   * The trap's file with the anchor text edited away and nothing else moved: the comment is still
   * on line 15, so the coordinate is intact and only the quoted source is gone. That is hard drift
   * rather than a moved anchor, and the whole point of this section is that the two are not
   * reported the same way.
   */
  const CHECKOUT_WITHOUT_THE_TRAP_ANCHOR = [
    "<?php",
    "",
    "namespace Acme\\Http\\Controllers;",
    "",
    "use Acme\\Libraries\\Price\\PriceCalculator;",
    "",
    "class CheckoutController",
    "{",
    "    private PriceCalculator $prices;",
    "",
    "    public function confirm(PriceCalculator $prices): string",
    "    {",
    "        $this->prices = $prices;",
    "",
    "        // the mail goes out later, from the queue worker",
    "        return 'confirmed';",
    "    }",
    "}",
  ];

  function brief(): string {
    return capture(() => reviewCommand(repo, undefined, { workflow: false }));
  }

  function briefJson(): {
    spinesCurated: number;
    spines: {
      name: string;
      path: string;
      guarded: { path: string; movedTo: string | null }[];
      onChain: string[];
      flows: string[];
    }[];
  } {
    return JSON.parse(
      capture(() => reviewCommand(repo, undefined, { json: true, workflow: false })),
    );
  }

  /**
   * The spines section on its own, from its heading to the next section's. The brief prints file
   * paths, flow names and coordinates in four other sections, so matching against the whole output
   * would let an assertion here pass on a line that is not part of the answer under test.
   */
  function spinesBlock(printed: string): string {
    const lines = printed.split("\n");
    const start = lines.findIndex((line) => line.startsWith("spines touched  "));
    if (start === -1) throw new Error("the brief printed no spines section");
    const end = lines.findIndex(
      (line, index) => index > start && line.startsWith("tests that reach the changed code"),
    );
    return lines.slice(start, end === -1 ? undefined : end).join("\n");
  }

  /**
   * A change to a file the graph does not hold and no spine claims. composer.json is under a root
   * but is not a php file, so it is no node, reaches no flow, matches no `guarded` glob and is
   * cited by no hop or trap: all three reasons absent at once, which is what the "nothing touched"
   * cases need and what changing any php file would spoil.
   */
  function changeComposer(): void {
    const path = join(repo, COMPOSER_FILE);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.description = "The acme-platform order and checkout API, second edition";
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  test("names the spine, its file, the guarded path and what empo check will want, when a guarded file changes", () => {
    changeCalculator();

    const block = spinesBlock(brief());

    expect(block).toContain("spines touched  1 of 1");
    expect(block).toContain(`pricing  ${SPINE_PATH}`);
    expect(block).toContain(
      "principle  Every hop copies the subtotal forward, and nothing between the route and the " +
        "response asserts the total still holds.",
    );
    expect(block).toContain(`guarded  ${CALCULATOR_FILE}`);
    // The reviewer is told the gate's own rule, in the gate's own words, so the review and the
    // commit hook cannot disagree about what would satisfy this spine.
    expect(block).toContain(
      'empo check wants an added test line using "assertSame(" or "assertEqualsWithDelta("',
    );
  });

  test("names the test files a spine scopes itself to, in the gate's own words", () => {
    // Third surface, one sentence. `empo check` fails a change that asserts outside a spine's
    // `assertionPaths`, so a brief that told the reviewer any test file would do would be telling
    // them something the gate will refuse an hour later.
    const spine = JSON.parse(readFileSync(join(repo, SPINE_PATH), "utf8")) as Record<
      string,
      unknown
    >;
    spine.assertionPaths = ["apps/api/tests/Feature/OrderTest.php"];
    writeFileSync(join(repo, SPINE_PATH), `${JSON.stringify(spine, null, 2)}\n`);
    changeCalculator();

    expect(spinesBlock(brief())).toContain(
      'empo check wants an added test line using "assertSame(" or "assertEqualsWithDelta(" in ' +
        "apps/api/tests/Feature/OrderTest.php",
    );
  });

  test("names a spine whose guarded file this change renames out of the guarded tree", () => {
    // The brief and the gate ask through one function on purpose (engine/guard.ts `guardedTouches`),
    // so this is the review half of the `empo check` rename fix: a move the gate now fails must not
    // be a move the brief stays silent about, or a reader is told the change is on no chain and the
    // commit is then refused. Printed the same way in both places, guarded spelling first.
    //
    // `diff.renames` is set here rather than inherited from the machine: it defaults to true but is
    // a documented user setting, and with it off git records delete + add, the brief still names the
    // spine (through the delete half's old path) and prints no destination. A spec about the printed
    // destination has to decide for itself which of the two git will record, so it does, and then
    // asserts git really did record the rename.
    const moved = "apps/api/app/Support/PriceCalculator.php";
    git(repo, ["config", "--local", "diff.renames", "true"]);
    mkdirSync(join(repo, "apps/api/app/Support"), { recursive: true });
    git(repo, ["mv", CALCULATOR_FILE, moved]);

    expect(run(repo, "git", ["diff", "--name-status", "main"]).stdout).toContain("R");

    const block = spinesBlock(brief());

    expect(block).toContain("spines touched  1 of 1");
    expect(block).toContain(
      `guarded  ${CALCULATOR_FILE} -> ${moved}  (moved out of the guarded tree)`,
    );
  });

  test("marks only the hops whose file this diff changes, so the reader is shown where on the chain they are", () => {
    changeCalculator();

    const hops = spinesBlock(brief())
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("hop "));

    // All four, in the spine's order: a section that printed only the changed hops would hide the
    // chain, and the chain is the thing the author is being asked to read.
    expect(hops).toHaveLength(4);
    expect(hops[0]).toContain(API_ROUTES_FILE);
    expect(hops[1]).toContain(ORDER_CONTROLLER_FILE);
    expect(hops[0]).not.toContain("CHANGED BY THIS DIFF");
    expect(hops[1]).not.toContain("CHANGED BY THIS DIFF");
    expect(hops[2]).toContain(`${CALCULATOR_FILE}:13  CHANGED BY THIS DIFF`);
    expect(hops[3]).toContain("CHANGED BY THIS DIFF");
  });

  test("prints a cited invariant's coordinate and marks an uncited one PROSE ONLY, because only one of them is checkable", () => {
    changeCalculator();

    const lines = spinesBlock(brief()).split("\n");
    const cited = lines.findIndex((line) => line.trim().startsWith("invariant 1  "));
    const prose = lines.findIndex((line) => line.trim().startsWith("invariant 2  "));

    expect(cited).toBeGreaterThan(-1);
    expect(prose).toBeGreaterThan(-1);
    // Asserted on the line that follows each invariant rather than on the block as a whole, or a
    // section that printed both verdicts under one invariant would pass this.
    expect(lines[cited + 1]).toContain(`asserted at ${ORDER_TEST_FILE}:15`);
    expect(lines[cited + 1]).not.toContain("PROSE ONLY");
    expect(lines[prose + 1]).toContain(
      "PROSE ONLY: nothing asserts this, so only reading catches a break",
    );
  });

  test("marks a reached flow the spine records as unguarded, so a blind chain is not read as a covered one", () => {
    changeCalculator();

    const flows = spinesBlock(brief())
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("flow "));

    expect(flows).toContain(
      "flow checkout  UNGUARDED: this spine records that no test asserts a value on it",
    );
    // The other flow the change reaches is on the same spine and carries no mark, which is what
    // makes the mark mean something.
    expect(flows).toContain("flow orders");
  });

  /**
   * The load-bearing case, and the same asymmetry the findings gate runs on: quoted source that
   * merely moved is worth reading and is printed at the line it is really on, while a coordinate
   * whose quoted source is nowhere is not a coordinate at all and is labelled rather than offered.
   *
   * Both drifts are caused by editing the code under review and never by editing the spine, which
   * is the situation a review is for: the map is the team's, the code is this change's.
   */
  test("corrects a hop whose anchor moved and labels a trap whose anchor is nowhere, rather than printing either as fact", () => {
    changeCalculator();
    writeFileSync(
      join(repo, CHECKOUT_CONTROLLER_FILE),
      `${CHECKOUT_WITHOUT_THE_TRAP_ANCHOR.join("\n")}\n`,
    );

    const block = spinesBlock(brief());
    // Where the added discount method pushed the tax hop's anchor to. The spine still says 18.
    const moved = lineOf("intdiv($subtotal * self::TAX_RATE_BASIS_POINTS");
    expect(moved).not.toBe(18);

    expect(block).toContain(
      `hop 3  tax applied  ${CALCULATOR_FILE}:${moved}  ` +
        "(the spine says :18; the anchor moved, empo verify has the rest)",
    );
    // The repaired line is offered instead of the stale one, not beside it.
    expect(block).not.toContain(`hop 3  tax applied  ${CALCULATOR_FILE}:18`);

    expect(block).toContain(
      `${CHECKOUT_CONTROLLER_FILE}:15  ANCHOR NOWHERE: do not trust this coordinate, run empo verify`,
    );
    // A hard-drifted coordinate is never quietly corrected: there is no line to correct it to.
    expect(block).not.toContain(`${CHECKOUT_CONTROLLER_FILE}:15  (the spine says`);
    // The spine's other trap still resolves, so the label above is about one coordinate and not
    // about the review having lost the file.
    expect(block).toContain("apps/api/app/Observers/OrderObserver.php:11");
    expect(block).not.toContain("apps/api/app/Observers/OrderObserver.php:11  ANCHOR NOWHERE");
  });

  test("says no spine claims this change, and still prints the denominator, so silence is not read as absence of spines", () => {
    changeComposer();

    const block = spinesBlock(brief());

    expect(block).toContain("spines touched  0 of 1");
    expect(block).toContain("no spine claims a file or a flow this change touches");
    expect(block).not.toContain("this repository curates no spine");
    expect(block).not.toContain(SPINE_PATH);
  });

  test("says the repository curates no spine at all, which is a different answer from no spine matching", () => {
    rmSync(join(repo, ".empo/spines"), { recursive: true, force: true });
    git(repo, ["add", "-A", "-f"]);
    commit(repo, "drop the curated spine");
    changeCalculator();

    const block = spinesBlock(brief());

    expect(block).toContain("spines touched  0 of 0");
    expect(block).toContain(
      "this repository curates no spine, so nothing here is claimed either way",
    );
    expect(block).not.toContain("no spine claims a file or a flow this change touches");
  });

  test("carries spinesCurated beside spines under --json, and keeps it non-zero when the list is empty", () => {
    // The untouched case first, while nothing on the chain has been edited yet. Both answers say
    // `spines: []`, and only the denominator tells a caller which of the two it is holding.
    changeComposer();
    const untouched = briefJson();

    expect(untouched.spines).toEqual([]);
    expect(untouched.spinesCurated).toBe(1);

    changeCalculator();
    const touched = briefJson();

    expect(touched.spinesCurated).toBe(1);
    expect(touched.spines.map((entry) => entry.name)).toEqual(["pricing"]);
    expect(touched.spines[0]?.path).toBe(SPINE_PATH);
    expect(touched.spines[0]?.guarded).toEqual([{ path: CALCULATOR_FILE, movedTo: null }]);
    expect(touched.spines[0]?.onChain).toEqual([CALCULATOR_FILE]);
    expect(touched.spines[0]?.flows).toEqual(["checkout", "orders"]);
  });
});

describe("the session directory", () => {
  interface BriefJson {
    diffPath: string;
    findingsPath: string;
    readRoot: string;
  }
  interface GateJson {
    readRoot: string;
    kept: { finding: { id: string } }[];
    dropped: { finding: { id: string }; reason: string }[];
  }

  function brief(dir: string): BriefJson {
    return JSON.parse(
      capture(() => reviewCommand(dir, undefined, { json: true, workflow: false })),
    ) as BriefJson;
  }

  test("names the directory after the id and the repository it belongs to", () => {
    changeCalculator();

    const first = brief(repo);

    expect(dirname(first.findingsPath)).toBe(sessionDirOf(repo));
    // The id stays readable in the name: a human told to write findings into this directory has to
    // be able to recognise it, and the digest alone would name nothing.
    expect(basename(dirname(first.findingsPath))).toMatch(/^local-[0-9a-f]{8}$/);
    expect(dirname(first.diffPath)).toBe(sessionDirOf(repo));
    expect(existsSync(join(sessionDirOf(repo), "session.json"))).toBe(true);
    expect(existsSync(first.diffPath)).toBe(true);
  });

  test("keeps two repositories reviewed under the same id apart", () => {
    changeCalculator();
    const other = makeRepo();
    writeCalculator(other, OTHER_CALCULATOR);

    const first = brief(repo);
    const second = brief(other);

    // Both reviews are local, so both are the id "local". The directories may still not be one
    // directory: the second review would otherwise have deleted the first one's session to make it.
    expect(dirname(second.findingsPath)).not.toBe(dirname(first.findingsPath));
    expect(existsSync(join(dirname(first.findingsPath), "session.json"))).toBe(true);
    expect(existsSync(first.diffPath)).toBe(true);

    writeFileSync(
      first.findingsPath,
      `${JSON.stringify({ findings: [realFinding()] }, null, 2)}\n`,
    );
    const gated = JSON.parse(
      capture(() => reviewCommand(repo, undefined, { json: true, findings: first.findingsPath })),
    ) as GateJson;

    // The whole reason this matters: the gate recovers its read root from the session file, so a
    // shared directory means the first repository's finding is verified against the second one's
    // source, where its anchor is nowhere, and a real finding is dropped as fabricated.
    expect(gated.readRoot).toBe(repo);
    expect(gated.kept.map((row) => row.finding.id)).toEqual(["F1"]);
    expect(gated.dropped).toEqual([]);
  });
});

describe("exit codes", () => {
  test("refuses a findings path that does not exist, with exit code 2", () => {
    const missing = join(repo, "nowhere/findings.json");

    const error = expectEmpoError(2, () =>
      capture(() => reviewCommand(repo, undefined, { findings: missing })),
    );

    expect(error.message).toContain(missing);
  });

  /**
   * The order is the property, not the refusal. `--post` on a forge that cannot post always failed;
   * it failed after the whole discipline had run and every verified finding was already on screen,
   * from inside the posting loop. So each of these asserts what was printed before the throw as well
   * as the throw itself, because a test that only caught the error would pass on the old behaviour.
   */
  test("refuses --post before the brief runs when no forge is configured, with exit code 2", () => {
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.join(" "));
    });

    const error = expectEmpoError(2, () => reviewCommand(repo, undefined, { post: true }));

    expect(error.message).toContain("cannot post");
    // Exit 2 and not 3: with nothing in adapters.forge this is a config gap the author closes.
    expect(error.details.join("\n")).toContain("Drop --post");
    expect(printed).toEqual([]);
  });

  /**
   * The exit code comes off the adapter that refuses and never off what is written in config, which
   * is what keeps it the code that adapter's own throw would have produced. A configured forge that
   * degraded to `local` is refused exactly as an unconfigured one is, because the thing with nowhere
   * to post is the same thing in both, and a run reading the working diff is the author's config to
   * fix rather than their machine's.
   */
  test("refuses --post as a config error when a configured forge degraded to local", () => {
    configureAdapters(repo, { forge: { kind: "mcp", host: "bitbucket" } });

    const error = expectEmpoError(2, () =>
      capture(() => reviewCommand(repo, undefined, { post: true, workflow: false })),
    );

    // Named for the adapter that refused, not for the kind in config: with no pull request the mcp
    // forge was never consulted, and telling this author "the bitbucket forge" would send them to
    // debug a host this run never reached.
    expect(error.message).toContain("The local forge cannot post");
    // The capability set it does declare, so the reader can see `post` is the one absent from it.
    expect(error.details.join("\n")).toContain("It declares: diff");
    // The note, which is the only line saying this is not the forge that was configured.
    expect(error.details.join("\n")).toContain("no pull request was named");
  });

  test("refuses --post even when nothing survived verification and there was nothing to post", () => {
    // The case that used to print "posted 0 finding(s) to local" and exit 0: the loop never called
    // the adapter, so nothing refused, and a run that could not have posted reported that it had.
    capture(() => reviewCommand(repo, undefined, { workflow: false }));
    const path = findingsPathOf(repo);
    writeFileSync(path, `${JSON.stringify({ findings: [] }, null, 2)}\n`);

    const error = expectEmpoError(2, () =>
      capture(() => reviewCommand(repo, undefined, { findings: path, post: true })),
    );

    expect(error.message).toContain("cannot post");
  });

  test("refuses --post in the gate phase before it has posted anything", () => {
    capture(() => reviewCommand(repo, undefined, { workflow: false }));
    const path = findingsPathOf(repo);
    writeFileSync(path, `${JSON.stringify({ findings: [realFinding()] }, null, 2)}\n`);

    // The brief is what wrote the session, so posting is refused on a review that got all the way
    // to having verified findings: the refusal is about the forge and never about the findings.
    const error = expectEmpoError(2, () =>
      capture(() => reviewCommand(repo, undefined, { findings: path, post: true })),
    );

    expect(error.message).toContain("cannot post");
  });

  test("refuses --post together with --readonly, with exit code 2", () => {
    const error = expectEmpoError(2, () =>
      capture(() => reviewCommand(repo, undefined, { post: true, readonly: true })),
    );

    expect(error.message).toContain("contradict");
  });

  test("refuses a findings file that is not valid JSON, with exit code 2", () => {
    const broken = join(repo, "findings.json");
    writeFileSync(broken, "{ not json");

    const error = expectEmpoError(2, () =>
      capture(() => reviewCommand(repo, undefined, { findings: broken })),
    );

    expect(error.message).toContain("is not valid JSON");
  });
});

describe("reviewableFiles", () => {
  function changed(path: string): ChangedFile {
    return {
      path,
      oldPath: null,
      status: "modified",
      hunks: [],
      addedCount: 0,
      removedCount: 0,
      isBinary: false,
    };
  }

  test("skips what empo index owns and keeps everything a human wrote", () => {
    const result = reviewableFiles(
      [
        ".empo/generated/graph.json",
        ".empo/generated/packs.lock.json",
        ".empo/config.json",
        ".empo/conventions.md",
        CALCULATOR_FILE,
      ].map(changed),
    );

    expect(result.files.map((file) => file.path)).toEqual([
      ".empo/config.json",
      ".empo/conventions.md",
      CALCULATOR_FILE,
    ]);
    expect(result.skipped).toEqual([
      ".empo/generated/graph.json",
      ".empo/generated/packs.lock.json",
    ]);
  });

  test("keeps a generated path that is not the repo root's", () => {
    // `.empo/` is a single directory at the target repo root (docs/02-on-disk-layout.md), so the
    // rule is anchored there. A directory of that name inside an app is somebody's real file.
    const result = reviewableFiles([changed("apps/api/.empo/generated/graph.json")]);

    expect(result.files.map((file) => file.path)).toEqual(["apps/api/.empo/generated/graph.json"]);
    expect(result.skipped).toEqual([]);
  });
});

/**
 * Which of a file's exports a diff actually touched.
 *
 * The rule under test is a refusal as much as a narrowing: it names fewer exports only when every
 * changed line is attributable, because the extents are a line partition rather than a parse and a
 * review that drops the symbol a change really touched is worse than one naming too many
 * (docs/14-implementation-notes.md).
 */
describe("narrowToChangedLines", () => {
  function node(symbol: string, extents?: { start: number; end: number }[]): GraphNode {
    return {
      id: `src/money.ts#${symbol}`,
      file: "src/money.ts",
      root: ".",
      lang: "typescript",
      kind: "module",
      name: symbol,
      symbol,
      produces: [],
      consumes: [],
      isTest: false,
      assertsValue: false,
      extents,
    };
  }

  /** One hunk, `added` holding the new-file line numbers it writes. */
  function changedAt(added: number[], newStart = added[0] ?? 1): ChangedFile {
    return {
      path: "src/money.ts",
      oldPath: null,
      status: "modified",
      hunks: [
        {
          oldStart: newStart,
          oldLines: added.length,
          newStart,
          newLines: added.length,
          added: added.map((line) => ({ line, text: "  return 0;" })),
          removed: [],
        },
      ],
      addedCount: added.length,
      removedCount: 0,
      isBinary: false,
    };
  }

  const formatMoney = node("formatMoney", [{ start: 1, end: 4 }]);
  const parseMoney = node("parseMoney", [{ start: 5, end: 7 }]);

  test("keeps only the export whose lines the diff touched", () => {
    const narrowed = narrowToChangedLines([formatMoney, parseMoney], changedAt([6]));

    expect(narrowed.map((entry) => entry.symbol)).toEqual(["parseMoney"]);
  });

  test("keeps both when the diff touches both", () => {
    const narrowed = narrowToChangedLines([formatMoney, parseMoney], changedAt([2, 6]));

    expect(narrowed.map((entry) => entry.symbol)).toEqual(["formatMoney", "parseMoney"]);
  });

  test("matches a name on either of the extents it owns", () => {
    // Declaration merging: one node, two disjoint runs of lines, and an edit to the second one is
    // an edit to that name and not to whatever is declared above it.
    const merged = node("Money", [
      { start: 1, end: 3 },
      { start: 8, end: 10 },
    ]);
    const between = node("format", [{ start: 4, end: 7 }]);

    expect(narrowToChangedLines([merged, between], changedAt([9])).map((n) => n.symbol)).toEqual([
      "Money",
    ]);
  });

  test("refuses to narrow when a changed line falls outside every extent", () => {
    // The import block: written above every declaration, enclosed by nothing, and the case this
    // fallback exists for.
    const narrowed = narrowToChangedLines([formatMoney, parseMoney], changedAt([1, 6], 1));
    const importEdit = narrowToChangedLines(
      [node("formatMoney", [{ start: 3, end: 5 }]), node("parseMoney", [{ start: 6, end: 8 }])],
      changedAt([1]),
    );

    expect(narrowed.map((entry) => entry.symbol)).toEqual(["formatMoney", "parseMoney"]);
    expect(importEdit.map((entry) => entry.symbol)).toEqual(["formatMoney", "parseMoney"]);
  });

  function deletionAt(removed: number[]): ChangedFile {
    const file = changedAt([]);
    file.hunks = [
      {
        oldStart: removed[0] ?? 1,
        oldLines: removed.length,
        newStart: removed[0] ?? 1,
        newLines: 0,
        added: [],
        removed: removed.map((line) => ({ line, text: "  return 0;" })),
      },
    ];
    return file;
  }

  test("attributes a deletion by the lines it cut", () => {
    // A hunk that only deletes writes no new line to narrow by, and answering it with whatever
    // survived around the cut would report the blast radius of the code that did not change.
    const narrowed = narrowToChangedLines([formatMoney, parseMoney], deletionAt([5, 6, 7]));

    expect(narrowed.map((entry) => entry.symbol)).toEqual(["parseMoney"]);
  });

  test("refuses to narrow when a cut line lies past every extent", () => {
    // Deleting the last export of a file: the lines it held are beyond anything the indexed file
    // spans, so nothing owns them and the whole file answers.
    const narrowed = narrowToChangedLines([formatMoney, parseMoney], deletionAt([8, 9]));

    expect(narrowed.map((entry) => entry.symbol)).toEqual(["formatMoney", "parseMoney"]);
  });

  test("refuses to narrow a graph written before extents were recorded", () => {
    // A schema 7 graph, or any pack that ids by file or by class. Absent lines are not "spans
    // nothing": defaulting them that way would answer an empty blast radius for a real change.
    const narrowed = narrowToChangedLines(
      [node("formatMoney"), node("parseMoney")],
      changedAt([6]),
    );

    expect(narrowed.map((entry) => entry.symbol)).toEqual(["formatMoney", "parseMoney"]);
  });

  test("leaves a file that yields one node alone", () => {
    expect(narrowToChangedLines([formatMoney], changedAt([99]))).toEqual([formatMoney]);
  });
});

/**
 * A brief over a graph whose ids name exported symbols rather than files.
 *
 * The acme fixture cannot ask this question: it is php under a pack that ids by class, where a file
 * is always one node, so every count in the brief is the same whether it folds per file or per node.
 * The symbol fixture is TypeScript, and its `src/money.ts` exports two functions.
 *
 * The graph is written rather than indexed, because the shipped TypeScript pack still ids by module
 * path. What is under test here is the brief's folding, which reads a graph and never builds one, so
 * handing it the graph the pack will produce is the honest input and not a stand-in for one.
 */
describe("a changed file that holds several exports", () => {
  const symbolFixture = fileURLToPath(new URL("../../fixtures/symbol-fixture", import.meta.url));

  const MONEY = "src/money.ts";
  const SETUP_TEST = "src/setup.test.ts";

  function symbolNode(
    file: string,
    symbol: string,
    isTest = false,
    extents?: { start: number; end: number }[],
  ): GraphNode {
    return {
      extents,
      id: `${file}#${symbol}`,
      file,
      root: ".",
      lang: "typescript",
      kind: "module",
      name: symbol,
      symbol,
      produces: [],
      consumes: [],
      isTest,
      assertsValue: isTest,
    };
  }

  /**
   * Two exports in the changed file, two in its consumer, and two test cases exported from one test
   * file. Every pair is there to catch a printer that still counts nodes: one blast-radius block, one
   * row of export names, and one line naming the test file.
   */
  function symbolGraph(): Graph {
    const nodes = [
      // The extents of the fixture's own src/money.ts, so a diff can be narrowed to one of the two
      // exports. Only this file carries them: the others are never the file under the edit here.
      symbolNode(MONEY, "formatMoney", false, [{ start: 1, end: 4 }]),
      symbolNode(MONEY, "parseMoney", false, [{ start: 5, end: 7 }]),
      symbolNode("src/total.ts", "LABEL"),
      symbolNode("src/total.ts", "total"),
      symbolNode(SETUP_TEST, "addsUp", true),
      symbolNode(SETUP_TEST, "formats", true),
    ];
    const edge = (from: string, to: string, file: string, line: number): GraphEdge => ({
      from,
      to,
      kind: "import",
      symbol: null,
      evidence: { file, line },
    });

    return {
      schema: GRAPH_SCHEMA,
      builtAgainst: "",
      builtAtCommitSubject: "",
      roots: [{ path: ".", lang: "typescript" }],
      packs: { typescript: loadPack("typescript").version },
      stats: { files: 3, nodes: nodes.length, edges: 4, bridgedEdges: 0 },
      nodes,
      edges: [
        edge("src/total.ts#total", `${MONEY}#formatMoney`, "src/total.ts", 1),
        edge("src/total.ts#total", `${MONEY}#parseMoney`, "src/total.ts", 1),
        edge(`${SETUP_TEST}#addsUp`, "src/total.ts#total", SETUP_TEST, 1),
        edge(`${SETUP_TEST}#formats`, "src/total.ts#total", SETUP_TEST, 1),
      ],
      flows: { checkout: ["src/total.ts#total"] },
      fanin: {
        [`${MONEY}#formatMoney`]: 1,
        [`${MONEY}#parseMoney`]: 1,
        "src/total.ts#total": 2,
      },
      coverage: {
        checkout: {
          flow: "checkout",
          testNodes: [`${SETUP_TEST}#addsUp`, `${SETUP_TEST}#formats`],
          testFiles: [SETUP_TEST],
          reaches: true,
          assertsValue: true,
          blind: false,
        },
      },
      hazards: [],
      hazardsScanned: [],
      names: [],
      fanout: [],
      permanentFailures: [],
    };
  }

  function symbolRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "empo-review-symbol-"));
    repos.push(dir);
    cpSync(symbolFixture, dir, { recursive: true });
    mkdirSync(dirname(graphPath(dir)), { recursive: true });
    writeFileSync(graphPath(dir), serializeGraph(symbolGraph()));

    git(dir, ["init", "-b", "main"]);
    git(dir, ["add", "-A", "-f"]);
    commit(dir, "the fixture as it stands");
    return dir;
  }

  test("prints one blast radius per changed file, not one per export", () => {
    const dir = symbolRepo();
    writeFileSync(join(dir, MONEY), "export function formatMoney(): string {\n  return '0';\n}\n");

    const printed = capture(() => reviewCommand(dir, undefined, { workflow: false }));

    // Two nodes changed and one block printed, whose fan-in is the union: the direct count is the
    // one file that imports both names and not the two edges it wrote, and the transitive count is
    // that file's export plus the two test cases above it.
    expect(printed.match(/fan-in/g)?.length).toBe(1);
    expect(printed).toContain("fan-in 1 direct, 3 transitive");
  });

  test("names the exports on the changed-files row, since the path is already there", () => {
    const dir = symbolRepo();
    writeFileSync(join(dir, MONEY), "export function formatMoney(): string {\n  return '0';\n}\n");

    const printed = capture(() => reviewCommand(dir, undefined, { workflow: false }));
    const row = printed
      .split("\n")
      .find((line) => line.trimStart().startsWith("modified") && line.includes(MONEY));

    expect(row ?? "").toContain("formatMoney, parseMoney");
  });

  test("reports the export the diff touched, not every export the file holds", () => {
    const dir = symbolRepo();
    const source = readFileSync(join(dir, MONEY), "utf8").split("\n");
    // Line 6 only: the body of parseMoney, which is the second of the file's two exports.
    source[5] = "  return Math.round(Number(text) * 1000);";
    writeFileSync(join(dir, MONEY), source.join("\n"));

    const printed = capture(() => reviewCommand(dir, undefined, { workflow: false }));
    const row = printed
      .split("\n")
      .find((line) => line.trimStart().startsWith("modified") && line.includes(MONEY));

    expect(row ?? "").toContain("1 of 2 exports: parseMoney");
    // The fan-in is that one export's, not the union of the file's: only src/total.ts imports it.
    expect(printed).toContain("fan-in 1 direct, 3 transitive");
  });

  test("names a test file once however many test nodes it exports", () => {
    const dir = symbolRepo();
    writeFileSync(join(dir, MONEY), "export function formatMoney(): string {\n  return '0';\n}\n");

    const printed = capture(() => reviewCommand(dir, undefined, { workflow: false }));

    expect(printed.match(/src\/setup\.test\.ts/g)?.length).toBe(1);
    expect(printed).toContain(`${SETUP_TEST}  asserts a value`);
  });
});

/**
 * The scheduler as an entrypoint, in the brief. Two facts and neither is a finding: this changed
 * file is reached from a scheduled entry, and it dispatches from inside a loop. Both are printed for
 * the reviewing model to ask the cardinality question about; neither reaches the author except
 * through the gate every other finding goes through.
 *
 * The command is committed and indexed first and only then edited, because "a changed file that is
 * reachable from the scheduler" is the case under test and a file that is new in the diff is not
 * yet in anybody's graph.
 */
describe("a changed file the scheduler reaches", () => {
  const COMMAND_FILE = "apps/api/app/Console/Commands/ReconcileCommand.php";

  function commandSource(body: string): string {
    return [
      "<?php",
      "",
      "namespace Acme\\Console\\Commands;",
      "",
      "class ReconcileCommand",
      "{",
      "    protected $signature = 'acme:reconcile {--force}';",
      "",
      "    public function handle(): void",
      "    {",
      body,
      "    }",
      "}",
      "",
    ].join("\n");
  }

  function scheduleTheCommand(): void {
    mkdirSync(join(repo, "apps/api/app/Console/Commands"), { recursive: true });
    writeFileSync(
      join(repo, "apps/api/app/Console/Kernel.php"),
      [
        "<?php",
        "",
        "namespace Acme\\Console;",
        "",
        "class Kernel",
        "{",
        "    protected function schedule($schedule): void",
        "    {",
        "        $schedule->command('acme:reconcile --force')->dailyAt('03:20');",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(repo, COMMAND_FILE), commandSource("        $this->reconcile();"));
    git(repo, ["add", "-A", "-f"]);
    commit(repo, "schedule the reconcile command");
    capture(() => indexCommand(repo));
  }

  test("the brief names the scheduler entry that reaches it, and cites the scheduled line", () => {
    scheduleTheCommand();
    writeFileSync(join(repo, COMMAND_FILE), commandSource("        $this->reconcileEverything();"));

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));
    const row = printed
      .split("\n")
      .find((line) => line.trimStart().startsWith("join scheduled-command"));

    // The near end is the Kernel and the far end is the command, and the citation is the scheduler
    // line itself: that is where the cadence is written, which the graph does not carry, so the row
    // sends the reader to the one line that states it.
    expect(row).toBeDefined();
    expect(row ?? "").toContain(
      "Acme\\Console\\Kernel consumes Acme\\Console\\Commands\\ReconcileCommand",
    );
    expect(row ?? "").toMatch(/named at apps\/api\/app\/Console\/Kernel\.php:9$/);
  });

  /** The loop written into the working tree, and the graph rebuilt over it. */
  function dispatchInALoop(): void {
    writeFileSync(
      join(repo, COMMAND_FILE),
      commandSource(
        [
          "        foreach ($members as $member) {",
          "            SyncMember::dispatch($member);",
          "        }",
        ].join("\n"),
      ),
    );
    // Reindexed, because every fact in the brief is a fact about the indexed graph and this one is
    // no exception: a loop that exists only in an uncommitted edit no run has read is a loop the
    // graph does not hold, and the brief prints the staleness of its own source under every section.
    capture(() => indexCommand(repo));
  }

  test("a dispatch inside a loop in the changed file is stated, and stated as a question", () => {
    scheduleTheCommand();
    dispatchInALoop();

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));

    expect(printed).toContain("dispatches inside a loop");
    expect(printed).toContain(`${COMMAND_FILE}:12  dispatches SyncMember  loop opened at line 11`);
    // The sentence under the coordinate, because the coordinate alone reads as an accusation and
    // this axis accuses nobody: it is the cardinality question, put where the diff is being read.
    expect(printed).toContain("How often the loop runs is a property of the data");
  });

  test("neither fact is worded as a finding, and neither reaches the author on its own", () => {
    scheduleTheCommand();
    dispatchInALoop();

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));

    // The brief is facts and the findings file is where a claim about the pull request goes. Phase 1
    // writes no finding at all, so a fan-out line can only reach the author by an agent making the
    // claim itself and putting it through the gate, like every other finding.
    expect(existsSync(findingsPathOf(repo))).toBe(false);
    for (const word of ["unbounded", "too many", "risk", "must fix"]) {
      expect(printed.toLowerCase()).not.toContain(`loop  ${word}`);
    }
  });

  test("the consumer row calls a join a join, the word the rest of the block uses", () => {
    scheduleTheCommand();
    writeFileSync(join(repo, COMMAND_FILE), commandSource("        $this->reconcileEverything();"));

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));
    const row = printed
      .split("\n")
      .find((line) => line.trimStart().startsWith("consumer Acme\\Console\\Kernel"));

    // `bridge` is the edge kind on disk and stays one. It is not a word the reader is shown, because
    // the two lines under this one say `join` about the same edge.
    expect(row ?? "").toContain("class join");
    expect(row ?? "").not.toContain("bridge");
  });

  /**
   * The hub case. A Kernel schedules every command in the repository, so every one of its joins is
   * in the radius of any single command, and a print cap applied in graph order buries the only row
   * that names the file under review.
   */
  test("the join that names the changed file is printed, not buried under the hub's siblings", () => {
    const siblings = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];
    mkdirSync(join(repo, "apps/api/app/Console/Commands"), { recursive: true });
    for (const name of siblings) {
      writeFileSync(
        join(repo, `apps/api/app/Console/Commands/${name}Command.php`),
        [
          "<?php",
          "",
          "namespace Acme\\Console\\Commands;",
          "",
          `class ${name}Command`,
          "{",
          `    protected $signature = 'acme:${name.toLowerCase()}';`,
          "}",
          "",
        ].join("\n"),
      );
    }
    writeFileSync(
      join(repo, "apps/api/app/Console/Kernel.php"),
      [
        "<?php",
        "",
        "namespace Acme\\Console;",
        "",
        "class Kernel",
        "{",
        "    protected function schedule($schedule): void",
        "    {",
        ...siblings.map((name) => `        $schedule->command('acme:${name.toLowerCase()}');`),
        "        $schedule->command('acme:reconcile --force')->dailyAt('03:20');",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(repo, COMMAND_FILE), commandSource("        $this->reconcile();"));
    git(repo, ["add", "-A", "-f"]);
    commit(repo, "schedule seven commands from one kernel");
    capture(() => indexCommand(repo));
    writeFileSync(join(repo, COMMAND_FILE), commandSource("        $this->reconcileEverything();"));

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));
    const joins = printed
      .split("\n")
      .filter((line) => line.trimStart().startsWith("join scheduled-command"));

    // First row, not merely present: the cap is five and there are seven joins, so a row that sorts
    // on anything but "names the file under review" is a row the reader never sees.
    expect(joins[0] ?? "").toContain("consumes Acme\\Console\\Commands\\ReconcileCommand");
    // And the siblings are demoted, never dropped. They are the Kernel's own joins and the Kernel is
    // in this diff's radius; hiding them would be a different lie from burying the useful one.
    expect(printed).toContain("more symbol joins");
  });

  /**
   * The hop the axis used to stop one short of. What a dispatch does with a failure is written in
   * the handler, and what else feeds that handler is written in another scheduler entry, so a row
   * naming only the call site asks the cardinality question with half the answer out of frame.
   */
  test("the dispatched job is named as a coordinate, with the other scheduled entries that reach it", () => {
    mkdirSync(join(repo, "apps/api/app/Jobs"), { recursive: true });
    mkdirSync(join(repo, "apps/api/app/Console/Commands"), { recursive: true });
    writeFileSync(
      join(repo, "apps/api/app/Jobs/SyncMember.php"),
      ["<?php", "", "namespace Acme\\Jobs;", "", "class SyncMember", "{", "}", ""].join("\n"),
    );
    writeFileSync(
      join(repo, "apps/api/app/Console/Commands/RetryCommand.php"),
      [
        "<?php",
        "",
        "namespace Acme\\Console\\Commands;",
        "",
        "use Acme\\Jobs\\SyncMember;",
        "",
        "class RetryCommand",
        "{",
        "    protected $signature = 'acme:retry';",
        "",
        "    public function handle(): void",
        "    {",
        "        SyncMember::dispatch($this->error);",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(repo, "apps/api/app/Console/Kernel.php"),
      [
        "<?php",
        "",
        "namespace Acme\\Console;",
        "",
        "class Kernel",
        "{",
        "    protected function schedule($schedule): void",
        "    {",
        "        $schedule->command('acme:reconcile --force')->dailyAt('03:20');",
        "        $schedule->command('acme:retry')->everyFiveMinutes();",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    const dispatching = [
      "<?php",
      "",
      "namespace Acme\\Console\\Commands;",
      "",
      "use Acme\\Jobs\\SyncMember;",
      "",
      "class ReconcileCommand",
      "{",
      "    protected $signature = 'acme:reconcile {--force}';",
      "",
      "    public function handle(): void",
      "    {",
      "        foreach ($members as $member) {",
      "            SyncMember::dispatch($member);",
      "        }",
      "    }",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(repo, COMMAND_FILE), dispatching.replace("$members", "$endingToday"));
    git(repo, ["add", "-A", "-f"]);
    commit(repo, "dispatch the job from a nightly loop and a five-minute retry");
    capture(() => indexCommand(repo));
    writeFileSync(join(repo, COMMAND_FILE), dispatching);
    capture(() => indexCommand(repo));

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));

    // The job as a node and a file, so the reader can go and read what it does with a failure.
    expect(printed).toContain("target Acme\\Jobs\\SyncMember  apps/api/app/Jobs/SyncMember.php");
    // The other entry that feeds the same queue, cited on ITS scheduled line, which is where its
    // cadence is written. This is the row that turns a volume change into a loop.
    expect(printed).toContain(
      "reached from Acme\\Console\\Commands\\RetryCommand  scheduled at apps/api/app/Console/Kernel.php:10",
    );
    // And the changed file's own cadence, which is the half a reader cannot get anywhere else: the
    // loop they just widened runs nightly. Excluding the dispatch site would have dropped exactly
    // the row the shape this axis was written for produces.
    expect(printed).toContain(
      "reached from Acme\\Console\\Commands\\ReconcileCommand  scheduled at apps/api/app/Console/Kernel.php:9",
    );
    // Still not a finding, and still nothing about volume.
    expect(printed).toContain("says nothing about volume");
  });

  /**
   * The far side of the fan-out, and the only fact in the brief about a file the diff never
   * touched. The handler is reached through the dispatch target, and its error handling lives one
   * inheritance hop further, which is where a queued job routinely keeps it.
   */
  test("names what the dispatched job does with a failure it was told would pass", () => {
    mkdirSync(join(repo, "apps/api/app/Jobs"), { recursive: true });
    mkdirSync(join(repo, "apps/api/app/Console/Commands"), { recursive: true });
    writeFileSync(
      join(repo, "apps/api/app/Jobs/AbstractSync.php"),
      [
        "<?php",
        "",
        "namespace Acme\\Jobs;",
        "",
        "abstract class AbstractSync",
        "{",
        "    public function handle(): void",
        "    {",
        "        try {",
        "            $this->run();",
        "        } catch (RateLimitException $e) {",
        "            $this->storeForRetry($e);",
        "            $this->fail($e);",
        "        }",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    // No `use` statement, deliberately: the parent is a sibling in the same namespace, which is the
    // shape php resolves against the current namespace and the `import` rules never see. Without
    // the `inherit` family this edge does not exist and the line under test cannot be reached.
    writeFileSync(
      join(repo, "apps/api/app/Jobs/SyncMember.php"),
      [
        "<?php",
        "",
        "namespace Acme\\Jobs;",
        "",
        "class SyncMember extends AbstractSync",
        "{",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(repo, "apps/api/app/Console/Kernel.php"),
      [
        "<?php",
        "",
        "namespace Acme\\Console;",
        "",
        "class Kernel",
        "{",
        "    protected function schedule($schedule): void",
        "    {",
        "        $schedule->command('acme:reconcile --force')->dailyAt('03:20');",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    const dispatching = [
      "<?php",
      "",
      "namespace Acme\\Console\\Commands;",
      "",
      "use Acme\\Jobs\\SyncMember;",
      "",
      "class ReconcileCommand",
      "{",
      "    protected $signature = 'acme:reconcile {--force}';",
      "",
      "    public function handle(): void",
      "    {",
      "        foreach ($members as $member) {",
      "            SyncMember::dispatch($member);",
      "        }",
      "    }",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(repo, COMMAND_FILE), dispatching.replace("$members", "$endingToday"));
    git(repo, ["add", "-A", "-f"]);
    commit(repo, "dispatch a job whose base class fails on a rate limit");
    capture(() => indexCommand(repo));
    writeFileSync(join(repo, COMMAND_FILE), dispatching);
    capture(() => indexCommand(repo));

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));

    // The line the diff has no reason to lead anybody to: the job the widened loop feeds records a
    // rate limit as a final failure, and it is written in neither changed file.
    expect(printed).toContain(
      "on failure  apps/api/app/Jobs/AbstractSync.php:13  $this->fail()  inside a catch at line 11",
    );
    // And it is still a coordinate, not a verdict: whether the fail is wrong depends on what
    // storeForRetry arranged, which no rule here can see.
    expect(printed).not.toMatch(/on failure.*(?:bug|wrong|must|should)/);
  });

  /**
   * The other side of "one hop": the hop is an inheritance and nothing else. A job imports a dozen
   * helpers and none of them run as the job, so a failure written in one of them printed under the
   * job's name is an attribution to work that never executes it.
   */
  test("a failure in a file the job merely imports is not attributed to the job", () => {
    mkdirSync(join(repo, "apps/api/app/Jobs"), { recursive: true });
    mkdirSync(join(repo, "apps/api/app/Support"), { recursive: true });
    mkdirSync(join(repo, "apps/api/app/Console/Commands"), { recursive: true });
    writeFileSync(
      join(repo, "apps/api/app/Support/Rescue.php"),
      [
        "<?php",
        "",
        "namespace Acme\\Support;",
        "",
        "class Rescue",
        "{",
        "    public function attempt(): void",
        "    {",
        "        try {",
        "            $this->run();",
        "        } catch (RateLimitException $e) {",
        "            $this->fail($e);",
        "        }",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    // An import and not an extends: the only difference between this test and the one above, and
    // the whole of what decides whether the failure belongs to the job.
    writeFileSync(
      join(repo, "apps/api/app/Jobs/SyncMember.php"),
      [
        "<?php",
        "",
        "namespace Acme\\Jobs;",
        "",
        "use Acme\\Support\\Rescue;",
        "",
        "class SyncMember",
        "{",
        "}",
        "",
      ].join("\n"),
    );
    const dispatching = [
      "<?php",
      "",
      "namespace Acme\\Console\\Commands;",
      "",
      "use Acme\\Jobs\\SyncMember;",
      "",
      "class ReconcileCommand",
      "{",
      "    public function handle(): void",
      "    {",
      "        foreach ($members as $member) {",
      "            SyncMember::dispatch($member);",
      "        }",
      "    }",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(repo, COMMAND_FILE), dispatching.replace("$members", "$endingToday"));
    git(repo, ["add", "-A", "-f"]);
    commit(repo, "dispatch a job that imports a helper which fails on a rate limit");
    capture(() => indexCommand(repo));
    writeFileSync(join(repo, COMMAND_FILE), dispatching);
    capture(() => indexCommand(repo));

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));

    // The dispatch is found, so the row exists to attribute anything to at all.
    expect(printed).toContain("dispatches SyncMember");
    expect(printed).not.toContain("apps/api/app/Support/Rescue.php");
  });

  /**
   * The absence the header above cannot carry. A schema 9 graph has `fanout`, so the rows print and
   * the header says nothing; its failure list was never written, and a blank under every row would
   * read as "this job records no final failure" off a scan that never ran.
   */
  test("a graph built before the failure axis says so instead of printing no failures", () => {
    mkdirSync(join(repo, "apps/api/app/Jobs"), { recursive: true });
    mkdirSync(join(repo, "apps/api/app/Console/Commands"), { recursive: true });
    writeFileSync(
      join(repo, "apps/api/app/Jobs/SyncMember.php"),
      ["<?php", "", "namespace Acme\\Jobs;", "", "class SyncMember", "{", "}", ""].join("\n"),
    );
    const dispatching = [
      "<?php",
      "",
      "namespace Acme\\Console\\Commands;",
      "",
      "use Acme\\Jobs\\SyncMember;",
      "",
      "class ReconcileCommand",
      "{",
      "    public function handle(): void",
      "    {",
      "        foreach ($members as $member) {",
      "            SyncMember::dispatch($member);",
      "        }",
      "    }",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(repo, COMMAND_FILE), dispatching.replace("$members", "$endingToday"));
    git(repo, ["add", "-A", "-f"]);
    commit(repo, "dispatch a job from a loop");
    capture(() => indexCommand(repo));
    writeFileSync(join(repo, COMMAND_FILE), dispatching);
    capture(() => indexCommand(repo));

    // The graph a schema 9 build wrote: the fanout axis present, the failure axis never scanned.
    const aged = JSON.parse(readFileSync(graphPath(repo), "utf8")) as Record<string, unknown>;
    aged.schema = GRAPH_SCHEMA - 1;
    delete aged.permanentFailures;
    writeFileSync(graphPath(repo), JSON.stringify(aged));

    const printed = capture(() => reviewCommand(repo, undefined, { workflow: false }));

    expect(printed).toContain("dispatches SyncMember");
    expect(printed).toContain("on failure: unknown, this graph predates the axis. Run empo index.");
  });
});
