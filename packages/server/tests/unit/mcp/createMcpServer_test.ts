/**
 * Tests for `createMcpServer` — the composition root.
 *
 * The most important assertion here is the description-stability test
 * (the drift detector — design.md Decision 11): each tool's
 * `description` field is matched verbatim against a hand-encoded copy
 * from `mcp-engineer-surface/spec.md`. A silent rewording of any tool
 * description fails CI.
 *
 * The "exactly eight tools" assertion is the second drift detector —
 * a missing or extra `registerTool` call fails the test.
 */

import { assertEquals, assertExists } from "@std/assert";
import type {
  ActivityAppendRequest,
  ActivityEntryResponse,
  ActivityFilter,
  MergePrResponse,
  TicketResponse,
  TicketStatus,
  TicketSummaryResponse,
} from "@keni/shared";
import type { McpHttpClient } from "../../../src/mcp/httpClient.ts";
import { createMcpServer, DEFAULT_MCP_SERVER_OPTIONS } from "../../../src/mcp/createMcpServer.ts";
import {
  LIST_TICKETS_DESCRIPTION,
  READ_TICKET_DESCRIPTION,
  TRANSITION_TICKET_STATUS_DESCRIPTION,
  UPDATE_TICKET_BODY_DESCRIPTION,
} from "../../../src/mcp/tools/tickets.ts";
import {
  APPEND_ACTIVITY_ENTRY_DESCRIPTION,
  QUERY_ACTIVITY_DESCRIPTION,
} from "../../../src/mcp/tools/activity.ts";
import { GET_WORKSPACE_PATH_DESCRIPTION } from "../../../src/mcp/tools/workspace.ts";
import { MERGE_PR_DESCRIPTION } from "../../../src/mcp/tools/prs.ts";

/**
 * Hand-encoded copy of every tool's description, lifted from
 * `openspec/changes/mcp-server-for-engineers/specs/mcp-engineer-surface/spec.md`.
 * If the spec changes, both the constants in `tools/*.ts` and the copy
 * below must be updated in lock-step. That double-write is the load-
 * bearing drift detector.
 */
const SPEC_DESCRIPTIONS: Record<string, string> = {
  list_tickets:
    "Lists tickets in the project, optionally filtered by status, assignee, priority range, or change-request id. Returns a summary view per ticket; use read_ticket for the full body.",
  read_ticket: "Reads a single ticket by id. Returns the full ticket including its markdown body.",
  update_ticket_body:
    "Updates the markdown body of a ticket. Cannot change status, title, assignee, priority, or change-request link; use transition_ticket_status to move statuses.",
  transition_ticket_status:
    "Transitions a ticket from `from` to `to`, where `to` must be in the engineer-owned subset of the status graph. The orchestration server enforces the §4.1 status graph and §4.2 owning-role rule.",
  append_activity_entry:
    "Appends one entry to the project's activity log under the calling agent's identity. The agent and role fields are stamped server-side and cannot be overridden.",
  query_activity:
    "Queries the activity log with optional filters and a per-call limit (default 200, hard ceiling 1000). Use a narrow from/to window to keep results focused.",
  get_workspace_path:
    "Returns the absolute filesystem path of this engineer's workspace clone. The path is read once at startup and is constant for the life of this MCP-server process.",
  merge_pr:
    "Fast-forward merges an approved PR's source branch onto `main` and returns the resulting merge commit SHA. Engineers only; non-fast-forward attempts return `merge_conflict` and require a rebase.",
};

function makeFakeHttpClient(): McpHttpClient {
  const sampleEntry: ActivityEntryResponse = {
    id: "e1",
    timestamp: "2026-04-30T10:00:00Z",
    session_id: "s1",
    agent: "alice",
    role: "engineer",
    event: "session_start",
    summary: null,
    refs: {},
  };
  const sampleTicket: TicketResponse = {
    id: "ticket-0001",
    title: "T",
    status: "open",
    assignee: null,
    priority: 100,
    change_request: null,
    body: "B",
    created_at: "2026-04-30T10:00:00Z",
    updated_at: "2026-04-30T10:00:00Z",
  };
  return {
    listTickets(): Promise<readonly TicketSummaryResponse[]> {
      return Promise.resolve([]);
    },
    readTicket(_id: string): Promise<TicketResponse> {
      return Promise.resolve(sampleTicket);
    },
    updateTicketBody(_id: string, body: string): Promise<TicketResponse> {
      return Promise.resolve({ ...sampleTicket, body });
    },
    transitionTicket(
      _id: string,
      _from: TicketStatus,
      to: TicketStatus,
    ): Promise<TicketResponse> {
      return Promise.resolve({ ...sampleTicket, status: to });
    },
    appendActivity(_input: ActivityAppendRequest): Promise<ActivityEntryResponse> {
      return Promise.resolve(sampleEntry);
    },
    queryActivity(
      _filter: ActivityFilter,
      _limit: number,
    ): Promise<readonly ActivityEntryResponse[]> {
      return Promise.resolve([sampleEntry]);
    },
    mergePr(_prId: string): Promise<MergePrResponse> {
      return Promise.resolve({
        merge_commit_sha: "0123456789abcdef0123456789abcdef01234567",
      });
    },
  };
}

interface RegisteredTool {
  description?: string;
  handler: (args: unknown, extra: unknown) => Promise<unknown> | unknown;
}

function getRegisteredTools(server: object): Record<string, RegisteredTool> {
  return (server as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

const FAKE_EXTRA = { signal: new AbortController().signal };

Deno.test("createMcpServer registers exactly eight tools, named per the spec", () => {
  const server = createMcpServer({
    httpClient: makeFakeHttpClient(),
    agentId: "alice",
    workspacePath: "/ws",
  });
  const registered = getRegisteredTools(server);
  const names = Object.keys(registered).sort();
  const expected = [
    "append_activity_entry",
    "get_workspace_path",
    "list_tickets",
    "merge_pr",
    "query_activity",
    "read_ticket",
    "transition_ticket_status",
    "update_ticket_body",
  ];
  assertEquals(names, expected);
  assertEquals(names.length, 8);
});

Deno.test("each tool's description matches the hand-encoded spec copy verbatim (drift detector)", () => {
  const server = createMcpServer({
    httpClient: makeFakeHttpClient(),
    agentId: "alice",
    workspacePath: "/ws",
  });
  const registered = getRegisteredTools(server);
  for (const [name, expected] of Object.entries(SPEC_DESCRIPTIONS)) {
    const tool = registered[name];
    assertExists(tool, `tool ${name} must be registered`);
    assertEquals(
      tool.description,
      expected,
      `tool ${name} description drifted from the spec`,
    );
  }
});

Deno.test("each tool's description is a non-empty string ≤ 240 characters", () => {
  const server = createMcpServer({
    httpClient: makeFakeHttpClient(),
    agentId: "alice",
    workspacePath: "/ws",
  });
  const registered = getRegisteredTools(server);
  for (const [name, tool] of Object.entries(registered)) {
    assertExists(tool.description, `tool ${name} must have a description`);
    if (tool.description!.length === 0 || tool.description!.length > 240) {
      throw new Error(
        `tool ${name}'s description has length ${tool.description!.length} (must be 1..240)`,
      );
    }
  }
});

Deno.test("description constants in source match the hand-encoded copies (drift inversion)", () => {
  /*
   * This is the inverse drift check: a future contributor who edits
   * the spec copy above without also editing the source constants (or
   * vice versa) trips this assertion. The two pin points must agree.
   */
  assertEquals(LIST_TICKETS_DESCRIPTION, SPEC_DESCRIPTIONS.list_tickets);
  assertEquals(READ_TICKET_DESCRIPTION, SPEC_DESCRIPTIONS.read_ticket);
  assertEquals(UPDATE_TICKET_BODY_DESCRIPTION, SPEC_DESCRIPTIONS.update_ticket_body);
  assertEquals(
    TRANSITION_TICKET_STATUS_DESCRIPTION,
    SPEC_DESCRIPTIONS.transition_ticket_status,
  );
  assertEquals(APPEND_ACTIVITY_ENTRY_DESCRIPTION, SPEC_DESCRIPTIONS.append_activity_entry);
  assertEquals(QUERY_ACTIVITY_DESCRIPTION, SPEC_DESCRIPTIONS.query_activity);
  assertEquals(GET_WORKSPACE_PATH_DESCRIPTION, SPEC_DESCRIPTIONS.get_workspace_path);
  assertEquals(MERGE_PR_DESCRIPTION, SPEC_DESCRIPTIONS.merge_pr);
});

Deno.test("createMcpServer is pure — construction performs no fetch / no Deno.stat", () => {
  /*
   * Sentinel approach: replace globalThis.fetch and Deno.stat with
   * trip-wires; if construction calls either, the test fails.
   */
  const originalFetch = globalThis.fetch;
  const originalStat = Deno.stat;
  let fetchCalled = 0;
  let statCalled = 0;
  globalThis.fetch = (() => {
    fetchCalled++;
    throw new Error("fetch should not be called during createMcpServer");
  }) as typeof fetch;
  Deno.stat = ((..._args: Parameters<typeof Deno.stat>) => {
    statCalled++;
    throw new Error("Deno.stat should not be called during createMcpServer");
  }) as typeof Deno.stat;
  try {
    createMcpServer({
      httpClient: makeFakeHttpClient(),
      agentId: "alice",
      workspacePath: "/ws",
    });
  } finally {
    globalThis.fetch = originalFetch;
    Deno.stat = originalStat;
  }
  assertEquals(fetchCalled, 0);
  assertEquals(statCalled, 0);
});

Deno.test("createMcpServer accepts custom server name + version", () => {
  const server = createMcpServer(
    { httpClient: makeFakeHttpClient(), agentId: "alice", workspacePath: "/ws" },
    { serverName: "my-mcp", serverVersion: "9.9.9" },
  );
  const meta = (server as unknown as { server: { _serverInfo: { name: string; version: string } } })
    .server._serverInfo;
  assertEquals(meta.name, "my-mcp");
  assertEquals(meta.version, "9.9.9");
});

Deno.test("DEFAULT_MCP_SERVER_OPTIONS is the documented default", () => {
  assertEquals(DEFAULT_MCP_SERVER_OPTIONS.serverName, "keni-engineer-mcp");
  assertEquals(DEFAULT_MCP_SERVER_OPTIONS.serverVersion, "0.1.0");
});

/* Per-tool happy-path smoke (Task 6.3) — invoke each registered handler. */
Deno.test("registered handlers — list_tickets returns a wrapped success result", async () => {
  const server = createMcpServer({
    httpClient: makeFakeHttpClient(),
    agentId: "alice",
    workspacePath: "/ws",
  });
  const handler = getRegisteredTools(server).list_tickets!.handler;
  const result = (await handler({ status: "open" }, FAKE_EXTRA)) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  assertEquals(result.isError, undefined);
  assertEquals(result.content[0]!.type, "text");
});

Deno.test("registered handlers — read_ticket returns a wrapped success result", async () => {
  const server = createMcpServer({
    httpClient: makeFakeHttpClient(),
    agentId: "alice",
    workspacePath: "/ws",
  });
  const handler = getRegisteredTools(server).read_ticket!.handler;
  const result = (await handler({ id: "ticket-0001" }, FAKE_EXTRA)) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  assertEquals(result.isError, undefined);
  assertEquals(result.content[0]!.type, "text");
});

Deno.test("registered handlers — update_ticket_body returns a wrapped success result", async () => {
  const server = createMcpServer({
    httpClient: makeFakeHttpClient(),
    agentId: "alice",
    workspacePath: "/ws",
  });
  const handler = getRegisteredTools(server).update_ticket_body!.handler;
  const result = (await handler({ id: "ticket-0001", body: "x" }, FAKE_EXTRA)) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  assertEquals(result.isError, undefined);
  assertEquals(result.content[0]!.type, "text");
});

Deno.test("registered handlers — transition_ticket_status returns a wrapped success result", async () => {
  const server = createMcpServer({
    httpClient: makeFakeHttpClient(),
    agentId: "alice",
    workspacePath: "/ws",
  });
  const handler = getRegisteredTools(server).transition_ticket_status!.handler;
  const result = (await handler(
    { id: "ticket-0001", from: "open", to: "in_progress" },
    FAKE_EXTRA,
  )) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  assertEquals(result.isError, undefined);
});

Deno.test("registered handlers — append_activity_entry returns a wrapped success result", async () => {
  const server = createMcpServer({
    httpClient: makeFakeHttpClient(),
    agentId: "alice",
    workspacePath: "/ws",
  });
  const handler = getRegisteredTools(server).append_activity_entry!.handler;
  const result = (await handler(
    { session_id: "s1", event: "summary" },
    FAKE_EXTRA,
  )) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  assertEquals(result.isError, undefined);
});

Deno.test("registered handlers — query_activity returns a wrapped success result", async () => {
  const server = createMcpServer({
    httpClient: makeFakeHttpClient(),
    agentId: "alice",
    workspacePath: "/ws",
  });
  const handler = getRegisteredTools(server).query_activity!.handler;
  const result = (await handler({}, FAKE_EXTRA)) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  assertEquals(result.isError, undefined);
});

Deno.test("registered handlers — get_workspace_path returns the boot-time path", async () => {
  const server = createMcpServer({
    httpClient: makeFakeHttpClient(),
    agentId: "alice",
    workspacePath: "/abs/ws",
  });
  const handler = getRegisteredTools(server).get_workspace_path!.handler;
  const result = (await handler({}, FAKE_EXTRA)) as {
    content: Array<{ type: string; text: string }>;
  };
  const parsed = JSON.parse(result.content[0]!.text);
  assertEquals(parsed.path, "/abs/ws");
});
