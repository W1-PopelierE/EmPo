/**
 * The small amount of terminal presentation EmPo does, in one place.
 *
 * Every command in this tree formats with bare `console.log`, which is right for output that is
 * read once and scrolled past. `empo upgrade` is the exception: it downloads a hundred megabytes
 * over a link it does not control, and a command that prints nothing for a minute is
 * indistinguishable from one that has hung. That needs a line that repaints, and a repainting line
 * needs to know whether anybody is watching.
 *
 * No dependency for this. `chalk` and `ora` are four escape sequences and a carriage return with a
 * release cadence attached, and this file is the whole of what would be used.
 *
 * Colour is decided per stream and at call time rather than once at import, because the tests
 * capture streams that are not terminals and a module-level constant would bake in whichever
 * environment happened to load the module first. NO_COLOR is honoured because it is the convention
 * (no-color.org), and TERM=dumb because that is what a terminal says when it cannot render this.
 */

import { resolve } from "node:path";

/**
 * A count and its noun, as a sentence fragment: "1 file", "3 files".
 *
 * The default appends an "s", which is right for every noun the commands had until "alias", the
 * first one whose plural is not the singular plus a letter. So the irregular form is a parameter
 * rather than a rule: a caller that knows its noun passes both, and every other caller is
 * unchanged.
 */
export function plural(count: number, noun: string, plural?: string): string {
  if (count === 1) return `${count} ${noun}`;
  return `${count} ${plural ?? `${noun}s`}`;
}

/** A path as written against the repo root, and unchanged when it lies outside it. */
export function relativeTo(repoRoot: string, path: string): string {
  const prefix = `${resolve(repoRoot)}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  red(text: string): string;
  cyan(text: string): string;
}

const PLAIN: Style = {
  bold: (text) => text,
  dim: (text) => text,
  green: (text) => text,
  red: (text) => text,
  cyan: (text) => text,
};

const ANSI: Style = {
  bold: (text) => `\u001b[1m${text}\u001b[0m`,
  dim: (text) => `\u001b[2m${text}\u001b[0m`,
  green: (text) => `\u001b[32m${text}\u001b[0m`,
  red: (text) => `\u001b[31m${text}\u001b[0m`,
  cyan: (text) => `\u001b[36m${text}\u001b[0m`,
};

/** Whether escape sequences on this stream would be read by a terminal rather than stored in a file. */
export function supportsColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.TERM === "dumb") return false;
  return stream.isTTY === true;
}

/** Styling functions that are the identity when nobody would see the difference. */
export function styleFor(stream: NodeJS.WriteStream = process.stdout): Style {
  return supportsColor(stream) ? ANSI : PLAIN;
}

/**
 * A green `✓ ` to prefix a line that succeeded, and the empty string everywhere else. Empty rather
 * than a plain `✓` on purpose: the existing tests assert on what upgrade prints, and a redirected
 * or captured stream should keep receiving exactly the sentences it received before.
 */
export function tick(stream: NodeJS.WriteStream = process.stdout): string {
  return supportsColor(stream) ? `${styleFor(stream).green("✓")} ` : "";
}

/**
 * Bytes as the size a human would say out loud, at one decimal place. Used for download totals,
 * where 108.1 MB tells somebody how long to expect to wait and 113417024 does not.
 */
export function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * A single line that repaints in place, or nothing at all.
 *
 * Written to stderr, for the reason curl writes its own bar there: progress is not the output of the
 * command, and `empo upgrade --json | jq` must keep working. Silent off a terminal, so a CI log gets
 * the result rather than a thousand carriage returns, and so a test that spies on `console.log`
 * never has to know this exists.
 */
export class ProgressLine {
  private readonly stream: NodeJS.WriteStream;
  private readonly enabled: boolean;
  private painted = false;

  constructor(stream: NodeJS.WriteStream = process.stderr) {
    this.stream = stream;
    this.enabled = stream.isTTY === true;
  }

  /**
   * Repaint with `received` of `total` bytes. A null total is a server that sent no Content-Length:
   * the count is still worth showing, and a bar drawn from a guessed denominator is not.
   */
  update(label: string, received: number, total: number | null): void {
    if (!this.enabled) return;
    const style = styleFor(this.stream);

    if (total === null || total <= 0) {
      this.paint(`${style.dim("·")} ${label} ${style.dim(humanBytes(received))}`);
      return;
    }

    // 28 cells, which fits beside the label inside the 80 columns that are always there.
    const width = 28;
    const done = Math.min(width, Math.round((received / total) * width));
    const bar = `${"█".repeat(done)}${style.dim("░".repeat(width - done))}`;
    const percent = `${Math.min(100, Math.floor((received / total) * 100))}`.padStart(3);
    this.paint(`${style.dim("·")} ${label} ${bar} ${percent}% ${style.dim(humanBytes(total))}`);
  }

  /** Erase the line, so whatever the command prints next starts on a clean one. */
  clear(): void {
    if (!this.enabled || !this.painted) return;
    this.stream.write("\r\u001b[K");
    this.painted = false;
  }

  private paint(text: string): void {
    this.stream.write(`\r${text}\u001b[K`);
    this.painted = true;
  }
}

/**
 * The widest cell in a column, for `padEnd`. Folded rather than spread: `Math.max(0, ...rows.map())`
 * throws a RangeError once the list passes the engine's argument limit, and the lists these columns
 * are drawn from (a blast radius on a widely-bridged file) are the ones with no cap on them.
 */
export function columnWidth<T>(rows: readonly T[], of: (row: T) => string): number {
  return rows.reduce((width, row) => Math.max(width, of(row).length), 0);
}
