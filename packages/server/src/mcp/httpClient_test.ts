/**
 * Tests for the MCP layer's typed HTTP client.
 *
 * Each test boots a `Deno.serve`-backed mock orchestration server on an
 * OS-assigned port (`port: 0`), exercises one method, and shuts the
 * server down. The mock records every inbound request so we can assert
 * URL composition + headers without depending on Hono's `createServer`.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { ActivityEntryResponse, TicketResponse, TicketSummaryResponse } from "@keni/shared";
import { McpHttpError } from "./errors.ts";
import { createMcpHttpClient } from "./httpClient.ts";

interface CapturedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | null;
}

interface MockHandle {
  readonly url: string;
  readonly captured: readonly CapturedRequest[];
  readonly stop: () => Promise<void>;
}

function startMock(
  respond: (req: CapturedRequest) => Response | Promise<Response>,
): MockHandle {
  const captured: CapturedRequest[] = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    const url = new URL(req.url);
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
    const captureEntry: CapturedRequest = {
      method: req.method,
      url,
      headers: new Headers(req.headers),
      body,
    };
    captured.push(captureEntry);
    return await respond(captureEntry);
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    captured,
    stop: () => server.shutdown(),
  };
}

const SAMPLE_SUMMARY: TicketSummaryResponse = {
  id: "ticket-0001",
  title: "First",
  status: "open",
  assignee: null,
  priority: 100,
  change_request: null,
  created_at: "2026-04-30T10:00:00Z",
  updated_at: "2026-04-30T10:00:00Z",
};

const SAMPLE_TICKET: TicketResponse = {
  ...SAMPLE_SUMMARY,
  body: "Body here",
};

const SAMPLE_ENTRY: ActivityEntryResponse = {
  id: "01900000-0000-7000-8000-000000000001",
  timestamp: "2026-04-30T10:00:00Z",
  session_id: "s1",
  agent: "alice",
  role: "engineer",
  event: "session_start",
  summary: null,
  refs: {},
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("listTickets composes /tickets and stamps role + agent headers", async () => {
  const mock = await startMock(() => jsonResponse({ data: [SAMPLE_SUMMARY], project_id: "p" }));
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    const result = await client.listTickets({});
    assertEquals(result, [SAMPLE_SUMMARY]);
    const first = mock.captured[0]!;
    assertEquals(first.method, "GET");
    assertEquals(first.url.pathname, "/tickets");
    assertEquals(first.headers.get("X-Keni-Role"), "engineer");
    assertEquals(first.headers.get("X-Keni-Agent"), "alice");
  } finally {
    await mock.stop();
  }
});

Deno.test("listTickets serialises a status array as a single comma-joined param", async () => {
  const mock = await startMock(() => jsonResponse({ data: [], project_id: "p" }));
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    await client.listTickets({ status: ["open", "in_progress"] });
    const first = mock.captured[0]!;
    assertEquals(first.url.search, "?status=open%2Cin_progress");
    assertEquals(first.url.searchParams.getAll("status"), ["open,in_progress"]);
  } finally {
    await mock.stop();
  }
});

Deno.test("listTickets serialises a single status string verbatim", async () => {
  const mock = await startMock(() => jsonResponse({ data: [], project_id: "p" }));
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    await client.listTickets({ status: "open" });
    assertEquals(mock.captured[0]!.url.search, "?status=open");
  } finally {
    await mock.stop();
  }
});

Deno.test("listTickets serialises every documented filter field", async () => {
  const mock = await startMock(() => jsonResponse({ data: [], project_id: "p" }));
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    await client.listTickets({
      status: "open",
      assignee: "bob",
      priorityMin: 0,
      priorityMax: 200,
      change_request: "cr-1",
    });
    const params = mock.captured[0]!.url.searchParams;
    assertEquals(params.get("status"), "open");
    assertEquals(params.get("assignee"), "bob");
    assertEquals(params.get("priorityMin"), "0");
    assertEquals(params.get("priorityMax"), "200");
    assertEquals(params.get("change_request"), "cr-1");
  } finally {
    await mock.stop();
  }
});

Deno.test("readTicket composes /tickets/<id>", async () => {
  const mock = await startMock(() => jsonResponse({ data: SAMPLE_TICKET, project_id: "p" }));
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    const ticket = await client.readTicket("ticket-0001");
    assertEquals(ticket.body, "Body here");
    assertEquals(mock.captured[0]!.url.pathname, "/tickets/ticket-0001");
    assertEquals(mock.captured[0]!.method, "GET");
  } finally {
    await mock.stop();
  }
});

Deno.test("updateTicketBody PATCHes /tickets/<id> with { body } and Content-Type JSON", async () => {
  const mock = await startMock(() =>
    jsonResponse({ data: { ...SAMPLE_TICKET, body: "new" }, project_id: "p" })
  );
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    const ticket = await client.updateTicketBody("ticket-0001", "new");
    assertEquals(ticket.body, "new");
    const first = mock.captured[0]!;
    assertEquals(first.method, "PATCH");
    assertEquals(first.url.pathname, "/tickets/ticket-0001");
    assertEquals(first.headers.get("Content-Type"), "application/json");
    assertEquals(JSON.parse(first.body!), { body: "new" });
  } finally {
    await mock.stop();
  }
});

Deno.test("transitionTicket POSTs /tickets/<id>/transition with { from, to }", async () => {
  const mock = await startMock(() =>
    jsonResponse({
      data: { ...SAMPLE_TICKET, status: "in_progress" },
      project_id: "p",
    })
  );
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    const ticket = await client.transitionTicket("ticket-0001", "open", "in_progress");
    assertEquals(ticket.status, "in_progress");
    const first = mock.captured[0]!;
    assertEquals(first.method, "POST");
    assertEquals(first.url.pathname, "/tickets/ticket-0001/transition");
    assertEquals(JSON.parse(first.body!), { from: "open", to: "in_progress" });
  } finally {
    await mock.stop();
  }
});

Deno.test("appendActivity stamps agent + role into the body and POSTs /activity", async () => {
  const mock = await startMock(() => jsonResponse({ data: SAMPLE_ENTRY, project_id: "p" }));
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    await client.appendActivity({
      session_id: "s1",
      agent: "this-is-ignored-but-required-by-shared-type",
      role: "this-is-ignored-but-required-by-shared-type",
      event: "session_start",
    });
    const first = mock.captured[0]!;
    assertEquals(first.method, "POST");
    assertEquals(first.url.pathname, "/activity");
    const sent = JSON.parse(first.body!) as Record<string, unknown>;
    assertEquals(sent.agent, "alice");
    assertEquals(sent.role, "engineer");
    assertEquals(sent.session_id, "s1");
  } finally {
    await mock.stop();
  }
});

Deno.test("queryActivity GETs /activity, forwards filters, and trims to limit", async () => {
  const entries: ActivityEntryResponse[] = Array.from({ length: 7 }, (_, i) => ({
    ...SAMPLE_ENTRY,
    id: `entry-${i}`,
  }));
  const mock = await startMock(() => jsonResponse({ data: entries, project_id: "p" }));
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    const result = await client.queryActivity(
      { agent: "alice", from: "2026-04-30T00:00:00Z" },
      3,
    );
    assertEquals(result.length, 3);
    assertEquals(result[0]!.id, "entry-0");
    const params = mock.captured[0]!.url.searchParams;
    assertEquals(params.get("agent"), "alice");
    assertEquals(params.get("from"), "2026-04-30T00:00:00Z");
  } finally {
    await mock.stop();
  }
});

Deno.test("a non-2xx response surfaces as McpHttpError with code/details/httpStatus", async () => {
  const mock = await startMock(() =>
    jsonResponse(
      {
        error: {
          code: "store_not_found",
          message: "ticket not found",
          details: { id: "ticket-9999" },
        },
        project_id: "p",
      },
      404,
    )
  );
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    const err = await assertRejects(
      () => client.readTicket("ticket-9999"),
      McpHttpError,
    );
    assertEquals(err.code, "store_not_found");
    assertEquals(err.httpStatus, 404);
    assertEquals(err.details, { id: "ticket-9999" });
  } finally {
    await mock.stop();
  }
});

Deno.test("a non-JSON error body falls back to internal_error with the response text", async () => {
  const mock = await startMock(() =>
    new Response("backend went pop", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    })
  );
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    const err = await assertRejects(
      () => client.readTicket("ticket-0001"),
      McpHttpError,
    );
    assertEquals(err.code, "internal_error");
    assertEquals(err.httpStatus, 502);
    assertStringIncludes(err.message, "backend went pop");
  } finally {
    await mock.stop();
  }
});

Deno.test("a network-level failure surfaces as McpHttpError(internal_error, url, ..., 0)", async () => {
  const mock = await startMock(() => jsonResponse({ data: [], project_id: "p" }));
  const url = mock.url;
  await mock.stop();
  const client = createMcpHttpClient({ serverUrl: url, agentId: "alice" });
  const err = await assertRejects(
    () => client.listTickets({}),
    McpHttpError,
  );
  assertEquals(err.code, "internal_error");
  assertEquals(err.httpStatus, 0);
  assertStringIncludes(err.message, "Network error talking to ");
  assertStringIncludes(err.message, url);
});

Deno.test("the agent id is stamped on every method's outbound request", async () => {
  const mock = await startMock((req) => {
    if (req.url.pathname === "/activity") {
      return jsonResponse({ data: SAMPLE_ENTRY, project_id: "p" });
    }
    return jsonResponse({ data: SAMPLE_TICKET, project_id: "p" });
  });
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "ada-lovelace" });
    await client.readTicket("ticket-0001");
    await client.updateTicketBody("ticket-0001", "x");
    await client.transitionTicket("ticket-0001", "open", "in_progress");
    await client.appendActivity({
      session_id: "s1",
      agent: "x",
      role: "x",
      event: "summary",
    });
    assert(mock.captured.length === 4);
    for (const req of mock.captured) {
      assertEquals(req.headers.get("X-Keni-Role"), "engineer");
      assertEquals(req.headers.get("X-Keni-Agent"), "ada-lovelace");
    }
  } finally {
    await mock.stop();
  }
});

Deno.test("read_ticket id is URL-encoded against path-traversal characters", async () => {
  const mock = await startMock(() => jsonResponse({ data: SAMPLE_TICKET, project_id: "p" }));
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    await client.readTicket("ticket-0001/../escape");
    const path = mock.captured[0]!.url.pathname;
    assertStringIncludes(path, "%2F");
  } finally {
    await mock.stop();
  }
});
