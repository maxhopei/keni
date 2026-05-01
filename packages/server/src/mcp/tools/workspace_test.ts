/**
 * Tests for the `get_workspace_path` tool.
 *
 * The handler is the only one that does no I/O — it returns the
 * boot-time `deps.workspacePath` verbatim. The tests confirm:
 *
 * 1. The path is returned exactly as supplied (no canonicalisation).
 * 2. Multiple invocations return identical results (no recompute).
 * 3. No HTTP calls are made (would manifest as a fake-client method
 *    being invoked).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ActivityAppendRequest,
  ActivityEntryResponse,
  ActivityFilter,
  TicketResponse,
  TicketStatus,
  TicketSummaryResponse,
} from "@keni/shared";
import type { McpServerDeps } from "../createMcpServer.ts";
import type { McpHttpClient } from "../httpClient.ts";
import { registerWorkspaceTools } from "./workspace.ts";

interface RecordedCall {
  readonly method: string;
}

function makeFakeHttpClient(): { client: McpHttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const trip = <T>(method: string): Promise<T> => {
    calls.push({ method });
    return Promise.reject(new Error(`workspace tool should never call ${method}`));
  };
  const client: McpHttpClient = {
    listTickets: () => trip<readonly TicketSummaryResponse[]>("listTickets"),
    readTicket: (_id: string) => trip<TicketResponse>("readTicket"),
    updateTicketBody: (_id: string, _body: string) => trip<TicketResponse>("updateTicketBody"),
    transitionTicket: (_id: string, _from: TicketStatus, _to: TicketStatus) =>
      trip<TicketResponse>("transitionTicket"),
    appendActivity: (_input: ActivityAppendRequest) =>
      trip<ActivityEntryResponse>("appendActivity"),
    queryActivity: (_filter: ActivityFilter, _limit: number) =>
      trip<readonly ActivityEntryResponse[]>("queryActivity"),
  };
  return { client, calls };
}

function buildServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerWorkspaceTools(server, deps);
  return server;
}

interface RegisteredHandler {
  callback: (args: unknown, extra: unknown) => Promise<unknown> | unknown;
}

function getHandler(server: McpServer, toolName: string): RegisteredHandler {
  const registry = (server as unknown as {
    _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => unknown }>;
  })._registeredTools;
  const tool = registry[toolName];
  if (!tool) throw new Error(`tool ${toolName} should be registered`);
  return { callback: tool.handler };
}

const FAKE_EXTRA = { signal: new AbortController().signal };

Deno.test("get_workspace_path returns the boot-time path verbatim", async () => {
  const { client, calls } = makeFakeHttpClient();
  const wsPath = "/Users/alice/work/keni-ws";
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: wsPath });
  const handler = getHandler(server, "get_workspace_path");
  const result = (await handler.callback({}, FAKE_EXTRA)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  assertEquals(result.isError, undefined);
  assertStringIncludes(result.content[0]!.text, wsPath);
  const parsed = JSON.parse(result.content[0]!.text);
  assertEquals(parsed.path, wsPath);
  assertEquals(calls.length, 0);
});

Deno.test("get_workspace_path is invariant across multiple invocations", async () => {
  const { client, calls } = makeFakeHttpClient();
  const wsPath = "/abs/ws/path";
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: wsPath });
  const handler = getHandler(server, "get_workspace_path");
  const r1 = (await handler.callback({}, FAKE_EXTRA)) as { content: Array<{ text: string }> };
  const r2 = (await handler.callback({}, FAKE_EXTRA)) as { content: Array<{ text: string }> };
  const r3 = (await handler.callback({}, FAKE_EXTRA)) as { content: Array<{ text: string }> };
  assertEquals(r1.content[0]!.text, r2.content[0]!.text);
  assertEquals(r2.content[0]!.text, r3.content[0]!.text);
  assertEquals(calls.length, 0);
});

Deno.test("get_workspace_path returns the path without canonicalisation", async () => {
  const { client } = makeFakeHttpClient();
  const wsPath = "/abs/path/with/./dot/segments";
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: wsPath });
  const handler = getHandler(server, "get_workspace_path");
  const result = (await handler.callback({}, FAKE_EXTRA)) as {
    content: Array<{ text: string }>;
  };
  const parsed = JSON.parse(result.content[0]!.text);
  assertEquals(parsed.path, wsPath);
});
