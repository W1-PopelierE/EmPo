import { basename, dirname } from "node:path";
import { globSync } from "tinyglobby";
import { configError } from "../errors";
import type { Pack } from "../schema/pack.schema";
import { run } from "./git";
import { compareStrings } from "./order";
import { installedPacks, loadPack } from "./pack-loader";

/**
 * Step 1 of `empo init` (docs/06-cli.md): where are the roots, and in what language. This runs
 * before any config exists, so the only thing it can stand on is each pack's `match` block
 * (docs/04-language-packs.md): a manifest basename says "a package is rooted here", extensions say
 * "this file is mine".
 *
 * Two properties make the result usable as a config seed. It is deterministic, because `empo init`
 * writes a file a human then edits and a detector that reorders roots between runs churns that file.
 * And every candidate it discards is reported with a reason, because the surprising outcomes here
 * (a workspace container that roots nothing, two languages in one directory) are exactly the ones a
 * human needs explained before they accept the config.
 */

export interface DetectedRoot {
  /** Repo-relative directory, "." for the repository root. */
  path: string;
  lang: string;
  /** Files this root owns, after deeper roots of the same language take theirs. */
  files: number;
  via: "manifest" | "extensions";
}

export interface DroppedCandidate {
  path: string;
  lang: string;
  /** Human-readable, printed by `empo init` so a surprising result is explainable. */
  reason: string;
}

export interface Detection {
  roots: DetectedRoot[];
  /** The languages the roots use, sorted. This is what goes into config `packs`. */
  langs: string[];
  dropped: DroppedCandidate[];
}

/**
 * Directories never worth walking, and what `empo init` seeds config `ignore` with. Deliberately
 * shorter than the example list in docs/03-config-schema.md: test files stay in, because the graph
 * needs them to answer "would a test notice" (docs/05-graph-model.md). An ignore rule for test
 * filenames here would make every flow in the repository look blind.
 */
export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.empo/**",
];

export function detectRoots(repoRoot: string, options: { langs?: string[] } = {}): Detection {
  const packs = choosePacks(options.langs);
  const manifests = manifestOwners(packs);
  const extensions = extensionOwners(packs);

  // One walk for every pack, not one per pack: the tree is the expensive part, and a second pass
  // could see a different tree than the first.
  const found = globSync(
    [
      ...extensions.map((owner) => `**/*${owner.extension}`),
      ...[...manifests.keys()].map((name) => `**/${name}`),
    ],
    { cwd: repoRoot, ignore: DEFAULT_IGNORE, onlyFiles: true, dot: false },
  );

  /** Directories a manifest points at, per language. */
  const candidates = new Map<string, Set<string>>();
  /** Every file a pack's extensions claim, per language. */
  const sources = new Map<string, string[]>();

  for (const file of [...found].sort(compareStrings)) {
    const declaring = manifests.get(basename(file));
    if (declaring !== undefined) add(candidates, declaring, dirname(file));

    const owning = extensionOwner(extensions, file);
    if (owning !== undefined) push(sources, owning, file);
  }

  const roots: DetectedRoot[] = [];
  const dropped: DroppedCandidate[] = [];

  for (const pack of packs) {
    const lang = pack.name;
    const dirs = [...(candidates.get(lang) ?? [])];
    const files = sources.get(lang) ?? [];

    const owned = new Map(dirs.map((dir) => [dir, 0]));
    const orphans: string[] = [];
    for (const file of files) {
      // Only a candidate of this language may own it: a root package.json says nothing about where
      // the PHP lives, so it must not swallow the .php files under it.
      const dir = deepestHolding(dirs, file);
      if (dir === undefined) orphans.push(file);
      else owned.set(dir, (owned.get(dir) ?? 0) + 1);
    }

    for (const [dir, count] of owned) {
      if (count > 0) {
        roots.push({ path: dir, lang, files: count, via: "manifest" });
        continue;
      }

      // A container manifest, which is the workspaces root of a monorepo: it declares the packages
      // rather than holding code, and a root there would swallow every one of them. The two reasons
      // are told apart because the repair differs, and because a drop that claims a deeper root took
      // the files sends a human looking for a root that does not exist.
      dropped.push({
        path: dir,
        lang,
        reason: files.some((file) => holds(dir, file))
          ? `every ${lang} file under it belongs to a deeper root`
          : `no ${lang} files under it`,
      });
    }

    // No manifest at all is a normal repository, not an undetectable one.
    if (orphans.length > 0) {
      roots.push({ path: commonAncestor(orphans), lang, files: orphans.length, via: "extensions" });
    }
  }

  const resolved = resolveCollisions(roots);

  return {
    roots: resolved.roots.sort(byPathThenLang),
    langs: [...new Set(resolved.roots.map((root) => root.lang))].sort(compareStrings),
    dropped: [...dropped, ...resolved.dropped].sort(byPathThenLang),
  };
}

/**
 * The packs to detect with, deduplicated and sorted, so a caller's argument order can never change
 * the answer and every tie below breaks the same way twice.
 */
function choosePacks(langs: string[] | undefined): Pack[] {
  const installed = installedPacks();

  const names = [...new Set(langs ?? installed)].sort(compareStrings);
  for (const name of names) {
    if (installed.includes(name)) continue;
    throw configError(`Unknown language pack "${name}"`, [
      installed.length === 0
        ? "No language packs are installed."
        : `Installed packs: ${installed.join(", ")}.`,
    ]);
  }

  return names.map(loadPack);
}

/** Manifest basename to pack. Two packs declaring one basename: the first-sorting name takes it. */
function manifestOwners(packs: Pack[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const pack of packs) {
    for (const name of pack.match.manifest ?? []) {
      if (!owners.has(name)) owners.set(name, pack.name);
    }
  }
  return owners;
}

interface ExtensionOwner {
  extension: string;
  lang: string;
}

/**
 * Extension to pack, longest extension first, so a pack declaring ".d.ts" takes a .d.ts file from
 * one declaring ".ts" instead of the answer depending on which pack was walked first. Two packs
 * declaring the same extension is a real ambiguity, and it is settled by name for the same reason.
 */
function extensionOwners(packs: Pack[]): ExtensionOwner[] {
  const owners = new Map<string, string>();
  for (const pack of packs) {
    for (const extension of pack.match.extensions) {
      if (!owners.has(extension)) owners.set(extension, pack.name);
    }
  }

  return [...owners]
    .map(([extension, lang]) => ({ extension, lang }))
    .sort(
      (a, b) => b.extension.length - a.extension.length || compareStrings(a.extension, b.extension),
    );
}

function extensionOwner(owners: ExtensionOwner[], file: string): string | undefined {
  return owners.find((owner) => file.endsWith(owner.extension))?.lang;
}

/**
 * The deepest candidate directory holding this file. Every directory that holds it lies on one chain
 * from the repository root down, so the longest of them is the deepest.
 */
function deepestHolding(dirs: string[], file: string): string | undefined {
  let deepest: string | undefined;
  for (const dir of dirs) {
    if (holds(dir, file) && (deepest === undefined || dir.length > deepest.length)) deepest = dir;
  }
  return deepest;
}

function holds(dir: string, file: string): boolean {
  return dir === "." || file.startsWith(`${dir}/`);
}

/**
 * The deepest directory holding every one of these files, which is where a language with no manifest
 * is rooted. Files that share no directory land at the repository root.
 */
function commonAncestor(files: string[]): string {
  let shared: string[] | undefined;

  for (const file of files) {
    const segments = segmentsOf(dirname(file));
    if (shared === undefined) {
      shared = segments;
      continue;
    }
    const common: string[] = [];
    for (const [index, segment] of shared.entries()) {
      if (segment !== segments[index]) break;
      common.push(segment);
    }
    shared = common;
  }

  return shared === undefined || shared.length === 0 ? "." : shared.join("/");
}

function segmentsOf(dir: string): string[] {
  return dir === "." ? [] : dir.split("/");
}

/**
 * At most one root per path, because a root has exactly one language (docs/03-config-schema.md).
 * The language with more files under it keeps the path; the other is reported rather than silently
 * lost, because a directory that really holds two languages is a repository nobody can detect for,
 * only configure.
 */
function resolveCollisions(roots: DetectedRoot[]): {
  roots: DetectedRoot[];
  dropped: DroppedCandidate[];
} {
  const byPath = new Map<string, DetectedRoot[]>();
  for (const root of roots) {
    const bucket = byPath.get(root.path);
    if (bucket) bucket.push(root);
    else byPath.set(root.path, [root]);
  }

  const kept: DetectedRoot[] = [];
  const dropped: DroppedCandidate[] = [];

  for (const contenders of byPath.values()) {
    const [winner, ...losers] = [...contenders].sort(
      (a, b) => b.files - a.files || compareStrings(a.lang, b.lang),
    );
    if (winner === undefined) continue;

    kept.push(winner);
    for (const loser of losers) {
      dropped.push({
        path: loser.path,
        lang: loser.lang,
        reason: `${winner.lang} roots here too, with ${winner.files} files against ${loser.files}, and a root has one language: set both by hand`,
      });
    }
  }

  return { roots: kept, dropped };
}

function byPathThenLang(
  a: { path: string; lang: string },
  b: { path: string; lang: string },
): number {
  return compareStrings(a.path, b.path) || compareStrings(a.lang, b.lang);
}

// ---------------------------------------------------------------------------------------------
// The forge, from the origin remote
// ---------------------------------------------------------------------------------------------

/**
 * The other half of the config `empo init` can seed, and the only adapter that is detectable at all:
 * the pull request host is written in the origin remote, so asking a human for it would be asking
 * them to retype something git already knows.
 *
 * Two mappings, and the asymmetry is the point. github.com becomes kind `github`, which is the
 * shipped gh-CLI adapter: empo can fetch a GitHub pull request itself, and an adapter that fetches
 * beats one that asks the agent to. Every other host becomes kind `mcp` with `host` naming it,
 * because empo makes no network call and holds no token, so the agent running it fetches through its
 * own connector and empo validates what comes back. A host nothing here recognizes still becomes
 * `mcp`, with the bare hostname as `host`: the value is only ever printed at the agent, and
 * "fetch it with your git.acme.internal tool" is a useful sentence even when this module has never
 * heard of that host.
 *
 * The tracker has no equivalent. Nothing in a checkout says where the tickets live, so `empo init`
 * takes it as a flag and says out loud that it could not detect one.
 */
export interface DetectedForge {
  /** Never `local`: that is what you configure when there is no host, not something to detect. */
  kind: "github" | "mcp";
  /** The short name of the host, absent for `github` where the kind already names it. */
  host?: string;
  /**
   * The owner, workspace or group the repository sits in, whatever the host calls it: the segment
   * above it, and on gitlab.com the whole group path, where a subgroup is part of the project's
   * name rather than a directory over it. This is the slug every Bitbucket tool wants (`workspaceId` takes the slug and prefers
   * it to the uuid), so nothing has to be looked up before the agent can fetch.
   */
  workspace?: string;
  repo: string;
}

/**
 * Hosts with a short name worth printing. Everything else keeps its bare hostname.
 *
 * Matched on the domain and any subdomain of it, never by string equality, because
 * `altssh.bitbucket.org` is Bitbucket's documented port-443 ssh endpoint and a remote pointing at it
 * is the same Bitbucket repository. Enterprise installs (`github.acme.com`) are deliberately not
 * caught by this: they are a different host with a different tool, and they land on `mcp` under
 * their own name, which is the right answer for both.
 */
const KNOWN_HOSTS = new Map([
  ["github.com", "github"],
  ["bitbucket.org", "bitbucket"],
  ["gitlab.com", "gitlab"],
]);

function shortName(host: string): string | undefined {
  for (const [domain, name] of KNOWN_HOSTS) {
    if (host === domain || host.endsWith(`.${domain}`)) return name;
  }
  return undefined;
}

/**
 * Whether the detected host is one this module knows by name, or a bare hostname it is only
 * repeating back. `host` alone cannot answer that: `bitbucket` and `github.acme.com` are the same
 * field, and the second is a hostname nothing here recognized.
 *
 * Exported for `engine/health.ts`, which reports a remote that disagrees with the configured forge
 * and may only raise a finding on the recognized half. An unrecognized host is what a GitHub
 * Enterprise install, a mirror, an ssh alias and a proxying checkout all look like from here, and
 * every one of those is a working setup whose kind detection cannot infer. A finding on those fires
 * on every session forever and is right about none of them.
 *
 * It is a function rather than a field on `DetectedForge` because `engine/scaffold.ts` spreads that
 * object straight into `config.json`, so a field added here is a key written into somebody's config.
 */
export function recognizedHost(forge: DetectedForge): boolean {
  // Undefined only on `github`, which is the one kind whose host matched by domain rather than by
  // being copied out of the url.
  if (forge.host === undefined) return true;
  for (const name of KNOWN_HOSTS.values()) if (name === forge.host) return true;
  return false;
}

/**
 * `null` when this is not a git checkout, when it has no origin, or when the origin names no host
 * (a path, or a `file://` url). All four are the same answer for the caller: write no forge section,
 * because a forge nobody can reach is worse than none. A local clone of a local clone genuinely has
 * no pull request host.
 *
 * The url read is the **configured** one, and not what `git remote get-url` prints: that command
 * applies the `url.<base>.insteadOf` rewrites, which are a local transport convenience (an https
 * proxy, ssh-for-https, a mirror) and never the repository's identity. A checkout whose git rewrites
 * github.com to `http://127.0.0.1:<port>/git/` is still a GitHub repository, and reading the
 * expanded url detects kind `mcp` on a hostname no human ever configured. `--get-all` with the first
 * line taken, rather than `--get`, because a remote may carry several urls and git's own first-url
 * rule is the one every other tool follows, while `--get` would hand back the last.
 */
export function detectForge(repoRoot: string): DetectedForge | null {
  const origin = run(repoRoot, "git", ["config", "--get-all", "remote.origin.url"]);
  if (!origin.ok) return null;
  return forgeFromRemote(origin.stdout.split("\n")[0] ?? "");
}

/** Exported for the sake of one table-driven spec: every url form, without a checkout per row. */
export function forgeFromRemote(url: string): DetectedForge | null {
  const remote = parseRemote(url);
  if (remote === null) return null;

  const known = shortName(remote.host);
  const forge: DetectedForge =
    known === "github"
      ? { kind: "github", repo: remote.repo }
      : { kind: "mcp", host: known ?? remote.host, repo: remote.repo };

  return remote.workspace === null ? forge : { ...forge, workspace: remote.workspace };
}

interface ParsedRemote {
  /** Lowercased hostname, with no port and no credentials. */
  host: string;
  /** What stands above the repository, or null when the path holds only the repository. */
  workspace: string | null;
  repo: string;
}

/**
 * `scheme://[user[:password]@]host[:port]/path`, which covers https, http, ssh and git. The
 * userinfo is matched so it can be thrown away: a parser that keeps it reads Bitbucket's documented
 * `https://x-token-auth@bitbucket.org/...` token form as a repository owned by `x-token-auth`, and
 * writes that into the config, where it is wrong in a way nobody notices until a review fails.
 */
const URL_REMOTE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/(.+)$/i;

/**
 * git's scp-like shorthand, `[user@]host:path`. **This is not a URL**, and `new URL()` mis-parses
 * it: the colon separates a path rather than a port, so `git@bitbucket.org:acme/acme-platform`
 * comes back with the scheme `git@bitbucket.org:` and no hostname at all. It is matched here with
 * its own pattern, and matched second, so nothing carrying a `://` can reach it.
 *
 * The host has to look like one, or `C:/repos/thing` parses as a repository on a host called "c":
 * either it carries a dot, or it came with a `user@` that only a remote has.
 */
const SCP_REMOTE = /^(?:([^/@]+)@)?([A-Za-z0-9][A-Za-z0-9.-]*):(.+)$/;

function parseRemote(url: string): ParsedRemote | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;

  const asUrl = URL_REMOTE.exec(trimmed);
  if (asUrl !== null) return split(asUrl[1] ?? "", asUrl[2] ?? "");

  const asScp = SCP_REMOTE.exec(trimmed);
  if (asScp === null) return null;
  const host = asScp[2] ?? "";
  if (asScp[1] === undefined && !host.includes(".")) return null;
  return split(host, asScp[3] ?? "");
}

/**
 * The workspace and the repository are the last two segments, for every host but one. Bitbucket and
 * GitHub spell it that way and never deeper, and a Bitbucket Server url carries a `/scm/` prefix
 * that is transport and not identity, so leading segments are dropped rather than kept.
 *
 * GitLab is the exception, because it is the one host where a deeper path is the repository's real
 * name: `acme/backend/api` lives in group `acme`, and `backend/api` resolves to nothing. Dropping
 * the outer group wrote a workspace no GitLab call could use, which is worse than a second rule.
 * Only gitlab.com and its subdomains take it: a self-hosted install is an unrecognized hostname
 * here, so it keeps the two-segment reading, which is the one this module can defend.
 *
 * Two details that look like nits and are not. The trailing `.git` is stripped **once**, because
 * Atlassian's own documentation shows the remote `.../tutorials/tutorials.git.bitbucket.org.git`,
 * and a global or greedy strip turns that repository into `tutorials.bitbucket.org`. And the slugs
 * keep the case they were written in: Bitbucket lowercases its own, but GitHub owners and Bitbucket
 * usernames are case-sensitive, so only the hostname, which is case-insensitive by definition, is
 * folded.
 */
function split(host: string, path: string): ParsedRemote | null {
  const segments = path
    .replace(/\.git$/, "")
    .split("/")
    .filter((segment) => segment !== "");

  const repo = segments.pop();
  if (repo === undefined) return null;

  const bare = host.toLowerCase().replace(/^www\./, "");
  if (bare === "") return null;

  const workspace =
    shortName(bare) === "gitlab" ? segments.join("/") || null : (segments.pop() ?? null);
  return { host: bare, workspace, repo };
}

function add(index: Map<string, Set<string>>, key: string, value: string): void {
  const bucket = index.get(key);
  if (bucket) bucket.add(value);
  else index.set(key, new Set([value]));
}

function push(index: Map<string, string[]>, key: string, value: string): void {
  const bucket = index.get(key);
  if (bucket) bucket.push(value);
  else index.set(key, [value]);
}
