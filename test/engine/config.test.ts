import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig } from "../../src/engine/config";
import { EmpoError } from "../../src/errors";

const minimalConfig = {
  version: 1,
  roots: [{ path: "apps/api", lang: "php" }],
  packs: { php: { version: "^1" } },
};

let repo: string;

function write(relPath: string, contents: unknown): void {
  const target = join(repo, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(contents, null, 2)}\n`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "empo-config-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("loads and validates .empo/config.json", () => {
    write(".empo/config.json", minimalConfig);

    const loaded = loadConfig(repo);

    expect(loaded.path).toBe(join(repo, ".empo/config.json"));
    expect(loaded.config.roots).toEqual([{ path: "apps/api", lang: "php" }]);
  });

  test("falls back to empo.config.json at the repo root", () => {
    write("empo.config.json", minimalConfig);

    const loaded = loadConfig(repo);

    expect(loaded.path).toBe(join(repo, "empo.config.json"));
  });

  test("prefers .empo/config.json when both exist", () => {
    write(".empo/config.json", minimalConfig);
    write("empo.config.json", { ...minimalConfig, roots: [{ path: "other", lang: "php" }] });

    expect(loadConfig(repo).config.roots[0]?.path).toBe("apps/api");
  });

  test("defaults the optional fields so callers never handle undefined", () => {
    write(".empo/config.json", minimalConfig);

    const { config } = loadConfig(repo);

    expect(config.bridges).toEqual([]);
    expect(config.ignore).toEqual([]);
    expect(config.commit).toEqual([]);
    expect(config.flows).toBe(".empo/flows.json");
    expect(config.spines).toBe(".empo/spines");
  });

  test("carries a root's alias map from the file on disk to roots[].aliases", () => {
    // The field `empo index` resolves every non-relative import through, read the way a command
    // really reads it. An undeclared key is stripped in silence, so a map that never survives this
    // trip leaves every aliased import in the repository resolving to no edge, with a config file
    // that looks filled in and a graph that says the file is barely used.
    write(".empo/config.json", {
      ...minimalConfig,
      roots: [
        { path: "apps/portal", lang: "typescript", aliases: { "@/*": ["apps/portal/src/*"] } },
      ],
      packs: { typescript: { version: "^1" } },
    });

    const { config } = loadConfig(repo);

    expect(config.roots[0]?.aliases).toEqual({ "@/*": ["apps/portal/src/*"] });
  });

  test("fails with exit code 2 when no config exists", () => {
    expect(() => loadConfig(repo)).toThrow(EmpoError);
    try {
      loadConfig(repo);
    } catch (error) {
      expect((error as EmpoError).exitCode).toBe(2);
    }
  });

  test("fails with exit code 2 when roots are missing", () => {
    write(".empo/config.json", { version: 1, packs: { php: { version: "^1" } } });

    try {
      loadConfig(repo);
      expect.unreachable("expected a config error");
    } catch (error) {
      expect((error as EmpoError).exitCode).toBe(2);
      expect((error as EmpoError).details.join("\n")).toContain("roots");
    }
  });

  test("fails on a tracker keyPattern that does not compile", () => {
    // The kind has to be one the enum still accepts. With the retired `jira` this test parsed as
    // green while asserting nothing it was written to assert: the kind failed first, the `.refine`
    // never ran, and the error named the rename rather than the pattern.
    write(".empo/config.json", {
      ...minimalConfig,
      adapters: { tracker: { kind: "mcp", keyPattern: "[A-Z" } },
    });

    try {
      loadConfig(repo);
      expect.unreachable("expected a config error");
    } catch (error) {
      expect((error as EmpoError).details.join("\n")).toContain("keyPattern");
    }
  });

  test("fails on malformed JSON with exit code 2", () => {
    mkdirSync(join(repo, ".empo"), { recursive: true });
    writeFileSync(join(repo, ".empo/config.json"), "{ not json");

    try {
      loadConfig(repo);
      expect.unreachable("expected a config error");
    } catch (error) {
      expect((error as EmpoError).exitCode).toBe(2);
    }
  });

  test("accepts the shipped example config", () => {
    const example = new URL("../../examples/empo.config.example.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(example, "utf8"));
    write(".empo/config.json", parsed);

    const { config } = loadConfig(repo);

    expect(config.roots).toHaveLength(3);
    expect(config.bridges[0]?.kind).toBe("http-route");
    expect(config.adapters?.forge?.kind).toBe("github");
    // The example is the copy-pasteable documentation of this schema, so it is the one file that
    // has to be checked against a retirement rather than assumed to have survived it. This test is
    // what caught the example still carrying `"kind": "jira"` after the mcp change landed.
    expect(config.adapters?.tracker?.kind).toBe("mcp");
    expect(config.adapters?.tracker?.host).toBe("jira");
  });
});
