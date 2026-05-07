import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { parse as parseToml } from "@std/toml";
import type { AgentId } from "@keni/shared";
import {
  createSubprocessCodingAgentInvoker,
  setTempfileJsonOverrideForTesting,
} from "../../src/codingAgentInvoker.ts";
import type {
  CodingAgentInvocation,
  CodingAgentLifecycle,
  CodingAgentOutcome,
} from "../../src/types.ts";
import { RoleRuntimeError } from "../../src/types.ts";

const FIXTURE_PATH = fromFileUrl(
  new URL("../fixtures/fake-coding-agent.ts", import.meta.url),
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
    mcpConfigStrategy: { kind: "tempfile-json" },
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
    mcpConfigStrategy: { kind: "tempfile-json" },
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
    mcpConfigStrategy: { kind: "tempfile-json" },
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
    mcpConfigStrategy: { kind: "tempfile-json" },
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
    mcpConfigStrategy: { kind: "tempfile-json" },
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

Deno.test(
  "invoker — tempfile-json strategy: temp file is removed after invoke resolves",
  async () => {
    const before = await listTempFiles("keni-mcp-");
    const invoker = createSubprocessCodingAgentInvoker({
      cliBinary: Deno.execPath(),
      buildArgs: () => ["run", "-A", FIXTURE_PATH],
      promptInjection: "stdin",
      mcpConfigStrategy: { kind: "tempfile-json" },
    });
    const lifecycle = makeLifecycle();
    await invoker.invoke(baseInvocation(), lifecycle.bag);
    const after = await listTempFiles("keni-mcp-");
    assertEquals(after.length, before.length);
  },
);

Deno.test(
  "invoker — tempfile-json strategy: test seam routes the temp path through the override",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "keni-invoker-test-" });
    try {
      let capturedPath: string | null = null;
      setTempfileJsonOverrideForTesting(async (_inv) => {
        const path = join(tempDir, "mcp.json");
        capturedPath = path;
        return await Promise.resolve(path);
      });
      try {
        const invoker = createSubprocessCodingAgentInvoker({
          cliBinary: Deno.execPath(),
          buildArgs: () => ["run", "-A", FIXTURE_PATH],
          promptInjection: "stdin",
          mcpConfigStrategy: { kind: "tempfile-json" },
        });
        const lifecycle = makeLifecycle();
        await invoker.invoke(baseInvocation(), lifecycle.bag);
        assert(capturedPath !== null, "expected the override to be called");
        // The override returns the path; the invoker writes the file
        // there and removes it on cleanup.
        await assertRejects(() => Deno.stat(capturedPath!), Deno.errors.NotFound);
      } finally {
        setTempfileJsonOverrideForTesting(null);
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "invoker — workspace-json strategy: merges into existing file under mergeKey.entryName",
  async () => {
    const ws = await Deno.makeTempDir({ prefix: "keni-ws-json-" });
    try {
      // Pre-existing sibling entry the user committed; it must survive
      // the merge.
      await Deno.mkdir(join(ws, ".cursor"), { recursive: true });
      await Deno.writeTextFile(
        join(ws, ".cursor", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            playwright: { command: "npx", args: ["@playwright/mcp"] },
          },
        }),
      );

      const invoker = createSubprocessCodingAgentInvoker({
        cliBinary: Deno.execPath(),
        buildArgs: () => ["run", "-A", FIXTURE_PATH],
        promptInjection: "stdin",
        mcpConfigStrategy: {
          kind: "workspace-json",
          relativePath: ".cursor/mcp.json",
          mergeKey: "mcpServers",
          entryName: "keni",
        },
      });
      const lifecycle = makeLifecycle();
      await invoker.invoke(
        baseInvocation({
          workspacePath: ws,
          mcpServerConfig: { command: "deno", args: ["run", "-A", "/keni/mcp.ts"] },
        }),
        lifecycle.bag,
      );

      // The file must persist after cycle exit (no cleanup).
      const text = await Deno.readTextFile(join(ws, ".cursor", "mcp.json"));
      const parsed = JSON.parse(text) as {
        mcpServers: Record<string, { command: string }>;
      };
      assertEquals(parsed.mcpServers.playwright?.command, "npx");
      assertEquals(parsed.mcpServers.keni?.command, "deno");
    } finally {
      await Deno.remove(ws, { recursive: true });
    }
  },
);

Deno.test(
  "invoker — workspace-json strategy: creates parent directory and file when both absent",
  async () => {
    const ws = await Deno.makeTempDir({ prefix: "keni-ws-json-fresh-" });
    try {
      const invoker = createSubprocessCodingAgentInvoker({
        cliBinary: Deno.execPath(),
        buildArgs: () => ["run", "-A", FIXTURE_PATH],
        promptInjection: "stdin",
        mcpConfigStrategy: {
          kind: "workspace-json",
          relativePath: ".cursor/mcp.json",
          mergeKey: "mcpServers",
          entryName: "keni",
        },
      });
      const lifecycle = makeLifecycle();
      await invoker.invoke(
        baseInvocation({
          workspacePath: ws,
          mcpServerConfig: { command: "deno", args: [] },
        }),
        lifecycle.bag,
      );

      const text = await Deno.readTextFile(join(ws, ".cursor", "mcp.json"));
      const parsed = JSON.parse(text) as {
        mcpServers: Record<string, { command: string }>;
      };
      assertEquals(parsed.mcpServers.keni?.command, "deno");
    } finally {
      await Deno.remove(ws, { recursive: true });
    }
  },
);

Deno.test(
  "invoker — workspace-json strategy: rejects null workspacePath with workspace_required_for_strategy",
  async () => {
    const invoker = createSubprocessCodingAgentInvoker({
      cliBinary: Deno.execPath(),
      buildArgs: () => ["run", "-A", FIXTURE_PATH],
      promptInjection: "stdin",
      mcpConfigStrategy: {
        kind: "workspace-json",
        relativePath: ".cursor/mcp.json",
        mergeKey: "mcpServers",
        entryName: "keni",
      },
    });
    const lifecycle = makeLifecycle();
    const err = await assertRejects(
      () => invoker.invoke(baseInvocation({ workspacePath: null }), lifecycle.bag),
      RoleRuntimeError,
    );
    assertEquals(err.code, "workspace_required_for_strategy");
  },
);

Deno.test(
  "invoker — workspace-json strategy: rejects corrupt existing file with mcp_config_corrupt",
  async () => {
    const ws = await Deno.makeTempDir({ prefix: "keni-ws-corrupt-" });
    try {
      await Deno.mkdir(join(ws, ".cursor"), { recursive: true });
      // JSON array is not a plain object — must trigger mcp_config_corrupt.
      await Deno.writeTextFile(
        join(ws, ".cursor", "mcp.json"),
        JSON.stringify([1, 2, 3]),
      );

      const invoker = createSubprocessCodingAgentInvoker({
        cliBinary: Deno.execPath(),
        buildArgs: () => ["run", "-A", FIXTURE_PATH],
        promptInjection: "stdin",
        mcpConfigStrategy: {
          kind: "workspace-json",
          relativePath: ".cursor/mcp.json",
          mergeKey: "mcpServers",
          entryName: "keni",
        },
      });
      const lifecycle = makeLifecycle();
      const err = await assertRejects(
        () => invoker.invoke(baseInvocation({ workspacePath: ws }), lifecycle.bag),
        RoleRuntimeError,
      );
      assertEquals(err.code, "mcp_config_corrupt");
    } finally {
      await Deno.remove(ws, { recursive: true });
    }
  },
);

Deno.test(
  "invoker — workspace-toml strategy: merges into existing file under tableHeader.entryName",
  async () => {
    const ws = await Deno.makeTempDir({ prefix: "keni-ws-toml-" });
    try {
      await Deno.mkdir(join(ws, ".codex"), { recursive: true });
      await Deno.writeTextFile(
        join(ws, ".codex", "config.toml"),
        '[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp"]\n',
      );

      const invoker = createSubprocessCodingAgentInvoker({
        cliBinary: Deno.execPath(),
        buildArgs: () => ["run", "-A", FIXTURE_PATH],
        promptInjection: "stdin",
        mcpConfigStrategy: {
          kind: "workspace-toml",
          relativePath: ".codex/config.toml",
          tableHeader: "mcp_servers",
          entryName: "keni",
        },
      });
      const lifecycle = makeLifecycle();
      await invoker.invoke(
        baseInvocation({
          workspacePath: ws,
          mcpServerConfig: { command: "deno", args: ["run", "-A", "/keni/mcp.ts"] },
        }),
        lifecycle.bag,
      );

      const text = await Deno.readTextFile(join(ws, ".codex", "config.toml"));
      const parsed = parseToml(text) as {
        mcp_servers: Record<string, { command: string }>;
      };
      assertEquals(parsed.mcp_servers.playwright?.command, "npx");
      assertEquals(parsed.mcp_servers.keni?.command, "deno");
    } finally {
      await Deno.remove(ws, { recursive: true });
    }
  },
);

Deno.test({
  name: "invoker — cwd is set to invocation.workspacePath in production path",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const ws = await Deno.makeTempDir({ prefix: "keni-cwd-test-" });
    const tempDir = await Deno.makeTempDir({ prefix: "keni-cwd-script-" });
    try {
      const script = join(tempDir, "print-cwd.sh");
      await Deno.writeTextFile(script, "#!/bin/sh\npwd\n");
      await Deno.chmod(script, 0o755);

      const invoker = createSubprocessCodingAgentInvoker({
        cliBinary: script,
        buildArgs: () => [],
        promptInjection: "stdin",
        mcpConfigStrategy: { kind: "tempfile-json" },
      });
      const lifecycle = makeLifecycle();
      await invoker.invoke(
        baseInvocation({ workspacePath: ws }),
        lifecycle.bag,
      );
      // macOS may symlink `/tmp` to `/private/tmp`; resolve both.
      const realWs = await Deno.realPath(ws);
      const printedCwd = lifecycle.stdout[0] ?? "";
      const realPrinted = printedCwd.length > 0 ? await Deno.realPath(printedCwd) : "";
      assertEquals(realPrinted, realWs);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(ws, { recursive: true });
    }
  },
});

Deno.test({
  name: "invoker — cwd is omitted when invocation.workspacePath is null",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "keni-cwd-null-script-" });
    try {
      const script = join(tempDir, "print-cwd.sh");
      await Deno.writeTextFile(script, "#!/bin/sh\npwd\n");
      await Deno.chmod(script, 0o755);

      const invoker = createSubprocessCodingAgentInvoker({
        cliBinary: script,
        buildArgs: () => [],
        promptInjection: "stdin",
        mcpConfigStrategy: { kind: "tempfile-json" },
      });
      const lifecycle = makeLifecycle();
      await invoker.invoke(
        baseInvocation({ workspacePath: null }),
        lifecycle.bag,
      );
      const realParent = await Deno.realPath(Deno.cwd());
      const printed = lifecycle.stdout[0] ?? "";
      const realPrinted = printed.length > 0 ? await Deno.realPath(printed) : "";
      assertEquals(realPrinted, realParent);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test("invoker — promptInjection:stdin writes the prompt body to the subprocess", async () => {
  const invoker = createSubprocessCodingAgentInvoker({
    cliBinary: Deno.execPath(),
    buildArgs: () => ["run", "-A", FIXTURE_PATH],
    promptInjection: "stdin",
    mcpConfigStrategy: { kind: "tempfile-json" },
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
        mcpConfigStrategy: { kind: "tempfile-json" },
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
