import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

/**
 * The Node floor this package promises, checked against what its dependencies actually demand.
 *
 * `engines` said `>=20` for the whole of the build while `execa@10` said `>=22` and called
 * `Set.prototype.union`, which arrived with Node 22. On Node 20 the CLI did not start: not a
 * degraded answer, not a missing feature, a `TypeError` thrown out of a dependency before any EmPo
 * code ran. Nothing caught it, because every machine that ever ran this suite was on 22 or later,
 * and a floor is the one promise that is only tested by the people who are not in the room.
 *
 * So this asserts the arithmetic rather than the outcome: whatever `engines` says must be at least
 * what every runtime dependency says. It cannot prove the package runs on its floor, and nothing
 * here can, because the suite runs on exactly one Node at a time. What it can do is refuse the way
 * the floor went wrong, which was a dependency bump moving the real requirement while the declared
 * one stayed where somebody typed it.
 *
 * `devDependencies` are deliberately out of scope. Their floor binds whoever clones this repository
 * and is a matter for the CI matrix; `engines` is a promise to whoever installs the package, and an
 * installer never sees them.
 */

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as {
  engines: { node: string };
  dependencies: Record<string, string>;
};

type Version = [number, number, number];

/**
 * The lowest Node a range admits. Every version token in the range is read and the smallest wins,
 * which is the conservative reading of an alternation: `^18.17.0 || >=20.5.0` runs on 18, so 18 is
 * its floor and a package declaring 20 is not contradicting it.
 */
function floorOf(range: string): Version | null {
  const tokens = range.match(/\d+(?:\.\d+){0,2}/g);
  if (tokens === null) return null;

  const versions = tokens.map((token): Version => {
    const [major = 0, minor = 0, patch = 0] = token.split(".").map(Number);
    return [major, minor, patch];
  });

  return versions.reduce((lowest, next) => (compare(next, lowest) < 0 ? next : lowest));
}

/** Compared as a triple, never as a string, because "22.12.0" sorts below "22.9.0". */
function compare(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function show(version: Version): string {
  return version.join(".");
}

function floorOfDependency(name: string): Version | null {
  // A relative path rather than a bare specifier, so an `exports` map that does not publish
  // package.json cannot hide the field this reads.
  const { engines } = require(`../node_modules/${name}/package.json`) as {
    engines?: { node?: string };
  };
  return engines?.node === undefined ? null : floorOf(engines.node);
}

describe("reading a floor out of a range", () => {
  test("takes the version, however many parts it has", () => {
    expect(floorOf(">=22.12.0")).toEqual([22, 12, 0]);
    expect(floorOf(">=12")).toEqual([12, 0, 0]);
    expect(floorOf("^20.5")).toEqual([20, 5, 0]);
  });

  test("takes the lowest of an alternation, because either side may be the one that runs", () => {
    expect(floorOf("^18.17.0 || >=20.5.0")).toEqual([18, 17, 0]);
  });

  test("says so when there is no version in the range at all", () => {
    expect(floorOf("*")).toBeNull();
  });
});

describe("the Node floor package.json declares", () => {
  const declared = floorOf(pkg.engines.node);

  test("is a range with a floor in it, because a promise nothing can read is not one", () => {
    expect(declared).not.toBeNull();
  });

  for (const dependency of Object.keys(pkg.dependencies)) {
    const required = floorOfDependency(dependency);

    // A dependency declaring nothing constrains nothing, and naming it anyway beats a silently
    // absent case: which dependencies this spec covered should be readable from what it printed.
    if (required === null) {
      test(`is unconstrained by ${dependency}, which declares no engines`, () => {
        expect(floorOfDependency(dependency)).toBeNull();
      });
      continue;
    }

    test(`is not below ${dependency}, which needs ${show(required)}`, () => {
      const floor = declared === null ? "nothing readable" : show(declared);
      const verdict =
        declared !== null && compare(declared, required) >= 0 ? "at or above" : "below";

      expect(`${floor} is ${verdict} ${show(required)}`).toBe(
        `${floor} is at or above ${show(required)}`,
      );
    });
  }
});
