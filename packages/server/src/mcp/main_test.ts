/**
 * Smoke test for the `@keni/server/mcp` barrel.
 *
 * Asserts every named export resolves and is the right shape (callable
 * function or class). Type-check coverage gives the rest — this test is
 * here to catch a missing/misnamed re-export, not to exercise behaviour.
 */

import { assertEquals } from "@std/assert";
import {
  createMcpHttpClient,
  createMcpServer,
  DEFAULT_MCP_SERVER_OPTIONS,
  McpHttpError,
  parseRunMcpServerArgs,
  runMcpServer,
  UsageError,
} from "./main.ts";

Deno.test("@keni/server/mcp exports createMcpServer as a callable", () => {
  assertEquals(typeof createMcpServer, "function");
});

Deno.test("@keni/server/mcp exports runMcpServer as a callable", () => {
  assertEquals(typeof runMcpServer, "function");
});

Deno.test("@keni/server/mcp exports parseRunMcpServerArgs as a callable", () => {
  assertEquals(typeof parseRunMcpServerArgs, "function");
});

Deno.test("@keni/server/mcp exports createMcpHttpClient as a callable", () => {
  assertEquals(typeof createMcpHttpClient, "function");
});

Deno.test("@keni/server/mcp exports McpHttpError as a class", () => {
  assertEquals(typeof McpHttpError, "function");
  const err = new McpHttpError("internal_error", "x", undefined, 500);
  if (!(err instanceof Error)) {
    throw new Error("McpHttpError must extend Error");
  }
});

Deno.test("@keni/server/mcp exports UsageError as a class", () => {
  assertEquals(typeof UsageError, "function");
  const err = new UsageError("x");
  if (!(err instanceof Error)) {
    throw new Error("UsageError must extend Error");
  }
});

Deno.test("@keni/server/mcp exports DEFAULT_MCP_SERVER_OPTIONS as the documented defaults", () => {
  assertEquals(DEFAULT_MCP_SERVER_OPTIONS.serverName, "keni-engineer-mcp");
  assertEquals(DEFAULT_MCP_SERVER_OPTIONS.serverVersion, "0.1.0");
});
