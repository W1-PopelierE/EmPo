import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { checkCommand } from "../../src/commands/check";
import { run } from "../../src/engine/git";
import { EmpoError } from "../../src/errors";

/**
 * `empo check` end to end over the acme fixture: the commit gate, judged on a real staged diff.
 *
 * The fixture is not a repository of its own, it lives inside this one, so checking it in place
 * would read EmPo's own staged changes. Every test therefore copies it to a throwaway git
 * repository, commits it, and stages an edit, which is the exact shape of the thing the gate judges.
 *
 * The fixture's one spine, pricing, guards three patterns and counts two assertion terms, and the
 * php pack declares `tests/` as its only test path. Those four facts are what every case below
 * turns on, so each is asserted from the artifact rather than assumed.
 */

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

const SPINE_PATH = ".empo/spines/pricing.json";
const CALCULATOR_FILE = "apps/api/app/Libraries/Price/PriceCalculator.php";
/** Outside every guarded pattern the fixture spine declares, which is what makes a move a move. */
const MOVED_CALCULATOR_FILE = "apps/api/app/Support/PriceCalculator.php";
const ORDER_FILE = "apps/api/app/Models/Order.php";
const OBSERVER_FILE = "apps/api/app/Observers/OrderObserver.php";
const ORDER_TEST_FILE = "apps/api/tests/Feature/OrderTest.php";
/** A real test file in the same tree, about a flow the pricing spine's chain does not run through. */
const CHECKOUT_TEST_FILE = "apps/api/tests/Feature/CheckoutTest.php";
const ORDER_CONTROLLER_FILE = "apps/api/app/Http/Controllers/OrderController.php";
const ADMIN_CONTROLLER_FILE = "apps/api/app/Http/Controllers/AdminController.php";

const TAX_RATE = "private const TAX_RATE_BASIS_POINTS = 2100;";

/** What the fixture spine counts as asserting a value. Anything else added is not evidence. */
const TERMS = ['"assertSame("', '"assertEqualsWithDelta("'];

/**
 * One line holding one of those terms, added in two different files by the scoping test below. It is
 * a comment on purpose: the gate reads text, not meaning, so this is the weakest line that can still
 * satisfy it, and the only thing keeping it from satisfying it everywhere is the test path.
 */
const ASSERTING_LINE = "        // the value is asserted with assertSame( in the feature test";

/** Enough config to load, with no spines directory: the repository that has curated nothing. */
const MINIMAL_CONFIG = {
  version: 1,
  roots: [{ path: ".", lang: "php" }],
  packs: { php: { version: "^1" } },
};

let repo: string;
/** The sha of the commit that holds the fixture untouched, which is what --base compares against. */
let baseSha: string;
const temps: string[] = [];

interface Recorded {
  printed: string;
  thrown: unknown;
}

/** One run of a command, with everything it printed and whatever it threw kept side by side. */
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

  return { printed: lines.join("\n"), thrown };
}

/** Everything the command printed, joined, so a test can look for one line in it. */
function capture(body: () => void): string {
  const { printed, thrown } = record(body);
  if (thrown !== undefined) throw thrown;
  return printed;
}

/**
 * check prints its whole report and then fails the gate, so a test that only caught the error would
 * be blind to the part a human actually reads. Both halves come back from one run.
 */
function expectEmpoError(
  exitCode: number,
  body: () => void,
): { error: EmpoError; printed: string } {
  const { printed, thrown } = record(body);
  expect(thrown, `expected a EmpoError with exit code ${exitCode}`).toBeInstanceOf(EmpoError);
  expect((thrown as EmpoError).exitCode).toBe(exitCode);
  return { error: thrown as EmpoError, printed };
}

function git(args: string[]): string {
  const result = run(repo, "git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** -c on the commit so this passes with no git identity and no signing key configured. */
function commit(message: string): string {
  git([
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
  return git(["rev-parse", "HEAD"]);
}

function stage(...paths: string[]): void {
  git(["add", "-f", ...paths]);
}

function linesOf(path: string): string[] {
  return readFileSync(join(repo, path), "utf8").split("\n");
}

function indexOfAnchor(lines: string[], path: string, anchor: string): number {
  const index = lines.findIndex((line) => line.includes(anchor));
  if (index === -1) throw new Error(`no line of ${path} contains "${anchor}"`);
  return index;
}

/** Add a line just under an existing one, which is the shape of nearly every real edit. */
function insertAfter(path: string, anchor: string, added: string): void {
  const lines = linesOf(path);
  lines.splice(indexOfAnchor(lines, path, anchor) + 1, 0, added);
  writeFileSync(join(repo, path), lines.join("\n"));
}

/**
 * The change the gate exists for: a money value moves, in a file on the spine's critical chain, and
 * nothing anywhere asserts what it is now.
 */
function changeTaxRate(): void {
  const lines = linesOf(CALCULATOR_FILE);
  lines[indexOfAnchor(lines, CALCULATOR_FILE, TAX_RATE)] =
    "    private const TAX_RATE_BASIS_POINTS = 2000;";
  writeFileSync(join(repo, CALCULATOR_FILE), lines.join("\n"));
}

/** An added line in the real test file that asserts an exact value, which is what the gate wants. */
function assertInTest(): void {
  insertAfter(
    ORDER_TEST_FILE,
    "assertSame(1210,",
    "        $this->assertSame(1000, $order->subtotal);",
  );
}

/** A repository with a config and nothing curated, deliberately not a git checkout. */
function repoWithoutSpines(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-check-nospine-"));
  mkdirSync(join(dir, ".empo"), { recursive: true });
  writeFileSync(join(dir, ".empo/config.json"), `${JSON.stringify(MINIMAL_CONFIG, null, 2)}\n`);
  temps.push(dir);
  return dir;
}

/** The gate's failure, as a single string: the message and every detail under it. */
function failure(error: EmpoError): string {
  return [error.message, ...error.details].join("\n");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "empo-check-"));
  cpSync(fixture, repo, { recursive: true });
  // Generated output is a local artefact a clean checkout does not have, and committing it would
  // only put machine-owned files in every diff below.
  rmSync(join(repo, ".empo/generated"), { recursive: true, force: true });
  temps.push(repo);

  git(["init", "-b", "main"]);
  // -f so a global gitignore a EmPo developer plausibly has cannot decide what the diff can show.
  git(["add", "-A", "-f"]);
  baseSha = commit("the fixture as it stands");
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the subject of the gate", () => {
  test("passes when nothing is staged, because there is no change to judge", () => {
    const printed = capture(() => checkCommand(repo));

    expect(printed).toContain("subject    staged changes, 0 files");
    expect(printed).toContain("touched  none of its guarded files");
    expect(printed).toContain("OK  nothing on a spine changed unasserted");
  });

  test("ignores a working-tree change that was never staged", () => {
    // The gate answers "may this commit go", and an edit the author has not staged is not part of
    // it. Judging the working tree would fail commits for work that is not in them.
    changeTaxRate();

    const printed = capture(() => checkCommand(repo));

    expect(printed).toContain("subject    staged changes, 0 files");
    expect(printed).toContain("OK  nothing on a spine changed unasserted");
  });

  test("passes a staged edit to a file no guarded glob covers", () => {
    insertAfter(
      ADMIN_CONTROLLER_FILE,
      "$pending = new Order();",
      "        // the admin list never computes a total",
    );
    stage(ADMIN_CONTROLLER_FILE);

    const printed = capture(() => checkCommand(repo));

    expect(printed).toContain("subject    staged changes, 1 file");
    expect(printed).toContain("touched  none of its guarded files");
    expect(printed).toContain("OK  nothing on a spine changed unasserted");
  });
});

describe("a guarded change with no assertion", () => {
  test("fails with exit code 1, naming the spine, the guarded file and the terms it wanted", () => {
    changeTaxRate();
    stage(CALCULATOR_FILE);

    const { error, printed } = expectEmpoError(1, () => checkCommand(repo));

    const said = failure(error);
    expect(said).toContain("1 spine gates this change");
    // All three have to be in the failure, or the author is told they are blocked without being
    // told by what, over which file, or what would unblock them.
    expect(said).toContain("pricing");
    expect(said).toContain(SPINE_PATH);
    expect(said).toContain(CALCULATOR_FILE);
    for (const term of TERMS) expect(said).toContain(term);
    expect(said).toContain("Add a test that asserts the value in the smallest exact unit");

    expect(printed).toContain(`touched  ${CALCULATOR_FILE}`);
    expect(printed).toContain("asserts  NOTHING");
    expect(printed).toContain("FAIL  pricing");
  });

  test("fails on a git mv that carries a guarded file out of the guarded tree", () => {
    // The measured defect, replayed through real git rather than
    // through hand-written diff text, because the whole hole was in what git records and what the
    // gate then reads: `git mv` is stored as a rename, the gate matched the new path only, printed
    // "touched none of its guarded files" and exited 0 while the tax rate changed in that same
    // commit. The move is asserted to really be a rename, or this would pass for the wrong reason
    // the day git stops detecting one.
    //
    // Rename detection is turned on in this repository rather than inherited: `diff.renames`
    // defaults to true but is a documented user setting, and a developer or CI image that has
    // turned it off gets delete + add instead, which the case below this one covers. The gate's
    // verdict is the same either way, only the line it prints differs, so a spec about the printed
    // line has to decide for itself which of the two git will record.
    git(["config", "--local", "diff.renames", "true"]);
    mkdirSync(join(repo, "apps/api/app/Support"), { recursive: true });
    git(["mv", CALCULATOR_FILE, MOVED_CALCULATOR_FILE]);
    const lines = readFileSync(join(repo, MOVED_CALCULATOR_FILE), "utf8").split("\n");
    lines[indexOfAnchor(lines, MOVED_CALCULATOR_FILE, TAX_RATE)] =
      "    private const TAX_RATE_BASIS_POINTS = 2000;";
    writeFileSync(join(repo, MOVED_CALCULATOR_FILE), lines.join("\n"));
    // git mv staged both halves already, so only the edit that rode along needs staging.
    stage(MOVED_CALCULATOR_FILE);

    expect(git(["diff", "--cached", "--name-status"])).toContain("R");

    const { error, printed } = expectEmpoError(1, () => checkCommand(repo));

    // Named by the spelling the spine guards, which is the path the file no longer has, so the
    // destination is printed with it rather than leaving the author to look for a missing file.
    expect(failure(error)).toContain(CALCULATOR_FILE);
    expect(printed).toContain(
      `touched  ${CALCULATOR_FILE} -> ${MOVED_CALCULATOR_FILE}  (moved out of the guarded tree)`,
    );
    expect(printed).toContain("FAIL  pricing");
  });

  test("fails on a staged deletion of a guarded file", () => {
    // Deleting the model on the chain changes what every total is computed from just as surely as
    // editing it. A gate that only watched added lines would wave the loudest change through.
    rmSync(join(repo, ORDER_FILE));
    stage(ORDER_FILE);

    const { error, printed } = expectEmpoError(1, () => checkCommand(repo));

    expect(failure(error)).toContain(ORDER_FILE);
    expect(printed).toContain(`touched  ${ORDER_FILE}`);
    expect(printed).toContain("asserts  NOTHING");
  });
});

describe("what counts as an assertion", () => {
  test("passes when the same change also adds an asserting line to a test file", () => {
    changeTaxRate();
    assertInTest();
    stage(CALCULATOR_FILE, ORDER_TEST_FILE);

    const printed = capture(() => checkCommand(repo));

    expect(printed).toContain(`touched  ${CALCULATOR_FILE}`);
    expect(printed).toContain(`asserts  ${ORDER_TEST_FILE}:`);
    expect(printed).toContain('"assertSame("');
    expect(printed).toContain("OK  nothing on a spine changed unasserted");
  });

  test("still fails when the asserting line was added outside a test file", () => {
    // The one case that proves the gate is scoped to tests. The line added below is added twice,
    // character for character: once in a controller, where it must count for nothing, and then in
    // the feature test, where it must open the gate. Nothing about the line differs between the two
    // halves, so the only thing under test here is where it landed.
    changeTaxRate();
    insertAfter(ORDER_CONTROLLER_FILE, "$order->subtotal = 1000;", ASSERTING_LINE);
    stage(CALCULATOR_FILE, ORDER_CONTROLLER_FILE);

    const { error, printed } = expectEmpoError(1, () => checkCommand(repo));

    expect(failure(error)).toContain("no added line uses");
    // Both edits really are in the subject, so the failure cannot be a diff that lost the line.
    expect(printed).toContain("subject    staged changes, 2 files");
    expect(printed).toContain("asserts  NOTHING");
    expect(printed).not.toContain(`asserts  ${ORDER_CONTROLLER_FILE}`);
    // And it failed because the controller is not a test, not because no pack knew what a test is:
    // that fallback counts a term anywhere in the diff, and it announces itself.
    expect(printed).not.toContain("no installed pack declares a test path");

    insertAfter(ORDER_TEST_FILE, "assertSame(1210,", ASSERTING_LINE);
    stage(ORDER_TEST_FILE);

    expect(capture(() => checkCommand(repo))).toContain(
      "OK  nothing on a spine changed unasserted",
    );
  });
});

describe("the test files a spine names", () => {
  /**
   * Curate the fixture spine one step further and commit it, so the only thing staged afterwards is
   * the change under judgement. The fixture's own spine deliberately stays unscoped, because that is
   * the configuration every spine written before this field had and the one the wider caveat is
   * about, so the two answers are exercised by the two states of one artifact rather than by two
   * fixtures that could drift apart.
   */
  function scopeSpineTo(paths: string[]): void {
    const spine = JSON.parse(readFileSync(join(repo, SPINE_PATH), "utf8")) as Record<
      string,
      unknown
    >;
    spine.assertionPaths = paths;
    writeFileSync(join(repo, SPINE_PATH), `${JSON.stringify(spine, null, 2)}\n`);
    stage(SPINE_PATH);
    commit("scope the pricing spine to its own tests");
  }

  /** An exact value asserted in a test about the checkout flow, which is not the pricing chain. */
  function assertInUnrelatedTest(): void {
    insertAfter(
      CHECKOUT_TEST_FILE,
      "$controller = new CheckoutController();",
      "        $this->assertSame(200, $controller->status());",
    );
  }

  test("passes on an unrelated test's assertion while the spine names no paths", () => {
    // The defect, end to end and unfixed, because this is what an uncurated spine still does. A
    // rounding rule changes inside the guarded money calculator and the gate opens on an assertion
    // in a checkout test that imports nothing from pricing. Measured against a real gate and
    // reproduced here so the two cases below mean something.
    changeTaxRate();
    assertInUnrelatedTest();
    stage(CALCULATOR_FILE, CHECKOUT_TEST_FILE);

    const printed = capture(() => checkCommand(repo));

    expect(printed).toContain(`asserts  ${CHECKOUT_TEST_FILE}:`);
    expect(printed).toContain("OK  nothing on a spine changed unasserted");
    // And the answer says so, which is the whole of what an unscoped spine gets: the reader is told
    // the line may be in any test file at all, so the file named above can be read for what it is.
    expect(printed).toContain("Where a spine declares no assertionPaths");
  });

  test("fails on the same change once the spine names its own tests, and prints the scope", () => {
    scopeSpineTo([ORDER_TEST_FILE]);
    changeTaxRate();
    assertInUnrelatedTest();
    stage(CALCULATOR_FILE, CHECKOUT_TEST_FILE);

    const { error, printed } = expectEmpoError(1, () => checkCommand(repo));

    // Both edits are in the subject, so this is not a diff that lost the assertion.
    expect(printed).toContain("subject    staged changes, 2 files");
    expect(printed).toContain("asserts  NOTHING");
    expect(printed).not.toContain(`asserts  ${CHECKOUT_TEST_FILE}`);
    // The author is held to a scope, so the failure names it rather than leaving them to reopen the
    // spine to find out which file the gate would have accepted.
    expect(failure(error)).toContain(`in ${ORDER_TEST_FILE}`);
    // And the caveat drops its wider half, because it is no longer true of this answer.
    expect(printed).not.toContain("Where a spine declares no assertionPaths");
  });

  test("passes once the assertion lands in one of them", () => {
    // The control this pair needs: a scope that nothing can satisfy is a gate that fails every
    // change it sees, which is the one curation defect the spine schema refuses outright.
    scopeSpineTo([ORDER_TEST_FILE]);
    changeTaxRate();
    assertInTest();
    stage(CALCULATOR_FILE, ORDER_TEST_FILE);

    const printed = capture(() => checkCommand(repo));

    expect(printed).toContain(`asserts  ${ORDER_TEST_FILE}:`);
    expect(printed).toContain("OK  nothing on a spine changed unasserted");
  });

  test("reads a directory scope the way it reads a guarded directory", () => {
    // One matcher for both fields, so a human who wrote a directory into `guarded` and got a whole
    // subtree gets one here too. Feature/ holds both tests, so this is the scope widening back out.
    scopeSpineTo(["apps/api/tests/Feature"]);
    changeTaxRate();
    assertInUnrelatedTest();
    stage(CALCULATOR_FILE, CHECKOUT_TEST_FILE);

    expect(capture(() => checkCommand(repo))).toContain(
      "OK  nothing on a spine changed unasserted",
    );
  });

  test("carries the scope into --json beside the terms", () => {
    scopeSpineTo([ORDER_TEST_FILE]);
    changeTaxRate();
    stage(CALCULATOR_FILE);

    const { printed } = expectEmpoError(1, () => checkCommand(repo, { json: true }));
    const answer = JSON.parse(printed) as {
      caveat: string;
      spines: { termsWanted: string[]; pathsWanted: string[] }[];
    };

    expect(answer.spines[0]?.pathsWanted).toEqual([ORDER_TEST_FILE]);
    expect(answer.spines[0]?.termsWanted).toEqual(["assertSame(", "assertEqualsWithDelta("]);
    // The machine form carries the same caveat the prose does, both halves or one, so a reader that
    // only ever parses JSON is told exactly what this answer is worth.
    expect(answer.caveat).toContain("Reading the test is still the reviewer's job.");
    expect(answer.caveat).not.toContain("Where a spine declares no assertionPaths");
  });
});

describe("every guarded pattern form", () => {
  /** Each form on its own, so a form that silently matched nothing could not hide behind another. */
  function expectGated(path: string): void {
    stage(path);
    const { error } = expectEmpoError(1, () => checkCommand(repo));
    expect(failure(error)).toContain(path);
  }

  test("guards a globstar pattern: apps/api/app/Libraries/Price/**", () => {
    changeTaxRate();
    expectGated(CALCULATOR_FILE);
  });

  test("guards an exact file: apps/api/app/Models/Order.php", () => {
    insertAfter(ORDER_FILE, "public int $subtotal = 0;", "    public int $shipping = 0;");
    expectGated(ORDER_FILE);
  });

  test("guards a bare directory: apps/api/app/Observers", () => {
    // No trailing /**, and it still guards its subtree. A spine that names a directory and gates
    // nothing at all would be the quietest possible failure.
    insertAfter(
      OBSERVER_FILE,
      "the order summary cache is refreshed here",
      "        // and the cached summary holds the total",
    );
    expectGated(OBSERVER_FILE);
  });
});

describe("--bypass", () => {
  test("lets a stated reason through and prints it, so the override is on the record", () => {
    changeTaxRate();
    stage(CALCULATOR_FILE);

    const printed = capture(() => checkCommand(repo, { bypass: "config only" }));

    expect(printed).toContain("BYPASSED  config only");
    expect(printed).toContain("pricing gated this change and a human overrode it.");
  });

  test("refuses a blank reason with exit code 2, because a bare flag is not a decision", () => {
    changeTaxRate();
    stage(CALCULATOR_FILE);

    const { error } = expectEmpoError(2, () => checkCommand(repo, { bypass: "   " }));

    expect(error.message).toContain("empo check --bypass needs a reason");
    expect(error.details.join("\n")).toContain("human decision on the record");
    // Whitespace and nothing at all are the same non-answer, and both are a usage error rather
    // than a gate failure: the change was never judged, so it did not fail.
    expect(expectEmpoError(2, () => checkCommand(repo, { bypass: "" })).error.message).toBe(
      error.message,
    );
  });
});

describe("--base", () => {
  test("judges the change against a ref, which is what CI has instead of an index", () => {
    changeTaxRate();
    stage(CALCULATOR_FILE);
    commit("raise the tax rate");

    // Committed, not staged: nothing is in the index now, so only --base can still see it.
    expect(capture(() => checkCommand(repo))).toContain(
      "OK  nothing on a spine changed unasserted",
    );

    const { error, printed } = expectEmpoError(1, () => checkCommand(repo, { base: baseSha }));

    expect(printed).toContain(`subject    changes against ${baseSha}`);
    expect(failure(error)).toContain(CALCULATOR_FILE);
  });

  test("refuses a ref the repository does not know with exit code 2", () => {
    changeTaxRate();
    stage(CALCULATOR_FILE);

    const { error } = expectEmpoError(2, () => checkCommand(repo, { base: "no-such-ref" }));

    expect(error.message).toContain('"no-such-ref" is not a ref this repository knows');
  });
});

describe("a repository with nothing curated", () => {
  test("passes without git, because a gate that costs nothing there is a gate that stays installed", () => {
    // This is the case a pre-commit hook depends on: no spines means no diff is even read, so the
    // hook is free in every repository that has curated nothing, git checkout or not.
    const bare = repoWithoutSpines();

    const printed = capture(() => checkCommand(bare));

    expect(printed).toContain("spines     none: there is nothing to gate");
    expect(printed).not.toContain("could not read the staged diff");
  });
});

describe("--json", () => {
  test("emits the per-spine verdicts and still fails the gate", () => {
    changeTaxRate();
    stage(CALCULATOR_FILE);

    const { error, printed } = expectEmpoError(1, () => checkCommand(repo, { json: true }));

    const answer = JSON.parse(printed) as {
      bypass: string | null;
      subject: string;
      files: number;
      passed: boolean;
      caveat: string;
      spines: {
        name: string;
        path: string;
        guards: boolean;
        termsWanted: string[];
        touched: { path: string; movedTo: string | null }[];
        assertions: unknown[];
        passed: boolean;
      }[];
    };

    expect(answer.subject).toBe("staged changes");
    expect(answer.files).toBe(1);
    expect(answer.passed).toBe(false);
    expect(answer.spines).toHaveLength(1);
    expect(answer.spines[0]?.name).toBe("pricing");
    expect(answer.spines[0]?.path).toBe(SPINE_PATH);
    expect(answer.spines[0]?.guards).toBe(true);
    expect(answer.spines[0]?.termsWanted).toEqual(["assertSame(", "assertEqualsWithDelta("]);
    expect(answer.spines[0]?.touched).toEqual([{ path: CALCULATOR_FILE, movedTo: null }]);
    expect(answer.spines[0]?.assertions).toEqual([]);
    expect(answer.spines[0]?.passed).toBe(false);
    // The caveat travels with the machine form too: a verdict of "passed" is not a verdict that the
    // test asserts the right value.
    expect(answer.caveat).toContain("Reading the test is still the reviewer's job.");
    expect(answer.bypass).toBeNull();

    expect(error.exitCode).toBe(1);
  });

  test("stays parseable when a human overrides the gate, and carries the reason", () => {
    // The regression this pins: the bypass used to print three plain lines after the JSON, so the
    // document was unparseable at exactly the moment a machine reader most needs to be told what
    // happened. An override is not a detail to print beside the answer, it is part of the answer.
    changeTaxRate();
    stage(CALCULATOR_FILE);

    const printed = capture(() => checkCommand(repo, { json: true, bypass: "config only" }));

    expect(printed).not.toContain("BYPASSED");
    const answer = JSON.parse(printed) as { passed: boolean; bypass: string | null };

    // The mechanical verdict stays false: the chain changed unasserted, a human simply decided to
    // proceed. Collapsing the two into one field would hide the override from everything downstream.
    expect(answer.passed).toBe(false);
    expect(answer.bypass).toBe("config only");
  });
});
