/**
 * Every command returns a numeric exit code by throwing one of these, caught in empo.ts.
 * The codes are the table in docs/06-cli.md. Nothing under engine/ calls process.exit.
 *
 * The two readers at the bottom live here rather than in engine/ for the same reason: every layer
 * of this tree reads a JSON file and validates it, and this is the only module that imports nothing
 * of ours, so it is the one place all of them can import from without a cycle.
 */

import { readFileSync } from "node:fs";
import type { output, ZodType } from "zod";

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

/**
 * A JSON file, or a config error (exit 2) naming the file a human has to go and open.
 *
 * `path` is separate from `absolute` because the two are not the same string to a reader: the file
 * is opened by its absolute path and reported by whatever form the caller prints elsewhere, which
 * for spines is the repo-relative one every other path EmPo prints takes. `extraDetails` is for the
 * callers that can say something useful about how to get the file back, e.g. the generated graph,
 * which `empo index` rewrites.
 */
export function readJson(absolute: string, path: string, extraDetails: string[] = []): unknown {
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw configError(`${path} is not valid JSON`, [(error as Error).message, ...extraDetails]);
  }
}

/**
 * Validate an already-parsed value against its schema, or throw a config error (exit 2) listing
 * every issue rather than only the first: a config with three mistakes in it should cost one run to
 * fix, not three. Each issue is reported at its path, and issues at the document root have no path
 * to print, so they are printed as the bare message.
 *
 * `source` is the file, `noun` is what it was supposed to be, and they are separate arguments
 * because the noun is the whole of what differs between the callers.
 */
export function parseOrThrow<S extends ZodType>(
  schema: S,
  raw: unknown,
  source: string,
  noun: string,
): output<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  throw configError(`${source} is not a valid ${noun}`, details);
}
