/**
 * Tests for the four ticket tools, against a fake `McpHttpClient` that
 * records every call. The tests exercise the handlers in two ways:
 *
 * 1. Directly: the handler is built by registering on a real
 *    `McpServer` and then queried via the SDK's internal registry. This
 *    is the "happy-path" delegation check.
 * 2. Through the server's full callTool plumbing: spec scenarios about
 *    `isError: true` for an `McpHttpError` thrown by the client are
 *    validated end-to-end by funnelling through the SDK's call path.
 *
 * Schema-level rejections (e.g. extra `status` on `update_ticket_body`)
 * surface as JSON-RPC `InvalidParams` errors at the MCP protocol layer
 * (the SDK's `validateToolInput` throws `McpError`); the `tool list`
 * scenarios in `createMcpServer_test.ts` cover those paths against a
 * real client. Here we cover the handler logic in isolation.
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
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
import { McpHttpError } from "../errors.ts";
import type { ListTicketsInput } from "../wire/tickets.ts";
import { registerTicketTools } from "./tickets.ts";

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function makeFakeHttpClient(canned?: {
  list?: readonly TicketSummaryResponse[];
  read?: TicketResponse;
  updated?: TicketResponse;
  transitioned?: TicketResponse;
  throwOn?: string;
  throwAs?: McpHttpError;
}): { client: McpHttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const ticket: TicketResponse = canned?.read ?? {
    id: "ticket-0001",
    title: "T",
    status: "open",
    assignee: null,
    priority: 100,
    change_request: null,
    body: "Body",
    created_at: "2026-04-30T10:00:00Z",
    updated_at: "2026-04-30T10:00:00Z",
  };
  const client: McpHttpClient = {
    listTickets(filter: ListTicketsInput): Promise<readonly TicketSummaryResponse[]> {
      calls.push({ method: "listTickets", args: [filter] });
      if (canned?.throwOn === "listTickets" && canned.throwAs) {
        return Promise.reject(canned.throwAs);
      }
      return Promise.resolve(canned?.list ?? []);
    },
    readTicket(id: string): Promise<TicketResponse> {
      calls.push({ method: "readTicket", args: [id] });
      if (canned?.throwOn === "readTicket" && canned.throwAs) return Promise.reject(canned.throwAs);
      return Promise.resolve(ticket);
    },
    updateTicketBody(id: string, body: string): Promise<TicketResponse> {
      calls.push({ method: "updateTicketBody", args: [id, body] });
      if (canned?.throwOn === "updateTicketBody" && canned.throwAs) {
        return Promise.reject(canned.throwAs);
      }
      return Promise.resolve(canned?.updated ?? { ...ticket, body });
    },
    transitionTicket(id: string, from: TicketStatus, to: TicketStatus): Promise<TicketResponse> {
      calls.push({ method: "transitionTicket", args: [id, from, to] });
      if (canned?.throwOn === "transitionTicket" && canned.throwAs) {
        return Promise.reject(canned.throwAs);
      }
      return Promise.resolve(canned?.transitioned ?? { ...ticket, status: to });
    },
    appendActivity(input: ActivityAppendRequest): Promise<ActivityEntryResponse> {
      calls.push({ method: "appendActivity", args: [input] });
      return Promise.reject(new Error("not used here"));
    },
    queryActivity(
      filter: ActivityFilter,
      limit: number,
    ): Promise<readonly ActivityEntryResponse[]> {
      calls.push({ method: "queryActivity", args: [filter, limit] });
      return Promise.reject(new Error("not used here"));
    },
  };
  return { client, calls };
}

function buildServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTicketTools(server, deps);
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
  assertExists(tool, `tool ${toolName} should be registered`);
  return { callback: tool.handler };
}

const FAKE_EXTRA = { signal: new AbortController().signal };

Deno.test("list_tickets handler delegates to httpClient.listTickets with the validated filter", async () => {
  const { client, calls } = makeFakeHttpClient({ list: [] });
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "list_tickets");
  const result = (await handler.callback(
    { status: "open" },
    FAKE_EXTRA,
  )) as { content: Array<{ text: string }>; isError?: boolean };
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "listTickets");
  assertEquals(calls[0]!.args[0], { status: "open" });
  assertEquals(result.isError, undefined);
});

Deno.test("read_ticket handler passes the id through to httpClient.readTicket", async () => {
  const { client, calls } = makeFakeHttpClient();
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "read_ticket");
  const result = (await handler.callback(
    { id: "ticket-0001" },
    FAKE_EXTRA,
  )) as { content: Array<{ text: string }>; isError?: boolean };
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "readTicket");
  assertEquals(calls[0]!.args[0], "ticket-0001");
  assertStringIncludes(result.content[0]!.text, "ticket-0001");
});

Deno.test("update_ticket_body handler passes id + body through to httpClient.updateTicketBody", async () => {
  const { client, calls } = makeFakeHttpClient();
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "update_ticket_body");
  await handler.callback({ id: "ticket-0001", body: "new body" }, FAKE_EXTRA);
  assertEquals(calls[0]!.method, "updateTicketBody");
  assertEquals(calls[0]!.args, ["ticket-0001", "new body"]);
});

Deno.test("transition_ticket_status handler passes id + from + to through", async () => {
  const { client, calls } = makeFakeHttpClient();
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "transition_ticket_status");
  await handler.callback(
    { id: "ticket-0001", from: "open", to: "in_progress" },
    FAKE_EXTRA,
  );
  assertEquals(calls[0]!.method, "transitionTicket");
  assertEquals(calls[0]!.args, ["ticket-0001", "open", "in_progress"]);
});

Deno.test("a thrown McpHttpError funnels through to isError: true with the documented prefix", async () => {
  const err = new McpHttpError("store_not_found", "no such ticket", { id: "ticket-9999" }, 404);
  const { client } = makeFakeHttpClient({ throwOn: "readTicket", throwAs: err });
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "read_ticket");
  const result = (await handler.callback(
    { id: "ticket-9999" },
    FAKE_EXTRA,
  )) as { content: Array<{ text: string }>; isError?: boolean };
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0]!.text, "[store_not_found]");
});

Deno.test("a thrown role_not_owner funnels through to isError: true with [role_not_owner]", async () => {
  const err = new McpHttpError(
    "role_not_owner",
    "engineer cannot transition to done",
    { role: "engineer", target: "done" },
    403,
  );
  const { client } = makeFakeHttpClient({ throwOn: "transitionTicket", throwAs: err });
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "transition_ticket_status");
  const result = (await handler.callback(
    { id: "ticket-0001", from: "tested", to: "done" },
    FAKE_EXTRA,
  )) as { content: Array<{ text: string }>; isError?: boolean };
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0]!.text, "[role_not_owner]");
});

Deno.test("a network error funnels through to isError: true with [internal_error]", async () => {
  const err = new McpHttpError(
    "internal_error",
    "Network error talking to http://x:1: ECONNREFUSED",
    undefined,
    0,
  );
  const { client } = makeFakeHttpClient({ throwOn: "listTickets", throwAs: err });
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "list_tickets");
  const result = (await handler.callback({}, FAKE_EXTRA)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0]!.text, "[internal_error]");
});

Deno.test("the four ticket tools are registered (sanity)", () => {
  const { client } = makeFakeHttpClient();
  const server = buildServer({ httpClient: client, agentId: "alice", workspacePath: "/ws" });
  for (
    const name of ["list_tickets", "read_ticket", "update_ticket_body", "transition_ticket_status"]
  ) {
    getHandler(server, name);
  }
});
