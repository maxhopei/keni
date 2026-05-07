/**
 * End-to-end integration test for the role-runtime cycle.
 *
 * Architecture (mirrors `packages/server/src/mcp/integration_test.ts`):
 *
 * - The orchestration server runs **in-process** via `runServer` with an
 *   injected `shutdownSignal`. Each test spins up a fresh server bound
 *   to port 0 against a fresh `Deno.makeTempDir()` project root.
 * - The "coding agent" is the Deno-script fixture under
 *   `packages/runtime-common/tests/fixtures/fake-coding-agent.ts`,
 *   driven by env vars (`KENI_FAKE_AGENT_LINES`, `..._SLEEP_MS`, etc.).
 * - The cycle is invoked via `startCycle(...)` exactly as a downstream
 *   role would. The test asserts on the returned `RoleCycleResult` and
 *   on the on-disk activity log file.
 *
 * Three scenarios per the capability spec (happy-path completion,
 * idle, graceful termination), plus three structural assertions
 * (no `.keni/` reads in source, no role-keyed conditionals, no MCP
 * SDK import) per `design.md` Decision 11.
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import type { AgentId } from "@keni/shared";
import { FileConfigStore, resolveGlobalPaths, resolveProjectPaths } from "@keni/shared";
import { runServer } from "../../../server/src/runServer.ts";
import { PLACEHOLDER_PROMPT_BODY, PLACEHOLDER_PROMPT_NAME } from "../fakes/placeholderPrompt.ts";
import { startCycle } from "../../src/startCycle.ts";
import { createSubprocessCodingAgentInvoker } from "../../src/codingAgentInvoker.ts";
import type { RoleCycleParams } from "../../src/types.ts";
import { FakeWorkspaceProvisioner } from "@keni/runtime-workspace/test-fakes";

const PROJECT_ID = "00000000-0000-4000-8000-0000000000bb";
const FIXTURE_PATH = fromFileUrl(
  new URL("../fixtures/fake-coding-agent.ts", import.meta.url),
);

interface IntegrationContext {
  readonly serverUrl: string;
  readonly projectRoot: string;
  readonly home: string;
  readonly workspacePath: string;
  readonly stop: () => Promise<void>;
}

async function setup(): Promise<IntegrationContext> {
  const projectRoot = await Deno.makeTempDir({ prefix: "keni-rr-it-" });
  const home = await Deno.makeTempDir({ prefix: "keni-rr-it-home-" });
  const workspacePath = await Deno.makeTempDir({ prefix: "keni-rr-it-ws-" });

  const projectPaths = resolveProjectPaths(projectRoot);
  const globalPaths = resolveGlobalPaths(home);
  await Deno.mkdir(projectPaths.keni, { recursive: true });
  await Deno.mkdir(projectPaths.tickets, { recursive: true });
  await Deno.mkdir(projectPaths.prs, { recursive: true });
  await Deno.mkdir(projectPaths.activity, { recursive: true });
  const config = new FileConfigStore(projectPaths, globalPaths);
  await config.writeProjectConfig({
    project_id: PROJECT_ID,
    name: "rr-it-project",
    agents: [{ id: "alice", role: "engineer" }],
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
      // Cycle-level integration test — the workspace surface is not
      // exercised here, so a fake provisioner skips the real
      // git-clone plumbing.
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
    if (banner === undefined) await new Promise((r) => setTimeout(r, 5));
  }
  const serverUrl = banner.replace(/^Keni server running at /, "");

  return {
    serverUrl,
    projectRoot,
    home,
    workspacePath,
    stop: async () => {
      ctrl.abort();
      await promise;
      try {
        await Deno.remove(projectRoot, { recursive: true });
      } catch { /* best-effort */ }
      try {
        await Deno.remove(home, { recursive: true });
      } catch { /* best-effort */ }
      try {
        await Deno.remove(workspacePath, { recursive: true });
      } catch { /* best-effort */ }
    },
  };
}

function buildParams(
  ctx: IntegrationContext,
  override: Partial<RoleCycleParams> = {},
): RoleCycleParams {
  return {
    role: "engineer",
    agentId: "alice" as AgentId,
    serverUrl: ctx.serverUrl,
    projectName: "rr-it-project",
    workspacePath: ctx.workspacePath,
    mcpServerConfig: {
      command: Deno.execPath(),
      args: ["run", "-A", "packages/server/src/mcp/main.ts", "--agent=alice"],
    },
    precheck: () => ({ kind: "proceed", roleContext: {} }),
    promptResolver: () => ({
      name: PLACEHOLDER_PROMPT_NAME,
      body: PLACEHOLDER_PROMPT_BODY,
    }),
    codingAgentInvoker: createSubprocessCodingAgentInvoker({
      cliBinary: Deno.execPath(),
      buildArgs: () => ["run", "-A", FIXTURE_PATH],
      promptInjection: "stdin",
      mcpConfigStrategy: { kind: "tempfile-json" },
      graceMs: 1000,
      envAllowlist: [
        "KENI_FAKE_AGENT_LINES",
        "KENI_FAKE_AGENT_SUMMARY",
        "KENI_FAKE_AGENT_EXIT_CODE",
        "KENI_FAKE_AGENT_SLEEP_MS",
        "KENI_FAKE_AGENT_STDERR_LINES",
        "PATH",
      ],
    }),
    ...override,
  };
}

interface ActivityRow {
  readonly session_id: string;
  readonly agent: string;
  readonly role: string;
  readonly event: string;
  readonly summary: string | null;
  readonly refs: Record<string, string>;
}

async function readActivity(projectRoot: string, sessionId: string): Promise<ActivityRow[]> {
  const projectPaths = resolveProjectPaths(projectRoot);
  const out: ActivityRow[] = [];
  for await (const entry of Deno.readDir(projectPaths.activity)) {
    if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
    const text = await Deno.readTextFile(join(projectPaths.activity, entry.name));
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const row = JSON.parse(line) as ActivityRow;
      if (row.session_id === sessionId) out.push(row);
    }
  }
  return out;
}

Deno.test({
  name: "integration — happy-path cycle gains the documented activity entries on disk",
  fn: async () => {
    const ctx = await setup();
    try {
      // Fixture prints LINES content lines + 1 summary line. To get the
      // documented "5 stdout lines with summary as the last", set LINES=4.
      Deno.env.set("KENI_FAKE_AGENT_LINES", "4");
      Deno.env.set("KENI_FAKE_AGENT_SUMMARY", "happy summary");
      const params = buildParams(ctx);
      const result = await startCycle(params);
      Deno.env.delete("KENI_FAKE_AGENT_LINES");
      Deno.env.delete("KENI_FAKE_AGENT_SUMMARY");
      assertEquals(result.outcome, "completed");
      assert("sessionId" in result);
      const sessionId = (result as { sessionId: string }).sessionId;
      const rows = await readActivity(ctx.projectRoot, sessionId);
      assertEquals(rows.length, 7);
      assertEquals(rows[0]!.event, "session_start");
      for (let i = 1; i <= 5; i++) {
        assertEquals(rows[i]!.event, "subprocess_stdout");
      }
      assertEquals(rows[6]!.event, "session_end");
      assertEquals(rows[6]!.summary, "happy summary");
      for (const row of rows) {
        assertEquals(row.agent, "alice");
        assertEquals(row.role, "engineer");
      }
    } finally {
      Deno.env.delete("KENI_FAKE_AGENT_LINES");
      Deno.env.delete("KENI_FAKE_AGENT_SUMMARY");
      await ctx.stop();
    }
  },
});

Deno.test({
  name: "integration — idle cycle gains exactly two activity entries (session_start + idle)",
  fn: async () => {
    const ctx = await setup();
    try {
      Deno.env.set("KENI_FAKE_AGENT_LINES", "0");
      Deno.env.set("KENI_FAKE_AGENT_SUMMARY", "");
      // Generous threshold so the integration test isn't flaky on a slow CI box.
      const params = buildParams(ctx, { idleThresholdMs: 60000 });
      const result = await startCycle(params);
      Deno.env.delete("KENI_FAKE_AGENT_LINES");
      Deno.env.delete("KENI_FAKE_AGENT_SUMMARY");
      assertEquals(result.outcome, "idle");
      assert("sessionId" in result);
      const sessionId = (result as { sessionId: string }).sessionId;
      const rows = await readActivity(ctx.projectRoot, sessionId);
      assertEquals(rows.length, 2);
      assertEquals(rows[0]!.event, "session_start");
      assertEquals(rows[1]!.event, "idle");
    } finally {
      Deno.env.delete("KENI_FAKE_AGENT_LINES");
      Deno.env.delete("KENI_FAKE_AGENT_SUMMARY");
      await ctx.stop();
    }
  },
});

Deno.test({
  name: "integration — graceful termination produces session_end with refs.terminated_by:sigterm",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const ctx = await setup();
    try {
      Deno.env.set("KENI_FAKE_AGENT_SLEEP_MS", "30000");
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 200);
      const params = buildParams(ctx, { signal: ctrl.signal });
      const result = await startCycle(params);
      Deno.env.delete("KENI_FAKE_AGENT_SLEEP_MS");
      assertEquals(result.outcome, "terminated");
      if (result.outcome === "terminated") {
        assertEquals(result.terminatedBy, "sigterm");
      }
      assert("sessionId" in result);
      const sessionId = (result as { sessionId: string }).sessionId;
      const rows = await readActivity(ctx.projectRoot, sessionId);
      const sessionEnd = rows.find((r) => r.event === "session_end");
      assert(sessionEnd !== undefined, "expected session_end on disk");
      assertEquals(sessionEnd!.refs.terminated_by, "sigterm");
    } finally {
      Deno.env.delete("KENI_FAKE_AGENT_SLEEP_MS");
      await ctx.stop();
    }
  },
});

// ---------------------------------------------------------------
// Structural assertions
// ---------------------------------------------------------------

const COMMON_DIR = fromFileUrl(new URL("../../src/", import.meta.url));

async function listProductionSourceFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(COMMON_DIR)) {
    if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.endsWith("_test.ts")) {
      out.push(join(COMMON_DIR, entry.name));
    }
  }
  // Walk subdirectory `codingAgentClis/` as well. (The `prompts/` and
  // `fakes/` subdirectories used to live under `src/common/` but moved
  // out under `tests/` as part of the relocate-unit-tests-to-tests-folder
  // change.)
  for (const sub of ["codingAgentClis"]) {
    const dir = join(COMMON_DIR, sub);
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.endsWith("_test.ts")) {
          out.push(join(dir, entry.name));
        }
      }
    } catch { /* dir may be empty */ }
  }
  return out;
}

function stripComments(source: string): string {
  // Remove block comments and line comments so doc-comments referencing
  // forbidden tokens (e.g., `.keni/`) don't trip the structural test.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

Deno.test("structural — packages/runtime-common/src/ has no `.keni/` reads or writes", async () => {
  const files = await listProductionSourceFiles();
  // The default subprocess invoker's strategy executor (per the
  // role-runtime spec's `mcpConfigStrategy` requirement) is the one
  // sanctioned production file that may read / write workspace-rooted
  // MCP-config files (`.cursor/mcp.json`, `.codex/config.toml`). Every
  // other file under `common/` retains the no-disk-prompt-loading
  // contract.
  const SANCTIONED_IO_FILES = new Set(["codingAgentInvoker.ts"]);
  for (const file of files) {
    const stripped = stripComments(await Deno.readTextFile(file));
    const basename = file.split("/").pop() ?? file;
    const ioSanctioned = SANCTIONED_IO_FILES.has(basename);

    // Read primitives are forbidden in production source — prompts ship as
    // TS constants, never read from disk. Sanctioned files may use them
    // for MCP-config materialisation.
    if (!ioSanctioned) {
      for (const forbidden of ["Deno.readTextFile", "Deno.readFile"]) {
        if (stripped.includes(forbidden)) {
          throw new Error(`${file}: contains forbidden read primitive \`${forbidden}\``);
        }
      }
    }
    // No path literal under `.keni/` or `~/.keni/` may appear anywhere
    // (sanctioned files included — the strategy executor's workspace
    // paths are computed via `joinPath`, never as literals).
    for (const pathToken of ['".keni/', "'.keni/", '"~/.keni/', "'~/.keni/"]) {
      if (stripped.includes(pathToken)) {
        throw new Error(`${file}: contains forbidden path literal \`${pathToken}\``);
      }
    }
    // Writes in non-sanctioned files are permitted only against
    // `Deno.makeTempFile`-derived paths (the default invoker's
    // mcp-config tempfile in the `tempfile-json` strategy).
    if (!ioSanctioned) {
      if (
        (stripped.includes("Deno.writeTextFile") || stripped.includes("Deno.writeFile")) &&
        !stripped.includes("Deno.makeTempFile")
      ) {
        throw new Error(
          `${file}: uses a write primitive without a paired Deno.makeTempFile (the only sanctioned write target)`,
        );
      }
    }
  }
});

Deno.test("structural — packages/runtime-common/src/ has no role-keyed conditionals", async () => {
  const files = await listProductionSourceFiles();
  const forbiddenLiterals = [
    '=== "engineer"',
    '=== "qa"',
    '=== "po"',
    '=== "writer"',
    '=== "user"',
    "=== 'engineer'",
    "=== 'qa'",
    "=== 'po'",
    "=== 'writer'",
    "=== 'user'",
  ];
  for (const file of files) {
    const stripped = stripComments(await Deno.readTextFile(file));
    for (const literal of forbiddenLiterals) {
      if (stripped.includes(literal)) {
        throw new Error(
          `${file}: contains forbidden role-keyed conditional \`${literal}\``,
        );
      }
    }
  }
});

Deno.test("structural — packages/runtime-common/src/ does not import the MCP SDK", async () => {
  const files = await listProductionSourceFiles();
  for (const file of files) {
    const stripped = stripComments(await Deno.readTextFile(file));
    if (stripped.includes("@modelcontextprotocol/sdk")) {
      throw new Error(`${file}: imports forbidden \`@modelcontextprotocol/sdk\``);
    }
  }
});
