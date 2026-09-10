import { createServer, type Server, type ServerResponse } from "node:http";
import { emptySnapshot, readReviewState, type Snapshot } from "../engine/review-state";
import { configError, environmentError } from "../errors";
import { page } from "../web/page";

/**
 * `empo web`: a viewer for a review in progress. Read-only, loopback-only, and derived entirely
 * from files `empo review` writes for its own reasons, so starting it changes nothing about a
 * review and stopping it loses nothing but the window.
 */

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const DEFAULT_PORT = 7373;
const PORT_ATTEMPTS = 10;
const POLL_MS = 400;

export interface WebOptions {
  port?: number;
}

export function createViewer(repoRoot: string): { server: Server; stop(): void } {
  let snapshot = emptySnapshot();
  const clients = new Set<ServerResponse>();

  // ponytail: polling, not fs.watch. fs.watch on macOS misses subdirectories created after the
  // watch and duplicates events; five stats per tick is cheaper than working around that.
  const timer = setInterval(() => {
    const next = readReviewState(repoRoot, snapshot);
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    for (const client of clients) client.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }, POLL_MS);
  timer.unref();

  /**
   * Three routes and nothing else, all GET. The state is read fresh per request rather than served
   * from the poll's copy, so a page that loads between two ticks is never a tick behind.
   */
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method !== "GET") return send(response, 405, "text/plain", "GET only");

    // Binding loopback keeps the network out, but not the reader's own browser: a page they visit
    // while the viewer is up can point its own domain at 127.0.0.1 and then read this origin as its
    // own. The Host header is what tells those two apart, so anything not loopback is refused.
    if (!LOOPBACK_HOST.test(request.headers.host ?? "")) {
      return send(response, 403, "text/plain", "Bad host");
    }

    if (url.pathname === "/") return send(response, 200, "text/html; charset=utf-8", page());

    if (url.pathname === "/api/state") {
      const state = readReviewState(repoRoot, snapshot);
      snapshot = state;
      return send(response, 200, "application/json", JSON.stringify(state));
    }

    if (url.pathname === "/events") return stream(response, clients, snapshot);

    return send(response, 404, "text/plain", "Not found");
  });

  return {
    server,
    stop() {
      clearInterval(timer);
      for (const client of clients) client.end();
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

  const { server } = createViewer(repoRoot);
  const first = options.port ?? DEFAULT_PORT;
  const last = options.port === undefined ? first + PORT_ATTEMPTS - 1 : first;

  for (let port = first; port <= last; port++) {
    const bound = await listen(server, port);
    if (bound) {
      console.log(`empo web  http://127.0.0.1:${port}`);
      return;
    }
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

/** One server-sent-events client: the current state at once, then every change until it leaves. */
function stream(response: ServerResponse, clients: Set<ServerResponse>, snapshot: Snapshot): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  clients.add(response);
  response.on("close", () => clients.delete(response));
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { "content-type": type });
  response.end(body);
}
