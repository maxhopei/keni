/**
 * Drives `createApiClient` against a `Deno.serve`-backed mock orchestration
 * server (port 0, abort-controlled). Each test stands up its own server so
 * cases stay isolated.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createApiClient, KeniApiError } from "./apiClient.ts";
import type { AgentListResponse, AgentResponse, ErrorResponse } from "@keni/shared";

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
