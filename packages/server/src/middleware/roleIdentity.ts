/**
 * `roleIdentity` middleware — reads the trusted `X-Keni-Role` and
 * `X-Keni-Agent` headers, validates the role against the documented enum
 * (`spec.md` §3), and stores them under `c.var.role` and `c.var.agent`.
 *
 * Throws `MissingRoleError` for absent or unknown roles; the
 * `errorBoundary` translates that to `400 missing_role`. Agent is optional
 * (`null` when absent).
 *
 * Optional `fallback` callback (added for the `agents-api-and-websocket`
 * change): when the `X-Keni-Role` header is absent, the middleware
 * invokes `fallback(c)` to read the role from somewhere else — used by
 * the `/events` WS upgrade to honour a `?role=<role>` query parameter
 * (browsers cannot set arbitrary headers on `new WebSocket(...)`). The
 * fallback applies *only* when the header is absent; REST routes that
 * never pass a fallback continue to require the header verbatim.
 *
 * @module
 */

import type { Context, MiddlewareHandler } from "@hono/hono";
import { isRole } from "@keni/shared";
import { MissingRoleError } from "../errors.ts";
import type { ServerVariables } from "./types.ts";

/** Optional configuration for the `roleIdentity` middleware. */
export interface RoleIdentityOptions {
  /**
   * Secondary role source consulted only when `X-Keni-Role` is absent.
   * Returning `undefined` falls through to the documented
   * `MissingRoleError(undefined)` flow.
   */
  readonly fallback?: (c: Context<{ Variables: ServerVariables }>) => string | undefined;
  /**
   * Predicate consulted BEFORE the header / fallback lookup. When it
   * returns `true` for a request, the middleware short-circuits with
   * a no-op (no role assigned, no error thrown) and the downstream
   * handler runs without a role guard. The
   * `cli-start-and-end-to-end-wiring` change wires this so the static
   * SPA route group (`GET /`, `/assets/*`, and the deep-link
   * fallthrough) serves browsers that cannot set the `X-Keni-Role`
   * header.
   *
   * The carve-out applies ONLY when the predicate is supplied and
   * returns `true` for the specific request; every existing call site
   * leaves it undefined and the role guard runs verbatim.
   */
  readonly exempt?: (c: Context<{ Variables: ServerVariables }>) => boolean;
}

export function roleIdentity(
  opts: RoleIdentityOptions = {},
): MiddlewareHandler<{ Variables: ServerVariables }> {
  return async (c, next) => {
    if (opts.exempt !== undefined && opts.exempt(c)) {
      await next();
      return;
    }
    let raw = c.req.header("X-Keni-Role");
    if (raw === undefined && opts.fallback !== undefined) {
      raw = opts.fallback(c);
    }
    if (raw === undefined) throw new MissingRoleError(undefined);
    if (!isRole(raw)) throw new MissingRoleError(raw);
    c.set("role", raw);
    const agent = c.req.header("X-Keni-Agent");
    c.set("agent", agent ?? null);
    await next();
  };
}
