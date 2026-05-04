/**
 * Pin the resolved {@link MCP_ENTRY_PATH} to the source-layout file
 * `packages/server/src/mcp/main.ts`. The constant is consumed by
 * `keni start`'s production engineer-runner wiring (see
 * `engineer-runner-production-wiring/specs/cli-start/spec.md`).
 */

import { assert, assertEquals } from "@std/assert";
import { MCP_ENTRY_PATH } from "./mcpEntryPath.ts";

Deno.test("MCP_ENTRY_PATH ends with /mcp/main.ts", () => {
  assert(
    MCP_ENTRY_PATH.endsWith("/mcp/main.ts"),
    `expected MCP_ENTRY_PATH to end with '/mcp/main.ts'; got '${MCP_ENTRY_PATH}'`,
  );
});

Deno.test("MCP_ENTRY_PATH is an absolute filesystem path", () => {
  assert(
    MCP_ENTRY_PATH.startsWith("/"),
    `expected MCP_ENTRY_PATH to be absolute; got '${MCP_ENTRY_PATH}'`,
  );
});

Deno.test("MCP_ENTRY_PATH resolves to a regular file on disk", () => {
  const stat = Deno.statSync(MCP_ENTRY_PATH);
  assertEquals(stat.isFile, true, `expected '${MCP_ENTRY_PATH}' to be a regular file`);
});
