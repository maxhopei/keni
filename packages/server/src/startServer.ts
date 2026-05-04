/**
 * `startServer` — bind the composed Hono app to a TCP port via `Deno.serve`.
 *
 * Thin wrapper around `createServer` + `Deno.serve` that resolves the bound
 * port (when `port: 0` is passed for OS-assigned), constructs the URL, and
 * returns an `abort()` handle so callers (tests and `runServer`) can shut
 * the listener down deterministically.
 *
 * Deliberately does not catch signals or print to stdout — `runServer` owns
 * those concerns. This keeps `startServer` reusable from tests that want to
 * spin up a real port without touching process globals.
 *
 * @module
 */

import { createServer, type ServerDeps, type ServerOptions } from "./createServer.ts";

/** Per-process startup options for `startServer`. */
export interface StartServerOptions extends ServerOptions {
  /** TCP port. `0` requests an OS-assigned port. Defaults to `0`. */
  readonly port?: number;
  /** Hostname / IP to bind. Defaults to `127.0.0.1` (local-only). */
  readonly host?: string;
}

/** Handle returned by `startServer`. */
export interface StartedServer {
  /** Resolved port the listener bound to (positive, even when input was 0). */
  readonly port: number;
  /** `http://<host>:<port>` URL. */
  readonly url: string;
  /**
   * Signal the underlying `Deno.serve` to stop. Resolves once the listener
   * has stopped accepting connections (the `Deno.HttpServer.shutdown()`
   * promise + the abort signal are both honoured).
   */
  readonly abort: () => Promise<void>;
}

/**
 * Bind the composed Hono app and return a handle. The default host is
 * `127.0.0.1`; do not change this — the trust model assumes loopback.
 *
 * `deps.serverStartedAt` is captured by the caller (`runServer`) AFTER
 * `Deno.serve.onListen` fires; this function does NOT mutate the field.
 * The wall-clock cost of port binding is small but non-zero, so callers
 * that need an accurate `uptime_ms` for `/health` should pass a thunk
 * indirection (the `createServer` factory does this via a closure).
 */
export function startServer(
  deps: ServerDeps,
  opts: StartServerOptions,
): Promise<StartedServer> {
  const app = createServer(deps, { projectId: opts.projectId });
  const ctrl = new AbortController();
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 0;

  return new Promise<StartedServer>((resolve, reject) => {
    let resolved = false;
    try {
      const server = Deno.serve({
        hostname: host,
        port: requestedPort,
        signal: ctrl.signal,
        onListen: ({ port }) => {
          resolved = true;
          resolve({
            port,
            url: `http://${host}:${port}`,
            abort: async () => {
              ctrl.abort();
              await server.finished;
            },
          });
        },
      }, app.fetch);
      void server.finished.catch(() => {/* swallowed — abort is the normal exit */});
    } catch (err) {
      if (!resolved) reject(err);
    }
  });
}
