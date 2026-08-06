import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { seedAliases, sortedAliases } from "../../src/engine/aliases";
import { loadPack } from "../../src/engine/pack-loader";

/**
 * The seed `empo init` takes once from the toolchain (docs/06-cli.md step 2), which is the only
 * place in EmPo that opens a tsconfig at all: `empo index` reads the config and nothing else, so
 * the graph stays a function of config plus scanned files on a machine with no toolchain installed.
 *
 * Both packs go through the real `loadPack` rather than being hand-built here. A pack field the
 * schema does not declare is stripped at load, so a hand-made `aliasSources` would keep these tests
 * green while `empo init` seeded nothing at all in a real repository.
 */

const TYPESCRIPT = loadPack("typescript");
const PHP = loadPack("php");

let repo: string;

function write(relPath: string, contents: string): void {
  const target = join(repo, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** The plain case: a strict-JSON config file, written the way most tooling writes one. */
function writeJson(relPath: string, contents: unknown): void {
  write(relPath, `${JSON.stringify(contents, null, 2)}\n`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "empo-aliases-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("seedAliases", () => {
  test("reads the files the pack declares, which reach the engine through the real loader", () => {
    // Nothing in engine/aliases.ts may name a language, so the two filenames below are the pack's
    // answer and not the engine's. Asserted through loadPack because zod strips an undeclared key:
    // drop `aliasSources` from pack.schema.ts and this is the line that notices.
    expect(TYPESCRIPT.aliasSources?.map((source) => source.file)).toEqual([
      "tsconfig.json",
      "jsconfig.json",
    ]);
    expect(TYPESCRIPT.aliasSources?.[0]?.paths).toBe("compilerOptions.paths");
  });

  test("seeds repo-relative targets from a tsconfig at the repository root", () => {
    writeJson("tsconfig.json", { compilerOptions: { paths: { "@/*": ["./src/*"] } } });

    const seed = seedAliases(repo, ".", TYPESCRIPT);

    expect(seed.aliases).toEqual({ "@/*": ["src/*"] });
    expect(seed.read).toEqual(["tsconfig.json"]);
    expect(seed.notes).toEqual([]);
  });

  test("joins a target through a root that is not the repository root", () => {
    // The whole reason a target is repo-relative: node ids are, so a target left spelled relative
    // to apps/portal would compare equal to nothing in the graph, and every aliased import in that
    // app would resolve to no edge while the config looked filled in.
    writeJson("apps/portal/tsconfig.json", { compilerOptions: { paths: { "@/*": ["./src/*"] } } });

    const seed = seedAliases(repo, "apps/portal", TYPESCRIPT);

    expect(seed.aliases).toEqual({ "@/*": ["apps/portal/src/*"] });
    expect(seed.read).toEqual(["apps/portal/tsconfig.json"]);
  });

  test("resolves targets against a declared baseUrl", () => {
    writeJson("apps/portal/tsconfig.json", {
      compilerOptions: { baseUrl: "./src", paths: { "@/*": ["*"], "~/*": ["shared/*"] } },
    });

    expect(seedAliases(repo, "apps/portal", TYPESCRIPT).aliases).toEqual({
      "@/*": ["apps/portal/src/*"],
      "~/*": ["apps/portal/src/shared/*"],
    });
  });

  test("resolves targets against the file's own directory when there is no baseUrl", () => {
    // TypeScript's rule for a `paths` written without a `baseUrl`. Taking the root or the repo
    // instead would seed a map one directory off, which resolves nothing and looks correct.
    writeJson("apps/admin/tsconfig.json", { compilerOptions: { paths: { "@/*": ["*"] } } });

    expect(seedAliases(repo, "apps/admin", TYPESCRIPT).aliases).toEqual({
      "@/*": ["apps/admin/*"],
    });
  });

  test("reads a file holding comments and trailing commas, which is what tsc --init writes", () => {
    // The common real case rather than an exotic one, so `JSON.parse` alone would report the
    // majority of TypeScript repositories as having no aliases at all.
    //
    // Three things here fail a naive strip. The `$schema` value holds `//` inside a string, which a
    // line-comment regex would cut the line at. The comments hold a `}` and a `,`, so a stripper
    // that ran over comment text would see braces that close nothing. And the trailing comma after
    // the target list is separated from its `}` by a block comment, which is exactly the case that
    // fails if trailing commas are removed before comments are masked rather than after.
    write(
      "tsconfig.json",
      [
        "{",
        '  // aliases live below, in { "compilerOptions": { "paths" } }, and nowhere else',
        '  "$schema": "https://json.schemastore.org/tsconfig",',
        '  "compilerOptions": {',
        "    /* a block comment holding a } and a , of its own */",
        '    "baseUrl": ".",',
        '    "paths": {',
        '      "@/*": ["./src/*"], /* the comma above is trailing once this comment is masked */',
        "    },",
        "  },",
        "}",
        "",
      ].join("\n"),
    );

    const seed = seedAliases(repo, ".", TYPESCRIPT);

    expect(seed.aliases).toEqual({ "@/*": ["src/*"] });
    expect(seed.notes).toEqual([]);
  });

  test("follows a relative extends chain, and a nearer file wins a pattern outright", () => {
    // Outright rather than by merging targets, because that is what the toolchain does: a `paths`
    // in the extending file replaces the inherited one whole. A merged map would resolve imports
    // the build does not, which is the invented-edge failure the resolver refuses elsewhere.
    writeJson("config/tsconfig.base.json", {
      compilerOptions: { paths: { "@/*": ["./src/base/*"], "~/*": ["./shared/*"] } },
    });
    writeJson("tsconfig.json", {
      extends: "./config/tsconfig.base.json",
      compilerOptions: { paths: { "@/*": ["./src/near/*"] } },
    });

    const seed = seedAliases(repo, ".", TYPESCRIPT);

    expect(seed.aliases).toEqual({
      "@/*": ["src/near/*"],
      // The base config's own relative target, resolved against the base config's directory and
      // not against the file that extends it. Any other rule is off by a directory silently.
      "~/*": ["config/shared/*"],
    });
    expect(seed.read).toEqual(["tsconfig.json", "config/tsconfig.base.json"]);
    expect(seed.notes).toEqual([]);
  });

  test("does not follow a package extends, and says which one it did not follow", () => {
    // A package name resolves through the module system, so following it would mean guessing at
    // node_modules and seeding a map out of a file the repository does not control. The gap is
    // reported rather than dropped: a narrower alias map is not a smaller answer, it is a set of
    // import edges that silently do not exist.
    writeJson("tsconfig.json", {
      extends: "@vue/tsconfig/tsconfig.json",
      compilerOptions: { paths: { "@/*": ["./src/*"] } },
    });

    const seed = seedAliases(repo, ".", TYPESCRIPT);

    expect(seed.aliases).toEqual({ "@/*": ["src/*"] });
    expect(seed.read).toEqual(["tsconfig.json"]);
    expect(seed.notes).toHaveLength(1);
    expect(seed.notes[0]).toContain("@vue/tsconfig/tsconfig.json");
    expect(seed.notes[0]).toContain("package");
  });

  test("notes a file it could not parse rather than throwing", () => {
    // `empo init` has already written a config by the time this runs, so a file this cannot read is
    // one line in the report and never a failure of the command.
    write("tsconfig.json", "{ this is not json\n");

    const seed = seedAliases(repo, ".", TYPESCRIPT);

    expect(seed.aliases).toEqual({});
    expect(seed.read).toEqual([]);
    expect(seed.notes.join("\n")).toContain("tsconfig.json could not be parsed");
  });

  test("says nothing at all about a root that has no toolchain config", () => {
    // A root with no tsconfig is a normal root, not a gap. A note here would print on every
    // repository that has none, and an alarm that is usually false is one nobody reads.
    const seed = seedAliases(repo, ".", TYPESCRIPT);

    expect(seed).toEqual({ aliases: {}, read: [], notes: [] });
  });

  test("distinguishes a config that declares no paths from a root that has no config", () => {
    // Two different facts, and `empo init` prints them differently ("no aliases in tsconfig.json"
    // against "no toolchain config under it"). The file it read is what carries the difference.
    writeJson("tsconfig.json", { compilerOptions: { strict: true } });

    const seed = seedAliases(repo, ".", TYPESCRIPT);

    expect(seed.aliases).toEqual({});
    expect(seed.read).toEqual(["tsconfig.json"]);
  });

  test("seeds nothing for a pack that declares no alias sources", () => {
    // php declares none, so a tsconfig sitting in a php root is not this pack's file to read. The
    // engine must reach that answer from the pack alone, never from the filename.
    writeJson("tsconfig.json", { compilerOptions: { paths: { "@/*": ["./src/*"] } } });

    expect(PHP.aliasSources).toBeUndefined();
    expect(seedAliases(repo, ".", PHP)).toEqual({ aliases: {}, read: [], notes: [] });
  });
});

describe("sortedAliases", () => {
  test("orders patterns by code unit, so a rerun writes the same file", () => {
    // `empo init` writes a file a human then edits, and a generator that reorders a map between
    // runs churns that file. Code units, not localeCompare: "Alpha" before "alpha" here, and the
    // reverse in an en locale, which is the disagreement compareStrings exists to end.
    const sorted = sortedAliases({
      "~/*": ["app/*"],
      "alpha/*": ["b/*"],
      "@/*": ["src/*"],
      "Alpha/*": ["a/*"],
    });

    expect(Object.keys(sorted)).toEqual(["@/*", "Alpha/*", "alpha/*", "~/*"]);
    // Targets travel untouched: their order is the order the toolchain tries them in, and sorting
    // them would seed a map that resolves a specifier to the wrong one of two real files.
    expect(sorted["@/*"]).toEqual(["src/*"]);
  });

  test("writes the same order whatever order the seed happened to be built in", () => {
    const one = sortedAliases({ "~/*": ["app/*"], "@/*": ["src/*"] });
    const other = sortedAliases({ "@/*": ["src/*"], "~/*": ["app/*"] });

    expect(JSON.stringify(one)).toBe(JSON.stringify(other));
  });
});
