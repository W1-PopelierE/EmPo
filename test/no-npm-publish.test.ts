import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The mechanical form of a decision that was otherwise only prose: **EmPo is not published to npm**,
 * and `curl -fsSL .../install.sh | sh` plus `empo upgrade` are the one supported route.
 *
 * Four reasons, recorded so nobody re-derives them from an empty registry page:
 *
 * - **npm's global prefix is per Node version**, measured against a real install. A globally
 *   installed `empo` leaves PATH the moment a repository switches Node versions, and EmPo runs from
 *   hooks inside other people's repositories, which is exactly where that switch has just happened.
 *   npm as the main channel would reintroduce the defect this branch exists to remove.
 * - **EmPo is language-agnostic.** Shipping a tool that indexes PHP through one language's package
 *   manager is a mismatch: a Laravel repository has npm because of Vite, which is luck.
 * - **npm is tightening install scripts**, so "an npm package that downloads a binary on
 *   postinstall" is a closing road rather than an open one.
 * - **Nothing has ever been published**, so there is no deprecation, no migration and no broken
 *   promise. That option disappears the moment anything is published once, which is why the flag
 *   goes in now and not later.
 *
 * What is given up is real: a team can no longer pin EmPo per project through a devDependency.
 * Publishing later stays possible; un-publishing does not, which is the asymmetry the decision turns
 * on.
 *
 * A rule that lives in prose is a rule somebody has to remember at the wrong hour, and this
 * repository's own history says remembering does not work (`test/packs/versions.test.ts` exists for
 * the same reason). `private: true` is npm's documented way to refuse a publish, so the assertions
 * below guard the flag and the machinery that would have to come back with it.
 *
 * **How far that flag was actually verified, because the obvious check does not check it.**
 * `npm publish --dry-run` was measured here against a minimal package with and without
 * `private: true`, on npm 10, and printed the identical "Publishing to ..." notice and exit 0 both
 * times. So the dry run is not a test of this flag and must not be quoted as one. A real publish
 * refusing was not measured, because measuring it means authenticating against the registry and the
 * failure mode of getting that wrong is the one thing this file exists to prevent. What is pinned
 * below is therefore the decision, not npm's behaviour: the flag is present, and the machinery a
 * publish would need is gone. The second half is the part that does not depend on trusting npm.
 *
 * The deleted half is
 * asserted absent from disk as well: `bin/empo.cjs` resolved a per-platform npm package at runtime
 * and `scripts/build-packages.mjs` assembled those packages, and either one creeping back
 * half-wired is worse than either being wholly present.
 */

const manifest = JSON.parse(readFileSync("package.json", "utf8"));

describe("this package is not published to npm", () => {
  it("is marked private, rather than relying on nobody typing the command", () => {
    expect(
      manifest.private,
      "package.json is no longer private, so nothing declares that this must not be published. " +
        "npm distribution was " +
        "dropped on purpose: npm's global prefix is per Node version, so a globally installed empo " +
        "leaves PATH when a repository switches Node, and that is the defect the standalone binary " +
        "exists to remove. The supported install is install.sh (curl | sh) plus `empo upgrade`. " +
        "Publishing once is irreversible, so read test/no-npm-publish.test.ts and the docs before " +
        "removing this flag.",
    ).toBe(true);
  });

  it("declares no bin, so npm has nothing to link and no launcher to run", () => {
    expect(
      manifest.bin,
      "package.json declares a bin again. The launcher it pointed at, bin/empo.cjs, existed only to " +
        "resolve a per-platform npm package at runtime, and no such package is published.",
    ).toBeUndefined();
  });

  it("declares no optionalDependencies, since the platform packages do not exist", () => {
    expect(
      manifest.optionalDependencies,
      "package.json declares optionalDependencies again. Those were the four per-platform packages, " +
        "none of which is published, so npm cannot resolve them, so they never reach " +
        "package-lock.json and `npm ci` fails outright under npm 11.",
    ).toBeUndefined();
  });

  it("has no script that builds publishable packages", () => {
    expect(
      manifest.scripts?.["build:packages"],
      "the build:packages script is back. Nothing publishes what it assembles.",
    ).toBeUndefined();
  });

  it("keeps the binary build, which is what replaced all of the above", () => {
    // The inverse assertion, so this file cannot pass by everything being gone. build:binary feeds
    // the GitHub Release assets that install.sh and `empo upgrade` download.
    expect(manifest.scripts?.["build:binary"]).toBe("node scripts/build-binary.mjs");
  });
});

describe("the npm distribution machinery is gone from disk", () => {
  it("has no launcher directory, so it cannot creep back half-deleted", () => {
    expect(
      existsSync("bin"),
      "bin/ is back. It held the npm launcher, whose only job was resolving a package that is " +
        "never published.",
    ).toBe(false);
  });

  it("has no platform-package build script", () => {
    expect(
      existsSync(join("scripts", "build-packages.mjs")),
      "scripts/build-packages.mjs is back. It assembles publishable per-platform package " +
        "directories, and nothing publishes them.",
    ).toBe(false);
  });

  it("still has the binary build it was replaced by", () => {
    // Again the inverse: absence proves nothing unless the surviving half is present to compare to.
    expect(existsSync(join("scripts", "build-binary.mjs"))).toBe(true);
    expect(existsSync("install.sh")).toBe(true);
  });
});
