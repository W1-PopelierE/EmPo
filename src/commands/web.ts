import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { emptySnapshot, readReviewState, type Snapshot } from "../engine/review-state";
import { configError, environmentError } from "../errors";
import { page } from "../web/page";

/**
 * `empo web`: a viewer for a review in progress. Read-only, loopback-only, and derived entirely
 * from files `empo review` writes for its own reasons, so starting it changes nothing about a
 * review and stopping it loses nothing but the window.
 */

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
export const DEFAULT_PORT = 7373;
const PORT_ATTEMPTS = 10;
const POLL_MS = 400;

export interface WebOptions {
  port?: number;
}

export function createViewer(repoRoot: string): { server: Server; stop(): void } {
  // One snapshot per selected session key, "" meaning "no choice, follow the newest". A single
  // shared copy would not do: `previous` is what carries a torn-down review's last state forward,
  // so session A would inherit B's frozen picture, and the timer's change test would compare A's
  // fresh read against whatever B last broadcast and fire on every tick.
  //
  // ponytail: never pruned. A key is a session directory basename, so the map holds one snapshot
  // per review the reader ever looked at in this viewer's lifetime — a handful. Drop keys nobody
  // holds if a viewer ever outlives hundreds of reviews.
  const snapshots = new Map<string, Snapshot>();
  const snapshotFor = (key: string): Snapshot => snapshots.get(key) ?? emptySnapshot();
  // Which session each stream asked for; the key decides who a frame goes to.
  const clients = new Map<ServerResponse, string>();

  // ponytail: polling, not fs.watch. fs.watch on macOS misses subdirectories created after the
  // watch and duplicates events; five stats per tick is cheaper than working around that.
  const timer = setInterval(() => {
    // Only the keys somebody is actually watching, plus "" for the next stream that arrives
    // without one: a key nobody holds would otherwise cost a full state read every tick forever.
    for (const key of new Set(["", ...clients.values()])) {
      const previous = snapshotFor(key);
      const next = readReviewState(repoRoot, previous, key === "" ? null : key);
      if (JSON.stringify(next) === JSON.stringify(previous)) continue;
      snapshots.set(key, next);
      const frame = `data: ${JSON.stringify(next)}\n\n`;
      for (const [client, watching] of clients) if (watching === key) client.write(frame);
    }
  }, POLL_MS);
  timer.unref();

  /**
   * Three routes and nothing else, all GET. The state is read fresh per request rather than served
   * from the poll's copy, so a page that loads between two ticks is never a tick behind.
   */
  const server = createServer((request, response) => {
    // A target starting with two slashes is parsed as an authority against this special base, so a
    // forbidden domain code point in it (`//%%`, `//^`) makes the parse fail — and a throw here is
    // in a listener nothing catches, long after `webCommand` resolved, so it takes the whole viewer
    // down. Any page the reader visits can send that. `URL.parse` reports the same failure as null.
    const url = URL.parse(request.url ?? "/", "http://127.0.0.1");
    if (!url) return send(response, 400, "text/plain", "Bad request");

    if (request.method !== "GET") return send(response, 405, "text/plain", "GET only");

    // Binding loopback keeps the network out, but not the reader's own browser: a page they visit
    // while the viewer is up can point its own domain at 127.0.0.1 and then read this origin as its
    // own. The Host header is what tells those two apart, so anything not loopback is refused.
    if (!LOOPBACK_HOST.test(request.headers.host ?? "")) {
      return send(response, 403, "text/plain", "Bad host");
    }

    // The page is static; `?session=` on it is for the page's own script to read back out of the
    // location, which is why the query never reaches here as anything but part of the URL.
    if (url.pathname === "/") return send(response, 200, "text/html; charset=utf-8", page());

    // A key naming no live session falls back to the newest inside `readReviewState`, so a tab
    // left open across a teardown keeps showing something rather than blanking.
    const key = url.searchParams.get("session") ?? "";

    // Read fresh, and left there: storing it under `key` from here would make the timer compare
    // its next poll against a state it never broadcast, so one request would swallow the frame
    // every SSE client on that key was owed. The timer keeps each key current on its own.
    if (url.pathname === "/api/state") {
      const state = readReviewState(repoRoot, snapshotFor(key), key === "" ? null : key);
      return send(response, 200, "application/json", JSON.stringify(state));
    }

    if (url.pathname === "/events") return stream(response, clients, key, snapshotFor(key));

    return send(response, 404, "text/plain", "Not found");
  });

  return {
    server,
    stop() {
      clearInterval(timer);
      for (const client of clients.keys()) client.end();
      clients.clear();
      server.close();
    },
  };
}

/**
 * `empo web` for a human: bind, print the address, and stay up. The port walks upward on
 * EADDRINUSE because the common collision is the viewer a previous review left running, and a
 * second window is worth more than a message telling the reader to go and find a port.
 */
export async function webCommand(repoRoot: string, options: WebOptions = {}): Promise<void> {
  // `--port abc` reaches here as NaN, which would otherwise walk zero ports and report a port
  // nobody tried; `--port 70000` would make `listen` throw a RangeError at the reader. Both are
  // usage mistakes, not environment ones.
  if (options.port !== undefined && !isPort(options.port)) {
    throw configError("--port takes a port number between 0 and 65535", [
      "For example: empo web --port 7373",
    ]);
  }

  const viewer = createViewer(repoRoot);
  const first = options.port ?? DEFAULT_PORT;
  const last = options.port === undefined ? first + PORT_ATTEMPTS - 1 : first;

  // Bound is the only outcome that keeps the poll timer: every way out of here that is not a live
  // server leaves an interval running for the life of the process, which in a test run is the rest
  // of the suite.
  let bound = false;
  try {
    for (let port = first; port <= last; port++) {
      bound = await listen(viewer.server, port);
      if (bound) {
        // `--port 0` is a port number the walk accepts, and it means "whatever the OS has free", so
        // the loop variable is an address nobody can open. The bound socket is what knows the real one.
        const address = viewer.server.address() as AddressInfo | null;
        console.log(`empo web  http://127.0.0.1:${address?.port ?? port}`);
        return;
      }
    }
  } finally {
    if (!bound) viewer.stop();
  }

  throw environmentError(
    options.port === undefined
      ? `No free port between ${first} and ${last}`
      : `Port ${first} is already in use`,
    ["Pass --port to pick one yourself."],
  );
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

/**
 * Resolves true once bound and false on EADDRINUSE, which is the one failure worth walking past.
 * Everything else — EACCES on a privileged port, most often — is the environment saying no, and is
 * reported as one (exit 3) rather than escaping as a stack trace.
 */
function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((done, fail) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (error.code === "EADDRINUSE") return done(false);
      fail(
        environmentError(`Cannot bind 127.0.0.1:${port}`, [
          error.message,
          "Pass --port to pick one yourself.",
        ]),
      );
    };
    const onListening = () => {
      server.removeListener("error", onError);
      done(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/**
 * One server-sent-events client: the current state at once, then every change to the session it
 * named until it leaves. The first frame is the timer's copy for that key, which is empty when
 * nobody was watching it yet — the next tick corrects it, exactly as it always has for the newest.
 */
function stream(
  response: ServerResponse,
  clients: Map<ServerResponse, string>,
  key: string,
  snapshot: Snapshot,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  clients.set(response, key);
  response.on("close", () => clients.delete(response));
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { "content-type": type });
  response.end(body);
}
