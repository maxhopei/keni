/**
 * MCP-internal zod schema for the `merge_pr` tool.
 *
 * The schema is `{ pr_id: string }` with `pr_id` constrained to the
 * documented PR id pattern (`/^pr-\d{4,}$/`). A malformed `pr_id` is
 * rejected at the schema layer — no HTTP request is issued, the MCP
 * SDK surfaces a `validation_failed`-shaped tool error.
 *
 * The response shape is `{ merge_commit_sha: string }`, lifted from
 * `@keni/shared`'s `MergePrResponse` so the SPA, the orchestration
 * server, and the MCP layer all reference a single source of truth.
 *
 * @module
 */

import { z } from "zod";

/** Input shape for the `merge_pr` MCP tool. */
export interface MergePrInput {
  readonly pr_id: string;
}

/** PR id pattern as documented across the spec / wire / MCP layers. */
export const PR_ID_PATTERN: RegExp = /^pr-\d{4,}$/;

/*
 * `satisfies z.ZodType<X>` keeps the schema's underlying `ZodObject<...>`
 * shape so the MCP SDK's `registerTool` generics can infer the handler
 * input type. `.strict()` rejects extra keys (the spec's "no sneaked-in
 * fields" rule).
 */
export const MergePrInputSchema = z.object({
  pr_id: z.string().regex(
    PR_ID_PATTERN,
    "pr_id must match the PR id pattern /^pr-\\d{4,}$/",
  ),
}).strict() satisfies z.ZodType<MergePrInput>;
