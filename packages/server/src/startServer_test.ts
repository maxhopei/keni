/**
 * Tests for `startServer`. Runs against a real loopback port so we exercise
 * `Deno.serve` end-to-end. Uses `port: 0` for OS-assigned to avoid
 * collisions when tests run in parallel.
 */

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  InMemoryActivityLogStore,
  InMemoryConfigStore,
  InMemoryPRStore,
  InMemoryTicketStore,
} from "@keni/shared";
import { createInMemoryAgentRuntimeStateStore } from "./agentState.ts";
import { createInMemoryEventBus } from "./eventBus.ts";
import { captureLogSink } from "./middleware/requestLog.ts";
import { startServer } from "./startServer.ts";

function makeDeps() {
  return {
    ticketStore: new InMemoryTicketStore(),
    prStore: new InMemoryPRStore(),
    activityLogStore: new InMemoryActivityLogStore(),
    configStore: new InMemoryConfigStore(),
    logSink: captureLogSink([]),
    eventBus: createInMemoryEventBus(),
    agentRuntimeStateStore: createInMemoryAgentRuntimeStateStore([]),
  };
}

Deno.test("startServer with port: 0 returns a positive bound port", async () => {
  const handle = await startServer(makeDeps(), { projectId: "p1", port: 0 });
  try {
    assert(handle.port > 0, `expected positive port, got ${handle.port}`);
  } finally {
    await handle.abort();
  }
});

Deno.test("startServer.url has the form http://127.0.0.1:<port>", async () => {
  const handle = await startServer(makeDeps(), { projectId: "p1", port: 0 });
  try {
    assertMatch(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assertEquals(handle.url, `http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.abort();
  }
});

Deno.test("startServer accepts requests against the bound port", async () => {
  const handle = await startServer(makeDeps(), { projectId: "p1", port: 0 });
  try {
    const res = await fetch(`${handle.url}/tickets`, {
      headers: { "X-Keni-Role": "user" },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.project_id, "p1");
  } finally {
    await handle.abort();
  }
});

Deno.test("startServer.abort() makes the port stop accepting connections", async () => {
  const handle = await startServer(makeDeps(), { projectId: "p1", port: 0 });
  await handle.abort();
  await assertRejects(async () => {
    await fetch(`${handle.url}/tickets`, { headers: { "X-Keni-Role": "user" } });
  });
});
