import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createViewer, webCommand } from "../../src/commands/web";
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

  test("answers 404 for anything it does not serve", async () => {
    const response = await fetch(`${await serve(repo())}/../secret`);

    expect(response.status).toBe(404);
    await response.text();
  });
});

describe("the viewer's host check", () => {
  /** `fetch` refuses to set Host, so the header a rebound page would send is sent by hand. */
  function status(base: string, host: string): Promise<number> {
    const { port } = new URL(base);
    return new Promise((done, fail) => {
      const call = httpRequest(
        { host: "127.0.0.1", port, path: "/api/state", headers: { host } },
        (response) => {
          response.resume();
          done(response.statusCode ?? 0);
        },
      );
      call.on("error", fail);
      call.end();
    });
  }

  test("refuses a request whose Host is not loopback, so a rebound domain reads nothing", async () => {
    const root = repo();
    startReview(root);
    const base = await serve(root);

    expect(await status(base, "evil.example")).toBe(403);
  });

  test("serves a request whose Host is the loopback address it bound", async () => {
    const base = await serve(repo());

    expect(await status(base, base.slice("http://".length))).toBe(200);
  });
});

describe("the command", () => {
  test("reports a port it cannot bind as an environment error", async () => {
    const blocker = createServer();
    await new Promise<void>((ready) => {
      blocker.listen(0, "127.0.0.1", ready);
    });
    const { port } = blocker.address() as AddressInfo;

    try {
      await expect(webCommand(repo(), { port })).rejects.toMatchObject({ exitCode: 3 });
    } finally {
      blocker.close();
    }
  });

  // Binding port 1 is EACCES for anyone but root, which is the bind failure the walk must not
  // swallow. Skipped as root, where it would simply succeed.
  test.skipIf(process.getuid?.() === 0)(
    "reports a bind refused by the OS as an environment error, not a stack trace",
    async () => {
      await expect(webCommand(repo(), { port: 1 })).rejects.toMatchObject({ exitCode: 3 });
    },
  );

  test("reports a --port that is not a port number as a usage error", async () => {
    await expect(webCommand(repo(), { port: Number.parseInt("abc", 10) })).rejects.toMatchObject({
      exitCode: 2,
    });
    await expect(webCommand(repo(), { port: 70000 })).rejects.toMatchObject({ exitCode: 2 });
  });
});
