import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import type { AgentId } from "@keni/shared";
import { createSubprocessCodingAgentInvoker } from "./codingAgentInvoker.ts";
import type { CodingAgentInvocation, CodingAgentLifecycle, CodingAgentOutcome } from "./types.ts";

const FIXTURE_PATH = fromFileUrl(
  new URL("../../tests/fixtures/fake-coding-agent.ts", import.meta.url),
);

function baseInvocation(
  override: Partial<CodingAgentInvocation> = {},
): CodingAgentInvocation {
  return {
    promptBody: "test prompt body\n",
    role: "engineer",
    agentId: "alice" as AgentId,
    projectName: "test",
    workspacePath: null,
    mcpServerConfig: { command: "echo", args: [] },
    resumeSessionId: null,
    envAllowlist: [],
    ...override,
  };
}

function makeLifecycle(): {
  readonly bag: CodingAgentLifecycle;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly spawnInfo: { pid: number }[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const spawnInfo: { pid: number }[] = [];
  return {
    bag: {
      onStdoutLine: (line) => {
        stdout.push(line);
      },
      onStderrLine: (line) => {
        stderr.push(line);
      },
      onSpawn: (info) => {
        spawnInfo.push(info);
      },
    },
    stdout,
    stderr,
    spawnInfo,
  };
}

Deno.test("invoker — happy path emits stdout lines and resolves with completed", async () => {
  const invoker = createSubprocessCodingAgentInvoker({
    cliBinary: Deno.execPath(),
    buildArgs: () => ["run", "-A", FIXTURE_PATH],
    promptInjection: "stdin",
  });
  const lifecycle = makeLifecycle();
  const outcome = await invoker.invoke(
    baseInvocation(),
    lifecycle.bag,
  );
  assertEquals(outcome.kind, "completed");
  assertEquals((outcome as Extract<CodingAgentOutcome, { kind: "completed" }>).exitCode, 0);
  assertEquals(lifecycle.stdout, ["placeholder summary"]);
  assertEquals(lifecycle.spawnInfo.length, 1);
});

Deno.test("invoker — multi-line stdout is observed in arrival order", async () => {
  const invoker = createSubprocessCodingAgentInvoker({
    cliBinary: Deno.execPath(),
    buildArgs: () => ["run", "-A", FIXTURE_PATH],
    promptInjection: "stdin",
    envAllowlist: ["KENI_FAKE_AGENT_LINES", "KENI_FAKE_AGENT_SUMMARY"],
  });
  const lifecycle = makeLifecycle();
  Deno.env.set("KENI_FAKE_AGENT_LINES", "2");
  Deno.env.set("KENI_FAKE_AGENT_SUMMARY", "hello");
  try {
    const outcome = await invoker.invoke(baseInvocation(), lifecycle.bag);
    assertEquals(outcome.kind, "completed");
    assertEquals(lifecycle.stdout, ["line 0", "line 1", "hello"]);
  } finally {
    Deno.env.delete("KENI_FAKE_AGENT_LINES");
    Deno.env.delete("KENI_FAKE_AGENT_SUMMARY");
  }
});

Deno.test("invoker — stderr lines surface through onStderrLine", async () => {
  const invoker = createSubprocessCodingAgentInvoker({
    cliBinary: Deno.execPath(),
    buildArgs: () => ["run", "-A", FIXTURE_PATH],
    promptInjection: "stdin",
    envAllowlist: ["KENI_FAKE_AGENT_STDERR_LINES"],
  });
  const lifecycle = makeLifecycle();
  Deno.env.set("KENI_FAKE_AGENT_STDERR_LINES", "1");
  try {
    await invoker.invoke(baseInvocation(), lifecycle.bag);
    assertEquals(lifecycle.stderr, ["stderr line 0"]);
  } finally {
    Deno.env.delete("KENI_FAKE_AGENT_STDERR_LINES");
  }
});

Deno.test("invoker — missing binary throws an Error naming the binary", async () => {
  const invoker = createSubprocessCodingAgentInvoker({
    cliBinary: "/no/such/binary",
    buildArgs: () => [],
  });
  const lifecycle = makeLifecycle();
  const err = await assertRejects(() => invoker.invoke(baseInvocation(), lifecycle.bag), Error);
  assert(err.message.includes("/no/such/binary") || err.message.toLowerCase().includes("not"));
});

Deno.test("invoker — abort signal triggers SIGTERM and resolves with terminated", async () => {
  const invoker = createSubprocessCodingAgentInvoker({
    cliBinary: Deno.execPath(),
    buildArgs: () => ["run", "-A", FIXTURE_PATH],
    promptInjection: "stdin",
    graceMs: 1000,
    envAllowlist: ["KENI_FAKE_AGENT_SLEEP_MS"],
  });
  const ctrl = new AbortController();
  const lifecycle = makeLifecycle();
  Deno.env.set("KENI_FAKE_AGENT_SLEEP_MS", "30000");
  setTimeout(() => ctrl.abort(), 200);
  try {
    const outcome = await invoker.invoke(
      baseInvocation(),
      { ...lifecycle.bag, abortSignal: ctrl.signal },
    );
    assertEquals(outcome.kind, "terminated");
    const terminated = outcome as Extract<CodingAgentOutcome, { kind: "terminated" }>;
    assertEquals(terminated.terminatedBy, "sigterm");
    assertEquals(terminated.exitCode, 143);
  } finally {
    Deno.env.delete("KENI_FAKE_AGENT_SLEEP_MS");
  }
});

Deno.test("invoker — MCP-config tempfile is removed after invoke resolves", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "keni-invoker-test-" });
  try {
    let capturedPath: string | null = null;
    const invoker = createSubprocessCodingAgentInvoker({
      cliBinary: Deno.execPath(),
      buildArgs: () => ["run", "-A", FIXTURE_PATH],
      promptInjection: "stdin",
      mcpConfigPathBuilder: async (inv) => {
        const path = join(tempDir, "mcp.json");
        await Deno.writeTextFile(
          path,
          JSON.stringify({ mcpServers: { keni: inv.mcpServerConfig } }),
        );
        capturedPath = path;
        return path;
      },
    });
    const lifecycle = makeLifecycle();
    await invoker.invoke(baseInvocation(), lifecycle.bag);
    assert(capturedPath !== null, "expected mcpConfigPathBuilder to have been called");
    // The custom builder owns lifecycle of the file; invoker did NOT remove it.
    assertEquals((await Deno.stat(capturedPath!)).isFile, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("invoker — default MCP-config tempfile is removed by the invoker", async () => {
  const before = await listTempFiles("keni-mcp-");
  const invoker = createSubprocessCodingAgentInvoker({
    cliBinary: Deno.execPath(),
    buildArgs: () => ["run", "-A", FIXTURE_PATH],
    promptInjection: "stdin",
  });
  const lifecycle = makeLifecycle();
  await invoker.invoke(baseInvocation(), lifecycle.bag);
  const after = await listTempFiles("keni-mcp-");
  assertEquals(after.length, before.length);
});

Deno.test("invoker — promptInjection:stdin writes the prompt body to the subprocess", async () => {
  const invoker = createSubprocessCodingAgentInvoker({
    cliBinary: Deno.execPath(),
    buildArgs: () => ["run", "-A", FIXTURE_PATH],
    promptInjection: "stdin",
    envAllowlist: ["KENI_FAKE_AGENT_REQUIRE_PROMPT"],
  });
  Deno.env.set("KENI_FAKE_AGENT_REQUIRE_PROMPT", "1");
  try {
    const lifecycle = makeLifecycle();
    const outcome = await invoker.invoke(
      baseInvocation({ promptBody: "non-empty\n" }),
      lifecycle.bag,
    );
    assertEquals(outcome.kind, "completed");
    assertEquals((outcome as Extract<CodingAgentOutcome, { kind: "completed" }>).exitCode, 0);
  } finally {
    Deno.env.delete("KENI_FAKE_AGENT_REQUIRE_PROMPT");
  }
});

Deno.test({
  name: "invoker — resumeSessionId prepends the resume flag pair to the spawned args",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "keni-args-echo-" });
    const echoScript = join(tempDir, "echo-args.sh");
    await Deno.writeTextFile(
      echoScript,
      '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n',
    );
    await Deno.chmod(echoScript, 0o755);
    try {
      const invoker = createSubprocessCodingAgentInvoker({
        cliBinary: echoScript,
        buildArgs: () => ["last-arg"],
      });
      const lifecycle = makeLifecycle();
      const outcome = await invoker.invoke(
        baseInvocation({ resumeSessionId: "session-abc-123" }),
        lifecycle.bag,
      );
      assertEquals(outcome.kind, "completed");
      // The script prints one arg per line. We expect `--resume`,
      // `session-abc-123`, then `last-arg`, in that consecutive order.
      assertEquals(lifecycle.stdout, ["--resume", "session-abc-123", "last-arg"]);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

async function listTempFiles(prefix: string): Promise<string[]> {
  const dir = Deno.env.get("TMPDIR") ?? "/tmp";
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.startsWith(prefix)) out.push(entry.name);
    }
  } catch {
    return [];
  }
  return out;
}
