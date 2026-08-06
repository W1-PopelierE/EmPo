import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  drifted,
  type LoadedSpine,
  loadSpines,
  type SpineReport,
  spineCitations,
  verifySpine,
} from "../../src/engine/spines";
import { EmpoError } from "../../src/errors";
import { configSchema, type EmpoConfig } from "../../src/schema/config.schema";
import { parseSpineFile } from "../../src/schema/spine.schema";

/**
 * A spine is the one hand-written artifact in a tool whose first principle is that a claim is worth
 * nothing until something checked it, so the loader has two jobs: refuse a spine that would mislead
 * (a name that disagrees with its filename, a file that is not JSON), and resolve every coordinate
 * it states against real source. Real files in a temp repo throughout, because "does this anchor
 * still exist" is exactly the question under test.
 */

let repo: string;

/** The file every spine below cites. The anchor sits on line 7, and nowhere else. */
const CALCULATOR = [
  "<?php",
  "",
  "class PriceCalculator",
  "{",
  "    public function total(): int",
  "    {",
  "        $total = $gross - $discount;",
  "        return $total;",
  "    }",
  "}",
];

const ANCHOR = "$total = $gross - $discount;";
const FILE = "app/PriceCalculator.php";

function config(spines = ".empo/spines"): EmpoConfig {
  return configSchema.parse({
    version: 1,
    roots: [{ path: ".", lang: "php" }],
    packs: { php: {} },
    spines,
  });
}

function write(relPath: string, contents: string): void {
  const target = join(repo, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function writeSpine(relPath: string, spine: Record<string, unknown>): void {
  write(relPath, JSON.stringify(spine));
}

/** A spine in hand, without going through the filesystem, for the cases that only verify. */
function loaded(spine: { name: string } & Record<string, unknown>): LoadedSpine {
  const path = `.empo/spines/${spine.name}.json`;
  return { spine: parseSpineFile({ version: 1, ...spine }, path), path };
}

function hop(n: number, line: number, anchor = ANCHOR, file = FILE): Record<string, unknown> {
  return { n, title: `hop ${n}`, file, line, anchor };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "empo-spines-"));
  write(FILE, `${CALCULATOR.join("\n")}\n`);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("loadSpines", () => {
  test("finds no spines when the directory does not exist, since most repositories have none", () => {
    expect(loadSpines(repo, config())).toEqual([]);
  });

  test("finds no spines in a directory that is there but empty", () => {
    mkdirSync(join(repo, ".empo/spines"), { recursive: true });

    expect(loadSpines(repo, config())).toEqual([]);
  });

  test("ignores everything in the directory that is not a spine file", () => {
    // A README beside the spines is normal, and a stale backup must not become a second spine.
    writeSpine(".empo/spines/money.json", { version: 1, name: "money" });
    write(".empo/spines/README.md", "# how to curate a spine\n");
    write(".empo/spines/money.json.bak", "{}");

    expect(loadSpines(repo, config()).map((entry) => entry.spine.name)).toEqual(["money"]);
  });

  test("reads every spine in filename order, and names each by its path inside the repo", () => {
    // Written out of order on purpose: the order in the listing is not the order that is reported.
    writeSpine(".empo/spines/money.json", { version: 1, name: "money" });
    writeSpine(".empo/spines/auth.json", { version: 1, name: "auth" });

    const spines = loadSpines(repo, config());

    expect(spines.map((entry) => entry.spine.name)).toEqual(["auth", "money"]);
    expect(spines.map((entry) => entry.path)).toEqual([
      ".empo/spines/auth.json",
      ".empo/spines/money.json",
    ]);
  });

  test("fails when a spine's name disagrees with its filename, naming both", () => {
    // Every gate message prints the declared name, so a mismatch sends a human hunting for a file
    // that does not exist under the name they were given.
    writeSpine(".empo/spines/money.json", { version: 1, name: "pricing" });

    try {
      loadSpines(repo, config());
      expect.unreachable("expected a config error");
    } catch (error) {
      expect(error).toBeInstanceOf(EmpoError);
      expect((error as EmpoError).exitCode).toBe(2);
      expect((error as EmpoError).message).toContain("pricing");
      expect((error as EmpoError).message).toContain("money");
    }
  });

  test("fails on a spine file that is not valid JSON, naming the file", () => {
    write(".empo/spines/money.json", '{ "version": 1, "name": "money", }');

    try {
      loadSpines(repo, config());
      expect.unreachable("expected a config error");
    } catch (error) {
      expect(error).toBeInstanceOf(EmpoError);
      expect((error as EmpoError).exitCode).toBe(2);
      expect((error as EmpoError).message).toContain(".empo/spines/money.json");
    }
  });

  test("reads spines from a configured directory other than the default", () => {
    writeSpine("tools/spines/money.json", { version: 1, name: "money" });

    const spines = loadSpines(repo, config("tools/spines"));

    expect(spines).toHaveLength(1);
    expect(spines[0]?.path).toBe("tools/spines/money.json");
  });

  test("reports the path a human can open, whatever spelling the config used", () => {
    // The reported path used to be the configured string with the file appended, so a spines of
    // "./tools/spines" came back as "./tools/spines/money.json". Every other path EmPo prints is
    // plain repo-relative, and this is the one verify, the gate's failure and doctor tell a human
    // to open, so it is derived from the file that was really read.
    writeSpine("tools/spines/money.json", { version: 1, name: "money" });

    for (const spelling of ["tools/spines", "./tools/spines", "tools/../tools/spines"]) {
      expect(loadSpines(repo, config(spelling))[0]?.path).toBe("tools/spines/money.json");
    }
  });
});

describe("spineCitations", () => {
  test("lists the chain first, then what must stay true, then the gotchas", () => {
    const spine = loaded({
      name: "money",
      hops: [hop(0, 7), { ...hop(1, 3), title: "class entry", anchor: "class PriceCalculator" }],
      invariants: [
        {
          id: 1,
          statement: "The total is the sum of its lines",
          citation: { file: FILE, line: 8, anchor: "return $total;" },
        },
      ],
      traps: [{ what: "gross, not net", file: FILE, line: 7, anchor: ANCHOR }],
    }).spine;

    expect(spineCitations(spine).map((entry) => entry.where)).toEqual([
      'hop 0 "hop 0"',
      'hop 1 "class entry"',
      "invariant 1",
      'trap "gross, not net"',
    ]);
    expect(spineCitations(spine)[2]?.citation).toEqual({
      file: FILE,
      line: 8,
      anchor: "return $total;",
    });
  });

  test("labels a hop by the number the human cites it by, not by its place in the list", () => {
    const spine = loaded({ name: "money", hops: [hop(1, 7), hop(5, 3, "class PriceCalculator")] });

    expect(spineCitations(spine.spine).map((entry) => entry.where)).toEqual([
      'hop 1 "hop 1"',
      'hop 5 "hop 5"',
    ]);
  });

  test("contributes nothing for an invariant that is stated in prose alone", () => {
    // Inventing an anchor for a prose invariant is the fiction this module exists to prevent.
    const spine = loaded({
      name: "money",
      invariants: [{ id: 1, statement: "A refund never exceeds what was charged" }],
    });

    expect(spineCitations(spine.spine)).toEqual([]);
  });
});

describe("verifySpine", () => {
  test("verifies an anchor that is still on the line the spine cites", () => {
    const report = verifySpine(repo, loaded({ name: "money", hops: [hop(0, 7)] }));

    expect(report.citations[0]?.level).toBe("verified");
    expect(report.citations[0]?.check.status).toBe("verified");
    expect(report).toMatchObject({ name: "money", path: ".empo/spines/money.json" });
  });

  test("calls an anchor that slipped a few lines soft drift, and says which line it is really on", () => {
    // Soft drift is a coordinate whose quoted source is still there: the fix is one number.
    const report = verifySpine(repo, loaded({ name: "money", hops: [hop(0, 4)] }));

    expect(report.citations[0]?.level).toBe("soft");
    expect(report.citations[0]?.check.actualLine).toBe(7);
  });

  test("calls an anchor that is nowhere in the file hard drift, since every claim on it is suspect", () => {
    const report = verifySpine(
      repo,
      loaded({ name: "money", hops: [hop(0, 7, "$total = $net + $tax;")] }),
    );

    expect(report.citations[0]?.level).toBe("hard");
    expect(report.citations[0]?.check.actualLine).toBeNull();
  });

  test("calls a citation whose file is gone hard drift", () => {
    const report = verifySpine(
      repo,
      loaded({ name: "money", hops: [hop(0, 7, "class Gone", "app/Gone.php")] }),
    );

    expect(report.citations[0]?.level).toBe("hard");
    expect(report.citations[0]?.check.status).toBe("missing-file");
  });

  test("counts each level over a whole spine, so a report can be read without walking it", () => {
    const report = verifySpine(
      repo,
      loaded({
        name: "money",
        hops: [hop(0, 7), hop(1, 4)],
        invariants: [
          {
            id: 1,
            statement: "The total is the sum of its lines",
            citation: { file: FILE, line: 8, anchor: "$total = $net + $tax;" },
          },
        ],
        traps: [{ what: "gone", file: "app/Gone.php", line: 1, anchor: "class Gone" }],
      }),
    );

    expect(report.citations.map((entry) => entry.level)).toEqual([
      "verified",
      "soft",
      "hard",
      "hard",
    ]);
    expect(report).toMatchObject({ verified: 1, soft: 1, hard: 2 });
  });

  test("verifies clean when a spine cites nothing at all", () => {
    // A spine can be prose and globs only, and having nothing to check is not a failure to check.
    const report = verifySpine(
      repo,
      loaded({
        name: "money",
        principle: "Money is decided once, in cents",
        guarded: ["app/**"],
        assertionTerms: ["assertSame"],
        invariants: [{ id: 1, statement: "A refund never exceeds what was charged" }],
      }),
    );

    expect(report.citations).toEqual([]);
    expect(report).toMatchObject({ verified: 0, soft: 0, hard: 0 });
  });
});

describe("drifted", () => {
  test("sums soft and hard drift across every spine, since one rotted map is enough to fail", () => {
    const reports: SpineReport[] = [
      verifySpine(repo, loaded({ name: "money", hops: [hop(0, 4), hop(1, 7)] })),
      verifySpine(repo, loaded({ name: "auth", hops: [hop(0, 7, "class Gone", "app/Gone.php")] })),
    ];

    expect(drifted(reports)).toBe(2);
  });

  test("is zero when every anchor still resolves", () => {
    const reports = [
      verifySpine(repo, loaded({ name: "money", hops: [hop(0, 7)] })),
      verifySpine(repo, loaded({ name: "auth", hops: [hop(0, 3, "class PriceCalculator")] })),
    ];

    expect(drifted(reports)).toBe(0);
  });
});
