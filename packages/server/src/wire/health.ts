/**
 * zod schemas for the orchestration server's `/health` wire shapes.
 *
 * Mirrors the existing `agents.ts` / `tickets.ts` pattern: each schema is
 * annotated `z.ZodType<SharedType>` so a schema-shape change that drifts
 * from the shared TypeScript wire type is caught at `deno task check`
 * time.
 *
 * @module
 */

import { z } from "zod";
import type { HealthResponse } from "@keni/shared";

/**
 * Schema for the body inside the success envelope of `GET /health`.
 *
 * `status` is the literal `"ok"` (the endpoint is unconditionally 200);
 * `uptime_ms` is non-negative; `project_id` and `version` are non-empty
 * strings. The `.strict()` rejects unknown fields at the wire boundary.
 */
export const HealthResponseSchema: z.ZodType<HealthResponse> = z.object({
  status: z.literal("ok"),
  project_id: z.string().min(1),
  uptime_ms: z.number().int().min(0),
  version: z.string().min(1),
}).strict();
