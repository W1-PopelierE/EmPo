import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import { emptySnapshot, readReviewState, type Snapshot } from "../engine/review-state";
import { environmentError } from "../errors";
import { page } from "../web/page";

/**
 * `empo web`: a viewer for a review in progress. Read-only, loopback-only, and derived entirely
 * from files `empo review` writes for its own reasons, so starting it changes nothing about a
 * review and stopping it loses nothing but the window.
 */

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
   * Four routes and nothing else, all GET. The state is read fresh per request rather than served
   * from the poll's copy, so a page that loads between two ticks is never a tick behind.
   */
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method !== "GET") return send(response, 405, "text/plain", "GET only");

    if (url.pathname === "/") return send(response, 200, "text/html; charset=utf-8", page());

    if (url.pathname === "/api/state") {
      const state = readReviewState(repoRoot, snapshot);
      snapshot = state;
      return send(response, 200, "application/json", JSON.stringify(state));
    }

    if (url.pathname === "/events") return stream(response, clients, snapshot);

    if (url.pathname === "/file") {
      const readRoot = readReviewState(repoRoot, snapshot).session?.readRoot ?? null;
      // No session means no file is in scope at all, which is a different answer from a path that
      // was in scope and refused: nothing here is being kept from the caller.
      if (readRoot === null) return send(response, 404, "text/plain", "No review is running");

      const content = fileWithin(readRoot, url.searchParams.get("path") ?? "");
      if (content === null) return send(response, 403, "text/plain", "Outside the read root");
      return send(response, 200, "text/plain; charset=utf-8", content);
    }

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

/** Resolves true once bound, false on EADDRINUSE; anything else is a real failure and throws. */
function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((done, fail) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (error.code === "EADDRINUSE") return done(false);
      fail(error);
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

/**
 * The one trust boundary in this command. The viewer serves source from a private machine, so a
 * path is resolved and then proven to be inside the read root; a request that climbs out is
 * refused rather than normalized into something servable.
 */
function fileWithin(readRoot: string, requested: string): string | null {
  if (requested === "" || isAbsolute(requested)) return null;
  const root = resolve(readRoot);
  const full = resolve(root, requested);
  const inside = relative(root, full);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
  try {
    // And again on the real paths: a symlink inside the root pointing out of it is an escape the
    // lexical check above cannot see. Both sides are resolved because the root itself is often
    // reached through a link (macOS /var), and comparing one form against the other refuses
    // everything.
    const real = realpathSync(full);
    const realInside = relative(realpathSync(root), real);
    if (realInside.startsWith("..") || isAbsolute(realInside)) return null;
    return statSync(real).isFile() ? readFileSync(real, "utf8") : null;
  } catch {
    return null;
  }
}
