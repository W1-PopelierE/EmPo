import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// Plain JavaScript build tooling, typed by scripts/embed.d.mts so this import is checked rather
// than suppressed: a `@ts-expect-error` here would have hidden a changed signature too.
import {
  collectDiscipline,
  collectPacks,
  embeddedExports,
  embeddedModule,
} from "../scripts/embed.mjs";
import * as embedded from "../src/embedded";
import type { EmpoError } from "../src/errors";

/**
 * What a test can and cannot pin about the standalone binary, stated once so the gap is not
 * mistaken for coverage.
 *
 * **It cannot pin the artifact.** No spec in this suite builds a 110MB executable, injects a blob
 * into it, or runs it on a machine whose Node is below the `engines` floor, and none should: that
 * is a build and a platform, and the only honest check of it is to build it and run it. CI does
 * that in the `binary` job, against a Node 21 on PATH, which is the measurement that matters and it
 * lives in a workflow rather than here.
 *
 * **It can pin everything the artifact depends on**, and that is what is below. The binary works by
 * replacing one module and taking a different branch in three loaders, so the failure modes that a
 * spec can actually reach are: the replacement module drifting out of step with the real one, and a
 * loader that ignores the embedded assets and reaches for a disk that is not there. Both are
 * silent in every other verification, because all four run from a source tree where the disk is
 * present and the embedded maps are empty.
 */

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/embedded");
});

describe("the module the binary replaces", () => {
  /**
   * Empty is the source, test and npm-package behaviour, and asserting it here is what makes every
   * other spec in this suite a statement about the disk path. If this ever ships populated, a
   * checkout would answer out of a compiled-in snapshot of its own packs and nobody would be told.
   */
  it("ships empty, so a checkout reads its assets off disk", () => {
    expect(embedded.EMBEDDED_PACKS).toEqual({});
    expect(embedded.EMBEDDED_DISCIPLINE).toEqual({});
    expect(embedded.EMBEDDED_VERSION).toBeNull();
    expect(embedded.isEmbeddedBuild()).toBe(false);
  });

  /**
   * The one failure the binary build can have that no other verification sees. `src/embedded.ts` is
   * imported by name from three modules, so an export added there and not added to the generator
   * leaves the binary importing `undefined` while `tsc`, `biome` and the whole suite stay green.
   * The same shape as a pack field the schema does not declare, which is stripped at load and
   * passes every hand-built unit test (CLAUDE.md, "Language packs").
   */
  it("declares exactly the exports the binary build generates", () => {
    const real = Object.keys(embedded).sort();
    const generated = [...embeddedExports()].sort();

    expect(generated).toEqual(real);
  });

  it("generates a module whose values are the assets on disk", () => {
    const packs = collectPacks();
    const discipline = collectDiscipline();
    const source: string = embeddedModule("9.9.9", packs, discipline);

    for (const name of ["php", "typescript"]) {
      const onDisk = readFileSync(join("src", "packs", name, "pack.json"), "utf8");
      expect(packs[name]).toBe(onDisk);
    }
    expect(Object.keys(discipline).sort()).toContain("review.md");
    expect(source).toContain('export const EMBEDDED_VERSION = "9.9.9"');
  });
});

/**
 * The embedded branch of each loader, exercised by standing a populated module in front of the
 * empty one. This is the code the binary runs and nothing else in the suite reaches it.
 */
describe("a build that carries its own assets", () => {
  /**
   * The real shipped pack, read off disk and handed over as though it had been compiled in. A
   * hand-built object would only prove that `loadPack` can parse whatever this spec invented; the
   * question worth asking is whether the text the build actually embeds still loads.
   */
  const PACK = readFileSync(join("src", "packs", "typescript", "pack.json"), "utf8");

  function withEmbedded(packs: Record<string, string>, discipline: Record<string, string> = {}) {
    vi.doMock("../src/embedded", () => ({
      EMBEDDED_PACKS: packs,
      EMBEDDED_DISCIPLINE: discipline,
      EMBEDDED_VERSION: "9.9.9",
      isEmbeddedBuild: () => Object.keys(packs).length > 0,
    }));
  }

  it("lists the packs it carries and not the packs on disk", async () => {
    withEmbedded({ typescript: PACK });
    const { installedPacks } = await import("../src/engine/pack-loader");

    // php is on disk and is not carried, so this is the whole assertion: a populated map wins
    // wholesale rather than being merged with what the filesystem offers.
    expect(installedPacks()).toEqual(["typescript"]);
  });

  it("answers packAvailable off what it carries", async () => {
    withEmbedded({ typescript: PACK });
    const { packAvailable } = await import("../src/engine/pack-loader");

    expect(packAvailable("typescript")).toBe(true);
    expect(packAvailable("php")).toBe(false);
  });

  it("parses a carried pack without opening a file", async () => {
    withEmbedded({ typescript: PACK });
    const { loadPack } = await import("../src/engine/pack-loader");

    expect(loadPack("typescript").name).toBe("typescript");
  });

  /**
   * The error names the packs the build has rather than the two directories it looked in, because
   * a binary looked in no directory and telling somebody to check a path that does not exist sends
   * them after the wrong repair.
   */
  it("names what it carries when asked for a pack it does not have", async () => {
    withEmbedded({ typescript: PACK });
    const { loadPack } = await import("../src/engine/pack-loader");

    expect(() => loadPack("php")).toThrow(/Unknown language pack "php"/);
    try {
      loadPack("php");
      expect.unreachable();
    } catch (error) {
      expect((error as EmpoError).details).toEqual(["Packs compiled into this build: typescript"]);
    }
  });

  it("hands over the discipline it carries", async () => {
    withEmbedded(
      { typescript: PACK },
      { "review.md": "# carried review", "map.md": "# carried map" },
    );
    const { mapWorkflow, reviewWorkflow } = await import("../src/discipline/load");

    expect(reviewWorkflow()).toBe("# carried review");
    expect(mapWorkflow()).toBe("# carried map");
  });

  it("reports a discipline file it failed to carry as a packaging fault", async () => {
    withEmbedded({ typescript: PACK }, { "map.md": "# carried map" });
    const { reviewWorkflow } = await import("../src/discipline/load");

    expect(() => reviewWorkflow()).toThrow(/The shipped discipline file "review.md" is missing/);
    try {
      reviewWorkflow();
      expect.unreachable();
    } catch (error) {
      expect((error as EmpoError).details).toContain(
        "This is a packaging fault, not a fault in the repository being reviewed.",
      );
    }
  });
});
