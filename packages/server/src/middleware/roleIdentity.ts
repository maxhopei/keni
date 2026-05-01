/**
 * `roleIdentity` middleware — reads the trusted `X-Keni-Role` and
 * `X-Keni-Agent` headers, validates the role against the documented enum
 * (`spec.md` §3), and stores them under `c.var.role` and `c.var.agent`.
 *
 * Throws `MissingRoleError` for absent or unknown roles; the
 * `errorBoundary` translates that to `400 missing_role`. Agent is optional
 * (`null` when absent).
 *
 * @module
 */

import type { MiddlewareHandler } from "@hono/hono";
import { isRole } from "@keni/shared";
import { MissingRoleError } from "../errors.ts";
import type { ServerVariables } from "./types.ts";

export function roleIdentity(): MiddlewareHandler<{ Variables: ServerVariables }> {
  return async (c, next) => {
    const raw = c.req.header("X-Keni-Role");
    if (raw === undefined) throw new MissingRoleError(undefined);
    if (!isRole(raw)) throw new MissingRoleError(raw);
    c.set("role", raw);
    const agent = c.req.header("X-Keni-Agent");
    c.set("agent", agent ?? null);
    await next();
  };
}
