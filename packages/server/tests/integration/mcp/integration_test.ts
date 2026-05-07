/**
 * End-to-end integration test for the engineer MCP server.
 *
 * Architecture choice (documented per task 9.1's instruction):
 *
 * - The orchestration server runs **in-process** via `runServer` with an
 *   injected `shutdownSignal` (the same pattern used by `runServer_test.ts`).
 *   No subprocess. Lifetime is bound to the test.
 * - The MCP server runs **as a `deno run` subprocess**, spawned by the
 *   SDK's `StdioClientTransport`. We rely on the SDK to manage the
 *   PID's lifecycle: `client.close()` closes the transport, which sends
 *   stdin EOF, which causes `runMcpServer` to resolve and the
 *   subprocess to exit.
 *
 * The bulk of the scenarios live inside one `Deno.test` with `t.step`
 * sub-tests rather than one `Deno.test` per scenario, because every
 * extra `Deno.test` would pay the `deno run` warm-up tax (~1-3s). The
 * shared subprocess sees a single ticket sequence, so each step uses
 * a fresh ticket created on demand.
 *
 * The negative trust-seam scenario (task 9.4) and the structural
 * "no .keni reads from MCP source" assertion (task 9.5) live as separate
 * `Deno.test`s — the first wants its own subprocess, the second needs
 * none.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "@std/path";
import { FileConfigStore, resolveGlobalPaths, resolveProjectPaths } from "@keni/shared";
import { FakeWorkspaceProvisioner } from "@keni/runtime-workspace/test-fakes";
import { runServer } from "../../../src/runServer.ts";

const PROJECT_ID = "00000000-0000-4000-8000-0000000000aa";

interface OrchestrationHandle {
  readonly url: string;
  readonly projectRoot: string;
  readonly home: string;
  readonly stop: () => Promise<void>;
}

async function startOrchestrationServer(
  agents: readonly { readonly id: string; readonly role: string }[],
): Promise<OrchestrationHandle> {
  const projectRoot = await Deno.makeTempDir({ prefix: "keni-mcp-it-" });
  const home = await Deno.makeTempDir({ prefix: "keni-mcp-it-home-" });
  const projectPaths = resolveProjectPaths(projectRoot);
  const globalPaths = resolveGlobalPaths(home);
  await Deno.mkdir(projectPaths.keni, { recursive: true });
  await Deno.mkdir(projectPaths.tickets, { recursive: true });
  await Deno.mkdir(projectPaths.prs, { recursive: true });
  await Deno.mkdir(projectPaths.activity, { recursive: true });
  const config = new FileConfigStore(projectPaths, globalPaths);
  await config.writeProjectConfig({
    project_id: PROJECT_ID,
    name: "mcp-it-project",
    ...(agents.length > 0 ? { agents } : {}),
  });

  const outLines: string[] = [];
  const ctrl = new AbortController();
  const promise = runServer(
    ["--project", projectRoot, "--port", "0"],
    {
      out: (m) => outLines.push(m),
      err: () => {},
      homeDir: home,
      shutdownSignal: ctrl.signal,
      // The MCP integration tests do not exercise the engineer
      // workspace surface; the fake provisioner short-circuits the
      // git-clone plumbing so the server boots against any temp dir.
      workspaceProvisioner: new FakeWorkspaceProvisioner({ homeDir: home }),
    },
  );
  const start = performance.now();
  let banner: string | undefined;
  while (banner === undefined) {
    if (performance.now() - start > 5000) {
      throw new Error("Orchestration server did not bind within 5s");
    }
    banner = outLines.find((l) => l.startsWith("Keni server running at "));
    if (banner === undefined) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  const url = banner.replace(/^Keni server running at /, "");

  return {
    url,
    projectRoot,
    home,
    stop: async () => {
      ctrl.abort();
      await promise;
      await Deno.remove(projectRoot, { recursive: true });
      await Deno.remove(home, { recursive: true });
    },
  };
}

async function spawnMcpClient(
  serverUrl: string,
  agentId: string,
  workspacePath: string,
): Promise<{ readonly client: Client; readonly stop: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: Deno.execPath(),
    args: [
      "run",
      "-A",
      "packages/server/src/mcp/main.ts",
      `--agent=${agentId}`,
      `--server-url=${serverUrl}`,
      `--workspace=${workspacePath}`,
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "keni-mcp-it", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    stop: async () => {
      try {
        await client.close();
      } catch {
        // ignore — close is best-effort during teardown
      }
    },
  };
}

async function createTicket(
  serverUrl: string,
  body: { readonly title: string; readonly priority: number },
): Promise<string> {
  const res = await fetch(`${serverUrl}/tickets`, {
    method: "POST",
    headers: {
      "X-Keni-Role": "user",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) {
    throw new Error(`createTicket: expected 201, got ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { readonly data: { readonly id: string } };
  return json.data.id;
}

async function transitionAs(
  serverUrl: string,
  role: string,
  id: string,
  from: string,
  to: string,
): Promise<void> {
  const res = await fetch(`${serverUrl}/tickets/${id}/transition`, {
    method: "POST",
    headers: {
      "X-Keni-Role": role,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to }),
  });
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(
      `transitionAs(${role}, ${id}, ${from}→${to}): expected 200, got ${res.status}: ${text}`,
    );
  }
  await res.body?.cancel();
}

interface ToolCallResult {
  readonly content: Array<{ readonly type: string; readonly text: string }>;
  readonly isError?: boolean;
}

function firstText(result: ToolCallResult): string {
  const item = result.content[0];
  if (item?.type !== "text") {
    throw new Error(`expected first content item to be text, got ${JSON.stringify(item)}`);
  }
  return item.text;
}

function parseFirstTextAs<T>(result: ToolCallResult): T {
  return JSON.parse(firstText(result)) as T;
}

/*
 * `sanitizeOps`/`sanitizeResources` are disabled for the two subprocess-
 * driving tests below. The SDK's `StdioClientTransport.close()` arms a
 * 2-second SIGTERM fallback timer via `setTimeout(...).unref()` (see
 * `@modelcontextprotocol/sdk/dist/esm/client/stdio.js` line 152). The
 * subprocess we spawn always exits cleanly on stdin EOF, so the
 * fallback never fires — but Deno's leak sanitizer still flags the
 * unfired (unref'd) timer. Disabling the sanitizer for this scope
 * isolates the workaround to the only path where it matters.
 */
Deno.test({
  name: "engineer MCP — happy paths and documented errors",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const orchestration = await startOrchestrationServer([
      { id: "alice", role: "engineer" },
    ]);
    const wsDir = await Deno.makeTempDir({ prefix: "keni-mcp-it-ws-" });
    const mcp = await spawnMcpClient(orchestration.url, "alice", wsDir);

    try {
      await t.step("listTools returns exactly the seven engineer tools", async () => {
        const list = await mcp.client.listTools();
        const names = list.tools
          .map((tool: { name: string }) => tool.name)
          .sort();
        assertEquals(names, [
          "append_activity_entry",
          "get_workspace_path",
          "list_tickets",
          "merge_pr",
          "query_activity",
          "read_ticket",
          "transition_ticket_status",
          "update_ticket_body",
        ]);
        for (const tool of list.tools as ReadonlyArray<{ description?: string }>) {
          assert(
            typeof tool.description === "string" && tool.description.length > 0,
            "every tool must carry a non-empty description",
          );
        }
      });

      await t.step("list_tickets returns [] on a fresh project", async () => {
        const result = (await mcp.client.callTool({ name: "list_tickets", arguments: {} })) as
          & ToolCallResult
          & Record<string, unknown>;
        assertEquals(result.isError, undefined);
        const data = parseFirstTextAs<readonly unknown[]>(result);
        assertEquals(data, []);
      });

      await t.step(
        "read_ticket returns isError: true with [store_not_found] for an unknown id",
        async () => {
          const result = (await mcp.client.callTool({
            name: "read_ticket",
            arguments: { id: "ticket-9999" },
          })) as ToolCallResult & Record<string, unknown>;
          assertEquals(result.isError, true);
          assertStringIncludes(firstText(result), "[store_not_found]");
        },
      );

      await t.step("list_tickets returns a created ticket", async () => {
        const id = await createTicket(orchestration.url, {
          title: "first ticket",
          priority: 100,
        });
        const result = (await mcp.client.callTool({
          name: "list_tickets",
          arguments: {},
        })) as ToolCallResult & Record<string, unknown>;
        assertEquals(result.isError, undefined);
        const data = parseFirstTextAs<ReadonlyArray<{ readonly id: string }>>(result);
        assert(data.some((t) => t.id === id), `expected ${id} in list_tickets result`);
      });

      await t.step("update_ticket_body updates the on-disk file", async () => {
        const id = await createTicket(orchestration.url, {
          title: "body update",
          priority: 100,
        });
        const result = (await mcp.client.callTool({
          name: "update_ticket_body",
          arguments: { id, body: "## new body\n\ndocumented change" },
        })) as ToolCallResult & Record<string, unknown>;
        assertEquals(result.isError, undefined);

        const path = join(orchestration.projectRoot, ".keni", "tickets", `${id}.md`);
        const onDisk = await Deno.readTextFile(path);
        assertStringIncludes(onDisk, "## new body");
        assertStringIncludes(onDisk, "documented change");
      });

      await t.step(
        "transition_ticket_status succeeds for engineer-owned open → in_progress",
        async () => {
          const id = await createTicket(orchestration.url, {
            title: "transition happy",
            priority: 100,
          });
          const result = (await mcp.client.callTool({
            name: "transition_ticket_status",
            arguments: { id, from: "open", to: "in_progress" },
          })) as ToolCallResult & Record<string, unknown>;
          assertEquals(result.isError, undefined);
          const data = parseFirstTextAs<{ readonly status: string }>(result);
          assertEquals(data.status, "in_progress");

          const path = join(orchestration.projectRoot, ".keni", "tickets", `${id}.md`);
          const onDisk = await Deno.readTextFile(path);
          assertStringIncludes(onDisk, "status: in_progress");
        },
      );

      await t.step(
        "transition_ticket_status fails [role_not_owner] for tested → done",
        async () => {
          const id = await createTicket(orchestration.url, {
            title: "tested-to-done not owned",
            priority: 100,
          });
          /*
           * Walk to `tested` via direct REST calls, alternating roles per
           * §4.2. Engineer owns through ready_for_test; QA owns the testing
           * states. We skip the activity-emission concern — these are
           * background transitions, not the assertion under test.
           */
          await transitionAs(orchestration.url, "engineer", id, "open", "in_progress");
          await transitionAs(
            orchestration.url,
            "engineer",
            id,
            "in_progress",
            "ready_for_review",
          );
          await transitionAs(
            orchestration.url,
            "engineer",
            id,
            "ready_for_review",
            "in_review",
          );
          await transitionAs(orchestration.url, "engineer", id, "in_review", "approved");
          await transitionAs(orchestration.url, "engineer", id, "approved", "merged");
          await transitionAs(
            orchestration.url,
            "engineer",
            id,
            "merged",
            "ready_for_test",
          );
          await transitionAs(orchestration.url, "qa", id, "ready_for_test", "in_testing");
          await transitionAs(orchestration.url, "qa", id, "in_testing", "tested");

          const result = (await mcp.client.callTool({
            name: "transition_ticket_status",
            arguments: { id, from: "tested", to: "done" },
          })) as ToolCallResult & Record<string, unknown>;
          assertEquals(result.isError, true);
          assertStringIncludes(firstText(result), "[role_not_owner]");
        },
      );

      await t.step(
        "transition_ticket_status fails [status_graph_violation] for open → merged",
        async () => {
          const id = await createTicket(orchestration.url, {
            title: "graph violation",
            priority: 100,
          });
          const result = (await mcp.client.callTool({
            name: "transition_ticket_status",
            arguments: { id, from: "open", to: "merged" },
          })) as ToolCallResult & Record<string, unknown>;
          assertEquals(result.isError, true);
          assertStringIncludes(firstText(result), "[status_graph_violation]");
        },
      );

      await t.step(
        "transition_ticket_status retried after success returns [stale_state]",
        async () => {
          const id = await createTicket(orchestration.url, {
            title: "stale state",
            priority: 100,
          });
          const first = (await mcp.client.callTool({
            name: "transition_ticket_status",
            arguments: { id, from: "open", to: "in_progress" },
          })) as ToolCallResult & Record<string, unknown>;
          assertEquals(first.isError, undefined);

          const second = (await mcp.client.callTool({
            name: "transition_ticket_status",
            arguments: { id, from: "open", to: "in_progress" },
          })) as ToolCallResult & Record<string, unknown>;
          assertEquals(second.isError, true);
          assertStringIncludes(firstText(second), "[stale_state]");
        },
      );

      await t.step(
        "append_activity_entry writes a date-partitioned line under alice/engineer",
        async () => {
          const today = new Date().toISOString().slice(0, 10);
          const path = join(orchestration.projectRoot, ".keni", "activity", `${today}.jsonl`);
          const before = await safeLineCount(path);

          const result = (await mcp.client.callTool({
            name: "append_activity_entry",
            arguments: {
              session_id: "session-it-1",
              event: "summary",
              summary: "smoke entry from integration test",
            },
          })) as ToolCallResult & Record<string, unknown>;
          assertEquals(result.isError, undefined);

          const after = await safeLineCount(path);
          assertEquals(after, before + 1);
          const lastLine = await lastNonEmptyLine(path);
          const parsed = JSON.parse(lastLine) as { readonly agent: string; readonly role: string };
          assertEquals(parsed.agent, "alice");
          assertEquals(parsed.role, "engineer");
        },
      );

      await t.step(
        "query_activity returns the appended entry and honours an explicit limit",
        async () => {
          const all = (await mcp.client.callTool({
            name: "query_activity",
            arguments: {},
          })) as ToolCallResult & Record<string, unknown>;
          assertEquals(all.isError, undefined);
          const allEntries = parseFirstTextAs<ReadonlyArray<{ readonly agent: string }>>(all);
          assert(allEntries.length >= 1, "at least one activity entry expected");
          for (const entry of allEntries) {
            assertEquals(entry.agent, "alice");
          }

          const limited = (await mcp.client.callTool({
            name: "query_activity",
            arguments: { limit: 1 },
          })) as ToolCallResult & Record<string, unknown>;
          assertEquals(limited.isError, undefined);
          const limitedEntries = parseFirstTextAs<readonly unknown[]>(limited);
          assertEquals(limitedEntries.length, 1);
        },
      );

      await t.step(
        "get_workspace_path returns the boot-time --workspace value verbatim",
        async () => {
          const result = (await mcp.client.callTool({
            name: "get_workspace_path",
            arguments: {},
          })) as ToolCallResult & Record<string, unknown>;
          assertEquals(result.isError, undefined);
          const data = parseFirstTextAs<{ readonly path: string }>(result);
          assertEquals(data.path, wsDir);
        },
      );
    } finally {
      await mcp.stop();
      await orchestration.stop();
      await Deno.remove(wsDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "engineer MCP — agent-override attempt is rejected (trust seam)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const orchestration = await startOrchestrationServer([
      { id: "alice", role: "engineer" },
    ]);
    const wsDir = await Deno.makeTempDir({ prefix: "keni-mcp-it-trust-ws-" });
    const mcp = await spawnMcpClient(orchestration.url, "alice", wsDir);

    try {
      const today = new Date().toISOString().slice(0, 10);
      const path = join(orchestration.projectRoot, ".keni", "activity", `${today}.jsonl`);

      /*
       * The schema is `.strict()`, so the SDK rejects the call at the
       * JSON-RPC validation layer (before the handler runs). The
       * client surfaces this as a thrown `McpError`. Either outcome is
       * fine for this test — the load-bearing assertion is the next
       * one: no entry with `agent: "bob"` ever lands on disk.
       */
      let threw = false;
      let toolErrored = false;
      try {
        const result = (await mcp.client.callTool({
          name: "append_activity_entry",
          arguments: {
            session_id: "session-trust-1",
            event: "summary",
            // Sneaked-in identity override — must be rejected.
            agent: "bob",
          },
        })) as ToolCallResult & Record<string, unknown>;
        if (result.isError === true) {
          toolErrored = true;
        }
      } catch {
        threw = true;
      }
      assert(
        threw || toolErrored,
        "schema-strict rejection must surface as either a thrown error or isError: true",
      );

      const text = await safeReadText(path);
      if (text.trim().length > 0) {
        for (const line of text.split("\n").filter(Boolean)) {
          const parsed = JSON.parse(line) as { readonly agent: string };
          assert(
            parsed.agent !== "bob",
            `no activity entry with agent='bob' should ever land on disk; got: ${line}`,
          );
        }
      }
    } finally {
      await mcp.stop();
      await orchestration.stop();
      await Deno.remove(wsDir, { recursive: true });
    }
  },
});

/**
 * Structural assertion (task 9.5) — proves at file-string level that
 * the MCP source never touches `.keni/` directly. If a future
 * contributor adds a `Deno.readTextFile(".keni/...")` to a tool handler,
 * this test fails before any behaviour test would.
 */
Deno.test("engineer MCP source — no `.keni/` reads from tool handlers", async () => {
  const root = "packages/server/src/mcp";
  const forbidden = [
    "Deno.readTextFile",
    "Deno.writeTextFile",
    "Deno.readFile",
    "Deno.writeFile",
    ".keni/",
  ];
  const skipFile = (path: string) =>
    path.endsWith("_test.ts") || path.endsWith("integration_test.ts");

  for await (const entry of walkFiles(root)) {
    if (skipFile(entry)) continue;
    const text = await Deno.readTextFile(entry);
    /*
     * Strip comments before scanning. Doc-comments mention `.keni/` to
     * explain why the MCP layer deliberately avoids it; those mentions
     * should not trip the structural check.
     */
    const code = stripComments(text);
    for (const banned of forbidden) {
      if (code.includes(banned)) {
        throw new Error(
          `${entry} contains the forbidden substring '${banned}'; ` +
            `MCP tool handlers must delegate every state read/write to the orchestration HTTP surface.`,
        );
      }
    }
  }
});

function stripComments(source: string): string {
  let stripped = source.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  stripped = stripped.replaceAll(/\/\/[^\n]*/g, "");
  return stripped;
}

async function* walkFiles(root: string): AsyncIterable<string> {
  for await (const entry of Deno.readDir(root)) {
    const full = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkFiles(full);
    } else if (entry.isFile && full.endsWith(".ts")) {
      yield full;
    }
  }
}

async function safeLineCount(path: string): Promise<number> {
  try {
    const text = await Deno.readTextFile(path);
    return text.split("\n").filter((l) => l.length > 0).length;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return 0;
    throw e;
  }
}

async function lastNonEmptyLine(path: string): Promise<string> {
  const text = await Deno.readTextFile(path);
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error(`Expected at least one line in ${path}`);
  }
  return lines[lines.length - 1]!;
}

async function safeReadText(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return "";
    throw e;
  }
}
