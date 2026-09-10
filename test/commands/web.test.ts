import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createViewer } from "../../src/commands/web";
import type { Snapshot } from "../../src/engine/review-state";
import { sessionDir } from "../../src/engine/session";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 export { x };
`;

const temps: string[] = [];
const running: { stop(): void }[] = [];

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-web-"));
  temps.push(dir);
  return dir;
}

/** A session on disk exactly as phase 1 leaves it. */
function startReview(root: string): string {
  const dir = sessionDir(root, "local");
  mkdirSync(dir, { recursive: true });
  temps.push(dir);
  const diffPath = join(dir, "pr-local.diff");
  writeFileSync(diffPath, DIFF, "utf8");
  writeFileSync(
    join(dir, "session.json"),
    JSON.stringify({
      id: "local",
      repoRoot: root,
      readRoot: root,
      worktree: null,
      base: "main",
      sourceBranch: "feat/x",
      sha: "abc123",
      tree: "def456",
      diffPath,
    }),
    "utf8",
  );
  return dir;
}

async function serve(root: string): Promise<string> {
  const viewer = createViewer(root);
  running.push(viewer);
  await new Promise<void>((resolve) => {
    viewer.server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = viewer.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(() => {
  for (const viewer of running.splice(0)) viewer.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the viewer's routes", () => {
  test("serves the page at the root", async () => {
    const response = await fetch(`${await serve(repo())}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await response.text();
  });

  test("serves the snapshot as JSON, idle when no review is running", async () => {
    const state = (await (await fetch(`${await serve(repo())}/api/state`)).json()) as Snapshot;

    expect(state.phase).toBe("idle");
  });

  test("serves a file from the session's read root", async () => {
    const root = repo();
    startReview(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "const x = 1;\n", "utf8");

    const response = await fetch(`${await serve(root)}/file?path=src/a.ts`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("const x = 1;\n");
  });

  test("refuses a path that climbs out of the read root", async () => {
    const root = repo();
    startReview(root);
    // A real file just outside the root, so the refusal is the check doing its job and not the
    // traversal happening to land on nothing.
    const outside = repo();
    writeFileSync(join(outside, "secret.txt"), "secret\n", "utf8");

    const climb = `../${basename(outside)}/secret.txt`;
    const response = await fetch(`${await serve(root)}/file?path=${encodeURIComponent(climb)}`);

    expect(response.status).toBe(403);
    await response.text();
  });

  test("refuses a symlink inside the root that points out of it", async () => {
    const root = repo();
    startReview(root);
    const outside = repo();
    writeFileSync(join(outside, "secret.txt"), "secret\n", "utf8");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));

    const response = await fetch(`${await serve(root)}/file?path=link.txt`);

    expect(response.status).toBe(403);
    await response.text();
  });

  test("refuses an absolute path", async () => {
    const root = repo();
    startReview(root);

    const response = await fetch(`${await serve(root)}/file?path=/etc/passwd`);

    expect(response.status).toBe(403);
    await response.text();
  });

  test("answers 404 for anything it does not serve", async () => {
    const response = await fetch(`${await serve(repo())}/../secret`);

    expect(response.status).toBe(404);
    await response.text();
  });

  test("serves no file at all when no review is running", async () => {
    const response = await fetch(`${await serve(repo())}/file?path=README.md`);

    expect(response.status).toBe(404);
    await response.text();
  });
});
