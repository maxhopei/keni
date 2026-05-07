import { assert, assertEquals } from "@std/assert";
import {
  InMemoryActivityLogStore,
  InMemoryConfigStore,
  InMemoryPRStore,
  InMemoryTicketStore,
  type TicketStore,
} from "@keni/shared";
import {
  captureLogSink,
  createInMemoryAgentRuntimeStateStore,
  createInMemoryEventBus,
  createServer,
  McpHttpError,
  packageName,
  runMcpServer,
  runServer,
} from "../../src/main.ts";

Deno.test("@keni/server exposes its package name", () => {
  assertEquals(packageName, "@keni/server");
});

Deno.test("@keni/server can import storage abstractions via bare specifier", async () => {
  const store: TicketStore = new InMemoryTicketStore();
  const created = await store.create({ title: "smoke", priority: 1 });
  assertEquals(created.header.title, "smoke");
});

Deno.test("@keni/server exports createServer as a callable function", () => {
  assertEquals(typeof createServer, "function");
});

Deno.test("@keni/server's createServer answers GET /tickets with in-memory stores", async () => {
  const app = createServer(
    {
      ticketStore: new InMemoryTicketStore(),
      prStore: new InMemoryPRStore(),
      activityLogStore: new InMemoryActivityLogStore(),
      configStore: new InMemoryConfigStore(),
      logSink: captureLogSink([]),
      eventBus: createInMemoryEventBus(),
      agentRuntimeStateStore: createInMemoryAgentRuntimeStateStore([]),
    },
    { projectId: "smoke-project" },
  );
  const res = await app.fetch(
    new Request("http://x/tickets", { headers: { "X-Keni-Role": "user" } }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as { project_id: string; data: unknown[] };
  assertEquals(body.project_id, "smoke-project");
  assert(Array.isArray(body.data));
});

Deno.test("@keni/server's runServer returns exit 2 on an unknown flag", async () => {
  const errLines: string[] = [];
  const code = await runServer(["--bogus-flag"], { out: () => {}, err: (m) => errLines.push(m) });
  assertEquals(code, 2);
});

Deno.test("@keni/server re-exports the MCP-server surface (runMcpServer, McpHttpError)", () => {
  assertEquals(typeof runMcpServer, "function");
  assertEquals(typeof McpHttpError, "function");
  assert(McpHttpError.prototype instanceof Error);
});
