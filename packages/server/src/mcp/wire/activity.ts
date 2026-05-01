/**
 * MCP-internal zod schemas for the two activity-log tools.
 *
 * `AppendActivityInputSchema` deliberately omits `agent` and `role` from
 * its input shape — both fields are stamped by the HTTP client from the
 * boot-time `--agent` flag (design.md Decision 5 / Decision 7). The
 * `.strict()` on the object schema is what catches a contributor who
 * accidentally wires an `agent` parameter into the tool surface.
 *
 * `event` is validated as a non-empty string, matching
 * `@keni/shared/storage/activity/interface.ts#ActivityEntryInput.event`'s
 * documented contract ("free-form event tag; the store does not validate
 * this; later steps may narrow the allowed set in their own layer"). A
 * future change can swap this for a closed enum without touching tool
 * handlers.
 *
 * `QueryActivityInputSchema` validates `limit` against a hard ceiling of
 * 1000 (spec scenario "rejects a `limit` above the hard ceiling"). The
 * 200 default is applied in the tool handler, not in the schema, so the
 * parsed type stays assignable to {@link QueryActivityInput} without
 * shifting `limit` from optional to required (the `z.ZodType<X>` upper
 * bound from design.md Decision 5 would otherwise reject the schema).
 *
 * @module
 */

import { z } from "zod";

/** Input shape for the `append_activity_entry` MCP tool. */
export interface AppendActivityInput {
  readonly session_id: string;
  readonly event: string;
  readonly summary?: string;
  readonly refs?: Readonly<Record<string, string>>;
}

/** Input shape for the `query_activity` MCP tool. */
export interface QueryActivityInput {
  readonly agent?: string;
  readonly role?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}

/**
 * Default `limit` applied by the tool handler when input omits it. Kept as
 * a named constant so the drift-detector tests (tasks.md 11.x) can pin it.
 */
export const QUERY_ACTIVITY_DEFAULT_LIMIT = 200;

/** Hard ceiling re-asserted by both the schema and the HTTP-client trim. */
export const QUERY_ACTIVITY_MAX_LIMIT = 1000;

/*
 * `satisfies z.ZodType<X>` (rather than an explicit annotation) keeps the
 * schemas' underlying `ZodObject<...>` shape so the MCP SDK's
 * `registerTool` generics can infer the handler's parsed-input type.
 * See `wire/tickets.ts` for the longer rationale.
 */

export const AppendActivityInputSchema = z.object({
  session_id: z.string().min(1),
  event: z.string().min(1),
  summary: z.string().max(500).optional(),
  refs: z.record(z.string(), z.string()).optional(),
}).strict() satisfies z.ZodType<AppendActivityInput>;

export const QueryActivityInputSchema = z.object({
  agent: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(QUERY_ACTIVITY_MAX_LIMIT).optional(),
}).strict() satisfies z.ZodType<QueryActivityInput>;
