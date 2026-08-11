import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { packageOf, vendorPackages } from "../../src/engine/packages";
import type { PackPackageSource } from "../../src/schema/types";

/**
 * The one fact that separates a third-party import from a workspace one, and it is read off disk, so
 * these cases build real manifests. What they pin is the subtraction: a monorepo lists its own
 * packages as dependencies of each other, and a set that kept them would refuse exactly the edges
 * the `template` family exists to find.
 */

const NPM: PackPackageSource = {
  file: "package.json",
  name: "name",
  dependencies: ["dependencies", "devDependencies"],
};

const temporary: string[] = [];

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** A repository of manifests, keyed by the repo-relative path each one sits at. */
function repoWith(manifests: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-packages-"));
  temporary.push(dir);
  for (const [relPath, manifest] of Object.entries(manifests)) {
    const full = join(dir, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  }
  return dir;
}

describe("vendorPackages", () => {
  test("subtracts the names the repository is from the names it depends on", () => {
    const repo = repoWith({
      "package.json": {
        name: "@acme/root",
        dependencies: { "@acme/ui": "*", "@mui/material": "*" },
      },
      "packages/ui/package.json": { name: "@acme/ui", dependencies: { sonner: "*" } },
    });

    expect([...vendorPackages(repo, NPM, [])].sort()).toEqual(["@mui/material", "sonner"]);
  });

  test("reads every declared dependency field, and nothing outside them", () => {
    // `peerDependencies` is absent from NPM above on purpose: a field the pack does not name is a
    // field the engine must not read, or a pack could not choose to leave one out.
    const repo = repoWith({
      "package.json": {
        name: "acme",
        dependencies: { react: "*" },
        devDependencies: { vitest: "*" },
        peerDependencies: { "react-dom": "*" },
      },
    });

    expect([...vendorPackages(repo, NPM, [])].sort()).toEqual(["react", "vitest"]);
  });

  test("skips a manifest that will not parse instead of refusing to build", () => {
    // A broken fixture is not a claim about anything. Refusing here would stop the repository being
    // indexed at all, and treating it as an empty manifest would silently widen what resolves.
    const repo = repoWith({
      "package.json": { name: "acme", dependencies: { react: "*" } },
      "fixtures/package.json": "{ not json",
    });

    expect([...vendorPackages(repo, NPM, [])]).toEqual(["react"]);
  });

  test("honours the config's ignore list, so an excluded tree cannot answer for the repository", () => {
    const repo = repoWith({
      "package.json": { name: "acme", dependencies: { react: "*" } },
      "examples/demo/package.json": { name: "demo", dependencies: { lodash: "*" } },
    });

    expect([...vendorPackages(repo, NPM, ["**/examples/**"])]).toEqual(["react"]);
  });

  test("never reads an installed tree, whatever the config ignores", () => {
    // The silent, backwards failure: an installed package's manifest declares its own name, so
    // reading node_modules subtracts `@mui/material` from the set it belongs in and the refusal
    // built on that set stops firing — on exactly the checkouts that have run an install.
    const repo = repoWith({
      "package.json": { name: "acme", dependencies: { "@mui/material": "*" } },
      "node_modules/@mui/material/package.json": { name: "@mui/material" },
      "node_modules/left-pad/package.json": { name: "left-pad", dependencies: { lodash: "*" } },
    });

    expect([...vendorPackages(repo, NPM, [])]).toEqual(["@mui/material"]);
  });

  test("claims nothing where the pack declares no manifest", () => {
    // Every pack before this field, and php today. The empty set is what makes the refusal below it
    // never fire, so such a pack resolves exactly as it did.
    expect(vendorPackages(repoWith({}), undefined, []).size).toBe(0);
  });
});

describe("packageOf", () => {
  test("reads a scoped package as two segments and everything else as one", () => {
    expect(packageOf("@mui/material/Button")).toBe("@mui/material");
    expect(packageOf("sonner")).toBe("sonner");
    expect(packageOf("react-router-dom/server")).toBe("react-router-dom");
  });

  test("answers null for a specifier that names a path rather than a package", () => {
    expect(packageOf("./Button")).toBeNull();
    expect(packageOf("../ui/Button")).toBeNull();
    expect(packageOf("/abs/Button")).toBeNull();
    expect(packageOf("")).toBeNull();
  });
});
