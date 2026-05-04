/**
 * Static SPA route group — serves the SPA's production bundle from the
 * orchestration server.
 *
 * Three handlers:
 *
 *  - `GET /` → serves `<staticAssetsRoot>/index.html`.
 *  - `GET /assets/*` → serves files under `<staticAssetsRoot>/assets/`
 *    with the immutable cache header
 *    (`Cache-Control: public, max-age=31536000, immutable`). Path
 *    traversal is rejected (any resolved path that escapes
 *    `staticAssetsRoot` returns 404).
 *  - `GET *` (fallthrough) → serves `index.html` so
 *    `react-router-dom`'s `BrowserRouter` can re-mount a deep link
 *    after a refresh. Restricted to GET requests whose path is NOT in
 *    `REST_PREFIXES` (so a stray REST prefix never gets swallowed by
 *    the SPA).
 *
 * The validator (`validateStaticAssetsRoot`) is a synchronous probe
 * called by `createServer`; the throw becomes the `createServer`
 * exception.
 *
 * @module
 */

import type { Hono } from "@hono/hono";
import { extname, join, normalize, resolve } from "@std/path";
import type { ServerVariables } from "../middleware/types.ts";
import { isRestPrefixed } from "../restPrefixes.ts";

/**
 * Thrown by `validateStaticAssetsRoot` when the supplied path does not
 * exist or does not contain an `index.html`. Callers (`createServer` and
 * `keni start`) translate this into a fail-fast at boot time so the user
 * sees the misconfiguration before any request is served.
 */
export class StaticAssetsRootInvalid extends Error {
  override readonly name = "StaticAssetsRootInvalid";
  /** The path the caller supplied. */
  readonly path: string;
  /** Short reason code: `"not_a_directory" | "no_index_html" | "stat_failed"`. */
  readonly reason: string;

  constructor(path: string, reason: string, message: string) {
    super(message);
    this.path = path;
    this.reason = reason;
  }
}

/** Options for {@link mountStaticSpa}. */
export interface MountStaticSpaOptions {
  /** Absolute path to the SPA's production bundle (must contain `index.html`). */
  readonly staticAssetsRoot: string;
}

/**
 * Probe `staticAssetsRoot` synchronously. The `Deno.statSync` call here
 * is the one documented filesystem touch in the `createServer` factory;
 * it runs once at composition time, not per request.
 *
 * @throws {StaticAssetsRootInvalid} when the path is missing, not a
 *   directory, or does not contain `index.html`.
 */
export function validateStaticAssetsRoot(root: string): void {
  let stat: Deno.FileInfo;
  try {
    stat = Deno.statSync(root);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new StaticAssetsRootInvalid(
        root,
        "not_a_directory",
        `staticAssetsRoot does not exist: ${root}`,
      );
    }
    throw new StaticAssetsRootInvalid(
      root,
      "stat_failed",
      `Could not stat staticAssetsRoot: ${root} (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!stat.isDirectory) {
    throw new StaticAssetsRootInvalid(
      root,
      "not_a_directory",
      `staticAssetsRoot is not a directory: ${root}`,
    );
  }
  let indexStat: Deno.FileInfo;
  try {
    indexStat = Deno.statSync(join(root, "index.html"));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new StaticAssetsRootInvalid(
        root,
        "no_index_html",
        `staticAssetsRoot is missing index.html: ${join(root, "index.html")}` +
          ` (run \`deno task build\` to produce the SPA bundle)`,
      );
    }
    throw new StaticAssetsRootInvalid(
      root,
      "stat_failed",
      `Could not stat ${join(root, "index.html")}`,
    );
  }
  if (!indexStat.isFile) {
    throw new StaticAssetsRootInvalid(
      root,
      "no_index_html",
      `staticAssetsRoot's index.html is not a regular file: ${join(root, "index.html")}`,
    );
  }
}

/** Mount the static SPA route group on `app`. */
export function mountStaticSpa(
  app: Hono<{ Variables: ServerVariables }>,
  opts: MountStaticSpaOptions,
): void {
  const root = resolve(opts.staticAssetsRoot);
  const indexPath = join(root, "index.html");

  app.get("/", async (c) => {
    return await serveFile(c, indexPath, false);
  });

  app.get("/assets/*", async (c) => {
    // The Hono context exposes the matched URL path; we strip the
    // leading "/" and reconstruct an absolute path under root so the
    // path-traversal probe below is a single string-prefix check.
    const requested = decodeURIComponentSafe(c.req.path);
    if (requested === undefined) return c.notFound();
    // `requested` looks like "/assets/main-abc.js"; map it onto the
    // filesystem under `root`.
    const fsPath = resolve(join(root, requested));
    if (!isUnder(fsPath, root)) return c.notFound();
    return await serveFile(c, fsPath, true);
  });

  // SPA fallthrough — any GET that did not match a REST prefix and did
  // not hit a more specific route above falls through to `index.html`.
  // The `REST_PREFIXES` allowlist is the closed list every contributor
  // updates in lock-step with `createServer`.
  app.get("*", async (c) => {
    if (c.req.method !== "GET") return c.notFound();
    if (isRestPrefixed(c.req.path)) return c.notFound();
    return await serveFile(c, indexPath, false);
  });
}

function decodeURIComponentSafe(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * Return `true` when `candidate` resolves to a path under (or equal to)
 * `root`. Both paths are normalised first so `..` and `./` segments
 * cannot escape the root.
 */
function isUnder(candidate: string, root: string): boolean {
  const a = normalize(candidate);
  const b = normalize(root);
  if (a === b) return true;
  return a.startsWith(b + "/");
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

interface HonoContextLike {
  notFound(): Response | Promise<Response>;
  body(
    data: BodyInit | null,
    init?: { status?: number; headers?: Record<string, string> },
  ): Response;
}

async function serveFile(
  c: HonoContextLike,
  fsPath: string,
  immutable: boolean,
): Promise<Response> {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(fsPath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return await c.notFound();
    throw e;
  }
  const headers: Record<string, string> = {
    "Content-Type": contentTypeFor(fsPath),
  };
  if (immutable) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  }
  return c.body(bytes as unknown as BodyInit, {
    status: 200,
    headers,
  });
}
