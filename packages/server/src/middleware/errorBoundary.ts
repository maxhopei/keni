/**
 * `errorBoundary` — Hono `onError` handler factory.
 *
 * Hono v4 only catches handler/middleware-thrown errors via `app.onError()`;
 * a `try/catch` around `await next()` inside a regular middleware does NOT
 * catch downstream throws (Hono's `compose()` swallows the error and stamps
 * it on `c.error`). The `onError` handler is the canonical, only-supported
 * place to translate exceptions into HTTP responses.
 *
 * The handler delegates to `mapErrorToResponse(err, projectId)`, sets
 * `c.var.error_code` so `requestLog` can surface it on its JSONL line, and
 * returns the documented `ErrorResponse` envelope.
 *
 * @module
 */

import type { ErrorHandler } from "@hono/hono";
import type { ContentfulStatusCode } from "@hono/hono/utils/http-status";
import { mapErrorToResponse } from "../errors.ts";
import type { ServerVariables } from "./types.ts";

/** Build the Hono `onError` handler for the orchestration server. */
export function errorBoundary(projectId: string): ErrorHandler<{ Variables: ServerVariables }> {
  return (err, c) => {
    const { status, body } = mapErrorToResponse(err, projectId);
    c.set("error_code", body.error.code);
    const response = c.json(body, status as ContentfulStatusCode);
    const requestId = c.var.request_id;
    if (requestId !== undefined && !response.headers.has("X-Keni-Request-Id")) {
      response.headers.set("X-Keni-Request-Id", requestId);
    }
    return response;
  };
}
