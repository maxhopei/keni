import { assert, assertEquals, assertGreaterOrEqual, assertRejects } from "@std/assert";
import type { AgentId } from "@keni/shared";
import { createActivityLogClient, SUMMARY_HARD_CAP_BYTES, truncateLine } from "./activityClient.ts";
import { RoleRuntimeHttpError } from "./types.ts";

interface MockServer {
  readonly url: string;
  readonly requests: () => readonly CapturedRequest[];
  readonly setResponse: (response: MockResponse) => void;
  readonly close: () => Promise<void>;
}

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type MockResponse =
  | { readonly kind: "success"; readonly status: number; readonly body: unknown }
  | {
    readonly kind: "error";
    readonly status: number;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly errorDetails?: Record<string, unknown>;
  }
  | { readonly kind: "non_json_error"; readonly status: number; readonly text: string };

async function startMockServer(): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  let response: MockResponse = {
    kind: "success",
    status: 201,
    body: { data: {}, project_id: "test" },
  };
  const ctrl = new AbortController();
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of req.headers.entries()) headers[k.toLowerCase()] = v;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    requests.push({ method: req.method, path: url.pathname, headers, body });
    if (response.kind === "success") {
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (response.kind === "non_json_error") {
      return new Response(response.text, {
        status: response.status,
        headers: { "content-type": "text/plain" },
      });
    }
    const errBody = response.errorDetails === undefined
      ? {
        error: { code: response.errorCode, message: response.errorMessage },
        project_id: "test",
      }
      : {
        error: {
          code: response.errorCode,
          message: response.errorMessage,
          details: response.errorDetails,
        },
        project_id: "test",
      };
    return new Response(JSON.stringify(errBody), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };

  let resolvedUrl: string;
  const ready = new Promise<string>((resolveFn) => {
    Deno.serve({
      port: 0,
      hostname: "127.0.0.1",
      signal: ctrl.signal,
      onListen: ({ port, hostname }) => {
        resolvedUrl = `http://${hostname}:${port}`;
        resolveFn(resolvedUrl);
      },
    }, handler);
  });
  resolvedUrl = await ready;

  return {
    url: resolvedUrl,
    requests: () => requests.slice(),
    setResponse: (next) => {
      response = next;
    },
    close: async () => {
      ctrl.abort();
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}

const ROLE = "engineer" as const;
const AGENT_ID = "alice" as AgentId;
const SESSION_ID = "00000000-0000-7000-8000-000000000000";

Deno.test("activityClient — appendSessionStart composes URL/headers/body", async () => {
  const server = await startMockServer();
  try {
    const client = createActivityLogClient({
      serverUrl: server.url,
      agentId: AGENT_ID,
      role: ROLE,
    });
    await client.appendSessionStart({ sessionId: SESSION_ID, summary: "summary text" });
    const reqs = server.requests();
    assertEquals(reqs.length, 1);
    assertEquals(reqs[0]!.method, "POST");
    assertEquals(reqs[0]!.path, "/activity");
    assertEquals(reqs[0]!.headers["content-type"], "application/json");
    assertEquals(reqs[0]!.headers["x-keni-role"], "engineer");
    assertEquals(reqs[0]!.headers["x-keni-agent"], "alice");
    const body = reqs[0]!.body as Record<string, unknown>;
    assertEquals(body.event, "session_start");
    assertEquals(body.session_id, SESSION_ID);
    assertEquals(body.summary, "summary text");
    assertEquals(body.role, "engineer");
    assertEquals(body.agent, "alice");
  } finally {
    await server.close();
  }
});

Deno.test("activityClient — appendSessionEnd carries refs.exit_code and refs.terminated_by", async () => {
  const server = await startMockServer();
  try {
    const client = createActivityLogClient({
      serverUrl: server.url,
      agentId: AGENT_ID,
      role: ROLE,
    });
    await client.appendSessionEnd({
      sessionId: SESSION_ID,
      exitCode: 143,
      summary: "stopped",
      terminatedBy: "sigterm",
    });
    const body = server.requests()[0]!.body as Record<string, unknown>;
    assertEquals(body.event, "session_end");
    assertEquals((body.refs as Record<string, string>).exit_code, "143");
    assertEquals((body.refs as Record<string, string>).terminated_by, "sigterm");
  } finally {
    await server.close();
  }
});

Deno.test("activityClient — appendSessionEnd omits terminated_by when not provided", async () => {
  const server = await startMockServer();
  try {
    const client = createActivityLogClient({
      serverUrl: server.url,
      agentId: AGENT_ID,
      role: ROLE,
    });
    await client.appendSessionEnd({
      sessionId: SESSION_ID,
      exitCode: 0,
      summary: "done",
    });
    const body = server.requests()[0]!.body as Record<string, unknown>;
    const refs = body.refs as Record<string, string>;
    assertEquals(refs.exit_code, "0");
    assertEquals("terminated_by" in refs, false);
  } finally {
    await server.close();
  }
});

Deno.test("activityClient — appendIdle uses event:idle, summary:null", async () => {
  const server = await startMockServer();
  try {
    const client = createActivityLogClient({
      serverUrl: server.url,
      agentId: AGENT_ID,
      role: ROLE,
    });
    await client.appendIdle({ sessionId: SESSION_ID });
    const body = server.requests()[0]!.body as Record<string, unknown>;
    assertEquals(body.event, "idle");
    assertEquals(body.summary, null);
  } finally {
    await server.close();
  }
});

Deno.test("activityClient — appendSubprocessOutput uses event:subprocess_stdout for stdout", async () => {
  const server = await startMockServer();
  try {
    const client = createActivityLogClient({
      serverUrl: server.url,
      agentId: AGENT_ID,
      role: ROLE,
    });
    await client.appendSubprocessOutput({
      sessionId: SESSION_ID,
      streamKind: "stdout",
      line: "hello",
    });
    const body = server.requests()[0]!.body as Record<string, unknown>;
    assertEquals(body.event, "subprocess_stdout");
    assertEquals(body.summary, "hello");
    assertEquals((body.refs as Record<string, string>).stream_kind, "stdout");
  } finally {
    await server.close();
  }
});

Deno.test("activityClient — appendSubprocessOutput uses event:subprocess_stderr for stderr", async () => {
  const server = await startMockServer();
  try {
    const client = createActivityLogClient({
      serverUrl: server.url,
      agentId: AGENT_ID,
      role: ROLE,
    });
    await client.appendSubprocessOutput({
      sessionId: SESSION_ID,
      streamKind: "stderr",
      line: "warn",
    });
    const body = server.requests()[0]!.body as Record<string, unknown>;
    assertEquals(body.event, "subprocess_stderr");
    assertEquals((body.refs as Record<string, string>).stream_kind, "stderr");
  } finally {
    await server.close();
  }
});

Deno.test("activityClient — appendSubprocessOutputTruncated event + dropped_count ref", async () => {
  const server = await startMockServer();
  try {
    const client = createActivityLogClient({
      serverUrl: server.url,
      agentId: AGENT_ID,
      role: ROLE,
    });
    await client.appendSubprocessOutputTruncated({
      sessionId: SESSION_ID,
      streamKind: "stdout",
      droppedCount: 500,
    });
    const body = server.requests()[0]!.body as Record<string, unknown>;
    assertEquals(body.event, "subprocess_output_truncated");
    assertEquals((body.refs as Record<string, string>).dropped_count, "500");
    assertEquals((body.refs as Record<string, string>).stream_kind, "stdout");
  } finally {
    await server.close();
  }
});

Deno.test("activityClient — non-2xx response throws RoleRuntimeHttpError with code/details/status", async () => {
  const server = await startMockServer();
  try {
    server.setResponse({
      kind: "error",
      status: 422,
      errorCode: "invalid_artifact",
      errorMessage: "size_exceeded",
      errorDetails: { reason: "size_exceeded" },
    });
    const client = createActivityLogClient({
      serverUrl: server.url,
      agentId: AGENT_ID,
      role: ROLE,
    });
    const err = await assertRejects(
      () => client.appendSessionStart({ sessionId: SESSION_ID, summary: null }),
      RoleRuntimeHttpError,
    );
    assertEquals(err.code, "invalid_artifact");
    assertEquals(err.httpStatus, 422);
    assertEquals(err.details, { reason: "size_exceeded" });
    assertEquals(err.message, "size_exceeded");
  } finally {
    await server.close();
  }
});

Deno.test("activityClient — non-JSON error keeps the default message but the right status", async () => {
  const server = await startMockServer();
  try {
    server.setResponse({ kind: "non_json_error", status: 502, text: "bad gateway" });
    const client = createActivityLogClient({
      serverUrl: server.url,
      agentId: AGENT_ID,
      role: ROLE,
    });
    const err = await assertRejects(
      () => client.appendSessionStart({ sessionId: SESSION_ID, summary: null }),
      RoleRuntimeHttpError,
    );
    assertEquals(err.httpStatus, 502);
    assertEquals(err.code, "internal_error");
    assert(err.message.includes("502"));
  } finally {
    await server.close();
  }
});

Deno.test("activityClient — network failure surfaces as internal_error naming the URL", async () => {
  const client = createActivityLogClient({
    serverUrl: "http://127.0.0.1:1",
    agentId: AGENT_ID,
    role: ROLE,
  });
  const err = await assertRejects(
    () => client.appendSessionStart({ sessionId: SESSION_ID, summary: null }),
    RoleRuntimeHttpError,
  );
  assertEquals(err.code, "internal_error");
  assertEquals(err.httpStatus, 0);
  assert(err.message.includes("127.0.0.1:1"));
});

Deno.test("activityClient — 5 KB single line is truncated by appendSubprocessOutput", async () => {
  const server = await startMockServer();
  try {
    const client = createActivityLogClient({
      serverUrl: server.url,
      agentId: AGENT_ID,
      role: ROLE,
    });
    const longLine = "x".repeat(5120);
    await client.appendSubprocessOutput({
      sessionId: SESSION_ID,
      streamKind: "stdout",
      line: longLine,
    });
    const body = server.requests()[0]!.body as Record<string, unknown>;
    const summary = body.summary as string;
    const summaryBytes = new TextEncoder().encode(summary);
    assertGreaterOrEqual(SUMMARY_HARD_CAP_BYTES, summaryBytes.length - 32); // marker fits inside cap
    assert(summary.includes("[truncated"));
    assertEquals((body.refs as Record<string, string>).truncated, "true");
  } finally {
    await server.close();
  }
});

Deno.test("truncateLine — multi-byte UTF-8 boundary is not split", () => {
  const head = "x".repeat(SUMMARY_HARD_CAP_BYTES - 1);
  const lineWithBoundaryChar = head + "é" + "y".repeat(50);
  const { value, wasTruncated } = truncateLine(lineWithBoundaryChar);
  assertEquals(wasTruncated, true);
  // Decoding the produced string should not yield any U+FFFD replacement
  // characters, which would indicate a split mid-codepoint.
  assertEquals(value.includes("\uFFFD"), false);
});

Deno.test("truncateLine — short lines pass through unchanged", () => {
  const { value, wasTruncated } = truncateLine("hello");
  assertEquals(value, "hello");
  assertEquals(wasTruncated, false);
});
