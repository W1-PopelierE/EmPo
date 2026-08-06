import { CommanderError } from "commander";
import { EmpoError } from "./errors";
import { buildProgram } from "./program";

/**
 * `parseAsync`, not `parse`, because `empo hook` reads its payload from stdin and so has an async
 * action. `parse` returns without awaiting one, which would drop a rejection on the floor and let
 * the process exit before the answer was written.
 */
async function main(): Promise<void> {
  const program = buildProgram();
  program.exitOverride();

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof EmpoError) {
      console.error("");
      console.error(`${error.message}`);
      for (const detail of error.details) console.error(`  ${detail}`);
      process.exit(error.exitCode);
    }
    // --help and --version land here with exit code 0; anything else is a usage error.
    if (error instanceof CommanderError) {
      process.exit(error.exitCode === 0 ? 0 : 2);
    }
    throw error;
  }
}

// Anything reaching here got past the handler above, so it is a defect rather than a known failure
// and is worth its stack trace. Exiting 1 keeps that distinct from the four documented exit codes.
main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
