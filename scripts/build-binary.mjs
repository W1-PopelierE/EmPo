/**
 * Builds the standalone binary: one executable that resolves no interpreter from the environment it
 * is invoked in (docs/10-distribution.md).
 *
 * That requirement is the whole design. A hook fires inside somebody else's repository, so a bare
 * `empo` and a `#!/usr/bin/env node` shebang both resolve against their Node, and a target pinning a
 * Node below `>=22.12.0` cannot start the tool at all. This artifact carries its own Node, so the
 * target's is never consulted and the version it pins stops being a fact about whether EmPo runs.
 *
 * Three things separate this build from `npm run build`, and each is forced rather than chosen:
 *
 * 1. **CommonJS, not ESM.** Node's single-executable API loads its main script as CommonJS. Nothing
 *    else about the source changes; esbuild emits the other format from the same entry point.
 * 2. **The assets are compiled in.** `import.meta.url` is empty in a CommonJS bundle, and a binary
 *    has no `src/packs/` or `src/discipline/` beside it either way, so the pack rules, the
 *    discipline markdown and the version string are generated into `src/embedded.ts` at build time
 *    and the disk loaders are never reached. See that file for why populated wins wholesale.
 * 3. **It is a copy of `node` with a blob injected into it**, so it is large (about 110MB) and it is
 *    platform-specific. Both are the cost of the requirement and neither is a defect.
 *
 * This script is plain JavaScript and `tsc` does not see it, the same standing as a shell script.
 * What it produces is checked by running it: `scripts/smoke-binary.sh` is the pin that a build
 * artifact can have, and `test/embedded.test.ts` pins the code paths the artifact depends on.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { collectDiscipline, collectPacks, embeddedModule } from "./embed.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "dist-binary");
const workDir = join(outDir, "work");

/** The constant Node's own documentation specifies. Not a value this project gets to choose. */
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

async function bundle(version, packs, discipline) {
  const embeddedPath = join(repoRoot, "src", "embedded.ts");
  const generated = embeddedModule(version, packs, discipline);
  const outfile = join(workDir, "empo.cjs");

  await build({
    entryPoints: [join(repoRoot, "src", "empo.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile,
    // `import.meta.url` is empty in the CommonJS format, and esbuild would emit `{}` for it. EmPo's
    // own three uses are all out of reach in this build (two lazy disk roots a populated embedded
    // map skips, and a `createRequire` behind a `??`), but a dependency's is not: `fdir`, under
    // `tinyglobby`, calls `createRequire(import.meta.url)` at module scope, so `{}` threw
    // ERR_INVALID_ARG_VALUE before any EmPo code ran. Defined to the executable's own file URL,
    // which is a real absolute path in a single executable, so the call succeeds.
    define: { "import.meta.url": "__empoMetaUrl" },
    banner: {
      js: 'const __empoMetaUrl = require("node:url").pathToFileURL(__filename).href;',
    },
    plugins: [
      {
        name: "empo-embed-assets",
        setup(pluginBuild) {
          pluginBuild.onLoad({ filter: /src[\\/]embedded\.ts$/ }, (args) => {
            if (args.path !== embeddedPath) return null;
            return { contents: generated, loader: "ts" };
          });
        },
      },
    ],
  });

  return outfile;
}

function makeExecutable(mainScript, binaryPath) {
  const seaConfig = join(workDir, "sea-config.json");
  const blob = join(workDir, "empo.blob");

  writeFileSync(
    seaConfig,
    JSON.stringify({ main: mainScript, output: blob, disableExperimentalSEAWarning: true }),
  );

  execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

  // The host binary is this very Node. That is what makes the artifact interpreter-independent:
  // whatever Node built it is the Node it runs on, forever, wherever it is invoked.
  copyFileSync(process.execPath, binaryPath);

  const darwin = process.platform === "darwin";

  if (darwin) {
    // A signature covers the bytes, so it has to come off before they change and go back on after.
    // Left signed, the injected copy is killed by the kernel rather than merely refused.
    execFileSync("codesign", ["--remove-signature", binaryPath], { stdio: "inherit" });
  }

  const postject = join(repoRoot, "node_modules", ".bin", "postject");
  execFileSync(
    postject,
    [
      binaryPath,
      "NODE_SEA_BLOB",
      blob,
      "--sentinel-fuse",
      SENTINEL_FUSE,
      ...(darwin ? ["--macho-segment-name", "NODE_SEA"] : []),
    ],
    { stdio: "inherit" },
  );

  if (darwin) {
    execFileSync("codesign", ["--sign", "-", binaryPath], { stdio: "inherit" });
  }
}

const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const packs = collectPacks();
const discipline = collectDiscipline();

rmSync(outDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const binaryPath = join(outDir, process.platform === "win32" ? "empo.exe" : "empo");
const mainScript = await bundle(version, packs, discipline);
makeExecutable(mainScript, binaryPath);
rmSync(workDir, { recursive: true, force: true });

console.log(`empo ${version} -> ${binaryPath}`);
console.log(`packs      ${Object.keys(packs).join(", ")}`);
console.log(`discipline ${Object.keys(discipline).join(", ")}`);
console.log(`node       ${process.version} (carried, not resolved)`);
