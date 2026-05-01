/**
 * Tests for the two activity-log tools.
 *
 * Trust-seam coverage: `append_activity_entry`'s schema rejects `agent`
 * and `role` overrides at the SDK validation layer (see `wire/`
 * tests); here we additionally verify that the HTTP-client *call args*
 * carry the boot-time agent id and the hard-coded `engineer` role,
 * regardless of what the input contained.
 *
 * The default `limit` (200) is applied by the handler — the schema
 * leaves `limit` optional so its parsed type stays assignable to
 * `QueryActivityInput`. The test asserts the handler's call args
 * contain `limit: 200` even when the input omits it.
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
import { registerActivityTools } from "./activity.ts";

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function makeFakeHttpClient(): { client: McpHttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const sampleEntry: ActivityEntryResponse = {
    id: "01900000-0000-7000-8000-000000000001",
    timestamp: "2026-04-30T10:00:00Z",
    session_id: "s1",
    agent: "alice",
    role: "engineer",
    event: "session_start",
    summary: null,
    refs: {},
  };
  const client: McpHttpClient = {
    listTickets(): Promise<readonly TicketSummaryResponse[]> {
      return Promise.reject(new Error("not used"));
    },
    readTicket(): Promise<TicketResponse> {
      return Promise.reject(new Error("not used"));
    },
    updateTicketBody(): Promise<TicketResponse> {
      return Promise.reject(new Error("not used"));
    },
    transitionTicket(
      _id: string,
      _from: TicketStatus,
      to: TicketStatus,
    ): Promise<TicketResponse> {
      return Promise.reject(new Error(`not used (${to})`));
    },
    appendActivity(input: ActivityAppendRequest): Promise<ActivityEntryResponse> {
      calls.push({ method: "appendActivity", args: [input] });
      return Promise.resolve(sampleEntry);
    },
    queryActivity(
      filter: ActivityFilter,
      limit: number,
    ): Promise<readonly ActivityEntryResponse[]> {
      calls.push({ method: "queryActivity", args: [filter, limit] });
      return Promise.resolve([sampleEntry]);
    },
  };
  return { client, calls };
}

function buildServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerActivityTools(server, deps);
  return server;
}

interface RegisteredHandler {
  callback: (args: unknown, extra: unknown) => Promise<unknown>;
}

function getHandler(server: McpServer, toolName: string): RegisteredHandler {
  const registry = (server as unknown as {
    _registeredTools: Record<
      string,
      { handler: (args: unknown, extra: unknown) => Promise<unknown> }
    >;
  })._registeredTools;
  const tool = registry[toolName];
  if (!tool) throw new Error(`tool ${toolName} should be registered`);
  return { callback: tool.handler };
}

const FAKE_EXTRA = { signal: new AbortController().signal };

Deno.test("append_activity_entry stamps boot-time agent and engineer role on the HTTP-client call", async () => {
  const { client, calls } = makeFakeHttpClient();
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "append_activity_entry");
  await handler.callback(
    { session_id: "s1", event: "session_start", summary: "starting" },
    FAKE_EXTRA,
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "appendActivity");
  const arg = calls[0]!.args[0] as ActivityAppendRequest;
  assertEquals(arg.agent, "alice");
  assertEquals(arg.role, "engineer");
  assertEquals(arg.session_id, "s1");
  assertEquals(arg.event, "session_start");
  assertEquals(arg.summary, "starting");
});

Deno.test("append_activity_entry handler does NOT consult tool input for agent or role", async () => {
  const { client, calls } = makeFakeHttpClient();
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "append_activity_entry");
  /*
   * The schema would normally reject this; here we simulate "the SDK
   * already validated" by passing only the documented keys. The point
   * is to confirm the handler reads agent/role from boot-time deps,
   * not from the input (which never carries them). A future contributor
   * who adds `agent` or `role` to the input type would have to update
   * both this test and the schema-rejection tests in `wire/`.
   */
  await handler.callback({ session_id: "s1", event: "summary" }, FAKE_EXTRA);
  const arg = calls[0]!.args[0] as ActivityAppendRequest;
  assertEquals(arg.agent, "alice");
  assertEquals(arg.role, "engineer");
});

Deno.test("query_activity defaults limit to 200 when the input omits it", async () => {
  const { client, calls } = makeFakeHttpClient();
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "query_activity");
  await handler.callback({}, FAKE_EXTRA);
  assertEquals(calls[0]!.method, "queryActivity");
  assertEquals(calls[0]!.args[1], 200);
});

Deno.test("query_activity honours an explicit limit of 5", async () => {
  const { client, calls } = makeFakeHttpClient();
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "query_activity");
  await handler.callback({ limit: 5 }, FAKE_EXTRA);
  assertEquals(calls[0]!.args[1], 5);
});

Deno.test("query_activity forwards documented filters to the HTTP client", async () => {
  const { client, calls } = makeFakeHttpClient();
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "query_activity");
  await handler.callback(
    {
      agent: "alice",
      role: "engineer",
      from: "2026-04-30T00:00:00Z",
      to: "2026-04-30T23:59:59Z",
    },
    FAKE_EXTRA,
  );
  const filter = calls[0]!.args[0] as ActivityFilter;
  assertEquals(filter.agent, "alice");
  assertEquals(filter.role, "engineer");
  assertEquals(filter.from, "2026-04-30T00:00:00Z");
  assertEquals(filter.to, "2026-04-30T23:59:59Z");
});

Deno.test("query_activity returns the wrapped success result", async () => {
  const { client } = makeFakeHttpClient();
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "query_activity");
  const result = (await handler.callback({}, FAKE_EXTRA)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  assertEquals(result.isError, undefined);
  assertStringIncludes(result.content[0]!.text, "session_start");
});
