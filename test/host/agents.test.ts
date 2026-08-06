import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { reviewWorkflow } from "../../src/discipline/load";
import { parseConfig } from "../../src/engine/config";
import { EmpoError } from "../../src/errors";
import {
  EMPO_BEGIN,
  EMPO_END,
  mergeAgents,
  renderAgentsBlock,
  writeAgents,
} from "../../src/host/agents";
import type { EmpoConfig } from "../../src/schema/config.schema";

/**
 * The host instruction file (docs/10-distribution.md). It is generated rather than hand-written for
 * two reasons this file pins: it names *this* repository's roots and adapters, so it cannot be one
 * shipped string, and `empo update` regenerates it, so it has to be byte-stable and it has to leave
 * everything a human wrote outside the markers exactly as it found it.
 */

/** A line of the shipped discipline, taken from the discipline itself so this cannot rot silently. */
const DISCIPLINE_LINE =
  "Read the ticket, its description and every comment, before you open the diff.";

function make(raw: Record<string, unknown>): EmpoConfig {
  return parseConfig({ version: 1, packs: { php: { version: "^1" } }, ...raw }, "a test config");
}

const TWO_ROOTS = make({
  roots: [
    { path: "apps/api", lang: "php" },
    { path: "apps/mobile", lang: "typescript" },
  ],
  packs: { php: { version: "^1" }, typescript: { version: "^1" } },
  adapters: { forge: { kind: "github", repo: "acme/platform" } },
});

const BARE = make({ roots: [{ path: ".", lang: "php" }] });

/**
 * An `mcp` forge and an `mcp` tracker, which is what a Bitbucket and Jira repository configures now
 * that there is no `bitbucket` kind and no `jira` kind. `host` is the free string that names them,
 * and text like this block is the only thing in the whole tool that reads it: the engine never
 * branches on it, so a case that stops printing it costs nothing anywhere a type-checker looks.
 */
const FULL = make({
  roots: [{ path: "apps/api", lang: "php", framework: "laravel" }],
  adapters: {
    forge: { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "platform" },
    tracker: { kind: "mcp", host: "jira", keyPattern: "[A-Z]{2,}-\\d+", project: "PLAT" },
  },
});

/**
 * The shape detection really produces for a github remote: a `workspace` and a `repo` as two fields,
 * never one pre-joined slug (src/engine/detect.ts, `DetectedForge`). A fixture that stuffs
 * `acme/platform` into `repo` alone reads fine and exercises nothing, because the join is the part
 * that can be wrong, and it was: the block spelled this location repo-first and space-separated.
 */
const GITHUB = make({
  roots: [{ path: ".", lang: "php" }],
  adapters: {
    forge: { kind: "github", workspace: "acme", repo: "platform" },
    tracker: { kind: "github-issues" },
  },
});

let repo: string;

function agents(): string {
  return readFileSync(join(repo, "AGENTS.md"), "utf8");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "empo-agents-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("the generated block", () => {
  test("names this repository's roots and their languages", () => {
    const block = renderAgentsBlock(TWO_ROOTS);

    expect(block).toContain("apps/api");
    expect(block).toContain("php");
    expect(block).toContain("apps/mobile");
    expect(block).toContain("typescript");
  });

  test("names the framework a root declares, because it decides which extractors run", () => {
    expect(renderAgentsBlock(FULL)).toContain("laravel");
  });

  test("names the configured forge and tracker", () => {
    const block = renderAgentsBlock(FULL);

    // The kind is what the engine acts on, the host is what the agent acts on. Both are printed:
    // "Forge: `mcp`" alone does not tell an agent which of its connectors to reach for.
    expect(block).toContain("Forge: `mcp`");
    expect(block).toContain("bitbucket");
    expect(block).toContain("Tracker: `mcp`");
    expect(block).toContain("jira");
    expect(block).toContain("PLAT");
  });

  test("says what degrades when there is no forge and no tracker", () => {
    // An agent that is not told an adapter is missing reads the review's silence as "the ticket
    // was fine" and "there was no pull request to read", which are both fabrications.
    const block = renderAgentsBlock(BARE);

    expect(block).toContain("Forge: none configured");
    expect(block).toContain("local diff");
    expect(block).toContain("Tracker: none configured");
    expect(block).toContain("ticket-fit");
  });

  test("degrades the same way for an adapter deliberately set to local or none", () => {
    // A configured `local` forge and a configured `none` tracker are decisions, not omissions, so
    // the block names them as configured. What they degrade is identical either way.
    const chosen = make({
      roots: [{ path: ".", lang: "php" }],
      adapters: { forge: { kind: "local" }, tracker: { kind: "none" } },
    });
    const block = renderAgentsBlock(chosen);

    expect(block).toContain("Forge: `local`");
    expect(block).toContain("local diff");
    expect(block).toContain("Tracker: `none`");
    expect(block).toContain("ticket-fit");
    expect(block).not.toContain("none configured");
  });

  test("lists every command an agent invokes itself, and leaves the host's own out", () => {
    // The set is a decision and not a listing of src/program.ts, so it is pinned exactly. A row that
    // goes missing costs an agent the command; a row that appears for `empo hook` costs it more than
    // that, because that command reads a payload on stdin and prints nothing when all is well, so an
    // agent that runs it by hand waits on a stdin nobody is writing and learns the wrong lesson.
    const rows = renderAgentsBlock(TWO_ROOTS)
      .split("\n")
      .filter((line) => line.startsWith("| `empo "));

    expect(rows).toEqual([
      "| `empo index` | Rebuild the graph from source, after the code moved. |",
      "| `empo query [<symbol>]` | Blast radius: fan-in, flows reached, blind flows, coverage. |",
      "| `empo review [<pr>]` | Print the review brief and the discipline to run over it. |",
      "| `empo check` | Commit gate: a guarded file changed with no value-asserting test. |",
      "| `empo verify` | Resolve every spine citation against source and report drift. |",
      "| `empo doctor` | Health: staleness, config validity, unmapped directories, adapters. |",
      "| `empo update` | Regenerate this section. |",
      "| `empo init --proposal <path>` | Gate a proposed flow and spine map; `--apply` writes it. |",
      "| `empo pack test <name>` | Run a language pack against its fixtures, after editing it. |",
    ]);
    expect(rows.some((row) => row.startsWith("| `empo hook"))).toBe(false);
  });

  test("says in the block itself that `empo hook` is missing on purpose", () => {
    // The absence above is a decision, and a bare table cannot carry a decision: an agent reading
    // the rendered file sees nine rows and no way to tell a deliberate omission from a forgotten
    // one, then finds `empo hook` in `empo --help` and runs it. The sentence is pinned whole rather
    // than by keyword, because "waits on a stdin nobody is writing" is the half that stops it and a
    // `toContain("empo hook")` would stay green over a sentence that merely mentioned the command.
    const block = renderAgentsBlock(TWO_ROOTS);

    expect(block).toContain(
      "`empo hook` is registered and left out of that table on purpose: the host calls it with a payload\non stdin, so running it by hand waits on a stdin nobody is writing.",
    );
  });

  test("names the same commands whatever the config, because the surface is not per-repository", () => {
    // The rows above are pinned against one config. Nothing about a root, a forge or a tracker
    // changes which commands exist, so a case that rendered a different table for a bare repository
    // would be a bug the pinned test could not see.
    const rowsFor = (config: EmpoConfig): string[] =>
      renderAgentsBlock(config)
        .split("\n")
        .filter((line) => line.startsWith("| `empo "));

    for (const config of [BARE, FULL, GITHUB]) {
      expect(rowsFor(config)).toEqual(rowsFor(TWO_ROOTS));
    }
  });

  test("states the two rules an agent must not get wrong", () => {
    const block = renderAgentsBlock(TWO_ROOTS);

    expect(block).toContain(".empo/generated/");
    expect(block).toContain("empo index");
    expect(block).toContain("guarded");
    expect(block).toContain("empo check");
  });

  test("points at the discipline instead of copying it", () => {
    // Two copies of the discipline drift, and the copy the verification gate is built around is the
    // one in src/discipline/review.md. So the block must send the agent to `empo review` for it.
    const block = renderAgentsBlock(TWO_ROOTS);

    expect(reviewWorkflow()).toContain(DISCIPLINE_LINE);
    expect(block).not.toContain(DISCIPLINE_LINE);
    expect(block).toContain("empo review");
  });

  test("is byte-identical for the same config, twice", () => {
    // A generated file that changes between runs produces a diff on every run, which trains a team
    // to stop reading the diff.
    expect(renderAgentsBlock(FULL)).toBe(renderAgentsBlock(FULL));
    expect(renderAgentsBlock(TWO_ROOTS)).not.toBe(renderAgentsBlock(FULL));
  });

  test("carries no markers of its own", () => {
    // The block is what goes *between* the markers. A marker inside it would make every later merge
    // ambiguous, one run after the file was first written.
    const block = renderAgentsBlock(FULL);

    expect(block).not.toContain(EMPO_BEGIN);
    expect(block).not.toContain(EMPO_END);
    expect(block.startsWith("\n")).toBe(false);
    expect(block.endsWith("\n")).toBe(false);
  });
});

/**
 * The `mcp` adapters turn this block from documentation into the interface an agent acts on. EmPo
 * cannot reach the host, so the pull request only ever arrives because these lines asked for it. If
 * they are wrong or missing, nobody writes a payload, every review silently degrades to a local diff
 * and nothing anywhere says why. Each case below is one way that has already been possible.
 */
describe("an mcp forge and tracker", () => {
  const NAMELESS = make({
    roots: [{ path: ".", lang: "php" }],
    adapters: { forge: { kind: "mcp" }, tracker: { kind: "mcp" } },
  });

  test("names the host, so the agent knows which of its connectors to reach for", () => {
    // The whole reason `host` exists. An agent told "Forge: `mcp`" does not know which of its
    // connectors to reach for, and `mcp` is a transport rather than a thing anyone has a tool for.
    const block = renderAgentsBlock(FULL);

    expect(block).toContain("backed by bitbucket");
    expect(block).toContain("your bitbucket tool");
    expect(block).toContain("backed by jira");
    expect(block).toContain("your jira tool");
    expect(block).toContain("workspace `acme`");
    expect(block).toContain("repository `platform`");
  });

  test("falls back to a generic tool when the config names no host", () => {
    // An mcp adapter with no host still works, so the text degrades to a noun rather than to a
    // guess: "your pull request tool" sends an agent to look at what it has, where a guessed name
    // would send it confidently to the wrong connector.
    const block = renderAgentsBlock(NAMELESS);

    expect(block).toContain("your pull request tool");
    expect(block).toContain("your ticket tool");
    expect(block).not.toContain("undefined");
  });

  test("says the review stops to ask for a payload, and that the stop is not an error", () => {
    // An agent that meets phase 0 without expecting it reads it as a failure and works around it:
    // it drops the id and reviews the local diff, which reports confidently on the wrong code.
    const block = renderAgentsBlock(FULL);

    expect(block).toContain("request block");
    expect(block).toContain("normal path and not an error");
    expect(block).toContain("empo review <id>");
  });

  test("says the payload is checked against this repository before it is believed", () => {
    const block = renderAgentsBlock(FULL);

    expect(block).toContain("checked against this repository");
    expect(block).toContain("origin/<branch>");
  });

  test("tells the agent not to fetch the diff, because git computes it here", () => {
    // The habit this has to break. The host's diff endpoint exists and an agent will reach for it
    // unprompted, and what comes back is capped, redirected and slower than the local git diff.
    const block = renderAgentsBlock(FULL);

    expect(block).toContain("Do not fetch the diff");
    expect(block).toContain("computes it locally from the two branch names");
  });

  test("points at the request block for the field names instead of copying them", () => {
    // The same rule this block already applies to the review discipline. The mapping was in here as
    // a table, confirmed against a live pull request and correct, and it was still the wrong place:
    // the request block prints it from the code that reads the payload back, so that copy cannot
    // drift from what EmPo accepts and this one could. Three copies agreeing today, with nothing
    // pinning that they keep agreeing, is a guarantee with no owner.
    const block = renderAgentsBlock(FULL);

    expect(block).toContain("The field names are not repeated here");
    expect(block).toContain("The request block prints the exact JSON EmPo accepts");
    expect(block).not.toContain("author.display_name");
    expect(block).not.toContain("<- source.branch.name");
  });

  test("points the same way whatever the host, because the pointer is not host-specific", () => {
    // The table was rendered for Bitbucket only, so the file said more to one host than another and
    // the skill had to ask which. A pointer at the authoritative copy is true for every host, and
    // the host-specific half is printed where it is acted on.
    const gitlab = make({
      roots: [{ path: ".", lang: "php" }],
      adapters: { forge: { kind: "mcp", host: "gitlab" } },
    });
    const block = renderAgentsBlock(gitlab);

    expect(block).toContain("your gitlab tool");
    expect(block).toContain("The field names are not repeated here");
    expect(block).not.toContain("author.display_name");
  });

  test("says an empty description is written, not omitted", () => {
    // One of three live pull requests read had an empty description. Absent and empty have to stay
    // apart: empty is the pull request, absent is a field that failed to map.
    expect(renderAgentsBlock(FULL)).toContain('Write `""` for an empty description');
  });

  test("says to omit ci rather than name a state it did not read", () => {
    // A guessed `passed` is the exact fabrication the whole tool exists to prevent. Which hosts
    // expose a pipeline result at all is host-specific and belongs with the mapping, in the request
    // block; what is true everywhere is that an omission is reported and a guess is not.
    const block = renderAgentsBlock(FULL);

    expect(block).toContain("Omit `ci`");
    expect(block).toContain("the review says the pipeline was not checked");
  });

  test("says nothing can be posted back, because the adapter has no connector", () => {
    expect(renderAgentsBlock(FULL)).toContain("Nothing can be posted back");
  });

  test("tells the agent to echo the ticket key back verbatim", () => {
    // The key is the only check a ticket has: nothing in the repository knows what it says. An
    // agent that fetched a task by a numeric id writes that id back by reflex, the lookup misses,
    // and it reads as a missing ticket rather than as the mistake it is.
    const block = renderAgentsBlock(FULL);

    expect(block).toContain("Echo the key EmPo asked for back, verbatim, in `key`");
    expect(block).toContain("permalink belong in `url`");
  });

  test("says what leaving criteria out means, against what an empty list means", () => {
    expect(renderAgentsBlock(FULL)).toContain("Leave `criteria` out unless the ticket states some");
  });

  test("promises none of this for a forge that is not mcp", () => {
    // The defect this whole case exists for. The block used to special-case `local` and say of
    // every other kind that the review reads the pull request from there, which was a sentence
    // about a fetch that was not happening.
    for (const config of [GITHUB, BARE]) {
      const block = renderAgentsBlock(config);

      expect(block).not.toContain("request block");
      expect(block).not.toContain("Do not fetch the diff");
      expect(block).not.toContain("author.display_name");
    }
  });

  test("still says a github forge reads the pull request, because it does", () => {
    const block = renderAgentsBlock(GITHUB);

    expect(block).toContain("Forge: `github`");
    expect(block).toContain("reads the pull request");
    expect(block).toContain("posts only when asked to");
    expect(block).toContain("Tracker: `github-issues`");
  });

  test("names a github repository as `OWNER/REPO`, the only form a github tool accepts", () => {
    // The agent reading this block is the one that types the slug back into a `gh` call, so a
    // location spelled any other way here is a call that fails on the format. The block used to
    // join the two fields itself, repo first and space-separated, and print `platform acme`.
    const block = renderAgentsBlock(GITHUB);

    expect(block).toContain("Forge: `github` (`acme/platform`)");
    expect(block).not.toContain("platform acme");
  });

  test("names a github repository that has no workspace on its own", () => {
    // A remote with nothing above the repository leaves `workspace` unset, and the slug is then the
    // repo alone. Joining an absent workspace in would print `/platform`, which is not a repository.
    const block = renderAgentsBlock(
      make({
        roots: [{ path: ".", lang: "php" }],
        adapters: { forge: { kind: "github", repo: "platform" } },
      }),
    );

    expect(block).toContain("Forge: `github` (`platform`)");
  });

  test("names no location at all when the config named no repository", () => {
    // Nothing to say beats a stray empty pair of backticks: `empo review` falls back to the working
    // directory in exactly this case, and an empty slug printed here would look like a broken one.
    const block = renderAgentsBlock(
      make({
        roots: [{ path: ".", lang: "php" }],
        adapters: { forge: { kind: "github" } },
      }),
    );

    expect(block).toContain("Forge: `github`. `empo review` reads the pull request");
  });
});

describe("mergeAgents", () => {
  const BLOCK = "the managed block";

  test("writes a heading and the block when there is no file", () => {
    const merged = mergeAgents(null, BLOCK);

    expect(merged).toContain(`${EMPO_BEGIN}\n${BLOCK}\n${EMPO_END}`);
    expect(merged.startsWith("# ")).toBe(true);
    expect(merged.endsWith("\n")).toBe(true);
  });

  test("appends to a hand-written file rather than replacing it", () => {
    // The common case in a real repository: AGENTS.md already exists and someone wrote it by hand.
    // EmPo owns what is between its markers and nothing else.
    const existing = "# Agents\n\nRun the linter before you commit.\n";

    const merged = mergeAgents(existing, BLOCK);

    expect(merged.startsWith(existing)).toBe(true);
    expect(merged).toContain(EMPO_BEGIN);
  });

  test("replaces only what is between the markers", () => {
    const existing = `before\n\n${EMPO_BEGIN}\nstale\n${EMPO_END}\n\nafter\n`;

    const merged = mergeAgents(existing, BLOCK);

    expect(merged).toBe(`before\n\n${EMPO_BEGIN}\n${BLOCK}\n${EMPO_END}\n\nafter\n`);
    expect(merged).not.toContain("stale");
  });

  test("is idempotent over its own output, whichever path produced it", () => {
    for (const existing of [null, "hand written\n", `x\n${EMPO_BEGIN}\nold\n${EMPO_END}\ny\n`]) {
      const once = mergeAgents(existing, BLOCK);
      expect(mergeAgents(once, BLOCK)).toBe(once);
    }
  });

  test("refuses a second marker pair instead of guessing which block is EmPo's", () => {
    // Both silent answers are wrong. Replacing the first pair leaves a stale copy of the very
    // instructions the block exists to keep current; replacing from the first marker to the last
    // one deletes whatever a human wrote between the pairs. So it stops and says what to fix.
    const doubled = `${EMPO_BEGIN}\na\n${EMPO_END}\nmine\n${EMPO_BEGIN}\nb\n${EMPO_END}\n`;

    const error = expectRefusal(() => mergeAgents(doubled, BLOCK));
    expect(error.message).toContain("AGENTS.md");
    expect([error.message, ...error.details].join("\n")).toContain(EMPO_BEGIN);
  });

  test("refuses an unclosed begin marker", () => {
    const unclosed = `# Agents\n\n${EMPO_BEGIN}\nhalf a block\n\nand a human's notes\n`;

    expectRefusal(() => mergeAgents(unclosed, BLOCK));
  });

  test("refuses an end marker with no begin", () => {
    expectRefusal(() => mergeAgents(`# Agents\n\nnotes\n${EMPO_END}\n`, BLOCK));
  });

  test("treats an empty file as a new one", () => {
    expect(mergeAgents("", BLOCK)).toBe(mergeAgents(null, BLOCK));
    expect(mergeAgents("\n\n", BLOCK)).toBe(mergeAgents(null, BLOCK));
  });
});

function expectRefusal(body: () => unknown): EmpoError {
  try {
    body();
    return expect.unreachable("expected a EmpoError");
  } catch (error) {
    expect(error).toBeInstanceOf(EmpoError);
    // A config error, exit 2: the repository is in a state a human has to resolve, and nothing was
    // written while it is.
    expect((error as EmpoError).exitCode).toBe(2);
    return error as EmpoError;
  }
}

describe("writeAgents", () => {
  test("creates the file when there is none", () => {
    const result = writeAgents(repo, TWO_ROOTS);

    expect(result).toEqual({ path: "AGENTS.md", state: "created" });
    expect(agents()).toContain(renderAgentsBlock(TWO_ROOTS));
  });

  test("is idempotent: a second run changes nothing and says so", () => {
    // This is what makes `empo update` runnable from a hook or a CI step: it does not dirty a
    // checkout it has nothing to change.
    writeAgents(repo, TWO_ROOTS);
    const written = agents();

    expect(writeAgents(repo, TWO_ROOTS)).toEqual({ path: "AGENTS.md", state: "unchanged" });
    expect(agents()).toBe(written);
  });

  test("updates the block when the config changed, and keeps the human's prose", () => {
    writeAgents(repo, TWO_ROOTS);
    const withNote = agents().replace(
      EMPO_BEGIN,
      `Our own house rules come first.\n\n${EMPO_BEGIN}`,
    );
    writeFileSync(join(repo, "AGENTS.md"), withNote);

    expect(writeAgents(repo, FULL)).toEqual({ path: "AGENTS.md", state: "updated" });
    expect(agents()).toContain("Our own house rules come first.");
    expect(agents()).toContain("bitbucket");
    expect(agents()).not.toContain("apps/mobile");
  });

  test("appends to an AGENTS.md that was written by hand", () => {
    writeFileSync(join(repo, "AGENTS.md"), "# Agents\n\nRun the linter.\n");

    expect(writeAgents(repo, BARE)).toEqual({ path: "AGENTS.md", state: "updated" });
    expect(agents()).toContain("Run the linter.");
    expect(agents()).toContain(EMPO_END);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
  });
});
