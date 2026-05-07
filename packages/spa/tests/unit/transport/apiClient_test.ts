/**
 * Drives `createApiClient` against a `Deno.serve`-backed mock orchestration
 * server (port 0, abort-controlled). Each test stands up its own server so
 * cases stay isolated.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createApiClient, KeniApiError } from "../../../src/transport/apiClient.ts";
import type {
  ActivityEntryResponse,
  ActivityEnvelope,
  AgentListResponse,
  AgentResponse,
  ErrorResponse,
  MergePrEnvelope,
  PREnvelope,
  PRResponse,
  TicketEnvelope,
  TicketResponse,
} from "@keni/shared";

interface MockBackend {
  readonly baseUrl: string;
  readonly requests: ReadonlyArray<{ method: string; url: URL; role: string | null }>;
  readonly close: () => Promise<void>;
}

interface RouteHandler {
  (request: Request, url: URL): Response | Promise<Response>;
}

interface MockServerOpts {
  readonly routes: Record<string, RouteHandler>;
}

function recordedHandler(opts: MockServerOpts) {
  const requests: { method: string; url: URL; role: string | null }[] = [];

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      url,
      role: request.headers.get("x-keni-role"),
    });
    const key = `${request.method} ${url.pathname}`;
    const route = opts.routes[key];
    if (route === undefined) {
      const body: ErrorResponse = {
        error: { code: "store_not_found", message: `no route for ${key}` },
      };
      return new Response(JSON.stringify(body), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return await route(request, url);
  };

  return { handler, requests };
}

async function startMockBackend(opts: MockServerOpts): Promise<MockBackend> {
  const { handler, requests } = recordedHandler(opts);
  const controller = new AbortController();
  const ready = Promise.withResolvers<{ port: number }>();
  const server = Deno.serve(
    {
      port: 0,
      signal: controller.signal,
      onListen: ({ port }) => ready.resolve({ port }),
    },
    handler,
  );
  const { port } = await ready.promise;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      controller.abort();
      await server.finished;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ALICE: AgentResponse = {
  id: "alice",
  role: "engineer",
  status: "idle",
  last_activity: null,
  last_active_at: null,
  paused: false,
};

const ALICE_PAUSED: AgentResponse = { ...ALICE, paused: true };

function firstRequest(backend: MockBackend) {
  const [first] = backend.requests;
  assert(first !== undefined, "expected at least one recorded request");
  return first;
}

Deno.test("listAgents returns the seeded envelope and parses the typed shape", async () => {
  const envelope: AgentListResponse = { data: [ALICE], project_id: "proj-1" };
  const backend = await startMockBackend({
    routes: {
      "GET /api/agents": () => jsonResponse(envelope),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const result = await client.listAgents();
    assertEquals(result.project_id, "proj-1");
    assertEquals(result.data.length, 1);
    const [first] = result.data;
    assert(first !== undefined);
    assertEquals(first.id, "alice");
    assertEquals(first.status, "idle");
  } finally {
    await backend.close();
  }
});

Deno.test("pauseAgent issues POST /agents/:id/pause with the role header", async () => {
  const backend = await startMockBackend({
    routes: {
      "POST /api/agents/alice/pause": () =>
        jsonResponse({ data: ALICE_PAUSED, project_id: "proj-1" }),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl, role: "user" });
    const result = await client.pauseAgent("alice");
    assertEquals(result.data.paused, true);
    assertEquals(backend.requests.length, 1);
    const recorded = firstRequest(backend);
    assertEquals(recorded.method, "POST");
    assertEquals(recorded.url.pathname, "/api/agents/alice/pause");
    assertEquals(recorded.role, "user");
  } finally {
    await backend.close();
  }
});

Deno.test("a 403 role_not_owner response rejects with KeniApiError carrying the code", async () => {
  const errorBody: ErrorResponse = {
    error: { code: "role_not_owner", message: "engineer required" },
    project_id: "proj-1",
  };
  const backend = await startMockBackend({
    routes: {
      "POST /api/agents/alice/pause": () => jsonResponse(errorBody, 403),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const error = await assertRejects(
      () => client.pauseAgent("alice"),
      KeniApiError,
    );
    assertEquals(error.status, 403);
    assertEquals(error.code, "role_not_owner");
    assertEquals(error.message, "engineer required");
  } finally {
    await backend.close();
  }
});

Deno.test("interruptAgent issues an empty-body POST /agents/:id/interrupt with the role header", async () => {
  const data: AgentResponse = {
    ...ALICE,
    last_activity: "session_interrupted",
    last_active_at: "2026-05-04T07:00:00.000Z",
  };
  const backend = await startMockBackend({
    routes: {
      "POST /api/agents/alice/interrupt": async (request) => {
        // The route MUST NOT advertise a JSON body when the SPA passes none.
        assertEquals(request.headers.get("content-type"), null);
        // Any body is the empty string (no Content-Length implies absence
        // for a fetch-built Request, but assert the read is empty either way).
        const body = await request.text();
        assertEquals(body, "");
        return jsonResponse({ data, project_id: "proj-1" });
      },
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl, role: "user" });
    const result = await client.interruptAgent("alice");
    assertEquals(result.data.id, "alice");
    assertEquals(result.data.last_activity, "session_interrupted");
    const recorded = firstRequest(backend);
    assertEquals(recorded.method, "POST");
    assertEquals(recorded.url.pathname, "/api/agents/alice/interrupt");
    assertEquals(recorded.role, "user");
  } finally {
    await backend.close();
  }
});

Deno.test("interruptAgent on a no-active-cycle 200 resolves with last_activity unchanged", async () => {
  // Idempotent no-op: server returns 200 with the pre-call snapshot.
  const idle: AgentResponse = { ...ALICE, last_activity: null };
  const backend = await startMockBackend({
    routes: {
      "POST /api/agents/alice/interrupt": () => jsonResponse({ data: idle, project_id: "proj-1" }),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const result = await client.interruptAgent("alice");
    assertEquals(result.data.last_activity, null);
    assertEquals(result.data.status, "idle");
  } finally {
    await backend.close();
  }
});

Deno.test("interruptAgent rejects with KeniApiError(store_not_found) on 404", async () => {
  const errorBody: ErrorResponse = {
    error: { code: "store_not_found", message: "ghost not found" },
    project_id: "proj-1",
  };
  const backend = await startMockBackend({
    routes: {
      "POST /api/agents/ghost/interrupt": () => jsonResponse(errorBody, 404),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const error = await assertRejects(
      () => client.interruptAgent("ghost"),
      KeniApiError,
    );
    assertEquals(error.status, 404);
    assertEquals(error.code, "store_not_found");
  } finally {
    await backend.close();
  }
});

Deno.test("interruptAgent rejects with KeniApiError(role_not_owner) on 403", async () => {
  const errorBody: ErrorResponse = {
    error: {
      code: "role_not_owner",
      message: "only the user role can interrupt",
      details: { role: "engineer", target: "interrupt_agent" },
    },
    project_id: "proj-1",
  };
  const backend = await startMockBackend({
    routes: {
      "POST /api/agents/alice/interrupt": () => jsonResponse(errorBody, 403),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl, role: "engineer" });
    const error = await assertRejects(
      () => client.interruptAgent("alice"),
      KeniApiError,
    );
    assertEquals(error.status, 403);
    assertEquals(error.code, "role_not_owner");
    assertEquals((error.details as { target: string } | undefined)?.target, "interrupt_agent");
  } finally {
    await backend.close();
  }
});

Deno.test("the role header defaults to X-Keni-Role: user", async () => {
  const backend = await startMockBackend({
    routes: {
      "GET /api/agents": () => jsonResponse({ data: [], project_id: "proj-1" }),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    await client.listAgents();
    assertEquals(firstRequest(backend).role, "user");
  } finally {
    await backend.close();
  }
});

Deno.test("getProjectId() caches the result across calls", async () => {
  const backend = await startMockBackend({
    routes: {
      "GET /api/agents": () => jsonResponse({ data: [], project_id: "proj-cached" }),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const first = await client.getProjectId();
    const second = await client.getProjectId();
    assertEquals(first, "proj-cached");
    assertEquals(second, "proj-cached");
    assertEquals(backend.requests.length, 1, "second getProjectId must not re-issue fetch");
  } finally {
    await backend.close();
  }
});

Deno.test("listTickets serialises a non-empty status filter as a query string", async () => {
  const backend = await startMockBackend({
    routes: {
      "GET /api/tickets": (_req, url) => {
        assertEquals(url.searchParams.get("status"), "open,in_progress");
        return jsonResponse({ data: [], project_id: "proj-1" });
      },
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    await client.listTickets({ status: ["open", "in_progress"] });
  } finally {
    await backend.close();
  }
});

Deno.test("listTickets omits the query string when no filter is provided", async () => {
  const backend = await startMockBackend({
    routes: {
      "GET /api/tickets": (_req, url) => {
        assertEquals(url.search, "");
        return jsonResponse({ data: [], project_id: "proj-1" });
      },
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    await client.listTickets();
    assertEquals(firstRequest(backend).url.search, "");
  } finally {
    await backend.close();
  }
});

// ---------------------------------------------------------------------------
// Tickets: getTicket / createTicket / patchTicket / transitionTicket
// ---------------------------------------------------------------------------

const TICKET_0001: TicketResponse = {
  id: "ticket-0001",
  title: "Add login page",
  status: "open",
  assignee: null,
  priority: 100,
  change_request: null,
  created_at: "2026-05-04T07:00:00.000Z",
  updated_at: "2026-05-04T07:00:00.000Z",
  body: "Users should be able to log in",
};

Deno.test("getTicket returns the typed envelope", async () => {
  const envelope: TicketEnvelope = { data: TICKET_0001, project_id: "proj-1" };
  const backend = await startMockBackend({
    routes: {
      "GET /api/tickets/ticket-0001": () => jsonResponse(envelope),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const result = await client.getTicket("ticket-0001");
    assertEquals(result.data.id, "ticket-0001");
    assertEquals(result.data.title, "Add login page");
  } finally {
    await backend.close();
  }
});

Deno.test("getTicket surfaces 404 as KeniApiError(store_not_found)", async () => {
  const errorBody: ErrorResponse = {
    error: { code: "store_not_found", message: "ticket-9999 not found" },
    project_id: "proj-1",
  };
  const backend = await startMockBackend({
    routes: {
      "GET /api/tickets/ticket-9999": () => jsonResponse(errorBody, 404),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const error = await assertRejects(
      () => client.getTicket("ticket-9999"),
      KeniApiError,
    );
    assertEquals(error.status, 404);
    assertEquals(error.code, "store_not_found");
  } finally {
    await backend.close();
  }
});

Deno.test("createTicket sends the typed body and returns the envelope", async () => {
  const envelope: TicketEnvelope = { data: TICKET_0001, project_id: "proj-1" };
  const backend = await startMockBackend({
    routes: {
      "POST /api/tickets": async (request) => {
        const body = await request.json();
        assertEquals(body.title, "Add login page");
        assertEquals(body.priority, 100);
        return jsonResponse(envelope, 201);
      },
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const result = await client.createTicket({ title: "Add login page", priority: 100 });
    assertEquals(result.data.id, "ticket-0001");
    assertEquals(firstRequest(backend).method, "POST");
  } finally {
    await backend.close();
  }
});

Deno.test("patchTicket surfaces validation_failed with field-level details", async () => {
  const errorBody: ErrorResponse = {
    error: { code: "validation_failed", message: "unknown field status" },
    project_id: "proj-1",
  };
  const backend = await startMockBackend({
    routes: {
      "PATCH /api/tickets/ticket-0001": () => jsonResponse(errorBody, 400),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const error = await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => client.patchTicket("ticket-0001", { status: "in_progress" } as any),
      KeniApiError,
    );
    assertEquals(error.status, 400);
    assertEquals(error.code, "validation_failed");
  } finally {
    await backend.close();
  }
});

Deno.test("transitionTicket sends {from,to} and surfaces status_graph_violation", async () => {
  const errorBody: ErrorResponse = {
    error: { code: "status_graph_violation", message: "open → tested not allowed" },
    project_id: "proj-1",
  };
  const backend = await startMockBackend({
    routes: {
      "POST /api/tickets/ticket-0001/transition": async (request) => {
        const body = await request.json();
        assertEquals(body.from, "open");
        assertEquals(body.to, "tested");
        return jsonResponse(errorBody, 403);
      },
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const error = await assertRejects(
      () => client.transitionTicket("ticket-0001", { from: "open", to: "tested" }),
      KeniApiError,
    );
    assertEquals(error.code, "status_graph_violation");
  } finally {
    await backend.close();
  }
});

Deno.test("transitionTicket happy path returns the updated ticket", async () => {
  const updated: TicketResponse = { ...TICKET_0001, status: "in_progress" };
  const envelope: TicketEnvelope = { data: updated, project_id: "proj-1" };
  const backend = await startMockBackend({
    routes: {
      "POST /api/tickets/ticket-0001/transition": () => jsonResponse(envelope),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const result = await client.transitionTicket("ticket-0001", {
      from: "open",
      to: "in_progress",
    });
    assertEquals(result.data.status, "in_progress");
  } finally {
    await backend.close();
  }
});

// ---------------------------------------------------------------------------
// PRs: getPr / patchPrIntent / transitionPr / mergePr / listPrs?ticket=
// ---------------------------------------------------------------------------

const PR_0001: PRResponse = {
  id: "pr-0001",
  title: "Login form",
  status: "approved",
  ticket: "ticket-0001",
  branch: "ticket-0001",
  author: "alice",
  created_at: "2026-05-04T07:00:00.000Z",
  updated_at: "2026-05-04T07:00:00.000Z",
  body: "Implements the login page",
};

Deno.test("getPr returns the typed envelope", async () => {
  const envelope: PREnvelope = { data: PR_0001, project_id: "proj-1" };
  const backend = await startMockBackend({
    routes: {
      "GET /api/prs/pr-0001": () => jsonResponse(envelope),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const result = await client.getPr("pr-0001");
    assertEquals(result.data.id, "pr-0001");
    assertEquals(result.data.status, "approved");
  } finally {
    await backend.close();
  }
});

Deno.test("patchPrIntent sends {intent} and returns the envelope", async () => {
  const updated: PRResponse = { ...PR_0001, body: "Updated intent" };
  const envelope: PREnvelope = { data: updated, project_id: "proj-1" };
  const backend = await startMockBackend({
    routes: {
      "PATCH /api/prs/pr-0001/intent": async (request) => {
        const body = await request.json();
        assertEquals(body.intent, "Updated intent");
        return jsonResponse(envelope);
      },
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const result = await client.patchPrIntent("pr-0001", { intent: "Updated intent" });
    assertEquals(result.data.body, "Updated intent");
  } finally {
    await backend.close();
  }
});

Deno.test("transitionPr sends {from,to} and returns the envelope", async () => {
  const updated: PRResponse = { ...PR_0001, status: "merged" };
  const envelope: PREnvelope = { data: updated, project_id: "proj-1" };
  const backend = await startMockBackend({
    routes: {
      "POST /api/prs/pr-0001/transition": async (request) => {
        const body = await request.json();
        assertEquals(body.from, "approved");
        assertEquals(body.to, "merged");
        return jsonResponse(envelope);
      },
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const result = await client.transitionPr("pr-0001", { from: "approved", to: "merged" });
    assertEquals(result.data.status, "merged");
  } finally {
    await backend.close();
  }
});

Deno.test("mergePr returns the merge envelope on success", async () => {
  const envelope: MergePrEnvelope = {
    data: { merge_commit_sha: "deadbeef1234" },
    project_id: "proj-1",
  };
  const backend = await startMockBackend({
    routes: {
      "POST /api/prs/pr-0001/merge": () => jsonResponse(envelope),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const result = await client.mergePr("pr-0001");
    assertEquals(result.data.merge_commit_sha, "deadbeef1234");
  } finally {
    await backend.close();
  }
});

Deno.test("mergePr surfaces 409 merge_conflict as KeniApiError", async () => {
  const errorBody: ErrorResponse = {
    error: {
      code: "merge_conflict",
      message: "non fast-forward",
      details: { reason: "non_fast_forward" },
    },
    project_id: "proj-1",
  };
  const backend = await startMockBackend({
    routes: {
      "POST /api/prs/pr-0001/merge": () => jsonResponse(errorBody, 409),
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const error = await assertRejects(
      () => client.mergePr("pr-0001"),
      KeniApiError,
    );
    assertEquals(error.status, 409);
    assertEquals(error.code, "merge_conflict");
    assertEquals(error.details?.reason, "non_fast_forward");
  } finally {
    await backend.close();
  }
});

Deno.test("listPrs serialises the ticket filter as ?ticket=<id>", async () => {
  const backend = await startMockBackend({
    routes: {
      "GET /api/prs": (_req, url) => {
        assertEquals(url.searchParams.get("ticket"), "ticket-0001");
        return jsonResponse({ data: [], project_id: "proj-1" });
      },
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    await client.listPrs({ ticket: "ticket-0001" });
  } finally {
    await backend.close();
  }
});

// ---------------------------------------------------------------------------
// Activity: appendActivity + role filter
// ---------------------------------------------------------------------------

const COMMENT_ENTRY: ActivityEntryResponse = {
  id: "01HW000000000000000000AAAA",
  timestamp: "2026-05-04T07:00:00.000Z",
  session_id: "ui",
  agent: "user",
  role: "user",
  event: "ticket_comment",
  summary: "Nice work",
  refs: { ticket: "ticket-0001" },
};

Deno.test("appendActivity sends the typed body including refs.ticket", async () => {
  const envelope: ActivityEnvelope = { data: COMMENT_ENTRY, project_id: "proj-1" };
  const backend = await startMockBackend({
    routes: {
      "POST /api/activity": async (request) => {
        const body = await request.json();
        assertEquals(body.event, "ticket_comment");
        assertEquals(body.refs.ticket, "ticket-0001");
        assertEquals(body.summary, "Nice work");
        return jsonResponse(envelope, 201);
      },
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    const result = await client.appendActivity({
      session_id: "ui",
      agent: "user",
      role: "user",
      event: "ticket_comment",
      summary: "Nice work",
      refs: { ticket: "ticket-0001" },
    });
    assertEquals(result.data.event, "ticket_comment");
    assertEquals(result.data.refs.ticket, "ticket-0001");
  } finally {
    await backend.close();
  }
});

Deno.test("listActivity serialises agent + role + date range as query params", async () => {
  const backend = await startMockBackend({
    routes: {
      "GET /api/activity": (_req, url) => {
        assertEquals(url.searchParams.get("agent"), "alice");
        assertEquals(url.searchParams.get("role"), "engineer");
        assertEquals(url.searchParams.get("from"), "2026-05-01T00:00:00.000Z");
        assertEquals(url.searchParams.get("to"), "2026-05-04T23:59:00.000Z");
        return jsonResponse({ data: [], project_id: "proj-1" });
      },
    },
  });
  try {
    const client = createApiClient({ baseUrl: backend.baseUrl });
    await client.listActivity({
      agent: "alice",
      role: "engineer",
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-05-04T23:59:00.000Z",
    });
  } finally {
    await backend.close();
  }
});
