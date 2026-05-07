/**
 * Tests for the engineer-only `merge_pr` MCP tool *and* the matching
 * `httpClient.mergePr` HTTP-client method.
 *
 * Coverage matrix follows `tasks.md` 8.5:
 *  - schema rejects malformed `pr_id` (no HTTP request issued);
 *  - happy path: `httpClient.mergePr` returns the unwrapped SHA, and the
 *    MCP tool's success envelope carries the same SHA;
 *  - `merge_conflict` HTTP error → `isError: true` result starting with
 *    `[merge_conflict]` and including the documented `branch` / `base`
 *    detail substrings;
 *  - `role_not_owner` HTTP error → `isError: true` `[role_not_owner]`;
 *  - `store_not_found` HTTP error → `isError: true` `[store_not_found]`;
 *  - HTTP-client unit tests for success / 409 / 404 / network-error
 *    paths against a `Deno.serve`-backed mock orchestration server.
 *
 * Each test that needs an HTTP round-trip boots a `Deno.serve` mock on
 * `port: 0`, exercises the path, asserts on the captured request, and
 * shuts the mock down in `finally`.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { McpHttpClient } from "../../../src/mcp/httpClient.ts";
import { createMcpHttpClient } from "../../../src/mcp/httpClient.ts";
import { McpHttpError } from "../../../src/mcp/errors.ts";
import { createMcpServer } from "../../../src/mcp/createMcpServer.ts";

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
    const entry: CapturedRequest = {
      method: req.method,
      url,
      headers: new Headers(req.headers),
      body,
    };
    captured.push(entry);
    return await respond(entry);
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    captured,
    stop: () => server.shutdown(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getHandler(server: object, name: string): (
  args: unknown,
  extra: unknown,
) => Promise<unknown> {
  const tools = (server as { _registeredTools: Record<string, { handler: unknown }> })
    ._registeredTools;
  const t = tools[name];
  if (!t) throw new Error(`tool ${name} is not registered`);
  return t.handler as (args: unknown, extra: unknown) => Promise<unknown>;
}

const FAKE_EXTRA = { signal: new AbortController().signal };
const SAMPLE_SHA = "0123456789abcdef0123456789abcdef01234567";

// ----------------------------------------------------------------------
// httpClient.mergePr — wire-level tests
// ----------------------------------------------------------------------

Deno.test("httpClient.mergePr POSTs to /prs/<id>/merge with engineer headers and empty body", async () => {
  const mock = startMock((_req) =>
    jsonResponse({ data: { merge_commit_sha: SAMPLE_SHA }, project_id: "p1" })
  );
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    const result = await client.mergePr("pr-0001");
    assertEquals(result.merge_commit_sha, SAMPLE_SHA);
    assertEquals(mock.captured.length, 1);
    const req = mock.captured[0]!;
    assertEquals(req.method, "POST");
    assertEquals(req.url.pathname, "/prs/pr-0001/merge");
    assertEquals(req.headers.get("X-Keni-Role"), "engineer");
    assertEquals(req.headers.get("X-Keni-Agent"), "alice");
    assertEquals(req.body, "");
  } finally {
    await mock.stop();
  }
});

Deno.test("httpClient.mergePr surfaces a 409 merge_conflict envelope as McpHttpError", async () => {
  const mock = startMock((_req) =>
    jsonResponse(
      {
        error: {
          code: "merge_conflict",
          message: "Branch is not a fast-forward of main",
          details: { branch: "ticket-0001", base: "main", git_stderr: "fatal: ..." },
        },
        project_id: "p1",
      },
      409,
    )
  );
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    const err = await assertRejects(
      () => client.mergePr("pr-0001"),
      McpHttpError,
    );
    assertEquals(err.code, "merge_conflict");
    assertEquals(err.httpStatus, 409);
    assertEquals(
      (err.details as Record<string, unknown> | undefined)?.branch,
      "ticket-0001",
    );
  } finally {
    await mock.stop();
  }
});

Deno.test("httpClient.mergePr surfaces a 404 store_not_found envelope as McpHttpError", async () => {
  const mock = startMock((_req) =>
    jsonResponse(
      {
        error: {
          code: "store_not_found",
          message: "PR pr-9999 not found",
          details: { id: "pr-9999" },
        },
        project_id: "p1",
      },
      404,
    )
  );
  try {
    const client = createMcpHttpClient({ serverUrl: mock.url, agentId: "alice" });
    const err = await assertRejects(
      () => client.mergePr("pr-9999"),
      McpHttpError,
    );
    assertEquals(err.code, "store_not_found");
    assertEquals(err.httpStatus, 404);
  } finally {
    await mock.stop();
  }
});

Deno.test("httpClient.mergePr maps a network-level rejection to McpHttpError(internal_error, 0)", async () => {
  const client = createMcpHttpClient({
    serverUrl: "http://127.0.0.1:1",
    agentId: "alice",
  });
  const err = await assertRejects(
    () => client.mergePr("pr-0001"),
    McpHttpError,
  );
  assertEquals(err.code, "internal_error");
  assertEquals(err.httpStatus, 0);
  assertStringIncludes(err.message, "/prs/pr-0001/merge");
});

// ----------------------------------------------------------------------
// merge_pr MCP tool — handler-level tests
// ----------------------------------------------------------------------

function makeStubHttpClient(
  override: Partial<McpHttpClient>,
): McpHttpClient {
  const base: McpHttpClient = {
    listTickets: () => Promise.resolve([]),
    readTicket: () => Promise.reject(new Error("unused")),
    updateTicketBody: () => Promise.reject(new Error("unused")),
    transitionTicket: () => Promise.reject(new Error("unused")),
    appendActivity: () => Promise.reject(new Error("unused")),
    queryActivity: () => Promise.resolve([]),
    mergePr: () => Promise.reject(new Error("unused")),
  };
  return { ...base, ...override };
}

Deno.test("merge_pr MCP tool — success returns SHA wrapped in standard MCP envelope", async () => {
  let callCount = 0;
  let receivedId: string | null = null;
  const httpClient = makeStubHttpClient({
    mergePr(prId: string) {
      callCount += 1;
      receivedId = prId;
      return Promise.resolve({ merge_commit_sha: SAMPLE_SHA });
    },
  });
  const server = createMcpServer({ httpClient, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "merge_pr");

  const result = await handler({ pr_id: "pr-0001" }, FAKE_EXTRA) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };

  assertEquals(callCount, 1);
  assertEquals(receivedId, "pr-0001");
  assertEquals(result.isError, undefined);
  assertEquals(result.content[0]!.type, "text");
  const parsed = JSON.parse(result.content[0]!.text) as { merge_commit_sha: string };
  assertEquals(parsed.merge_commit_sha, SAMPLE_SHA);
});

Deno.test("merge_pr MCP tool — merge_conflict surfaces as isError with [merge_conflict] prefix", async () => {
  const httpClient = makeStubHttpClient({
    mergePr() {
      return Promise.reject(
        new McpHttpError(
          "merge_conflict",
          "Branch is not a fast-forward of main",
          { branch: "ticket-0001", base: "main" },
          409,
        ),
      );
    },
  });
  const server = createMcpServer({ httpClient, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "merge_pr");

  const result = await handler({ pr_id: "pr-0001" }, FAKE_EXTRA) as {
    isError: boolean;
    content: Array<{ type: string; text: string }>;
  };

  assertEquals(result.isError, true);
  const text = result.content[0]!.text;
  assert(text.startsWith("[merge_conflict]"), `expected [merge_conflict] prefix, got: ${text}`);
  assertStringIncludes(text, "branch");
  assertStringIncludes(text, "main");
});

Deno.test("merge_pr MCP tool — role_not_owner surfaces as isError with [role_not_owner] prefix", async () => {
  const httpClient = makeStubHttpClient({
    mergePr() {
      return Promise.reject(
        new McpHttpError(
          "role_not_owner",
          "Role 'qa' may not perform 'merge_pr'",
          { role: "qa", target: "merge_pr" },
          403,
        ),
      );
    },
  });
  const server = createMcpServer({ httpClient, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "merge_pr");

  const result = await handler({ pr_id: "pr-0001" }, FAKE_EXTRA) as {
    isError: boolean;
    content: Array<{ type: string; text: string }>;
  };

  assertEquals(result.isError, true);
  assert(result.content[0]!.text.startsWith("[role_not_owner]"));
});

Deno.test("merge_pr MCP tool — store_not_found surfaces as isError with [store_not_found] prefix", async () => {
  const httpClient = makeStubHttpClient({
    mergePr() {
      return Promise.reject(
        new McpHttpError(
          "store_not_found",
          "PR pr-9999 not found",
          { id: "pr-9999" },
          404,
        ),
      );
    },
  });
  const server = createMcpServer({ httpClient, agentId: "alice", workspacePath: "/ws" });
  const handler = getHandler(server, "merge_pr");

  const result = await handler({ pr_id: "pr-9999" }, FAKE_EXTRA) as {
    isError: boolean;
    content: Array<{ type: string; text: string }>;
  };

  assertEquals(result.isError, true);
  assert(result.content[0]!.text.startsWith("[store_not_found]"));
});

// ----------------------------------------------------------------------
// merge_pr — schema validation
// ----------------------------------------------------------------------
// Note: we round-trip MergePrInputSchema directly because the MCP SDK's
// handler signature already coerces the input, so an end-to-end "tool
// call with a bad pr_id" needs the SDK's request/response layer (covered
// by the SDK itself). We pin our schema's behaviour here to cover the
// `tasks.md` 8.5 schema-rejection requirement without relying on SDK
// internals.

Deno.test("MergePrInputSchema rejects a ticket-shaped id (no HTTP request)", async () => {
  const { MergePrInputSchema } = await import("../../../src/mcp/wire/prs.ts");
  const result = MergePrInputSchema.safeParse({ pr_id: "ticket-0001" });
  assertEquals(result.success, false);
});

Deno.test("MergePrInputSchema rejects an empty / undefined pr_id", async () => {
  const { MergePrInputSchema } = await import("../../../src/mcp/wire/prs.ts");
  assertEquals(MergePrInputSchema.safeParse({ pr_id: "" }).success, false);
  assertEquals(MergePrInputSchema.safeParse({}).success, false);
});

Deno.test("MergePrInputSchema rejects extra keys (.strict())", async () => {
  const { MergePrInputSchema } = await import("../../../src/mcp/wire/prs.ts");
  const result = MergePrInputSchema.safeParse({ pr_id: "pr-0001", extra: "no" });
  assertEquals(result.success, false);
});

Deno.test("MergePrInputSchema accepts a well-formed pr_id matching /^pr-\\d{4,}$/", async () => {
  const { MergePrInputSchema } = await import("../../../src/mcp/wire/prs.ts");
  for (const id of ["pr-0001", "pr-1234", "pr-99999"]) {
    const result = MergePrInputSchema.safeParse({ pr_id: id });
    assertEquals(result.success, true, `expected ${id} to be accepted`);
  }
});
