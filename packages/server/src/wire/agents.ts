/**
 * zod schemas for the orchestration server's `/agents` wire shapes.
 *
 * Mirrors the existing `tickets.ts` / `prs.ts` pattern: each schema is
 * annotated `z.ZodType<SharedType>` so a schema-shape change that drifts
 * from the shared TypeScript wire type is caught at `deno task check`
 * time (`design.md` Decision 5; the existing wire-test helpers add the
 * inverse `expectType<z.infer<…>>().toEqual<SharedType>()` lower-bound
 * assertion).
 *
 * @module
 */

import { z } from "zod";
import { AGENT_STATUSES, type AgentResponse } from "@keni/shared";

/** zod enum for agent statuses, derived from the shared {@link AGENT_STATUSES} tuple. */
export const AgentStatusSchema = z.enum(AGENT_STATUSES);

/**
 * Schema for one agent row exposed by `GET /agents` and the pause / resume
 * endpoints. The on-disk record (the `AgentRuntimeState` map kept by the
 * in-memory store) is identity-shaped today; the schema lives here so
 * future divergence between storage and wire is a one-line change.
 */
export const AgentResponseSchema: z.ZodType<AgentResponse> = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  status: AgentStatusSchema,
  last_activity: z.string().nullable(),
  last_active_at: z.string().nullable(),
  paused: z.boolean(),
}).strict();
