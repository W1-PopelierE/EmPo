import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_IGNORE,
  type DetectedForge,
  detectForge,
  detectRoots,
  forgeFromRemote,
} from "../../src/engine/detect";
import { run } from "../../src/engine/git";
import { installedPacks } from "../../src/engine/pack-loader";
import { EmpoError } from "../../src/errors";

/**
 * Detection is step 1 of `empo init` (docs/06-cli.md), so it runs in the one situation where there
 * is no config to lean on: a tree, the installed packs, and nothing else. Every case below is a real
 * directory for that reason. Detection reads paths and never contents, which is why the files it
 * writes are empty.
 *
 * The acme fixture is the case that matters most: it ships a hand-written `.empo/config.json`, and
 * a detector that disagrees with a config a human wrote for the same tree is a detector nobody will
 * trust with the file it seeds.
 */

const fixture = fileURLToPath(new URL("../../fixtures/acme-platform", import.meta.url));

/**
 * What the fixture holds, counted by hand: apps/api has eleven .php files, apps/mobile five .ts(x),
 * apps/portal two .vue.
 */
const API_FILES = 11;
const MOBILE_FILES = 5;
const PORTAL_FILES = 2;

let repo: string;

function write(relPath: string, contents = ""): void {
  const target = join(repo, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function manifest(relPath: string, body: Record<string, unknown>): void {
  write(relPath, `${JSON.stringify(body, null, 2)}\n`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "empo-detect-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("installedPacks", () => {
  test("lists every pack that ships with EmPo, once and in order", () => {
    expect(installedPacks()).toEqual(["php", "typescript"]);
  });
});

describe("the acme-platform fixture", () => {
  test("finds one root per package, each from the manifest that package ships", () => {
    expect(detectRoots(fixture).roots).toEqual([
      { path: "apps/api", lang: "php", files: API_FILES, via: "manifest" },
      { path: "apps/mobile", lang: "typescript", files: MOBILE_FILES, via: "manifest" },
      { path: "apps/portal", lang: "typescript", files: PORTAL_FILES, via: "manifest" },
    ]);
  });

  test("agrees with the config the fixture ships by hand", () => {
    const config = JSON.parse(readFileSync(join(fixture, ".empo/config.json"), "utf8")) as {
      roots: { path: string; lang: string }[];
    };

    const detection = detectRoots(fixture);

    expect(detection.roots.map(({ path, lang }) => ({ path, lang }))).toEqual(
      config.roots.map(({ path, lang }) => ({ path, lang })),
    );
    expect(detection.langs).toEqual(["php", "typescript"]);
  });

  test("drops the workspace container at the repository root, and says why", () => {
    // The whole reason rule 6 exists: the root package.json of a workspaces monorepo is a container,
    // and a root there would swallow apps/mobile and apps/api both.
    expect(detectRoots(fixture).dropped).toEqual([
      {
        path: ".",
        lang: "typescript",
        reason: "every typescript file under it belongs to a deeper root",
      },
    ]);
  });

  test("counts test files, because the graph needs them to compute coverage", () => {
    // Three of the eighteen files are tests (two php feature tests, one .test.tsx), and they are in
    // the counts above. This is where DEFAULT_IGNORE deliberately parts from the example ignore list
    // in docs/03-config-schema.md, which ignores **/*.test.ts.
    expect(DEFAULT_IGNORE.some((pattern) => pattern.includes("test"))).toBe(false);

    const detection = detectRoots(fixture);

    expect(detection.roots.reduce((total, root) => total + root.files, 0)).toBe(
      API_FILES + MOBILE_FILES + PORTAL_FILES,
    );
  });
});

describe("manifest roots", () => {
  test("hands a container's files to the deeper package that really holds them", () => {
    manifest("package.json", { name: "acme-platform", private: true, workspaces: ["apps/*"] });
    manifest("apps/mobile/package.json", { name: "@acme/mobile" });
    write("apps/mobile/src/client.ts");
    write("apps/mobile/src/money.ts");

    const detection = detectRoots(repo);

    expect(detection.roots).toEqual([
      { path: "apps/mobile", lang: "typescript", files: 2, via: "manifest" },
    ]);
    expect(detection.dropped).toEqual([
      {
        path: ".",
        lang: "typescript",
        reason: "every typescript file under it belongs to a deeper root",
      },
    ]);
  });

  test("keeps an outer package that has files of its own beside a nested one", () => {
    // Not a container: the outer package is a real package, and only the files under the inner one
    // move. A rule that dropped every manifest with a deeper manifest under it would lose this root.
    manifest("package.json", { name: "acme-platform" });
    write("src/app.ts");
    manifest("packages/shared/package.json", { name: "@acme/shared" });
    write("packages/shared/money.ts");
    write("packages/shared/tax.ts");

    const detection = detectRoots(repo);

    expect(detection.roots).toEqual([
      { path: ".", lang: "typescript", files: 1, via: "manifest" },
      { path: "packages/shared", lang: "typescript", files: 2, via: "manifest" },
    ]);
    expect(detection.dropped).toEqual([]);
  });

  test("never lets one language's manifest own another language's files", () => {
    // A root package.json is normal in a repository whose backend is PHP, and it says nothing at all
    // about where the PHP is. Ownership is per language or it is worthless.
    manifest("package.json", { name: "acme-platform" });
    write("web/app.ts");
    manifest("apps/api/composer.json", { name: "acme/api" });
    write("apps/api/app/Order.php");

    expect(detectRoots(repo).roots).toEqual([
      { path: ".", lang: "typescript", files: 1, via: "manifest" },
      { path: "apps/api", lang: "php", files: 1, via: "manifest" },
    ]);
  });

  test("drops a manifest with no files of its language under it, and says that instead", () => {
    // A tsconfig.json in a directory holding no TypeScript at all delegates nothing to anybody, and
    // a reason that claimed it did would send a human looking for the deeper root that took them.
    manifest("tooling/tsconfig.json", { compilerOptions: {} });
    manifest("apps/mobile/package.json", { name: "@acme/mobile" });
    write("apps/mobile/src/client.ts");

    expect(detectRoots(repo).dropped).toEqual([
      { path: "tooling", lang: "typescript", reason: "no typescript files under it" },
    ]);
  });

  test("walks past node_modules and vendor, so a dependency is never a root", () => {
    // A vendored dependency ships its own manifest and its own source, and both would otherwise
    // outnumber the repository's own code in every count detection makes.
    manifest("package.json", { name: "acme-platform" });
    write("src/app.ts");
    manifest("node_modules/@acme/widget/package.json", { name: "@acme/widget" });
    write("node_modules/@acme/widget/index.ts");
    manifest("apps/api/composer.json", { name: "acme/api" });
    write("apps/api/app/Order.php");
    write("vendor/acme/http/src/Client.php");

    expect(detectRoots(repo).roots).toEqual([
      { path: ".", lang: "typescript", files: 1, via: "manifest" },
      { path: "apps/api", lang: "php", files: 1, via: "manifest" },
    ]);
  });
});

describe("the extension fallback", () => {
  test("detects a repository with no manifest anywhere", () => {
    // The root is the deepest directory holding every file found, so a repository that keeps its
    // source in one directory gets that directory rather than the whole tree.
    write("src/index.ts");
    write("src/shared/money.ts");

    expect(detectRoots(repo).roots).toEqual([
      { path: "src", lang: "typescript", files: 2, via: "extensions" },
    ]);
  });

  test("roots at the repository root when the files share no directory", () => {
    write("api/Order.php");
    write("legacy/Invoice.php");

    expect(detectRoots(repo).roots).toEqual([
      { path: ".", lang: "php", files: 2, via: "extensions" },
    ]);
  });

  test("keeps two unmanifested languages apart, each at its own directory", () => {
    write("api/app/Order.php");
    write("web/src/app.ts");

    expect(detectRoots(repo).roots).toEqual([
      { path: "api/app", lang: "php", files: 1, via: "extensions" },
      { path: "web/src", lang: "typescript", files: 1, via: "extensions" },
    ]);
  });

  test("counts a Vue single-file component toward typescript, not toward a language of its own", () => {
    // The typescript pack owns .vue because an SFC's script block is TypeScript and its imports
    // resolve against the same module paths (docs/04-language-packs.md). A vue pack would have to
    // root the same directory as typescript, and a root has exactly one language, so one of the two
    // would be dropped and every edge between a component and a composable with it.
    write("web/src/App.vue");
    write("web/src/components/CartPanel.vue");
    write("web/src/composables/useCart.ts");

    const detection = detectRoots(repo);

    expect(detection.roots).toEqual([
      { path: "web/src", lang: "typescript", files: 3, via: "extensions" },
    ]);
    expect(detection.langs).toEqual(["typescript"]);
    expect(detection.dropped).toEqual([]);
  });

  test("roots a frontend that holds nothing but single-file components", () => {
    // The shape the gap was found in: a Vue app whose components outnumber its modules. Before .vue
    // was matched this directory detected as no root at all.
    write("resources/js/Pages/Cart.vue");
    write("resources/js/Pages/Checkout.vue");

    expect(detectRoots(repo).roots).toEqual([
      { path: "resources/js/Pages", lang: "typescript", files: 2, via: "extensions" },
    ]);
  });

  test("takes only the files a manifest root left over", () => {
    manifest("apps/mobile/package.json", { name: "@acme/mobile" });
    write("apps/mobile/src/client.ts");
    write("tools/codegen/emit.ts");

    expect(detectRoots(repo).roots).toEqual([
      { path: "apps/mobile", lang: "typescript", files: 1, via: "manifest" },
      { path: "tools/codegen", lang: "typescript", files: 1, via: "extensions" },
    ]);
  });
});

describe("two languages wanting one path", () => {
  test("keeps the one with more files and tells the human to set the other by hand", () => {
    // A directory holding two languages is a repository nobody can detect for, only configure, and
    // silently dropping the smaller half would be the quietest possible way to lose a root.
    write("Order.php");
    write("Invoice.php");
    write("app.ts");

    const detection = detectRoots(repo);

    expect(detection.roots).toEqual([{ path: ".", lang: "php", files: 2, via: "extensions" }]);
    expect(detection.langs).toEqual(["php"]);
    expect(detection.dropped).toHaveLength(1);
    expect(detection.dropped[0]?.path).toBe(".");
    expect(detection.dropped[0]?.lang).toBe("typescript");
    expect(detection.dropped[0]?.reason).toContain("by hand");
  });
});

describe("options.langs", () => {
  test("detects with the named pack only, so nothing the other pack matches is even considered", () => {
    const detection = detectRoots(fixture, { langs: ["php"] });

    expect(detection.roots).toEqual([
      { path: "apps/api", lang: "php", files: API_FILES, via: "manifest" },
    ]);
    expect(detection.langs).toEqual(["php"]);
    // The container package.json is a TypeScript manifest, so with only php asked for it is not a
    // candidate at all and there is nothing to report as dropped.
    expect(detection.dropped).toEqual([]);
  });

  test("fails with exit code 2 on a pack that is not installed, listing the ones that are", () => {
    try {
      detectRoots(fixture, { langs: ["php", "rust"] });
      expect.unreachable("expected a config error");
    } catch (error) {
      expect(error).toBeInstanceOf(EmpoError);
      expect((error as EmpoError).exitCode).toBe(2);
      expect((error as EmpoError).message).toContain("rust");
      const details = (error as EmpoError).details.join("\n");
      expect(details).toContain("php");
      expect(details).toContain("typescript");
    }
  });
});

describe("a tree with nothing to find", () => {
  test("yields no roots and no dropped candidates for an empty directory", () => {
    expect(detectRoots(repo)).toEqual({ roots: [], langs: [], dropped: [] });
  });

  test("yields no roots for a tree holding nothing any pack matches", () => {
    write("README.md", "# acme-platform\n");
    write("docs/architecture.md", "# roots\n");

    expect(detectRoots(repo)).toEqual({ roots: [], langs: [], dropped: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// The forge, from the origin remote
// ---------------------------------------------------------------------------------------------

/**
 * Every remote form git accepts, against the forge it should seed. Table-driven because the
 * interesting cases are all in the string: two url syntaxes, an optional `.git`, an optional user,
 * an optional port, and a host that decides between the two adapters. None of them needs a
 * checkout, and one row per real repository is how the two examples that started this stay pinned.
 */
const REMOTES: [string, DetectedForge | null][] = [
  // The two shapes this was built for. A Bitbucket repository reached over ssh, and this repository
  // over https. The workspace and the repository differ in every row but the next one, so a parser
  // that returned the last segment twice fails here rather than passing on a coincidence.
  [
    "git@bitbucket.org:acme/acme-platform.git",
    { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "acme-platform" },
  ],

  // And the coincidence itself, once, on purpose: a repository whose name is its workspace's name
  // is ordinary (it is how a company's main product repository is usually spelled), and the two
  // fields must still come back separately rather than one of them being dropped as redundant.
  [
    "git@bitbucket.org:acme-platform/acme-platform.git",
    { kind: "mcp", host: "bitbucket", workspace: "acme-platform", repo: "acme-platform" },
  ],
  [
    "https://github.com/W1-PopelierE/empo.git",
    { kind: "github", workspace: "W1-PopelierE", repo: "empo" },
  ],

  // The same two with the other syntax, and with the `.git` suffix git leaves optional.
  [
    "https://bitbucket.org/acme/acme-platform.git",
    { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "acme-platform" },
  ],
  [
    "git@bitbucket.org:acme/acme-platform",
    { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "acme-platform" },
  ],
  [
    "git@github.com:W1-PopelierE/empo.git",
    { kind: "github", workspace: "W1-PopelierE", repo: "empo" },
  ],
  [
    "https://github.com/W1-PopelierE/empo",
    { kind: "github", workspace: "W1-PopelierE", repo: "empo" },
  ],

  // The third form Atlassian documents, an ssh url with no port, and the ssh url with the port a
  // self-hosted Bitbucket Server hands out.
  [
    "ssh://git@bitbucket.org/acme/acme-platform.git",
    { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "acme-platform" },
  ],
  [
    "ssh://git@bitbucket.org:7999/acme/acme-platform.git",
    { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "acme-platform" },
  ],

  // Bitbucket's port-443 ssh endpoint, for a network that blocks 22. Same repository, so the host
  // is matched on the domain and not by string equality against "bitbucket.org".
  [
    "ssh://git@altssh.bitbucket.org:443/acme/acme-platform.git",
    { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "acme-platform" },
  ],

  // A nested GitLab group. The workspace is the segment above the repository, one grammar for every
  // host, so the outer group is dropped rather than a per-host path rule being written.
  [
    "https://gitlab.com/acme/backend/api.git",
    { kind: "mcp", host: "gitlab", workspace: "backend", repo: "api" },
  ],

  // A host this module has never heard of, which is still worth a forge: the bare hostname is what
  // the request block names, and "fetch it with your git.acme.internal tool" is a useful sentence.
  [
    "git@git.acme.internal:platform/api.git",
    { kind: "mcp", host: "git.acme.internal", workspace: "platform", repo: "api" },
  ],

  // A hostname is case-insensitive and the forge that comes out of it must not depend on the case
  // somebody typed.
  [
    "https://GitHub.com/W1-PopelierE/empo.git",
    { kind: "github", workspace: "W1-PopelierE", repo: "empo" },
  ],

  // No host at all. A clone of a clone has no pull request host, and a windows path is not a
  // repository on a host called "c".
  ["/srv/git/mirror.git", null],
  ["file:///srv/git/mirror.git", null],
  ["../sibling-checkout", null],
  ["C:/repos/mirror", null],
  ["", null],
];

describe("forgeFromRemote", () => {
  for (const [url, expected] of REMOTES) {
    test(`${url === "" ? "an empty remote" : url} seeds ${expected === null ? "no forge" : expected.kind}`, () => {
      expect(forgeFromRemote(url)).toEqual(expected);
    });
  }

  test("never turns github.com into an mcp forge, whatever the url form", () => {
    // The one mapping that is a judgement rather than a fallback: empo ships a gh-CLI adapter that
    // fetches the pull request itself, and an adapter that fetches beats one that asks the agent to.
    // A regression here would silently downgrade every GitHub repository to a round trip.
    const github = REMOTES.filter(([url]) => url.toLowerCase().includes("github.com"));
    expect(github).toHaveLength(4);

    for (const [url] of github) {
      const forge = forgeFromRemote(url);
      expect(forge?.kind, url).toBe("github");
      // And no `host`: the kind already names it, and a value nothing reads is a value that drifts.
      expect(forge?.host, url).toBeUndefined();
    }
  });
});

/**
 * Four traps, one test each, every one pinned with the literal string that springs it. None of them
 * is hypothetical: all four are shapes Atlassian's own documentation hands out, and each has a
 * plausible implementation that passes every row of the table above and still gets this wrong.
 */
describe("the four ways a remote parser is quietly wrong", () => {
  test("throws the userinfo away, rather than reading it as the workspace", () => {
    // `x-token-auth` and `x-bitbucket-api-token-auth` are documented static usernames, so this is
    // the ordinary shape of a remote on any machine that clones with a token. A parser that keeps
    // the userinfo writes `x-token-auth` into the config as the workspace, where it is wrong in a
    // way nobody notices until a review fails to fetch.
    const expected = {
      kind: "mcp",
      host: "bitbucket",
      workspace: "acme",
      repo: "acme-platform",
    };

    for (const user of ["someone", "x-token-auth", "x-bitbucket-api-token-auth"]) {
      expect(forgeFromRemote(`https://${user}@bitbucket.org/acme/acme-platform.git`), user).toEqual(
        expected,
      );
    }
    // Including the password form, where a naive split on "@" or ":" has two ways to go wrong.
    expect(forgeFromRemote("https://user:secret@bitbucket.org/acme/acme-platform.git")).toEqual(
      expected,
    );
  });

  test("reads the scp form as a path, not as a scheme with a port", () => {
    // The single most likely way this file is wrong: `git@host:path` is not a URL, and Node reads
    // this exact string as the scheme `git@bitbucket.org:` with no hostname whatsoever. It is also
    // the form most Bitbucket checkouts are cloned with, so a parser that leaned on `new URL()`
    // would seed no forge at all, or a forge whose host is empty. Both are asserted against here.
    //
    // The workspace and the repository differ on purpose. Every assertion below would still pass on
    // a parser that returned the last segment twice if they were spelled the same.
    const forge = forgeFromRemote("git@bitbucket.org:acme/acme-platform.git");

    expect(forge).not.toBeNull();
    expect(forge?.host).toBe("bitbucket");
    expect(forge?.workspace).toBe("acme");
    expect(forge?.repo).toBe("acme-platform");

    // Stated against the alternative rather than described: `new URL` does not merely mis-parse
    // this form, it refuses it outright. Anything built on it would have seeded no forge here.
    expect(() => new URL("git@bitbucket.org:acme/acme-platform.git")).toThrow(/Invalid URL/);
    // While the url forms it does accept are the ones the other pattern already handles.
    expect(new URL("ssh://git@bitbucket.org/acme/acme-platform.git").hostname).toBe(
      "bitbucket.org",
    );
  });

  test("strips one trailing .git, not every .git it can find", () => {
    // Atlassian's own docs hand out this remote, and it is a real repository: the tutorials site,
    // whose name is a hostname. A global replace turns it into `tutorials.bitbucket.org` and a
    // greedy `\.git.*$` into `tutorials`, and both then name a repository that does not exist.
    expect(
      forgeFromRemote("https://bitbucket.org/tutorials/tutorials.git.bitbucket.org.git"),
    ).toEqual({
      kind: "mcp",
      host: "bitbucket",
      workspace: "tutorials",
      repo: "tutorials.git.bitbucket.org",
    });

    // The same name with the suffix already absent, which must not lose its last segment either.
    expect(
      forgeFromRemote("https://bitbucket.org/tutorials/tutorials.git.bitbucket.org")?.repo,
    ).toBe("tutorials.git.bitbucket.org");
  });

  test("folds the hostname and nothing else, because a slug's case is not decoration", () => {
    // A hostname is case-insensitive by definition, so the forge must not depend on how somebody
    // typed it. A workspace and a repository are not: Bitbucket lowercases its own slugs, but
    // Bitbucket usernames are case-sensitive and this parser runs against GitHub and GitLab too,
    // where `W1-PopelierE` is not `w1-popeliere`.
    expect(forgeFromRemote("https://someone@BitBucket.ORG/Acme/Acme-Platform.git")).toEqual({
      kind: "mcp",
      host: "bitbucket",
      workspace: "Acme",
      repo: "Acme-Platform",
    });
    expect(forgeFromRemote("git@GITHUB.com:W1-PopelierE/empo.git")).toEqual({
      kind: "github",
      workspace: "W1-PopelierE",
      repo: "empo",
    });
  });
});

describe("detectForge", () => {
  function git(args: string[]): void {
    const result = run(repo, "git", args);
    if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  test("reads the origin remote of a real checkout", () => {
    git(["init", "-b", "main"]);
    git(["remote", "add", "origin", "git@bitbucket.org:acme/acme-platform.git"]);

    expect(detectForge(repo)).toEqual({
      kind: "mcp",
      host: "bitbucket",
      workspace: "acme",
      repo: "acme-platform",
    });
  });

  test("reads the configured origin, not what an insteadOf rewrite expands it to", () => {
    // A `url.<base>.insteadOf` rewrite is local transport plumbing: an https proxy, ssh-for-https, a
    // mirror. `git remote get-url` expands it, so a container whose git points github.com at a
    // loopback proxy detected kind `mcp` on a hostname nobody configured, and both of `empo init`'s
    // github cases failed there. The repository's identity is the url the human wrote.
    //
    // The rewrite is set with `--local`, in this throwaway checkout only: a test that wrote a global
    // one would edit the developer's own git config. It names the owner as well as the host, because
    // git resolves competing rewrites by longest match, and a machine that already carries a global
    // `https://github.com/` rule would otherwise decide which of the two applies.
    git(["init", "-b", "main"]);
    git(["remote", "add", "origin", "https://github.com/acme/acme-platform.git"]);
    git([
      "config",
      "--local",
      "url.http://127.0.0.1:4321/git/.insteadOf",
      "https://github.com/acme/",
    ]);

    // The rewrite is really in force, or the case below proves nothing.
    expect(run(repo, "git", ["remote", "get-url", "origin"]).stdout).toBe(
      "http://127.0.0.1:4321/git/acme-platform.git",
    );

    expect(detectForge(repo)).toEqual({
      kind: "github",
      workspace: "acme",
      repo: "acme-platform",
    });
  });

  test("takes the first url of a remote that carries several, as git itself does", () => {
    // `git config --get` hands back the *last* value of a multi-valued key while `git remote
    // get-url` prints the first, so reading the configured url must ask for all of them and take
    // the first, or a second url added for a mirror silently becomes the detected forge.
    git(["init", "-b", "main"]);
    git(["remote", "add", "origin", "https://github.com/acme/acme-platform.git"]);
    git(["remote", "set-url", "--add", "origin", "https://gitlab.com/acme/mirror.git"]);

    expect(detectForge(repo)).toEqual({
      kind: "github",
      workspace: "acme",
      repo: "acme-platform",
    });
  });

  test("finds nothing in a checkout that has no origin, rather than guessing at one", () => {
    // A repository with only a `upstream` remote, or none at all, has no pull request host that
    // anybody can name. Writing a forge section here would point every review at a host the human
    // never mentioned.
    git(["init", "-b", "main"]);
    git(["remote", "add", "upstream", "git@bitbucket.org:acme/acme-platform.git"]);

    expect(detectForge(repo)).toBeNull();
  });

  test("finds nothing in a directory that is not a checkout at all", () => {
    // The freshly extracted directory `empo init` is most useful in. git is best-effort everywhere
    // in EmPo, so this is an absent forge and never an error.
    expect(detectForge(repo)).toBeNull();
  });
});

describe("determinism", () => {
  test("returns the same answer twice over one tree", () => {
    // Same tree in, byte-identical config out, or `empo init` writes a file that churns.
    manifest("package.json", { name: "acme-platform", workspaces: ["apps/*"] });
    manifest("apps/mobile/package.json", { name: "@acme/mobile" });
    write("apps/mobile/src/client.ts");
    manifest("apps/api/composer.json", { name: "acme/api" });
    write("apps/api/app/Order.php");
    write("tools/emit.ts");
    write("scripts/Deploy.php");

    const first = detectRoots(repo);
    const second = detectRoots(repo);

    // Four roots, so the comparison below is over a real answer rather than two empty ones.
    expect(first.roots).toHaveLength(4);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
