/**
 * `requestId` middleware — assigns or honours a per-request UUIDv4 in the
 * `X-Keni-Request-Id` header and stores it under `c.var.request_id` for
 * downstream middleware (`requestLog`, `errorBoundary`) and route handlers.
 *
 * Per the spec, the middleware MUST be the first link in the chain so the id
 * is available even when later middleware throws.
 *
 * @module
 */

import type { MiddlewareHandler } from "@hono/hono";
import type { ServerVariables } from "./types.ts";

const UUIDV4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * If the request carries an `X-Keni-Request-Id` header, use it verbatim;
 * otherwise generate a fresh UUIDv4. Echoes the id on the response.
 */
export function requestId(): MiddlewareHandler<{ Variables: ServerVariables }> {
  return async (c, next) => {
    const supplied = c.req.header("X-Keni-Request-Id");
    const id = supplied ?? crypto.randomUUID();
    c.set("request_id", id);
    c.header("X-Keni-Request-Id", id);
    await next();
  };
}

/** Exposed for tests; the regex matches what `crypto.randomUUID()` produces. */
export const REQUEST_ID_UUIDV4_REGEX = UUIDV4_REGEX;
