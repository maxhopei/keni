/**
 * Tests for `requestLog` middleware and its sink factories.
 */

import { join } from "@std/path";
import { Hono } from "@hono/hono";
import { assert, assertEquals, assertExists } from "@std/assert";
import { captureLogSink, fileLogSink, requestLog } from "../../../src/middleware/requestLog.ts";
import type { LogSink, RequestLogLine, ServerVariables } from "../../../src/middleware/types.ts";

const PROJECT_ID = "project-test";

function makeApp(sink: LogSink) {
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(async (c, next) => {
    c.set("request_id", "req-1");
    c.set("role", "user");
    c.set("agent", null);
    await next();
  });
  app.use(requestLog(sink, PROJECT_ID));
  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/boom", () => {
    throw new Error("kapow");
  });
  return app;
}

Deno.test("requestLog — successful request emits a line with no error_code", async () => {
  const buffer: RequestLogLine[] = [];
  const app = makeApp(captureLogSink(buffer));
  const res = await app.fetch(new Request("http://x/ok"));
  assertEquals(res.status, 200);
  assertEquals(buffer.length, 1);
  const line = buffer[0]!;
  assertEquals(line.request_id, "req-1");
  assertEquals(line.method, "GET");
  assertEquals(line.path, "/ok");
  assertEquals(line.status, 200);
  assertEquals(line.role, "user");
  assertEquals(line.agent, null);
  assertEquals(line.project_id, PROJECT_ID);
  assertEquals(line.error_code, undefined);
  assert(line.duration_ms >= 0);
});

Deno.test("requestLog — failed request emits a line with the error_code from c.var", async () => {
  const buffer: RequestLogLine[] = [];
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(async (c, next) => {
    c.set("request_id", "req-2");
    c.set("role", "engineer");
    c.set("agent", "alice");
    await next();
  });
  app.use(requestLog(captureLogSink(buffer), PROJECT_ID));
  app.get("/boom", (c) => {
    c.set("error_code", "store_not_found");
    return c.json({ error: { code: "store_not_found", message: "x" } }, 404);
  });
  const res = await app.fetch(new Request("http://x/boom"));
  assertEquals(res.status, 404);
  assertEquals(buffer.length, 1);
  assertEquals(buffer[0]!.error_code, "store_not_found");
  assertEquals(buffer[0]!.role, "engineer");
  assertEquals(buffer[0]!.agent, "alice");
});

Deno.test("requestLog — every documented core field is populated", async () => {
  const buffer: RequestLogLine[] = [];
  const app = makeApp(captureLogSink(buffer));
  await app.fetch(new Request("http://x/ok"));
  const line = buffer[0]!;
  assertExists(line.request_id);
  assertExists(line.timestamp);
  assertExists(line.method);
  assertExists(line.path);
  assert(typeof line.status === "number");
  assert(typeof line.duration_ms === "number");
  assertEquals(line.project_id, PROJECT_ID);
});

Deno.test("requestLog — duration_ms is a non-negative integer", async () => {
  const buffer: RequestLogLine[] = [];
  const app = makeApp(captureLogSink(buffer));
  await app.fetch(new Request("http://x/ok"));
  const d = buffer[0]!.duration_ms;
  assertEquals(Number.isInteger(d), true);
  assert(d >= 0);
});

Deno.test("requestLog — line round-trips as JSON", async () => {
  const buffer: RequestLogLine[] = [];
  const app = makeApp(captureLogSink(buffer));
  await app.fetch(new Request("http://x/ok"));
  const json = JSON.stringify(buffer[0]);
  const parsed = JSON.parse(json) as RequestLogLine;
  assertEquals(parsed.request_id, "req-1");
});

Deno.test("fileLogSink writes to the right daily file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "keni-server-log-" });
  try {
    const sink = fileLogSink(dir);
    await sink.write({
      request_id: "r1",
      timestamp: "2026-05-01T10:00:00.000Z",
      method: "GET",
      path: "/x",
      status: 200,
      duration_ms: 1,
      role: null,
      agent: null,
      project_id: PROJECT_ID,
    });
    await sink.write({
      request_id: "r2",
      timestamp: "2026-05-01T11:00:00.000Z",
      method: "GET",
      path: "/y",
      status: 200,
      duration_ms: 2,
      role: null,
      agent: null,
      project_id: PROJECT_ID,
    });
    const path = join(dir, "server-2026-05-01.jsonl");
    const content = await Deno.readTextFile(path);
    const lines = content.trim().split("\n");
    assertEquals(lines.length, 2);
    assertEquals((JSON.parse(lines[0]!) as RequestLogLine).request_id, "r1");
    assertEquals((JSON.parse(lines[1]!) as RequestLogLine).request_id, "r2");
    await sink.close?.();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fileLogSink rolls to a new file when the UTC date changes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "keni-server-log-" });
  try {
    const sink = fileLogSink(dir);
    await sink.write({
      request_id: "r1",
      timestamp: "2026-05-01T23:59:59.000Z",
      method: "GET",
      path: "/x",
      status: 200,
      duration_ms: 1,
      role: null,
      agent: null,
      project_id: PROJECT_ID,
    });
    await sink.write({
      request_id: "r2",
      timestamp: "2026-05-02T00:00:01.000Z",
      method: "GET",
      path: "/x",
      status: 200,
      duration_ms: 1,
      role: null,
      agent: null,
      project_id: PROJECT_ID,
    });
    await sink.close?.();
    const day1 = await Deno.readTextFile(join(dir, "server-2026-05-01.jsonl"));
    const day2 = await Deno.readTextFile(join(dir, "server-2026-05-02.jsonl"));
    assertEquals(day1.trim().split("\n").length, 1);
    assertEquals(day2.trim().split("\n").length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
