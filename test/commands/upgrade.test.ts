import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  compareVersions,
  decideUpgrade,
  type Release,
  upgradeCommand,
  verifyChecksum,
} from "../../src/commands/upgrade";
import { EmpoError } from "../../src/errors";

/**
 * `empo upgrade`, with the network replaced at the two seams the command declares.
 *
 * Nothing here reaches GitHub, and nothing here may: a suite that needs a socket is a suite that is
 * green on one machine. Both seams are passed in explicitly on every run, so a defect that made the
 * real fetcher run would fail as an unexpected request rather than pass quietly against a live
 * release.
 *
 * The install tests use a real directory with a real file standing in for the binary, because the
 * assertion that matters (a bad checksum installs nothing and leaves no temp file behind) is an
 * assertion about a directory listing and cannot be made against a mock.
 */

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BINARY = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

function hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A release carrying the four assets CI attaches, plus their sums. */
function release(tag: string): Release {
  const assets = [];
  for (const name of [
    "empo-darwin-arm64",
    "empo-darwin-x64",
    "empo-linux-x64",
    "empo-linux-arm64",
  ]) {
    assets.push({ name, url: `https://example.invalid/${tag}/${name}` });
    assets.push({ name: `${name}.sha256`, url: `https://example.invalid/${tag}/${name}.sha256` });
  }
  return { tag, assets };
}

/**
 * A downloader over a fixed body, recording every url it was asked for. `sum` is the checksum line
 * to answer with, so a mismatch is built by handing it a hash of something else.
 */
function downloader(
  bytes: Uint8Array,
  sum: string,
): {
  download: (url: string) => Promise<Uint8Array>;
  urls: string[];
} {
  const urls: string[] = [];
  return {
    urls,
    download: async (url: string) => {
      urls.push(url);
      return url.endsWith(".sha256") ? new Uint8Array(Buffer.from(sum, "utf8")) : bytes;
    },
  };
}

/** A downloader that fails the test if anything calls it. */
const forbidden = async (url: string): Promise<Uint8Array> => {
  throw new Error(`nothing may be downloaded here, but ${url} was requested`);
};

function capture(body: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  return body()
    .then(() => lines.join("\n"))
    .finally(() => {
      log.mockRestore();
    });
}

async function expectEmpoError(exitCode: number, body: () => Promise<void>): Promise<EmpoError> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let thrown: unknown;
  try {
    await body();
  } catch (error) {
    thrown = error;
  } finally {
    log.mockRestore();
  }
  expect(thrown, `expected a EmpoError with exit code ${exitCode}`).toBeInstanceOf(EmpoError);
  expect((thrown as EmpoError).exitCode).toBe(exitCode);
  return thrown as EmpoError;
}

/** A directory holding a file that stands in for the installed binary. */
function installDir(): { dir: string; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), "empo-upgrade-"));
  temps.push(dir);
  const binary = join(dir, "empo");
  writeFileSync(binary, "the old binary");
  return { dir, binary };
}

describe("compareVersions", () => {
  test("compares numerically, so 0.1.10 is newer than 0.1.9", () => {
    // The one case a string compare gets backwards, and the reason this function exists.
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.9", "0.1.10")).toBe(-1);
    expect("0.1.10" > "0.1.9").toBe(false);
  });

  test("compares major before minor before patch", () => {
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.2.0", "0.1.99")).toBe(1);
    expect(compareVersions("2.3.4", "2.3.4")).toBe(0);
  });

  test("ignores a leading v and a prerelease suffix", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-rc.1", "1.2.3")).toBe(0);
  });

  test("treats a missing or unparseable component as zero rather than as newer", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("nightly", "0.0.1")).toBe(-1);
  });
});

describe("decideUpgrade", () => {
  test("current when the running version equals the release", () => {
    const decision = decideUpgrade("0.1.1", release("v0.1.1"), "darwin", "arm64");
    expect(decision.state).toBe("current");
  });

  test("current when the running build is ahead of the last release", () => {
    const decision = decideUpgrade("0.2.0", release("v0.1.1"), "darwin", "arm64");
    expect(decision.state).toBe("current");
  });

  test("available names the asset for this platform and its sha256 sibling", () => {
    const decision = decideUpgrade("0.1.1", release("v0.1.2"), "linux", "x64");
    expect(decision.state).toBe("available");
    if (decision.state !== "available") return;
    expect(decision.asset.name).toBe("empo-linux-x64");
    expect(decision.sum.name).toBe("empo-linux-x64.sha256");
    expect(decision.latest).toBe("0.1.2");
  });

  test("no-asset names what was wanted and what was offered", () => {
    const decision = decideUpgrade("0.1.1", release("v0.1.2"), "freebsd", "riscv64");
    expect(decision.state).toBe("no-asset");
    if (decision.state !== "no-asset") return;
    expect(decision.wanted).toBe("empo-freebsd-riscv64");
    expect(decision.offered).toContain("empo-linux-x64");
  });

  test("no-asset when the binary is attached without its checksum", () => {
    const partial: Release = {
      tag: "v0.1.2",
      assets: [{ name: "empo-linux-x64", url: "https://example.invalid/empo-linux-x64" }],
    };
    // An unverifiable asset is not an asset. Installing it would be the one thing the checksum is
    // published to prevent.
    expect(decideUpgrade("0.1.1", partial, "linux", "x64").state).toBe("no-asset");
  });
});

describe("verifyChecksum", () => {
  test("accepts the shasum -a 256 line for these bytes", () => {
    const line = `${hex(BINARY)}  empo-linux-x64\n`;
    expect(verifyChecksum(BINARY, line, "empo-linux-x64").ok).toBe(true);
  });

  test("rejects a hash of different bytes", () => {
    const line = `${hex(new Uint8Array([1, 2, 3]))}  empo-linux-x64\n`;
    const checked = verifyChecksum(BINARY, line, "empo-linux-x64");
    expect(checked.ok).toBe(false);
    expect(checked.actual).toBe(hex(BINARY));
  });

  test("rejects a checksum file describing a different asset", () => {
    const line = `${hex(BINARY)}  empo-darwin-arm64\n`;
    const checked = verifyChecksum(BINARY, line, "empo-linux-x64");
    expect(checked.ok).toBe(false);
    expect(checked.note).toContain("empo-darwin-arm64");
  });

  test("rejects a checksum file that is not <hex>  <filename>", () => {
    const checked = verifyChecksum(BINARY, "not a checksum at all\n", "empo-linux-x64");
    expect(checked.ok).toBe(false);
    expect(checked.expected).toBeNull();
  });
});

describe("upgradeCommand", () => {
  test("reports current and downloads nothing when the latest release is installed", async () => {
    const printed = await capture(() =>
      upgradeCommand("0.1.1", {
        embedded: true,
        platform: "linux",
        arch: "x64",
        fetchRelease: async () => release("v0.1.1"),
        download: forbidden,
      }),
    );
    expect(printed).toContain("0.1.1 is the latest release");
  });

  test("--check reports a newer version and writes nothing", async () => {
    const { dir, binary } = installDir();
    const before = readFileSync(binary, "utf8");

    const printed = await capture(() =>
      upgradeCommand("0.1.1", {
        check: true,
        embedded: true,
        platform: "linux",
        arch: "x64",
        execPath: binary,
        fetchRelease: async () => release("v0.1.2"),
        download: forbidden,
      }),
    );

    expect(printed).toContain("0.1.2 is available");
    expect(readFileSync(binary, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["empo"]);
  });

  test("--json prints one document and no prose", async () => {
    const printed = await capture(() =>
      upgradeCommand("0.1.1", {
        check: true,
        json: true,
        embedded: true,
        platform: "linux",
        arch: "x64",
        fetchRelease: async () => release("v0.1.2"),
        download: forbidden,
      }),
    );
    expect(JSON.parse(printed)).toEqual({
      state: "available",
      current: "0.1.1",
      latest: "0.1.2",
      asset: "empo-linux-x64",
      target: null,
    });
  });

  // The header, the progress line and the two ticks all arrived with this feature, and any of them
  // leaking onto stdout under --json would turn the document into something JSON.parse rejects.
  test("--json stays one document on the path that actually installs", async () => {
    const { binary } = installDir();
    const { download } = downloader(BINARY, `${hex(BINARY)}  empo-linux-x64\n`);

    const printed = await capture(() =>
      upgradeCommand("0.1.1", {
        json: true,
        embedded: true,
        platform: "linux",
        arch: "x64",
        execPath: binary,
        fetchRelease: async () => release("v0.1.2"),
        download,
      }),
    );

    expect(JSON.parse(printed)).toEqual({
      state: "upgraded",
      current: "0.1.1",
      latest: "0.1.2",
      asset: "empo-linux-x64",
      target: binary,
    });
  });

  // A downloader written before progress existed takes one argument and ignores the second. Passing
  // the callback anyway has to stay harmless, because every fake in this file is such a function.
  test("reports download progress to a downloader that asks for it", async () => {
    const { binary } = installDir();

    const printed = await capture(() =>
      upgradeCommand("0.1.1", {
        embedded: true,
        platform: "linux",
        arch: "x64",
        execPath: binary,
        fetchRelease: async () => release("v0.1.2"),
        download: async (url, onProgress) => {
          if (url.endsWith(".sha256")) {
            // No progress for the checksum file, which is why nothing is reported here.
            expect(onProgress).toBeUndefined();
            return new TextEncoder().encode(`${hex(BINARY)}  empo-linux-x64\n`);
          }
          expect(typeof onProgress).toBe("function");
          onProgress?.(0, BINARY.byteLength);
          onProgress?.(BINARY.byteLength, BINARY.byteLength);
          // A server that sent no Content-Length still reports, with no denominator.
          onProgress?.(BINARY.byteLength, null);
          return BINARY;
        },
      }),
    );

    // Progress is drawn on stderr and only on a terminal, so the captured stdout of this run holds
    // the result and nothing else. That is the whole point of putting it there.
    expect(printed).toContain("Upgraded empo 0.1.1 -> 0.1.2");
    expect(printed).not.toContain("%");
  });

  test("installs the verified asset over the running binary", async () => {
    const { dir, binary } = installDir();
    const { download, urls } = downloader(BINARY, `${hex(BINARY)}  empo-linux-x64\n`);

    const printed = await capture(() =>
      upgradeCommand("0.1.1", {
        embedded: true,
        platform: "linux",
        arch: "x64",
        execPath: binary,
        fetchRelease: async () => release("v0.1.2"),
        download,
      }),
    );

    expect(printed).toContain("Upgraded empo 0.1.1 -> 0.1.2");
    expect(new Uint8Array(readFileSync(binary))).toEqual(BINARY);
    expect(statSync(binary).mode & 0o777).toBe(0o755);
    expect(urls).toEqual([
      "https://example.invalid/v0.1.2/empo-linux-x64",
      "https://example.invalid/v0.1.2/empo-linux-x64.sha256",
    ]);
    // The temp file is renamed, never left beside the binary it replaced.
    expect(readdirSync(dir)).toEqual(["empo"]);
  });

  test("a sha256 mismatch installs nothing and leaves no temp file behind", async () => {
    const { dir, binary } = installDir();
    const before = readFileSync(binary, "utf8");
    // The published sum of some other bytes: what a corrupted or substituted download looks like.
    const { download } = downloader(BINARY, `${hex(new Uint8Array([9, 9, 9]))}  empo-linux-x64\n`);

    const error = await expectEmpoError(3, () =>
      upgradeCommand("0.1.1", {
        embedded: true,
        platform: "linux",
        arch: "x64",
        execPath: binary,
        fetchRelease: async () => release("v0.1.2"),
        download,
      }),
    );

    expect(error.message).toContain("does not match its published sha256");
    expect(readFileSync(binary, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["empo"]);
  });

  test("no asset for this platform is an environment error naming the platform", async () => {
    const error = await expectEmpoError(3, () =>
      upgradeCommand("0.1.1", {
        embedded: true,
        platform: "freebsd",
        arch: "riscv64",
        fetchRelease: async () => release("v0.1.2"),
        download: forbidden,
      }),
    );

    expect(error.message).toContain("freebsd-riscv64");
    expect(error.details.join(" ")).toContain("empo-freebsd-riscv64");
    expect(error.details.join(" ")).toContain("empo-linux-x64");
  });

  test("refuses on a build that is not the standalone binary, and names the repair", async () => {
    const error = await expectEmpoError(2, () =>
      upgradeCommand("0.1.1", {
        embedded: false,
        fetchRelease: async () => {
          throw new Error("the network must not be reached before the build is checked");
        },
        download: forbidden,
      }),
    );

    expect(error.message).toContain("only replaces the standalone binary");
    // The repair is a rebuild or install.sh, never an npm install: EmPo is not published to npm and
    // `package.json` carries `private: true` to keep it that way (docs/10-distribution.md). A
    // message sending somebody to a registry that has never held this package is worse than none.
    expect(error.details.join(" ")).toContain("npm run install:local");
    expect(error.details.join(" ")).toContain("install.sh");
    expect(error.details.join(" ")).not.toContain("npm update -g");
    expect(error.details.join(" ")).not.toContain("sudo");
  });

  test("refuses to install on win32, and says --check still works", async () => {
    const error = await expectEmpoError(3, () =>
      upgradeCommand("0.1.1", {
        embedded: true,
        platform: "win32",
        arch: "x64",
        fetchRelease: async () => {
          throw new Error("the network must not be reached before the platform is checked");
        },
        download: forbidden,
      }),
    );

    expect(error.message).toContain("cannot replace a running executable on Windows");
    expect(error.details.join(" ")).toContain("--check");
  });

  test("--check still reports on win32, where only the install is impossible", async () => {
    const printed = await capture(() =>
      upgradeCommand("0.1.1", {
        check: true,
        embedded: true,
        platform: "win32",
        arch: "x64",
        fetchRelease: async () => ({
          tag: "v0.1.2",
          assets: [
            { name: "empo-win32-x64", url: "https://example.invalid/empo-win32-x64" },
            { name: "empo-win32-x64.sha256", url: "https://example.invalid/empo-win32-x64.sha256" },
          ],
        }),
        download: forbidden,
      }),
    );
    expect(printed).toContain("0.1.2 is available");
  });

  // Skipped for root, whose write is permitted whatever the mode says, so the condition this test
  // builds does not exist there. Skipping is honest; asserting the error anyway would be a red that
  // says nothing about the code.
  const unprivileged = process.platform !== "win32" && (process.getuid?.() ?? 0) !== 0;

  test.skipIf(!unprivileged)(
    "an unwritable target directory names the path and says to reinstall, never to sudo",
    async () => {
      const { dir, binary } = installDir();
      const { download } = downloader(BINARY, `${hex(BINARY)}  empo-linux-x64\n`);
      // Read and execute only: the shape of a binary installed into a prefix this user does not own.
      const original = statSync(dir).mode;
      chmodSync(dir, 0o555);

      try {
        const error = await expectEmpoError(3, () =>
          upgradeCommand("0.1.1", {
            embedded: true,
            platform: "linux",
            arch: "x64",
            execPath: binary,
            fetchRelease: async () => release("v0.1.2"),
            download,
          }),
        );
        expect(error.message).toContain(dir);
        expect(error.details.join(" ")).toContain("writable location");
        // The repair is a reinstall somewhere writable. The one thing it must never be is escalation.
        expect(error.details.join(" ")).toContain("Do not use sudo");
      } finally {
        // Restored so afterEach can remove the tree; rmSync cannot unlink out of a read-only parent.
        chmodSync(dir, original);
      }
    },
  );
});
