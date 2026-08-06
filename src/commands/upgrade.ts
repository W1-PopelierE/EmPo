import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isEmbeddedBuild } from "../embedded";
import { configError, environmentError } from "../errors";

/**
 * `empo upgrade`: replace the running standalone binary with the latest GitHub Release asset
 * (docs/10-distribution.md). Before this, updating meant cloning the repository and rebuilding,
 * which is a developer's workflow standing in for a user's.
 *
 * This is the one place in EmPo that touches the network, and it does so only on an explicit user
 * command. There is no startup check, no hook path, and no background poll: an analysis tool that
 * phones home while answering a question about somebody's private code is not one worth shipping.
 *
 * Everything that decides is a pure function over data, and everything that does IO is a seam with a
 * real default. `decideUpgrade` and `verifyChecksum` take structs and return structs, so the parts a
 * defect would be expensive in (is that version newer, is this the asset for this machine, do these
 * bytes hash to what the release says) are tested exhaustively without a socket. The alternative,
 * calling `fetch` inline, makes those branches reachable only from a network the suite must not
 * have, which is the same as not testing them.
 */

/** One downloadable file on a release, named as CI attached it. */
export interface ReleaseAsset {
  name: string;
  url: string;
}

/** As much of a GitHub release as this command reads. Nothing else in the payload is believed. */
export interface Release {
  tag: string;
  assets: ReleaseAsset[];
}

/** The seam that reaches GitHub. Replaced wholesale in tests; see `fetchLatestRelease`. */
export type ReleaseFetcher = () => Promise<Release>;

/** The seam that fetches asset bytes. The checksum file comes through it too, decoded as UTF-8. */
export type AssetDownloader = (url: string) => Promise<Uint8Array>;

export interface UpgradeOptions {
  check?: boolean;
  json?: boolean;
  /** Defaults are the running process; a spec names a platform so its assertion is not machine-dependent. */
  platform?: string;
  arch?: string;
  execPath?: string;
  embedded?: boolean;
  fetchRelease?: ReleaseFetcher;
  download?: AssetDownloader;
}

const RELEASES_URL = "https://api.github.com/repos/W1-PopelierE/EmPo/releases/latest";

/**
 * What to do about a release, decided from data alone. Returned rather than thrown so a spec can
 * enumerate the three outcomes, and so the command owns every sentence a user reads.
 */
export type UpgradeDecision =
  | { state: "current"; current: string; latest: string }
  | { state: "available"; current: string; latest: string; asset: ReleaseAsset; sum: ReleaseAsset }
  | { state: "no-asset"; current: string; latest: string; wanted: string; offered: string[] };

/**
 * Which asset this machine wants. Exactly the name `.github/workflows/ci.yml` attaches, and the one
 * `install.sh` asks for, so a rename in CI breaks all three visibly rather than leaving upgrade
 * quietly unable to find itself.
 */
export function assetNameFor(platform: string, arch: string): string {
  return `empo-${platform}-${arch}`;
}

/**
 * Compare two `X.Y.Z` versions numerically, returning the sign of a - b.
 *
 * A string comparison gets `0.1.10` against `0.1.9` backwards, and would have parked every user on
 * the ninth patch of a line forever. Each component is compared as a number for that reason. A
 * missing or non-numeric component counts as 0, so a tag this scheme does not describe sorts low and
 * cannot manufacture an upgrade out of nothing.
 */
export function compareVersions(a: string, b: string): number {
  const left = numbersOf(a);
  const right = numbersOf(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function numbersOf(version: string): number[] {
  // A leading `v` is how the tag is spelled and a prerelease suffix is not compared, so both are cut
  // before the split rather than being allowed to poison a component into NaN.
  const core = version.trim().replace(/^v/, "").split(/[-+]/)[0] ?? "";
  return core.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
}

/** The version a tag names, with the `v` GitHub prefixes it with removed. */
export function versionOfTag(tag: string): string {
  return tag.trim().replace(/^v/, "");
}

export function decideUpgrade(
  current: string,
  release: Release,
  platform: string,
  arch: string,
): UpgradeDecision {
  const latest = versionOfTag(release.tag);
  // `>= 0` rather than `=== 0`: a developer running a build ahead of the last release is current,
  // and downgrading them to it would undo the very thing they are testing.
  if (compareVersions(current, latest) >= 0) return { state: "current", current, latest };

  const wanted = assetNameFor(platform, arch);
  const asset = release.assets.find((candidate) => candidate.name === wanted);
  const sum = release.assets.find((candidate) => candidate.name === `${wanted}.sha256`);
  if (asset === undefined || sum === undefined) {
    return {
      state: "no-asset",
      current,
      latest,
      wanted,
      offered: release.assets.map((a) => a.name),
    };
  }

  return { state: "available", current, latest, asset, sum };
}

/** The hex sha256 of some bytes, spelled once so the download and the check cannot use two digests. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ChecksumCheck {
  ok: boolean;
  expected: string | null;
  actual: string;
  /** Why a null expectation is null, so a malformed checksum file is not reported as a mismatch. */
  note: string | null;
}

/**
 * Check bytes against a `shasum -a 256` line, which is `<hex>  <filename>`.
 *
 * The file name in the line is checked too, not only the hex. A release that attached
 * `empo-linux-x64.sha256` holding the sum of `empo-darwin-arm64` would otherwise install whichever
 * of the two the hex happened to match, and the mismatch this function exists to catch is precisely
 * the case where the two files disagree about which artifact is being described.
 */
export function verifyChecksum(bytes: Uint8Array, line: string, asset: string): ChecksumCheck {
  const actual = sha256(bytes);
  const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim().split("\n")[0]?.trim() ?? "");
  if (match === null) {
    return {
      ok: false,
      expected: null,
      actual,
      note: "the checksum file is not <hex>  <filename>",
    };
  }

  const [, hex = "", named = ""] = match;
  if (named !== asset) {
    return {
      ok: false,
      expected: hex.toLowerCase(),
      actual,
      note: `the checksum file describes ${named}, not ${asset}`,
    };
  }
  return { ok: hex.toLowerCase() === actual, expected: hex.toLowerCase(), actual, note: null };
}

/**
 * The default fetcher. `fetch` is global from Node 18 and the floor here is 22.12.0, so no HTTP
 * dependency enters the tree for one request made once per explicit user command.
 */
export const fetchLatestRelease: ReleaseFetcher = async () => {
  const response = await get(RELEASES_URL, { Accept: "application/vnd.github+json" });
  const payload = (await response.json()) as {
    tag_name?: unknown;
    assets?: { name?: unknown; browser_download_url?: unknown }[];
  };

  if (typeof payload.tag_name !== "string") {
    throw environmentError("The latest release names no tag", [
      "GitHub answered, but the payload has no tag_name, so there is nothing to compare against.",
    ]);
  }

  const assets: ReleaseAsset[] = [];
  for (const asset of payload.assets ?? []) {
    if (typeof asset.name === "string" && typeof asset.browser_download_url === "string") {
      assets.push({ name: asset.name, url: asset.browser_download_url });
    }
  }
  return { tag: payload.tag_name, assets };
};

export const downloadAsset: AssetDownloader = async (url) => {
  const response = await get(url, { Accept: "application/octet-stream" });
  return new Uint8Array(await response.arrayBuffer());
};

/**
 * One request, with every failure turned into an environment error rather than a stack trace. A
 * private repository answers 404 to an unauthenticated reader exactly as a deleted one does, so the
 * status is named instead of interpreted.
 */
async function get(url: string, headers: Record<string, string>): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { "User-Agent": "empo-upgrade", ...headers } });
  } catch (error) {
    throw environmentError(`Could not reach ${url}`, [
      (error as Error).message,
      "empo upgrade is the only command that uses the network. Check connectivity and rerun.",
    ]);
  }
  if (!response.ok) {
    throw environmentError(`${url} answered ${response.status} ${response.statusText}`, [
      response.status === 404
        ? "No published release with assets, or the repository is not readable from here."
        : "The release could not be read, so there is nothing to compare this build against.",
    ]);
  }
  return response;
}

export async function upgradeCommand(
  currentVersion: string,
  options: UpgradeOptions = {},
): Promise<void> {
  const json = options.json === true;
  const check = options.check === true;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const execPath = options.execPath ?? process.execPath;
  const embedded = options.embedded ?? isEmbeddedBuild();

  // Refused before the network is touched, because for these two builds no answer from GitHub would
  // change what the user should do next.
  if (!embedded) requireStandaloneBuild();
  if (!check && platform === "win32") refuseOnWindows();

  const fetchRelease = options.fetchRelease ?? fetchLatestRelease;
  const download = options.download ?? downloadAsset;

  const decision = decideUpgrade(currentVersion, await fetchRelease(), platform, arch);

  if (decision.state === "current") {
    report(json, {
      state: "current",
      current: decision.current,
      latest: decision.latest,
      asset: null,
      target: null,
    });
    if (!json) {
      console.log("");
      console.log(`empo ${decision.current} is the latest release. Nothing to do.`);
    }
    return;
  }

  if (decision.state === "no-asset") {
    throw environmentError(`Release v${decision.latest} has no binary for ${platform}-${arch}`, [
      `Wanted ${decision.wanted}.`,
      decision.offered.length === 0
        ? "The release carries no assets at all."
        : `The release offers: ${decision.offered.join(", ")}.`,
    ]);
  }

  if (check) {
    report(json, {
      state: "available",
      current: decision.current,
      latest: decision.latest,
      asset: decision.asset.name,
      target: null,
    });
    if (!json) {
      console.log("");
      console.log(`empo ${decision.current} is installed; ${decision.latest} is available.`);
      console.log("Run empo upgrade to install it.");
    }
    return;
  }

  install(execPath, await fetched(download, decision));

  report(json, {
    state: "upgraded",
    current: decision.current,
    latest: decision.latest,
    asset: decision.asset.name,
    target: execPath,
  });
  if (!json) {
    console.log("");
    console.log(`Upgraded empo ${decision.current} -> ${decision.latest} at ${execPath}`);
  }
}

/** The verified bytes of the new binary, or nothing at all. Nothing unverified leaves this function. */
async function fetched(
  download: AssetDownloader,
  decision: Extract<UpgradeDecision, { state: "available" }>,
): Promise<Uint8Array> {
  const bytes = await download(decision.asset.url);
  const line = Buffer.from(await download(decision.sum.url)).toString("utf8");
  const checked = verifyChecksum(bytes, line, decision.asset.name);
  if (checked.ok) return bytes;

  throw environmentError(
    `The downloaded ${decision.asset.name} does not match its published sha256`,
    [
      checked.note ?? `expected ${checked.expected}, got ${checked.actual}`,
      "Nothing was installed. Treat a mismatch as a corrupted or tampered download, not as a retryable error.",
    ],
  );
}

/**
 * Write, chmod, rename. The temp file goes in the same directory as the binary it replaces, because
 * `rename` is only atomic within one filesystem: from the system temp directory it would degrade to
 * a copy, and a copy interrupted halfway leaves a truncated executable where `empo` used to be. The
 * rename itself is safe over a running process on macOS and Linux, where an open file survives being
 * unlinked from its name.
 *
 * The temp file is removed on every failing path. A verified download that cannot be installed must
 * not leave a stray executable-shaped file beside the real one.
 */
function install(execPath: string, bytes: Uint8Array): void {
  const dir = dirname(execPath);
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw environmentError(`Cannot write to ${dir}`, [
      `empo is installed at ${execPath}, in a directory this user may not write.`,
      "Reinstall to a writable location, for example EMPO_INSTALL_DIR=$HOME/.local/bin. Do not use sudo.",
    ]);
  }

  const temp = join(dir, `.empo-upgrade-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temp, bytes);
    chmodSync(temp, 0o755);
    renameSync(temp, execPath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw environmentError(`Could not replace ${execPath}`, [
      (error as Error).message,
      "The previous binary is untouched.",
    ]);
  }
}

function requireStandaloneBuild(): never {
  throw configError("empo upgrade only replaces the standalone binary", [
    "This build reads its packs and discipline off disk, so it is a checkout rather than a release.",
    "From a checkout: git pull && npm install && npm run install:local.",
    "To install the released binary instead: curl -fsSL https://raw.githubusercontent.com/W1-PopelierE/EmPo/main/install.sh | sh",
  ]);
}

function refuseOnWindows(): never {
  throw environmentError("empo upgrade cannot replace a running executable on Windows", [
    "Windows holds a lock on the running image, so the rename that installs the new binary fails.",
    "Download the release asset and replace empo.exe while it is not running.",
    "empo upgrade --check reports the available version here and writes nothing.",
  ]);
}

interface UpgradeReport {
  state: "current" | "available" | "upgraded";
  current: string;
  latest: string;
  asset: string | null;
  target: string | null;
}

/**
 * The `--json` surface, following `empo doctor`: exactly one `console.log` on this path, and every
 * prose line lives on the other one, so a machine reader gets one complete document and nothing else.
 */
function report(json: boolean, document: UpgradeReport): void {
  if (json) console.log(JSON.stringify(document, null, 2));
}
