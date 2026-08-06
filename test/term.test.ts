import { afterEach, describe, expect, it } from "vitest";
import { humanBytes, ProgressLine, styleFor, supportsColor, tick } from "../src/term";

/**
 * The rules under test are the ones that decide whether anything is written at all. Colour and a
 * repainting line are correct in a terminal and wrong everywhere else: escape sequences in a CI log
 * are noise, and carriage returns in a redirected file are a corrupted record. Getting that decision
 * wrong is silent in development, where every stream is a terminal, and obvious only in somebody
 * else's pipeline, so it is the part worth pinning.
 */

/** A stand-in for a stream that records what was written and claims whatever TTY-ness is asked for. */
function fakeStream(isTTY: boolean): NodeJS.WriteStream & { written: string[] } {
  const written: string[] = [];
  return {
    isTTY,
    written,
    write(chunk: string): boolean {
      written.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream & { written: string[] };
}

const originalNoColor = process.env.NO_COLOR;
const originalTerm = process.env.TERM;

afterEach(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
  if (originalTerm === undefined) delete process.env.TERM;
  else process.env.TERM = originalTerm;
});

describe("supportsColor", () => {
  it("is true for a terminal with nothing objecting", () => {
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    expect(supportsColor(fakeStream(true))).toBe(true);
  });

  it("is false when the stream is not a terminal", () => {
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    expect(supportsColor(fakeStream(false))).toBe(false);
  });

  it("honours NO_COLOR even on a terminal", () => {
    process.env.NO_COLOR = "1";
    process.env.TERM = "xterm-256color";
    expect(supportsColor(fakeStream(true))).toBe(false);
  });

  // NO_COLOR is set-or-unset by its own specification, but an empty value is what a shell leaves
  // behind after `NO_COLOR=` and reading that as "no colour" would surprise whoever cleared it.
  it("ignores an empty NO_COLOR", () => {
    process.env.NO_COLOR = "";
    process.env.TERM = "xterm-256color";
    expect(supportsColor(fakeStream(true))).toBe(true);
  });

  it("is false under TERM=dumb", () => {
    delete process.env.NO_COLOR;
    process.env.TERM = "dumb";
    expect(supportsColor(fakeStream(true))).toBe(false);
  });
});

describe("styleFor", () => {
  it("wraps in escape sequences for a terminal", () => {
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    const style = styleFor(fakeStream(true));
    expect(style.bold("x")).toBe("\u001b[1mx\u001b[0m");
    expect(style.green("x")).toBe("\u001b[32mx\u001b[0m");
  });

  it("is the identity everywhere else, so redirected output is unchanged text", () => {
    const style = styleFor(fakeStream(false));
    expect(style.bold("x")).toBe("x");
    expect(style.dim("x")).toBe("x");
    expect(style.green("x")).toBe("x");
    expect(style.red("x")).toBe("x");
    expect(style.cyan("x")).toBe("x");
  });
});

describe("tick", () => {
  it("is a green mark on a terminal and nothing at all off one", () => {
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    expect(tick(fakeStream(true))).toBe("\u001b[32m✓\u001b[0m ");
    expect(tick(fakeStream(false))).toBe("");
  });
});

describe("humanBytes", () => {
  it("names sizes the way somebody waiting on a download would", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(2048)).toBe("2 KB");
    expect(humanBytes(113_417_024)).toBe("108.2 MB");
  });
});

describe("ProgressLine", () => {
  it("writes nothing at all when the stream is not a terminal", () => {
    const stream = fakeStream(false);
    const line = new ProgressLine(stream);
    line.update("asset", 10, 100);
    line.update("asset", 100, 100);
    line.clear();
    expect(stream.written).toEqual([]);
  });

  it("repaints one line, always returning to column zero and erasing the tail", () => {
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    const stream = fakeStream(true);
    const line = new ProgressLine(stream);

    line.update("empo-darwin-arm64", 0, 100);
    line.update("empo-darwin-arm64", 100, 100);

    expect(stream.written).toHaveLength(2);
    for (const write of stream.written) {
      expect(write.startsWith("\r")).toBe(true);
      expect(write.endsWith("\u001b[K")).toBe(true);
      expect(write).toContain("empo-darwin-arm64");
    }
    expect(stream.written[0]).toContain("  0%");
    expect(stream.written[1]).toContain("100%");
  });

  it("shows a running count rather than a bar when the server sent no length", () => {
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    const stream = fakeStream(true);
    new ProgressLine(stream).update("asset", 2048, null);
    expect(stream.written[0]).toContain("2 KB");
    expect(stream.written[0]).not.toContain("%");
  });

  it("erases on clear, but only if it had painted", () => {
    const stream = fakeStream(true);
    const line = new ProgressLine(stream);

    line.clear();
    expect(stream.written).toEqual([]);

    line.update("asset", 1, 2);
    line.clear();
    expect(stream.written.at(-1)).toBe("\r\u001b[K");

    // A second clear is a no-op rather than a second erase, so a caller may call it defensively.
    line.clear();
    expect(stream.written.at(-1)).toBe("\r\u001b[K");
  });
});
