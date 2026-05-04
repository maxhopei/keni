/**
 * `GET /health` — process-supervision and smoke-test endpoint.
 *
 * The endpoint is the only documented exemption from the role-identity
 * middleware (see the `orchestration-server` capability spec). It MUST
 * be mounted BEFORE `roleIdentity` so a missing `X-Keni-Role` header
 * does not yield `400 missing_role` for an unauthenticated supervisor
 * probe.
 *
 * Response body is the documented success envelope:
 *
 * ```json
 * { "data": { "status": "ok", "project_id": "<uuid>", "uptime_ms": 123, "version": "..." }, "project_id": "<uuid>" }
 * ```
 *
 * The `uptime_ms` value is computed from the closure-captured
 * `serverStartedAt` thunk; when the thunk returns `undefined` (the
 * existing test call sites that did not opt in to wiring the field),
 * the value is `0`.
 *
 * The handler is read-only: it does NOT mutate the runtime-state store
 * and does NOT emit on the event bus.
 *
 * @module
 */

import { Hono } from "@hono/hono";
import type { HealthEnvelope, HealthResponse } from "@keni/shared";
import { VERSION } from "@keni/shared";
import type { ServerVariables } from "../middleware/types.ts";

/**
 * Build the `/health` sub-app. Pass `getServerStartedAt` as a thunk so
 * `runServer` can capture the timestamp AFTER `Deno.serve.onListen` fires
 * (the `createServer` factory runs synchronously before any port has been
 * bound, so a flat `Date` argument would always be earlier than the real
 * "server started" moment by the wall-clock cost of port binding).
 */
export function healthRoute(
  projectId: string,
  getServerStartedAt: () => Date | undefined,
): Hono<{ Variables: ServerVariables }> {
  const app = new Hono<{ Variables: ServerVariables }>();

  app.get("/", (c) => {
    const startedAt = getServerStartedAt();
    const uptimeMs = startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt.getTime());
    const data: HealthResponse = {
      status: "ok",
      project_id: projectId,
      uptime_ms: uptimeMs,
      version: VERSION,
    };
    const body: HealthEnvelope = { data, project_id: projectId };
    return c.json(body, 200);
  });

  return app;
}
