/**
 * Every command returns a numeric exit code by throwing one of these, caught in empo.ts.
 * The codes are the table in docs/06-cli.md. Nothing under engine/ calls process.exit.
 */

export type ExitCode = 0 | 1 | 2 | 3;

export class EmpoError extends Error {
  readonly exitCode: ExitCode;
  readonly details: string[];

  constructor(message: string, exitCode: ExitCode, details: string[] = []) {
    super(message);
    this.name = "EmpoError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

/** 1: a gate failed (check, verify, index --check, pack test mismatch). */
export function gateFailure(message: string, details: string[] = []): EmpoError {
  return new EmpoError(message, 1, details);
}

/** 2: usage or config error (bad flags, invalid config.json, missing pack). */
export function configError(message: string, details: string[] = []): EmpoError {
  return new EmpoError(message, 2, details);
}

/** 3: environment error (an adapter's CLI or MCP is missing or unauthenticated). */
export function environmentError(message: string, details: string[] = []): EmpoError {
  return new EmpoError(message, 3, details);
}
