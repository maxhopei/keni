/**
 * Registers the engineer-only `merge_pr` MCP tool onto an `McpServer`.
 *
 * The handler is a thin transport adapter (`mcp-engineer-surface` spec
 * delta — "An eighth engineer MCP tool `merge_pr` is registered and
 * delegates to `POST /prs/:id/merge`"). Input validation lives in the
 * zod schema; identity stamping lives in the typed HTTP client; any
 * HTTP-shaped throw is funnelled through {@link mapHttpErrorToToolResult}
 * so the result carries the documented `[<code>] ...` prefix.
 *
 * The tool's description is a single literal string ≤ 240 chars (design
 * Decision 5 / spec scenario "every tool's `description` is a non-empty
 * string ... ≤ 240 characters") and is exported so the drift-detector
 * test in `createMcpServer_test.ts` can pin it.
 *
 * @module
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServerDeps } from "../createMcpServer.ts";
import { mapHttpErrorToToolResult, wrapToolSuccess } from "../errors.ts";
import { type MergePrInput, MergePrInputSchema } from "../wire/prs.ts";

/** Description for the `merge_pr` tool — pinned by the drift test. */
export const MERGE_PR_DESCRIPTION =
  "Fast-forward merges an approved PR's source branch onto `main` and returns the resulting merge commit SHA. Engineers only; non-fast-forward attempts return `merge_conflict` and require a rebase.";

/** Register the `merge_pr` MCP tool onto `server`. */
export function registerPrTools(server: McpServer, deps: McpServerDeps): void {
  server.registerTool(
    "merge_pr",
    {
      description: MERGE_PR_DESCRIPTION,
      inputSchema: MergePrInputSchema,
    },
    async (rawInput: unknown) => {
      const input = rawInput as MergePrInput;
      try {
        const data = await deps.httpClient.mergePr(input.pr_id);
        return wrapToolSuccess(data);
      } catch (err) {
        return mapHttpErrorToToolResult(err);
      }
    },
  );
}
