/**
 * MCP-internal zod schema for the `get_workspace_path` tool.
 *
 * The schema is `z.object({}).strict()` — no input parameters; any
 * non-empty input is rejected at the schema layer. The tool returns the
 * boot-time `--workspace` value verbatim, so the response shape is fixed
 * (design.md Decision 13 — the response interface is server-internal, not
 * promoted to `@keni/shared`).
 *
 * @module
 */

import { z } from "zod";

/** Input shape for the `get_workspace_path` MCP tool — empty object. */
export type GetWorkspacePathInput = Record<never, never>;

/** Response payload for the `get_workspace_path` MCP tool. */
export interface WorkspacePathResponse {
  readonly path: string;
}

/*
 * `satisfies z.ZodType<X>` (rather than an explicit annotation) keeps the
 * schema's underlying `ZodObject<...>` shape so the MCP SDK's
 * `registerTool` generics can infer the (empty) handler input type.
 */
export const GetWorkspacePathInputSchema = z.object({}).strict() satisfies z.ZodType<
  GetWorkspacePathInput
>;
