/**
 * Pin the closed `KnownCli` set, the per-entry shape, and the
 * documented argv invariants for the `claude` entry. These tests are
 * the contract surface for `engineer-runner-production-wiring` —
 * they ensure adding a new CLI is a deliberate code change with
 * scenarios, not a config-file edit.
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  type CodingAgentCliEntry,
  codingAgentCliRegistry,
  isKnownCli,
  type KnownCli,
} from "./codingAgentCliRegistry.ts";
import {
  createSubprocessCodingAgentInvoker,
  type SubprocessCodingAgentInvokerOpts,
} from "./codingAgentInvoker.ts";
import type { CodingAgentInvocation, McpServerConfig } from "./types.ts";
import type { AgentId } from "@keni/shared";

const FAKE_MCP_CONFIG: McpServerConfig = {
  command: "deno",
  args: ["run", "-A", "/abs/mcp/main.ts"],
};

function fakeInvocation(): CodingAgentInvocation {
  return {
    promptBody: "hello",
    role: "engineer",
    agentId: "alice" as AgentId,
    projectName: "demo",
    workspacePath: "/tmp/ws",
    mcpServerConfig: FAKE_MCP_CONFIG,
    resumeSessionId: null,
    envAllowlist: ["HOME", "PATH"],
  };
}

Deno.test("codingAgentCliRegistry: Object.keys matches the closed KnownCli set", () => {
  const keys = Object.keys(codingAgentCliRegistry).sort();
  assertEquals(keys, ["claude", "codex", "cursor-agent"]);
});

Deno.test(
  "codingAgentCliRegistry: every entry has the documented shape (cliBinary, buildArgs, promptInjection, resumeFlag, envAllowlist)",
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
  "codingAgentCliRegistry['claude'].buildArgs includes the mcpConfigPath exactly once and a non-interactive flag, and excludes --interactive",
  () => {
    const argv = codingAgentCliRegistry["claude"].buildArgs(
      fakeInvocation(),
      "/tmp/mcp-1234.json",
    );

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
  const reimport = await import("./codingAgentCliRegistry.ts");
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
