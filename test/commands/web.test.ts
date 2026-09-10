import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createViewer, DEFAULT_PORT, webCommand } from "../../src/commands/web";
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

// `webCommand` keeps the viewer it binds to itself — the reader has no use for it — so every server
// this process makes is noted on the way past. It is the only way a test can read the address off
// the one the command bound, and the only way to close it again afterwards.
const { servers } = vi.hoisted(() => ({ servers: [] as Server[] }));
vi.mock("node:http", async (importOriginal) => {
  const http = await importOriginal<typeof import("node:http")>();
  return {
    ...http,
    default: http,
    createServer: (...args: Parameters<typeof http.createServer>) => {
      const server = http.createServer(...args);
      servers.push(server);
      return server;
    },
  };
});

const temps: string[] = [];
const running: { stop(): void }[] = [];

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "empo-web-"));
  temps.push(dir);
  return dir;
}

/** A session on disk exactly as phase 1 leaves it. The branch is what tells two of them apart. */
function startReview(root: string, id = "local", sourceBranch = "feat/x"): string {
  const dir = sessionDir(root, id);
  mkdirSync(dir, { recursive: true });
  temps.push(dir);
  const diffPath = join(dir, `pr-${id}.diff`);
  writeFileSync(diffPath, DIFF, "utf8");
  writeFileSync(
    join(dir, "session.json"),
    JSON.stringify({
      id,
      repoRoot: root,
      readRoot: root,
      worktree: null,
      base: "main",
      sourceBranch,
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

/** The `data:` payloads an SSE client has received so far. */
function listen(url: string): { frames: string[]; close(): void } {
  const frames: string[] = [];
  const call = httpRequest(url, (response) => {
    let buffer = "";
    response.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        frames.push(buffer.slice(0, end).replace(/^data: /, ""));
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
      }
    });
  });
  call.end();
  return { frames, close: () => call.destroy() };
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100; tries++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
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

  // Read-only is a property of the server, not of the routes: nothing here writes, and a method
  // that could is refused before the path is ever looked at.
  test("answers 405 to anything that is not a GET", async () => {
    const response = await fetch(`${await serve(repo())}/api/state`, { method: "POST" });

    expect(response.status).toBe(405);
    await response.text();
  });

  /** A request target `fetch` would rewrite on the way out, sent verbatim instead. */
  function raw(port: string, path: string): Promise<number> {
    return new Promise((done, fail) => {
      const call = httpRequest({ host: "127.0.0.1", port, path }, (response) => {
        response.resume();
        done(response.statusCode ?? 0);
      });
      call.on("error", fail);
      call.end();
    });
  }

  // Two leading slashes make the target an authority against the base the server parses with, so a
  // forbidden domain code point in it is a parse failure. That used to throw inside the listener,
  // where nothing catches it and the viewer dies — hence the second half of this test.
  test("answers 400 to a target it cannot parse, and is still up afterwards", async () => {
    const base = await serve(repo());

    expect(await raw(new URL(base).port, "//%%")).toBe(400);

    const after = await fetch(`${base}/api/state`);
    expect(after.status).toBe(200);
    await after.text();
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

// The timer only broadcasts when the freshly polled state differs from the copy it last sent, so
// anything else that advances that copy swallows a frame nobody received. `/api/state` is the one
// other reader of it, and the page polls that route after any SSE blip — so a request landing
// between two ticks used to cost a live tab the transition permanently.
describe("the event stream against a request that reads the same state", () => {
  test("still tells a listener the review started after an /api/state request read it first", async () => {
    const root = repo();
    const base = await serve(root);
    const client = listen(`${base}/events`);
    await until(() => client.frames.length >= 1);
    expect(JSON.parse(client.frames[0] ?? "{}").phase).toBe("idle");

    startReview(root);
    // The request that used to eat the frame: it reads the new state and answers with it, and the
    // stream must still deliver that same change on the next tick.
    const polled = (await (await fetch(`${base}/api/state`)).json()) as Snapshot;
    expect(polled.phase).toBe("brief");

    await until(() => client.frames.length >= 2);
    client.close();

    expect(client.frames.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(client.frames.at(-1) ?? "{}").phase).toBe("brief");
  });
});

// Two reviews can be live in one checkout at once — a PR read in a worktree beside the local diff
// — and the reader picks between them by the basename of the session directory. Which session
// answered is what `sourceBranch` names, so every assertion here reads that.
describe("the viewer's session selection", () => {
  /** Two live sessions whose order `sessionDirs` cannot tie on: the older mtime is set by hand. */
  function twoReviews(root: string): { older: string; newer: string } {
    const older = startReview(root, "one", "feat/one");
    const newer = startReview(root, "two", "feat/two");
    const past = Date.now() / 1000 - 60;
    utimesSync(older, past, past);
    return { older: basename(older), newer: basename(newer) };
  }

  /** The branch named by the last frame a stream received, or nothing yet. */
  function branchOf(client: { frames: string[] }): string | undefined {
    return JSON.parse(client.frames.at(-1) ?? "{}").session?.sourceBranch;
  }

  test("answers with the session the query names, not the newest one", async () => {
    const root = repo();
    const { older } = twoReviews(root);
    const base = await serve(root);

    const state = (await (await fetch(`${base}/api/state?session=${older}`)).json()) as Snapshot;

    expect(state.session?.sourceBranch).toBe("feat/one");
    expect(state.selected).toBe(older);
  });

  // A key goes stale the moment its review tears down, and the page holding it is a tab the reader
  // left open. Falling back to the newest keeps that tab useful; failing would blank it.
  test("falls back to the newest session when the key names none that is live", async () => {
    const root = repo();
    twoReviews(root);
    const base = await serve(root);

    const state = (await (await fetch(`${base}/api/state?session=gone`)).json()) as Snapshot;

    expect(state.session?.sourceBranch).toBe("feat/two");
  });

  // One timer serves every stream, so the snapshot it compares against has to be per key: with a
  // single copy the two clients below would take turns overwriting it and each would be told about
  // the other's session.
  test("gives two streams that named different sessions their own snapshot", async () => {
    const root = repo();
    const { older, newer } = twoReviews(root);
    const base = await serve(root);
    const one = listen(`${base}/events?session=${older}`);
    const two = listen(`${base}/events?session=${newer}`);

    await until(() => branchOf(one) === "feat/one" && branchOf(two) === "feat/two");
    one.close();
    two.close();

    expect(branchOf(one)).toBe("feat/one");
    expect(branchOf(two)).toBe("feat/two");
  });

  // The change test is per key or it is nothing: against one shared copy, key B compares its fresh
  // read to whatever key A just wrote, so nothing ever looks unchanged and both streams get a frame
  // every 400ms for as long as the tab is open. Silence on a quiet tick is the observable half.
  test("sends nothing to either stream while neither session changes", async () => {
    const root = repo();
    const { older, newer } = twoReviews(root);
    const base = await serve(root);
    const one = listen(`${base}/events?session=${older}`);
    const two = listen(`${base}/events?session=${newer}`);
    await until(() => branchOf(one) === "feat/one" && branchOf(two) === "feat/two");
    const settled = [one.frames.length, two.frames.length];

    // Several polls with nothing on disk moving; a per-tick broadcast could not hide in this.
    await new Promise((done) => setTimeout(done, 1400));
    one.close();
    two.close();

    expect([one.frames.length, two.frames.length]).toEqual(settled);
  });

  // Teardown is where a shared `previous` does real damage rather than just extra frames: it is the
  // only state a finished review still has, so with one copy whichever key the tick reached last
  // would hand its frozen picture to every stream, and the reader of session one would be left
  // looking at session two's last moment under session one's heading.
  test("freezes each stream on the session it was watching once both are gone", async () => {
    const root = repo();
    const { older, newer } = twoReviews(root);
    const base = await serve(root);
    const one = listen(`${base}/events?session=${older}`);
    const two = listen(`${base}/events?session=${newer}`);
    await until(() => branchOf(one) === "feat/one" && branchOf(two) === "feat/two");

    rmSync(sessionDir(root, "one"), { recursive: true, force: true });
    rmSync(sessionDir(root, "two"), { recursive: true, force: true });

    await until(() => frozen(one) && frozen(two));
    one.close();
    two.close();
    // Both halves matter: a shared `previous` never sends the frozen frame at all, because the
    // first key to be carried forward writes the note into the copy the second one is compared
    // against, and the second then looks unchanged.
    expect([frozen(one), branchOf(one)]).toEqual([true, "feat/one"]);
    expect([frozen(two), branchOf(two)]).toEqual([true, "feat/two"]);
  });

  /** The note `readReviewState` carries a torn-down review forward under. */
  function frozen(client: { frames: string[] }): boolean {
    const note = JSON.parse(client.frames.at(-1) ?? "{}").note;
    return note === "session finished; showing its last state";
  }
});

describe("the command", () => {
  /** A server sitting on a fixed port, or null when this machine already has something there. */
  function occupy(port: number): Promise<Server | null> {
    const server = createServer();
    return new Promise((done) => {
      server.once("error", () => done(null));
      server.listen(port, "127.0.0.1", () => done(server));
    });
  }

  /** The server the command bound, taken from the tail of what it made, and closed with the rest. */
  function boundBy(before: number): Server {
    const server = servers[before] as Server;
    running.push({ stop: () => server.close() });
    return server;
  }

  // Loopback is the whole reason the Host check is worth anything: the header only tells a rebound
  // domain apart because nothing off this machine can reach the socket at all. Every other test
  // here calls `listen` itself, so this is the only one that sees the host the command passes.
  test("binds the loopback address, and prints the port it actually got", async () => {
    const before = servers.length;
    const printed: unknown[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => void printed.push(line));
    try {
      // `--port 0` is a port number, so it reaches `listen` and means "whatever is free": the port
      // asked for is exactly the one the reader must not be handed back.
      await webCommand(repo(), { port: 0 });
    } finally {
      log.mockRestore();
    }
    const address = boundBy(before).address() as AddressInfo;

    expect(address.address).toBe("127.0.0.1");
    expect(printed[0]).toBe(`empo web  http://127.0.0.1:${address.port}`);
  });

  // The walk only runs when no --port was passed, so the default port is the only way into it. If
  // this machine already has something on that port or the one after it, there is nothing left to
  // prove and the test says so rather than asserting against whatever else is listening.
  test("walks past a busy default port to the next one", async (ctx) => {
    const taken = await occupy(DEFAULT_PORT);
    const next = await occupy(DEFAULT_PORT + 1);
    if (!taken || !next) {
      taken?.close();
      next?.close();
      return ctx.skip();
    }
    // Held only to prove it was free, then handed straight back for the walk to land on.
    await new Promise<void>((closed) => next.close(() => closed()));

    const before = servers.length;
    try {
      await webCommand(repo());
    } finally {
      taken.close();
    }

    expect((boundBy(before).address() as AddressInfo).port).toBe(DEFAULT_PORT + 1);
  });

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
