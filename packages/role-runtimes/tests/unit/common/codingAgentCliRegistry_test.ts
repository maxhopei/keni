/**
 * Pin the closed `KnownCli` set, the per-entry shape, the per-CLI argv
 * invariants, and the modular file layout (one entry per module under
 * `codingAgentClis/`). These tests are the contract surface for
 * `coding-agent-cli-mcp-strategies` — they ensure adding a new CLI is
 * a deliberate code change with scenarios, not a config-file edit.
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  type CodingAgentCliEntry,
  codingAgentCliRegistry,
  isKnownCli,
  type KnownCli,
  type McpConfigStrategy,
} from "../../../src/common/codingAgentCliRegistry.ts";
import {
  createSubprocessCodingAgentInvoker,
  type SubprocessCodingAgentInvokerOpts,
} from "../../../src/common/codingAgentInvoker.ts";
import type { CodingAgentInvocation, McpServerConfig } from "../../../src/common/types.ts";
import type { AgentId } from "@keni/shared";

const FAKE_MCP_CONFIG: McpServerConfig = {
  command: "deno",
  args: ["run", "-A", "/abs/mcp/main.ts"],
};

function fakeInvocation(
  override: Partial<CodingAgentInvocation> = {},
): CodingAgentInvocation {
  return {
    promptBody: "hello",
    role: "engineer",
    agentId: "alice" as AgentId,
    projectName: "demo",
    workspacePath: "/tmp/ws",
    mcpServerConfig: FAKE_MCP_CONFIG,
    resumeSessionId: null,
    envAllowlist: ["HOME", "PATH"],
    ...override,
  };
}

Deno.test("codingAgentCliRegistry: Object.keys matches the closed KnownCli set", () => {
  const keys = Object.keys(codingAgentCliRegistry).sort();
  assertEquals(keys, ["claude", "codex", "cursor-agent"]);
});

Deno.test(
  "codingAgentCliRegistry: every entry has the documented shape (cliBinary, buildArgs, promptInjection, resumeFlag, envAllowlist, mcpConfigStrategy)",
  () => {
    for (const [name, entry] of Object.entries(codingAgentCliRegistry)) {
      assert(
        typeof entry.cliBinary === "string" && entry.cliBinary.length > 0,
        `${name}.cliBinary must be a non-empty string`,
      );
      assert(
        typeof entry.buildArgs === "function" && entry.buildArgs.length === 2,
        `${name}.buildArgs must be a function with arity 2`,
      );
      assert(
        entry.promptInjection === "stdin" || entry.promptInjection === "arg",
        `${name}.promptInjection must be 'stdin' or 'arg' (got '${entry.promptInjection}')`,
      );
      assert(
        typeof entry.resumeFlag === "string" && entry.resumeFlag.startsWith("--"),
        `${name}.resumeFlag must be a non-empty string starting with '--' (got '${entry.resumeFlag}')`,
      );
      assert(
        Array.isArray(entry.envAllowlist),
        `${name}.envAllowlist must be a readonly string[]`,
      );
      assert(
        typeof entry.mcpConfigStrategy === "object" &&
          entry.mcpConfigStrategy !== null,
        `${name}.mcpConfigStrategy must be a non-null object`,
      );
      const validKinds: McpConfigStrategy["kind"][] = [
        "tempfile-json",
        "workspace-json",
        "workspace-toml",
      ];
      assert(
        validKinds.includes(entry.mcpConfigStrategy.kind),
        `${name}.mcpConfigStrategy.kind must be one of ${
          validKinds.join(", ")
        } (got '${entry.mcpConfigStrategy.kind}')`,
      );
    }
  },
);

Deno.test(
  "codingAgentCliRegistry: every envAllowlist contains HOME and PATH and excludes the KENI_MCP_* mandates",
  () => {
    const FORBIDDEN = ["KENI_MCP_AGENT", "KENI_MCP_SERVER_URL", "KENI_MCP_WORKSPACE"];
    for (const [name, entry] of Object.entries(codingAgentCliRegistry)) {
      assert(
        entry.envAllowlist.includes("HOME"),
        `${name}.envAllowlist must include 'HOME'`,
      );
      assert(
        entry.envAllowlist.includes("PATH"),
        `${name}.envAllowlist must include 'PATH'`,
      );
      for (const banned of FORBIDDEN) {
        assert(
          !entry.envAllowlist.includes(banned),
          `${name}.envAllowlist must NOT include '${banned}' (the KENI_MCP_* mandates are added on top by buildChildEnv)`,
        );
      }
    }
  },
);

Deno.test(
  "codingAgentCliRegistry['claude'].buildArgs uses --mcp-config, --print, and --permission-mode bypassPermissions, and its strategy is tempfile-json",
  () => {
    const entry = codingAgentCliRegistry["claude"];
    const argv = entry.buildArgs(fakeInvocation(), "/tmp/mcp-1234.json");

    const occurrences = argv.filter((a) => a === "/tmp/mcp-1234.json").length;
    assertEquals(
      occurrences,
      1,
      `expected mcpConfigPath exactly once; got argv=${JSON.stringify(argv)}`,
    );

    assert(
      argv.includes("--print"),
      `expected the documented non-interactive flag '--print'; got argv=${JSON.stringify(argv)}`,
    );
    assert(
      !argv.includes("--interactive"),
      `argv must not contain '--interactive'; got argv=${JSON.stringify(argv)}`,
    );

    const permModeIdx = argv.indexOf("--permission-mode");
    assert(
      permModeIdx >= 0,
      `expected '--permission-mode' to make the engineer loop non-interactive (matches cursor-agent's --approve-mcps --trust); got argv=${
        JSON.stringify(argv)
      }`,
    );
    assertEquals(
      argv[permModeIdx + 1],
      "bypassPermissions",
      `expected the value after '--permission-mode' to be 'bypassPermissions'; got argv=${
        JSON.stringify(argv)
      }`,
    );

    assertEquals(entry.mcpConfigStrategy.kind, "tempfile-json");
  },
);

Deno.test(
  "codingAgentCliRegistry['cursor-agent'].buildArgs uses --print --approve-mcps --workspace, and its strategy is workspace-json under .cursor/mcp.json",
  () => {
    const entry = codingAgentCliRegistry["cursor-agent"];
    const argv = entry.buildArgs(
      fakeInvocation({ workspacePath: "/tmp/ws" }),
      "<ignored>",
    );

    assert(argv.includes("--print"), `argv=${JSON.stringify(argv)}`);
    assert(argv.includes("--approve-mcps"), `argv=${JSON.stringify(argv)}`);
    const wsIdx = argv.indexOf("--workspace");
    assert(wsIdx >= 0, `argv missing --workspace: ${JSON.stringify(argv)}`);
    assertEquals(argv[wsIdx + 1], "/tmp/ws");
    assert(
      !argv.includes("--mcp-config"),
      `argv must NOT contain --mcp-config: ${JSON.stringify(argv)}`,
    );

    const strategy = entry.mcpConfigStrategy;
    assertEquals(strategy.kind, "workspace-json");
    if (strategy.kind === "workspace-json") {
      assertEquals(strategy.relativePath, ".cursor/mcp.json");
      assertEquals(strategy.mergeKey, "mcpServers");
      assertEquals(strategy.entryName, "keni");
    }
  },
);

Deno.test(
  "codingAgentCliRegistry['cursor-agent'].buildArgs omits --workspace when invocation.workspacePath is null",
  () => {
    const entry = codingAgentCliRegistry["cursor-agent"];
    const argv = entry.buildArgs(
      fakeInvocation({ workspacePath: null }),
      "<ignored>",
    );
    assert(!argv.includes("--workspace"), `argv=${JSON.stringify(argv)}`);
    assert(argv.includes("--print"));
    assert(argv.includes("--approve-mcps"));
  },
);

Deno.test(
  "codingAgentCliRegistry['codex'].buildArgs uses 'exec' (no --mcp-config), and its strategy is workspace-toml under .codex/config.toml",
  () => {
    const entry = codingAgentCliRegistry["codex"];
    const argv = entry.buildArgs(fakeInvocation(), "<ignored>");

    assertEquals(argv[0], "exec", `argv=${JSON.stringify(argv)}`);
    assert(
      !argv.includes("--mcp-config"),
      `argv must NOT contain --mcp-config: ${JSON.stringify(argv)}`,
    );

    const strategy = entry.mcpConfigStrategy;
    assertEquals(strategy.kind, "workspace-toml");
    if (strategy.kind === "workspace-toml") {
      assertEquals(strategy.relativePath, ".codex/config.toml");
      assertEquals(strategy.tableHeader, "mcp_servers");
      assertEquals(strategy.entryName, "keni");
    }
  },
);

Deno.test("isKnownCli narrows the three documented names and rejects typos and the empty string", () => {
  for (const name of ["claude", "cursor-agent", "codex"] as const) {
    assertEquals(isKnownCli(name), true, `isKnownCli('${name}') must be true`);
  }
  for (const name of ["claud", "cursor_agent", "claudia", "", "CLAUDE"]) {
    assertEquals(isKnownCli(name), false, `isKnownCli('${name}') must be false`);
  }
});

Deno.test("a registry entry can be spread into createSubprocessCodingAgentInvoker without translation", () => {
  // Type-check shape: an entry must be assignable to the invoker's opts.
  const entry: CodingAgentCliEntry = codingAgentCliRegistry["claude"];
  const opts: SubprocessCodingAgentInvokerOpts = { ...entry };
  const invoker = createSubprocessCodingAgentInvoker(opts);
  assert(
    typeof invoker.invoke === "function",
    "createSubprocessCodingAgentInvoker must return an invoker",
  );
});

Deno.test("codingAgentCliRegistry is referentially stable across imports", async () => {
  // Re-import the module via a dynamic import; Deno's module cache returns the
  // same object instance, so the registry constant is the same reference.
  const reimport = await import("../../../src/common/codingAgentCliRegistry.ts");
  assertStrictEquals(reimport.codingAgentCliRegistry, codingAgentCliRegistry);
  assertStrictEquals(
    reimport.codingAgentCliRegistry["claude"],
    codingAgentCliRegistry["claude"],
  );
});

Deno.test("KnownCli union has exactly the three documented members at the type level", () => {
  // Exhaustiveness check: a `switch` over `KnownCli` with the three known
  // arms must satisfy a `never` assertion in the default branch.
  const exhaust = (k: KnownCli): string => {
    switch (k) {
      case "claude":
        return "claude";
      case "cursor-agent":
        return "cursor-agent";
      case "codex":
        return "codex";
      default: {
        const _never: never = k;
        return _never;
      }
    }
  };
  assertEquals(exhaust("claude"), "claude");
  assertEquals(exhaust("cursor-agent"), "cursor-agent");
  assertEquals(exhaust("codex"), "codex");
});

Deno.test(
  "McpConfigStrategy union has exactly the three documented members at the type level",
  () => {
    const exhaust = (s: McpConfigStrategy): string => {
      switch (s.kind) {
        case "tempfile-json":
          return "tempfile-json";
        case "workspace-json":
          return s.relativePath;
        case "workspace-toml":
          return s.relativePath;
        default: {
          const _never: never = s;
          return _never;
        }
      }
    };
    assertEquals(exhaust({ kind: "tempfile-json" }), "tempfile-json");
    assertEquals(
      exhaust({
        kind: "workspace-json",
        relativePath: "p",
        mergeKey: "k",
        entryName: "n",
      }),
      "p",
    );
    assertEquals(
      exhaust({
        kind: "workspace-toml",
        relativePath: "p",
        tableHeader: "h",
        entryName: "n",
      }),
      "p",
    );
  },
);

const CODING_AGENT_CLIS_DIR = fromFileUrl(
  new URL("../../../src/common/codingAgentClis", import.meta.url),
);

Deno.test(
  "registry assembly file does not contain inline per-CLI literal data",
  async () => {
    const registryPath = fromFileUrl(
      new URL("../../../src/common/codingAgentCliRegistry.ts", import.meta.url),
    );
    const text = await Deno.readTextFile(registryPath);
    // The registry assembly file must not redeclare the per-CLI literal
    // data — every entry's content lives in its own module.
    assert(
      !text.includes(`cliBinary: "claude"`),
      "registry file must not contain inline 'claude' cliBinary",
    );
    assert(
      !text.includes(`cliBinary: "cursor-agent"`),
      "registry file must not contain inline 'cursor-agent' cliBinary",
    );
    assert(
      !text.includes(`cliBinary: "codex"`),
      "registry file must not contain inline 'codex' cliBinary",
    );
    // It must import each per-CLI module by name.
    assert(text.includes('from "./codingAgentClis/claude.ts"'));
    assert(text.includes('from "./codingAgentClis/cursorAgent.ts"'));
    assert(text.includes('from "./codingAgentClis/codex.ts"'));
  },
);

Deno.test(
  "per-CLI modules under codingAgentClis/ do not import each other",
  async () => {
    const siblingNames = new Set<string>();
    for await (const entry of Deno.readDir(CODING_AGENT_CLIS_DIR)) {
      if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.endsWith("_test.ts")) {
        siblingNames.add(entry.name);
      }
    }
    assert(siblingNames.size >= 3, `expected ≥3 per-CLI modules, got ${siblingNames.size}`);

    for (const file of siblingNames) {
      const path = `${CODING_AGENT_CLIS_DIR}/${file}`;
      const text = await Deno.readTextFile(path);
      for (const sibling of siblingNames) {
        if (sibling === file) continue;
        const stem = sibling.replace(/\.ts$/, "");
        assert(
          !text.includes(`./codingAgentClis/${stem}`) &&
            !text.includes(`./${stem}.ts`) &&
            !text.includes(`./${stem}"`),
          `${file} must not import sibling ${sibling}`,
        );
      }
    }
  },
);

Deno.test(
  "every per-CLI module exports exactly one CodingAgentCliEntry constant",
  async () => {
    const expectedExports = new Map([
      ["claude.ts", "claudeEntry"],
      ["cursorAgent.ts", "cursorAgentEntry"],
      ["codex.ts", "codexEntry"],
    ]);
    for (const [file, exportName] of expectedExports.entries()) {
      const mod = await import(`../../../src/common/codingAgentClis/${file}`);
      const entry = (mod as Record<string, unknown>)[exportName];
      assert(
        entry !== undefined,
        `${file} must export ${exportName}`,
      );
      const e = entry as CodingAgentCliEntry;
      assert(typeof e.cliBinary === "string");
      assert(typeof e.buildArgs === "function");
    }
  },
);
