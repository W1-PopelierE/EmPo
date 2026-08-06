import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What this file can and cannot pin, stated once so the gap is not mistaken for coverage.
 *
 * **It cannot pin an install.** The repository is private and no release with assets exists, so
 * nothing here downloads a binary, verifies a real checksum or writes to a real `~/.local/bin`.
 * Those paths become exercisable on the first public release and are untested until then.
 *
 * **It can pin the two things that are silent when they break.** The first is cross-file agreement:
 * `install.sh` computes an asset name and `.github/workflows/ci.yml` builds one, nothing checks them
 * against each other, and a platform added to CI and not to the installer produces a 404 on somebody
 * else's machine rather than a red build here. The second is the `uname` normalisation, which is
 * pure logic and therefore fully testable.
 *
 * **How the mapping is exercised:** by putting a stub `uname` first on PATH and running the real
 * script with `--print-target`, which resolves the asset name and exits before it touches the
 * network. The alternative was to guard the script's body so a test could source it and call
 * `detect_target` directly, and that was declined: a sourcing guard is machinery that exists only
 * for the test, whereas `--print-target` is a diagnostic a user can run to answer "which of the four
 * builds is mine". The stub also tests the script exactly as shipped, with no test-only branch.
 */

const script = join(process.cwd(), "install.sh");
const source = readFileSync(script, "utf8");

/**
 * Run `install.sh --print-target` with `uname -s` and `uname -m` answering whatever this call says.
 * Returns the asset name, or the failure text when the script rejects the combination.
 */
function targetFor(unameS: string, unameM: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "empo-install-uname-"));

  try {
    writeFileSync(
      join(dir, "uname"),
      `#!/bin/sh\ncase "$1" in\n  -s) echo ${unameS} ;;\n  -m) echo ${unameM} ;;\nesac\n`,
      { mode: 0o755 },
    );

    try {
      const stdout = execFileSync("sh", [script, "--print-target"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });

      return { ok: true, output: stdout.trim() };
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string };

      return { ok: false, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the uname mapping", () => {
  /**
   * The same machine answers to two names on each axis, and only one of the two is the asset name.
   * A machine reporting `x86_64` asking for `empo-linux-x86_64` gets a 404 from a release that has
   * the binary it needs sitting right there under another spelling.
   */
  it("normalises both spellings of each architecture", () => {
    expect(targetFor("Linux", "x86_64")).toEqual({ ok: true, output: "empo-linux-x64" });
    expect(targetFor("Linux", "amd64")).toEqual({ ok: true, output: "empo-linux-x64" });
    expect(targetFor("Linux", "aarch64")).toEqual({ ok: true, output: "empo-linux-arm64" });
    expect(targetFor("Linux", "arm64")).toEqual({ ok: true, output: "empo-linux-arm64" });
  });

  it("maps Darwin the same way", () => {
    expect(targetFor("Darwin", "x86_64")).toEqual({ ok: true, output: "empo-darwin-x64" });
    expect(targetFor("Darwin", "arm64")).toEqual({ ok: true, output: "empo-darwin-arm64" });
  });

  it("refuses an unsupported combination by naming what it saw and what exists", () => {
    const rejected = targetFor("FreeBSD", "riscv64");

    expect(rejected.ok).toBe(false);
    expect(rejected.output).toContain("FreeBSD riscv64");
    for (const asset of [
      "empo-darwin-arm64",
      "empo-darwin-x64",
      "empo-linux-x64",
      "empo-linux-arm64",
    ]) {
      expect(rejected.output).toContain(asset);
    }
  });

  it("refuses a supported platform on an unsupported architecture", () => {
    const rejected = targetFor("Linux", "armv7l");

    expect(rejected.ok).toBe(false);
    expect(rejected.output).toContain("Linux armv7l");
  });
});

describe("the assets install.sh asks for and the ones CI builds", () => {
  /**
   * The platforms CI actually builds a binary for, read out of the `binaries` matrix rather than
   * restated here. Parsed with the same shape `test/packaging.test.ts` uses, and asserted non-empty
   * before it is compared: a regex that silently matches nothing turns a set comparison into
   * `[] vs []` and passes while proving nothing, which is the failure `docs/14` records.
   */
  function buildableTargets(): string[] {
    const workflow = readFileSync(join(".github", "workflows", "ci.yml"), "utf8");
    const targets = [...workflow.matchAll(/^\s+- os: \S+\n\s+target: (\S+)$/gm)].map(
      (match) => match[1] as string,
    );

    expect(
      targets.length,
      "no `- os: ... / target: ...` pairs found in the ci.yml binaries matrix, so this spec would " +
        "compare two empty sets and pass while proving nothing",
    ).toBeGreaterThan(0);

    return targets;
  }

  /** Every asset name the script can construct, taken from the script itself, not from a list. */
  function installableAssets(): string[] {
    const constructed = new Set<string>();

    for (const unameS of ["Darwin", "Linux"]) {
      for (const unameM of ["x86_64", "amd64", "aarch64", "arm64"]) {
        const resolved = targetFor(unameS, unameM);

        expect(resolved.ok, `${unameS} ${unameM} was rejected: ${resolved.output}`).toBe(true);
        constructed.add(resolved.output);
      }
    }

    return [...constructed].sort();
  }

  /**
   * Both directions, because each is silent in production and neither is caught by the other.
   *
   * A target CI builds that the installer cannot construct is a binary uploaded to every release and
   * downloaded by nobody: those machines are told there is no build for them while the build sits in
   * the release. A name the installer constructs that CI does not build is a 404 mid-install, on a
   * machine that had no other way to get EmPo.
   */
  it("are the same four, in both directions", () => {
    const buildable = buildableTargets()
      .map((target) => `empo-${target}`)
      .sort();
    const installable = installableAssets();

    const unbuildable = installable.filter((name) => !buildable.includes(name));
    const uninstallable = buildable.filter((name) => !installable.includes(name));

    expect(
      unbuildable,
      `install.sh will ask for ${unbuildable.join(", ")}, which CI builds no binary for: that is a ` +
        "404 partway through an install on a machine that has no other way to get EmPo",
    ).toEqual([]);

    expect(
      uninstallable,
      `CI builds ${uninstallable.join(", ")} but install.sh can never construct that name: the ` +
        "binary is uploaded to every release and those machines are told there is no build for them",
    ).toEqual([]);

    expect(installable).toEqual(buildable);
  });
});

describe("the script itself", () => {
  /**
   * Run through a real shell rather than a parser of our own. This script is piped into whatever
   * `/bin/sh` the target machine has, which on Debian and Ubuntu is dash and not bash, and a bashism
   * there is a syntax error on somebody else's machine and nowhere on this one.
   *
   * Both shells, because `sh -n` alone is weak on exactly the machines most likely to write the bug:
   * on macOS `/bin/sh` is bash 3.2 in POSIX mode, which parses `[[ ]]` and arrays without complaint.
   * dash rejects them, and macOS ships `/bin/dash` too, so the strict check is available in the two
   * places it matters (a developer's Mac, and the macOS CI runner) as well as on Linux where `sh`
   * already is dash. Where no dash exists the check degrades to `sh -n` rather than silently
   * skipping, which is why the loop runs over whatever it found rather than asserting it found two.
   */
  it("parses as POSIX sh, under dash where there is one", () => {
    const shells = ["sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])];

    for (const shell of shells) {
      expect(() => execFileSync(shell, ["-n", script], { encoding: "utf8" })).not.toThrow();
    }
  });

  /**
   * The decision recorded in the shared brief, pinned rather than trusted to review. This script
   * downloads an executable and puts it somewhere PATH points; the one thing it must never do is
   * escalate to do it. A privilege it cannot ask for is a privilege it cannot misuse.
   *
   * The ban is on the literal string anywhere in the file, comments included, which is why the
   * script says "elevated privileges" in prose instead. That is deliberate rather than an accident
   * of the assertion: a grep anybody can run and read in one line is worth more here than a
   * cleverer check that has to be trusted, and the prose loses nothing by the substitution.
   */
  it("never escalates", () => {
    expect(source).not.toContain("sudo");
    expect(source).not.toContain("doas");
  });

  /**
   * The default install dir is a user path and not a system prefix, which is what makes the line
   * above true rather than merely absent.
   */
  it("defaults to a directory the user already owns", () => {
    expect(source).toContain("EMPO_INSTALL_DIR:-$HOME/.local/bin");
    expect(source).not.toContain("/usr/local/bin");
  });

  /**
   * The other decision that is not negotiable: nothing is installed that was not verified. Asserted
   * as the presence of both hashers plus a mismatch path that exits, because a checksum computed and
   * not compared reads exactly like a checksum enforced.
   */
  it("verifies a checksum with whichever hasher exists, and aborts on a mismatch", () => {
    expect(source).toContain("shasum -a 256");
    expect(source).toContain("sha256sum");
    expect(source).toContain("checksum mismatch");
    // The verification has to precede the install, or the abort is a rollback rather than a refusal.
    expect(source.indexOf("checksum mismatch")).toBeLessThan(source.indexOf('mv -f "$tmp/$asset"'));
  });

  /** A failed run must not leave a partial download behind, so the cleanup hangs off the trap. */
  it("cleans its temp directory up on every exit", () => {
    expect(source).toContain("mktemp -d");
    expect(source).toMatch(/trap\s+'rm -rf "\$tmp"'\s+EXIT INT TERM/);
  });

  /**
   * The single most common reason an install "did not work" is that the directory it installed into
   * is not on PATH, so the advice has to name the file for the shell the user is actually running.
   */
  it("names a real profile file per shell when the install dir is off PATH", () => {
    expect(source).toContain(".zshrc");
    expect(source).toContain(".bashrc");
    // macOS login shells read .bash_profile and never .bashrc, so naming .bashrc alone there sends
    // people to a file nothing reads.
    expect(source).toContain(".bash_profile");
    expect(source).toContain("export PATH=");
  });

  it("proves the binary executes before it claims to have installed one", () => {
    expect(source).toContain('"$target" --version');
  });

  it("documents both environment variables in its own usage", () => {
    const usage = execFileSync("sh", [script, "--help"], { encoding: "utf8" });

    expect(usage).toContain("EMPO_INSTALL_DIR");
    expect(usage).toContain("EMPO_VERSION");
  });

  /**
   * `--help` has to survive `curl ... | sh`, where `$0` is the shell and the script has no file on
   * disk to read its own comment block back out of. Reproduced by feeding the script to `sh` on
   * stdin, which is the same condition.
   */
  it("prints usage when it has no file of its own to read", () => {
    const usage = execFileSync("sh", ["-s", "--", "--help"], {
      encoding: "utf8",
      input: source,
    });

    expect(usage).toContain("EMPO_INSTALL_DIR");
  });
});
