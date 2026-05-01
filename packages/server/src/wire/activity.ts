/**
 * zod schemas + query-string helpers for the activity-log endpoints.
 *
 * `ActivityAppendRequestSchema` validates `POST /activity` bodies.
 * `parseActivityQuery` parses a `URLSearchParams` from `GET /activity?...`
 * into the `ActivityFilter` shape the storage layer expects (rejects
 * malformed timestamps via zod, leaves unknown query keys alone).
 *
 * @module
 */

import { z } from "zod";
import type { ActivityAppendRequest, ActivityFilter } from "@keni/shared";

export const ActivityAppendRequestSchema: z.ZodType<ActivityAppendRequest> = z.object({
  timestamp: z.string().datetime({ offset: true }).optional(),
  session_id: z.string().min(1),
  agent: z.string().min(1),
  role: z.string().min(1),
  event: z.string().min(1),
  summary: z.string().nullable().optional(),
  refs: z.record(z.string(), z.string()).optional(),
}).strict();

const ActivityQuerySchema = z.object({
  agent: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/**
 * Parse `URLSearchParams` from `GET /activity?…` into an `ActivityFilter`.
 *
 * Throws `ZodError` (caught and mapped to `400 validation_failed` by the
 * route handler) when a documented field is malformed — currently only
 * `from` / `to` are validated as ISO 8601. Unknown keys are ignored.
 */
export function parseActivityQuery(searchParams: URLSearchParams): ActivityFilter {
  const raw: Record<string, string> = {};
  for (const key of ["agent", "role", "from", "to"] as const) {
    const value = searchParams.get(key);
    if (value !== null) raw[key] = value;
  }
  return ActivityQuerySchema.parse(raw);
}
