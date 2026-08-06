/**
 * The command surface, built and returned rather than run, so that something other than a terminal
 * can hold it. `src/empo.ts` is the entry point and runs it; a spec imports it to check that the
 * flags this program accepts are the flags the rest of the tool tells an agent to use.
 *
 * The two are separate files for one reason: empo.ts calls main() at module scope, which is what an
 * entry point is for and what makes it unimportable. Guarding that call on "am I the entry point"
 * would have made this file unnecessary and the CLI silently do nothing wherever the guard read a
 * symlinked bin shim wrong, which is the worst failure a command line tool has.
 */

import { createRequire } from "node:module";
import { Command } from "commander";
import { checkCommand } from "./commands/check";
import { doctorCommand } from "./commands/doctor";
import { hookCommand } from "./commands/hook";
import { indexCommand } from "./commands/index";
import { initCommand } from "./commands/init";
import { packTestCommand } from "./commands/pack";
import { queryCommand } from "./commands/query";
import { reviewCommand } from "./commands/review";
import { updateCommand } from "./commands/update";
import { upgradeCommand } from "./commands/upgrade";
import { verifyCommand } from "./commands/verify";
import { EMBEDDED_VERSION } from "./embedded";

/**
 * `package.json`'s version, which is the whole answer to "which build is this"
 * (docs/10-distribution.md). Read off the file wherever there is one beside the bundle, and
 * compiled in for the standalone binary, which ships no `package.json` and whose CommonJS bundle
 * has an empty `import.meta` besides. `??` is what keeps `createRequire` unreached in the binary
 * rather than merely unused, so the eager call cannot throw where the file is not there.
 */
const version =
  EMBEDDED_VERSION ??
  (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("empo")
    .description("Impact and review toolkit that keeps an AI agent honest about a codebase")
    .version(version);

  program
    .command("init")
    .description("Detect languages, scaffold .empo/, wire the host, and brief the mapping agent")
    .option("--repo <path>", "repository root", process.cwd())
    .option("--lang <packs>", "force the packs, comma separated, instead of detecting them")
    .option("--no-host", "skip host wiring, touch nothing outside .empo/")
    .option("--config-at-root", "write empo.config.json at the repo root instead of .empo/", false)
    .option("--commit-generated", "keep generated/ in version control", false)
    .option(
      "--tracker <host>",
      "the system tickets live in (jira, asana, linear); nothing detects it",
    )
    .option("--proposal <path>", "gate an agent's flow and spine proposal")
    .option("--apply", "write what the proposal gate kept", false)
    .action(
      (options: {
        repo: string;
        lang?: string;
        host: boolean;
        configAtRoot: boolean;
        commitGenerated: boolean;
        tracker?: string;
        proposal?: string;
        apply: boolean;
      }) => {
        initCommand(options.repo, options);
      },
    );

  program
    .command("update")
    .description("Regenerate host instructions from the shipped discipline and this config")
    .option("--repo <path>", "repository root", process.cwd())
    .action((options: { repo: string }) => {
      updateCommand(options.repo);
    });

  // The only command with no --repo option, and the only one that uses the network. It answers a
  // question about this installation rather than about a repository, so there is nothing for a repo
  // path to mean here. The running version is passed in rather than read again inside the command,
  // so `empo --version` and `empo upgrade` can never disagree about which build this is.
  program
    .command("upgrade")
    .description("Replace the running standalone binary with the latest release")
    .option("--check", "report whether an upgrade exists, download nothing, write nothing", false)
    .option("--json", "machine-readable output", false)
    .action(async (options: { check: boolean; json: boolean }) => {
      await upgradeCommand(version, { check: options.check, json: options.json });
    });

  program
    .command("doctor")
    .description("Health check: config validity, unmapped directories, graph staleness")
    .option("--repo <path>", "repository root", process.cwd())
    .option("--json", "machine-readable output", false)
    .action((options: { repo: string; json: boolean }) => {
      doctorCommand(options.repo, { json: options.json });
    });

  // The one command whose caller is a host rather than a person, so it is the one command that
  // prints nothing when all is well (docs/10-distribution.md). It reads the hook payload on stdin
  // and answers on stdout, and it never exits non-zero, not even to deny: a denial rides inside the
  // JSON, because exit 2 discards stdout. Nothing it can hit is allowed to become a crash in
  // somebody's unrelated repository, which is why hookCommand resolves rather than throwing.
  program
    .command("hook")
    .argument("<event>", "session-start, pre-edit, or pre-commit")
    .description("Answer a Claude Code hook, reading its payload on stdin")
    .option("--repo <path>", "repository root, which the hook fills from CLAUDE_PROJECT_DIR")
    .action(async (event: string, options: { repo?: string }) => {
      await hookCommand(event, { repo: options.repo });
    });

  program
    .command("index")
    .description("(Re)build .empo/generated/graph.json from source")
    .option("--repo <path>", "repository root", process.cwd())
    .option("--check", "exit 1 if the graph on disk is not what a rebuild would produce", false)
    .action((options: { repo: string; check: boolean }) => {
      indexCommand(options.repo, { check: options.check });
    });

  program
    .command("query")
    .argument("[symbol]", "node id, file path, or short name")
    .description("Blast radius: what breaks if I change this, and would a test notice")
    .option("--repo <path>", "repository root", process.cwd())
    .option("--json", "machine-readable output", false)
    .option("--blind", "flows reached by a test that asserts no value", false)
    .option("--gods", "the widest-blast-radius nodes in the repo", false)
    .option("--orphans", "nodes nothing references, dead-code candidates", false)
    .option("--hazards", "jobs dispatched inside a transaction, before it commits", false)
    // --orphans hides the kinds a pack marks framework-resolved, because a view rendered by name
    // has no fan-in whether it is used or not. This is how to see them anyway.
    .option("--all", "with --orphans, list the framework-resolved kinds too", false)
    .action(
      (
        symbol: string | undefined,
        options: {
          repo: string;
          json: boolean;
          blind: boolean;
          gods: boolean;
          orphans: boolean;
          hazards: boolean;
          all: boolean;
        },
      ) => {
        queryCommand(options.repo, symbol, options);
      },
    );

  program
    .command("verify")
    .description("Resolve every spine citation against current source and report drift")
    .option("--repo <path>", "repository root", process.cwd())
    .option("--json", "machine-readable output", false)
    .action((options: { repo: string; json: boolean }) => {
      verifyCommand(options.repo, { json: options.json });
    });

  program
    .command("check")
    .description("Commit gate: a spine's guarded files changed with no value-asserting test")
    .option("--repo <path>", "repository root", process.cwd())
    .option("--base <ref>", "judge the changes against this ref instead of the staged diff")
    .option("--bypass <reason>", "override the gate explicitly, with the reason on the record")
    .option("--json", "machine-readable output", false)
    .action((options: { repo: string; base?: string; bypass?: string; json: boolean }) => {
      checkCommand(options.repo, {
        base: options.base,
        bypass: options.bypass,
        json: options.json,
      });
    });

  program
    .command("review")
    .argument("[pr]", "pull request id, or nothing to review the local diff")
    .description("Run the review discipline over a pull request or the local diff")
    .option("--repo <path>", "repository root", process.cwd())
    .option("--base <ref>", "pin the comparison base, critical for stacked pull requests")
    .option("--findings <path>", "verify a findings file and produce the report")
    // Not --pr: the pull request id is already the positional argument, and one line reading
    // `empo review 412 --pr payload.json` would spend "pr" on two different things.
    .option("--pr-payload <path>", "the pull request an mcp host fetched, as JSON")
    .option("--ticket-payload <path>", "the ticket an mcp host fetched, as JSON")
    .option(
      "--no-ticket",
      "the ticket this pull request names cannot be fetched, review without it",
    )
    .option("--readonly", "no posting, no mutating forge actions", false)
    .option("--post", "post verified findings to the pull request", false)
    .option("--json", "machine-readable output", false)
    .option("--no-workflow", "leave the shipped discipline out of the brief")
    .action(
      (
        pr: string | undefined,
        options: {
          repo: string;
          base?: string;
          findings?: string;
          prPayload?: string;
          ticketPayload?: string;
          ticket: boolean;
          readonly: boolean;
          post: boolean;
          json: boolean;
          workflow: boolean;
        },
      ) => {
        reviewCommand(options.repo, pr, options);
      },
    );

  const pack = program.command("pack").description("Language pack tooling");

  pack
    .command("test")
    .argument("<name>", "pack name, e.g. php")
    .description("Run a language pack against its fixtures and diff the snapshot")
    .option("--update", "rewrite the expected snapshot instead of diffing it", false)
    .action((name: string, options: { update: boolean }) => {
      packTestCommand(name, { update: options.update });
    });

  return program;
}
