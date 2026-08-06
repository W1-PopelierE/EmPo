import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { disciplinePath, mapWorkflow } from "../../src/discipline/load";
import { type Citation, checkCitation } from "../../src/engine/citations";
import { proposalFileSchema } from "../../src/schema/proposal.schema";
import { spineFileSchema } from "../../src/schema/spine.schema";

/**
 * map.md is shipped data an agent follows verbatim, so an example inside it that has drifted out of
 * schema, or a `file:line` that resolves to nothing, misleads every agent that reads it rather than
 * failing anywhere. The document preaches that a coordinate is worth nothing until something checked
 * it; this suite is that rule applied to the document, which is the only honest way to ship it.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The fictional monorepo every example in the document is written against. */
const fixture = join(repoRoot, "fixtures", "acme-platform");

/** Every fenced ```json block, in document order: the examples an agent copies from. */
function jsonBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

/** Every {file, line, anchor} in a parsed example, however deep: hops, traps, invariant citations. */
function citations(value: unknown): Citation[] {
  if (Array.isArray(value)) return value.flatMap(citations);
  if (value === null || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const nested = Object.values(record).flatMap(citations);
  if (
    typeof record.file === "string" &&
    typeof record.line === "number" &&
    typeof record.anchor === "string"
  ) {
    return [{ file: record.file, line: record.line, anchor: record.anchor }, ...nested];
  }
  return nested;
}

const workflow = mapWorkflow();
const examples = jsonBlocks(workflow).map((block) => JSON.parse(block) as unknown);

function example(field: string): unknown {
  return examples.find((it) => typeof it === "object" && it !== null && field in it);
}

/** The block that is a whole spine file, and the block that is the proposal envelope. */
const spineExample = example("hops");
const proposalExample = example("spines");

/** Appended to the packaged copy below, so the assertion can tell the two files apart. */
const MARKER = "\n<!-- packaged copy -->\n";

let temp: string | undefined;

afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
  temp = undefined;
});

describe("mapWorkflow", () => {
  test("reads the shipped file from source", () => {
    expect(disciplinePath("map.md")).toBe(join(repoRoot, "src", "discipline", "map.md"));
    expect(workflow.trim().length).toBeGreaterThan(0);
    expect(workflow).toContain("# Map discipline");
  });

  /**
   * The published package ships src/discipline beside dist/, so there the loader resolves from
   * dist/../src/discipline and here from src/discipline itself. The suite only ever exercises the
   * second root, so the packaged layout is built for real and a copy of the loader is imported
   * inside it: the module resolves from its own location, which is the thing a release would break.
   */
  test("reads the shipped file through the packaged layout", async () => {
    temp = mkdtempSync(join(tmpdir(), "empo-discipline-"));
    mkdirSync(join(temp, "dist"), { recursive: true });
    mkdirSync(join(temp, "src", "discipline"), { recursive: true });
    cpSync(join(repoRoot, "src", "errors.ts"), join(temp, "errors.ts"));
    // The loader's other import. Copied unpopulated, which is what the published package carries:
    // only the standalone binary's build replaces it, and this layout is the npm one (src/embedded.ts).
    cpSync(join(repoRoot, "src", "embedded.ts"), join(temp, "embedded.ts"));
    cpSync(join(repoRoot, "src", "discipline", "load.ts"), join(temp, "dist", "load.ts"));
    const shipped = join(temp, "src", "discipline", "map.md");
    cpSync(disciplinePath("map.md"), shipped);
    // Marked, so the assertion proves the packaged copy was read and not this repository's own file,
    // which is otherwise byte-identical and would pass without the loader resolving anything.
    appendFileSync(shipped, MARKER);

    const packaged = (await import(pathToFileURL(join(temp, "dist", "load.ts")).href)) as {
      mapWorkflow: () => string;
    };

    expect(packaged.mapWorkflow()).toBe(workflow + MARKER);
  });

  test("names the file when it is in neither root", () => {
    expect(() => disciplinePath("nowhere.md")).toThrow(/nowhere\.md/);
  });
});

describe("the shipped map.md", () => {
  test("carries no em-dash", () => {
    expect(workflow).not.toMatch(/[—–]/);
  });

  test("holds json examples, and every one of them parses", () => {
    // The parse happened at import. This pins that there were blocks to parse at all, so a document
    // that lost its fences cannot pass the rest of this suite by vacuous truth.
    expect(examples.length).toBeGreaterThanOrEqual(2);
  });

  test("shows a proposal envelope the gate's own schema accepts", () => {
    // The strict schema, so a key the document spells wrong is a failure here rather than a field
    // that silently does nothing in every proposal written from this document.
    const flows = proposalFileSchema.parse(proposalExample).flows;

    expect(Object.keys(flows).length).toBeGreaterThan(0);
    for (const [name, flow] of Object.entries(flows)) {
      expect(flow.paths.length, `flow ${name}`).toBeGreaterThan(0);
      for (const path of flow.paths) {
        expect(existsSync(join(fixture, path)), `${name} declares ${path}`).toBe(true);
      }
    }
  });

  test("shows a spine skeleton that the spine schema accepts", () => {
    const spine = spineFileSchema.parse(spineExample);

    expect(spine.hops.length).toBeGreaterThan(1);
    expect(spine.assertionTerms.length).toBeGreaterThan(0);
  });

  test("drafts no invariant a human is meant to judge", () => {
    const spine = spineFileSchema.parse(spineExample);

    for (const invariant of spine.invariants) {
      // The field is left out of the document, so the schema default is what shows up here. An
      // example that set it teaches an agent to make the one judgement docs/08 reserves for a human.
      expect(invariant.assertableAtWriteTime).toBe(false);
      // An invariant with no citation is one the agent invented, which the document forbids.
      expect(invariant.citation).toBeDefined();
    }
  });

  test("cites only lines that resolve against the acme fixture", () => {
    const coordinates = citations(spineExample);
    expect(coordinates.length).toBeGreaterThan(3);

    for (const citation of coordinates) {
      const check = checkCitation(fixture, citation);
      // Compared as one string so a failure prints the coordinate that rotted, not just "moved".
      expect(`${citation.file}:${citation.line} ${check.status}`).toBe(
        `${citation.file}:${citation.line} verified`,
      );
    }
  });

  test("guards only paths that exist in the acme fixture", () => {
    const spine = spineFileSchema.parse(spineExample);
    const plain = spine.guarded.filter((pattern) => !/[*?[\]{}!]/.test(pattern));
    expect(plain.length).toBeGreaterThan(0);

    for (const pattern of plain) {
      expect(existsSync(join(fixture, pattern)), `guarded ${pattern}`).toBe(true);
    }
  });

  test("names the proposal flags an agent is told to run", () => {
    expect(workflow).toContain("empo init --proposal <path>");
    expect(workflow).toContain("--apply");
  });
});
