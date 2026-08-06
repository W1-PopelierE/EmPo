import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { verifyCommand } from "../../src/commands/verify";
import { EmpoError } from "../../src/errors";

/**
 * `empo verify` end to end over the acme fixture: resolve every anchor a spine states against the
 * source as it really is, and fail when one of them has rotted.
 *
 * The clean run reads the fixture in place, because verify only reads. Every drift test works on its
 * own copy under the system temp directory, since it has to change the source the spine points at,
 * and a fixture one test can dirty is a fixture that makes the next test lie.
 *
 * No line number below is counted by hand. The cited line is read out of the spine and the line an
 * anchor really moved to is found in the mutated file, so an edit to either one shows up here as a
 * failure rather than as a test that quietly checks the wrong number.
 */

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

const SPINE_PATH = ".empo/spines/pricing.json";
const CALCULATOR_FILE = "apps/api/app/Libraries/Price/PriceCalculator.php";
const OBSERVER_FILE = "apps/api/app/Observers/OrderObserver.php";

/** Hop 2, the sole funnel: the anchor every drift case below moves or destroys. */
const TOTAL_ANCHOR = "return $order->subtotal + $this->tax(";
/** Hop 3, below it in the same file, so an insertion above hop 2 must move this one too. */
const TAX_ANCHOR = "intdiv($subtotal * self::TAX_RATE_BASIS_POINTS";

/** The whole fixture spine: 4 hops, 1 invariant that cites a test, 2 traps. */
const CITATION_COUNT = 7;

/** Enough config to load, and no spines directory, which is the common case in a real repository. */
const MINIMAL_CONFIG = {
  version: 1,
  roots: [{ path: ".", lang: "php" }],
  packs: { php: { version: "^1" } },
};

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
 * verify prints its whole report and then fails the gate, so a test that only caught the error would
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

function copyFixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "empo-verify-"));
  cpSync(fixture, repo, { recursive: true });
  temps.push(repo);
  return repo;
}

/** A repository with a config and nothing curated: no spines directory at all. */
function repoWithoutSpines(): string {
  const repo = mkdtempSync(join(tmpdir(), "empo-verify-empty-"));
  mkdirSync(join(repo, ".empo"), { recursive: true });
  writeFileSync(join(repo, ".empo/config.json"), `${JSON.stringify(MINIMAL_CONFIG, null, 2)}\n`);
  temps.push(repo);
  return repo;
}

function linesOf(repo: string, path: string): string[] {
  return readFileSync(join(repo, path), "utf8").split("\n");
}

/** The line an anchor really sits on, read from the file, never counted by hand. */
function lineOf(repo: string, path: string, anchor: string): number {
  const index = linesOf(repo, path).findIndex((line) => line.includes(anchor));
  if (index === -1) throw new Error(`no line of ${path} contains "${anchor}"`);
  return index + 1;
}

/** The line the spine claims an anchor is on, so the expectation and the artifact cannot disagree. */
function citedLine(repo: string, anchor: string): number {
  const spine = JSON.parse(readFileSync(join(repo, SPINE_PATH), "utf8")) as {
    hops: { anchor: string; line: number }[];
  };
  const hop = spine.hops.find((candidate) => candidate.anchor === anchor);
  if (hop === undefined) throw new Error(`no hop of ${SPINE_PATH} anchors on "${anchor}"`);
  return hop.line;
}

/** Blank lines above an anchor: the source is untouched, only its coordinates slipped. */
function pushDown(repo: string, path: string, anchor: string, count: number): void {
  const lines = linesOf(repo, path);
  const index = lines.findIndex((line) => line.includes(anchor));
  if (index === -1) throw new Error(`no line of ${path} contains "${anchor}"`);
  lines.splice(index, 0, ...new Array<string>(count).fill(""));
  writeFileSync(join(repo, path), lines.join("\n"));
}

/** Rewrite the line holding an anchor, which is how an anchor stops existing anywhere in a file. */
function rewriteLine(repo: string, path: string, anchor: string, replacement: string): void {
  const lines = linesOf(repo, path);
  const index = lines.findIndex((line) => line.includes(anchor));
  if (index === -1) throw new Error(`no line of ${path} contains "${anchor}"`);
  lines[index] = replacement;
  writeFileSync(join(repo, path), lines.join("\n"));
}

function readSpine(repo: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repo, SPINE_PATH), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a spine that still describes its code", () => {
  test("resolves every anchor the fixture states and exits without failing the gate", () => {
    // Read in place: verify never writes, and this is the one case that must hold against the
    // fixture as committed rather than against a copy some earlier line edited.
    const printed = capture(() => verifyCommand(fixture));

    expect(printed).toContain(`1 spine under .empo/spines, ${CITATION_COUNT} citations`);
    expect(printed).toContain(`pricing  ${SPINE_PATH}`);
    expect(printed).toContain(`OK  every anchor resolved (${CITATION_COUNT} citations)`);
    // Every one of the seven, not merely seven counted somewhere. The breakdown is spelled out
    // because a spine's citations come from three different places in the file, and a count alone
    // would still pass if one place stopped contributing and another gained a line.
    const resolved = printed.split("\n").filter((line) => line.startsWith("  ok     "));
    expect(resolved).toHaveLength(CITATION_COUNT);
    expect(resolved.filter((line) => /\bhop \d/.test(line))).toHaveLength(4);
    expect(resolved.filter((line) => /\binvariant \d/.test(line))).toHaveLength(1);
    expect(resolved.filter((line) => line.includes('trap "'))).toHaveLength(2);
    expect(printed).not.toContain("SOFT");
    expect(printed).not.toContain("HARD");
  });
});

describe("drift", () => {
  test("reports a slipped coordinate as SOFT and names the line the anchor moved to", () => {
    const repo = copyFixture();
    const cited = citedLine(repo, TOTAL_ANCHOR);
    const citedTax = citedLine(repo, TAX_ANCHOR);

    pushDown(repo, CALCULATOR_FILE, TOTAL_ANCHOR, 3);
    const moved = lineOf(repo, CALCULATOR_FILE, TOTAL_ANCHOR);
    const movedTax = lineOf(repo, CALCULATOR_FILE, TAX_ANCHOR);

    const { error, printed } = expectEmpoError(1, () => verifyCommand(repo));

    // Three blank lines above hop 2 move hop 3 as well: everything below an insertion slips, and a
    // report that only noticed the first one would leave a spine half repaired.
    expect(moved).toBe(cited + 3);
    expect(movedTax).toBe(citedTax + 3);
    expect(printed).toContain(
      `SOFT   hop 2 "total resolution"  ${CALCULATOR_FILE}:${cited} -> ${moved}`,
    );
    expect(printed).toContain(`the anchor moved: set line to ${moved}`);
    expect(printed).toContain(
      `SOFT   hop 3 "tax applied"  ${CALCULATOR_FILE}:${citedTax} -> ${movedTax}`,
    );
    expect(printed).toContain("DRIFT  2 soft, 0 hard");
    expect(printed).not.toContain("HARD");

    expect(error.message).toContain("2 citations in 1 spine drifted");
    // Soft drift still fails, and the failure says what kind of work it is asking for.
    expect(error.details.join("\n")).toContain(
      "Every anchor was found; only line numbers slipped.",
    );
  });

  test("reports an anchor that no longer exists as HARD, pointing nowhere", () => {
    const repo = copyFixture();
    const cited = citedLine(repo, TOTAL_ANCHOR);

    // Same line, same behaviour, different text: the quoted source the spine stands on is gone, so
    // there is no line to correct the coordinate to.
    rewriteLine(
      repo,
      CALCULATOR_FILE,
      TOTAL_ANCHOR,
      "        return $this->tax($order->subtotal) + $order->subtotal;",
    );

    const { error, printed } = expectEmpoError(1, () => verifyCommand(repo));

    expect(printed).toContain(`HARD   hop 2 "total resolution"  ${CALCULATOR_FILE}:${cited}`);
    expect(printed).toContain(`anchor is nowhere in ${CALCULATOR_FILE}`);
    expect(printed).toContain("DRIFT  0 soft, 1 hard");
    expect(printed).not.toContain("SOFT");

    expect(error.message).toContain("1 citation in 1 spine drifted");
    expect(error.details.join("\n")).toContain("1 anchor resolved nowhere");
  });

  test("treats a citation into a deleted file as hard drift rather than crashing", () => {
    const repo = copyFixture();
    // The second trap cites the observer. A spine outliving the file it describes is the ordinary
    // way a map rots, so it has to come back as a report, not as an unhandled ENOENT.
    rmSync(join(repo, OBSERVER_FILE));

    const { error, printed } = expectEmpoError(1, () => verifyCommand(repo));

    expect(printed).toContain("HARD");
    expect(printed).toContain(`${OBSERVER_FILE} could not be read`);
    expect(printed).toContain("DRIFT  0 soft, 1 hard");
    expect(error.message).toContain("1 citation in 1 spine drifted");
  });
});

describe("nothing to verify", () => {
  test("exits without failing when the repository has no spines directory at all", () => {
    const repo = repoWithoutSpines();

    const printed = capture(() => verifyCommand(repo));

    expect(printed).toContain("spines     none under .empo/spines");
    // The absence is stated as normal rather than as a gap to fill, which is the honest reading:
    // a spine nobody needed is a spine nobody maintains.
    expect(printed).toContain("Most repositories have zero or one spine.");
  });
});

describe("--json", () => {
  test("emits the per-spine reports and the drift counts, and still fails the gate", () => {
    const repo = copyFixture();
    const cited = citedLine(repo, TOTAL_ANCHOR);
    pushDown(repo, CALCULATOR_FILE, TOTAL_ANCHOR, 3);
    const moved = lineOf(repo, CALCULATOR_FILE, TOTAL_ANCHOR);

    const { error, printed } = expectEmpoError(1, () => verifyCommand(repo, { json: true }));

    const answer = JSON.parse(printed) as {
      soft: number;
      hard: number;
      spines: {
        name: string;
        path: string;
        verified: number;
        soft: number;
        hard: number;
        citations: {
          where: string;
          level: string;
          citation: { file: string; line: number };
          check: { actualLine: number | null };
        }[];
      }[];
    };

    expect(answer.soft).toBe(2);
    expect(answer.hard).toBe(0);
    expect(answer.spines).toHaveLength(1);
    expect(answer.spines[0]?.name).toBe("pricing");
    expect(answer.spines[0]?.path).toBe(SPINE_PATH);
    expect(answer.spines[0]?.citations).toHaveLength(CITATION_COUNT);
    expect(answer.spines[0]?.verified).toBe(CITATION_COUNT - 2);

    const hop = answer.spines[0]?.citations.find((entry) => entry.where.startsWith("hop 2"));
    expect(hop?.level).toBe("soft");
    expect(hop?.citation.line).toBe(cited);
    expect(hop?.check.actualLine).toBe(moved);

    // The machine form is not a way around the gate: same drift, same exit code.
    expect(error.exitCode).toBe(1);
  });
});

describe("a broken spine file", () => {
  test("fails with exit code 2 when the spine is not valid JSON, not with a gate failure", () => {
    const repo = copyFixture();
    writeFileSync(join(repo, SPINE_PATH), "{ not json");

    // Exit 2 rather than 1 is the whole point: drift is a verdict about the code, an unreadable
    // artifact is a verdict about the artifact, and a CI job routes the two differently.
    const { error } = expectEmpoError(2, () => verifyCommand(repo));

    expect(error.message).toContain(`${SPINE_PATH} is not valid JSON`);
  });

  test("fails with exit code 2 when the declared name is not the file's name", () => {
    const repo = copyFixture();
    const spine = readSpine(repo);
    spine.name = "prices";
    writeFileSync(join(repo, SPINE_PATH), `${JSON.stringify(spine, null, 2)}\n`);

    // Every report and every gate message prints the declared name, so a file that answers to
    // something else leaves a human hunting for a spine that does not exist under that name.
    const { error } = expectEmpoError(2, () => verifyCommand(repo));

    expect(error.message).toContain('declares name "prices" but the file is named "pricing"');
  });
});
