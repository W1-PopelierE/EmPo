import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { buildProgram } from "../src/program";

/**
 * What `empo --version` answers, and the one thing it must never answer again.
 *
 * The version sat at `0.0.0` from the first commit until the release workflow landed, which is the
 * placeholder npm writes and not a statement about anything. It matters more here than in an
 * ordinary package: every command this tool ships exists to make an agent's answer checkable, and
 * the first line of a bug report about a wrong answer is which build produced it. A build that says
 * `0.0.0` says every build, which is the same as saying none.
 *
 * `.github/workflows/ci.yml` is what keeps it moving, so this spec is the pin under that workflow:
 * it fails on the state the workflow exists to end rather than on the workflow's own mechanics,
 * which no unit test can reach.
 */

const require = createRequire(import.meta.url);
const declared = (require("../package.json") as { version: string }).version;

describe("the version the CLI reports", () => {
  test("is the one package.json declares, because commander is handed that and nothing else", () => {
    expect(buildProgram().version()).toBe(declared);
  });

  test("is semver, so a tag can be named after it", () => {
    // The release workflow tags `v${version}` off whatever `npm version` wrote. A version that is
    // not semver would have failed there first, but it would have failed after pushing a commit.
    expect(declared).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  test("is not the 0.0.0 placeholder, so a bug report can name a build", () => {
    expect(declared).not.toBe("0.0.0");
  });
});
