/**
 * Tests for `AgentRunnerRegistry` — dedup-by-role, replace emits info,
 * `roles()` returns insertion order, `get(unknown)` returns `null`.
 */

import { assertEquals } from "@std/assert";
import { captureSchedulerLogger, type SchedulerLogEntry } from "./log.ts";
import { type AgentRunner, createAgentRunnerRegistry } from "./registry.ts";

function fakeRunner(role: AgentRunner["role"]): AgentRunner {
  return {
    role,
    precheck: () => ({ kind: "skip", reason: "test" }),
    promptResolver: () => ({ name: "placeholder", body: "PLACEHOLDER" }),
    codingAgentInvoker: {
      invoke: () => Promise.resolve({ kind: "completed", exitCode: 0 }),
    },
    mcpServerConfig: { command: "echo", args: [] },
  };
}

Deno.test("registry — get(unknown) returns null", () => {
  const buffer: SchedulerLogEntry[] = [];
  const registry = createAgentRunnerRegistry(captureSchedulerLogger(buffer));
  assertEquals(registry.get("engineer"), null);
  assertEquals(registry.roles(), []);
});

Deno.test("registry — register makes the runner reachable via get", () => {
  const buffer: SchedulerLogEntry[] = [];
  const registry = createAgentRunnerRegistry(captureSchedulerLogger(buffer));
  const runner = fakeRunner("engineer");
  registry.register(runner);
  assertEquals(registry.get("engineer"), runner);
});

Deno.test("registry — roles() returns insertion order", () => {
  const buffer: SchedulerLogEntry[] = [];
  const registry = createAgentRunnerRegistry(captureSchedulerLogger(buffer));
  registry.register(fakeRunner("po"));
  registry.register(fakeRunner("engineer"));
  registry.register(fakeRunner("qa"));
  assertEquals(registry.roles(), ["po", "engineer", "qa"]);
});

Deno.test("registry — replace emits info `runner.replaced`", () => {
  const buffer: SchedulerLogEntry[] = [];
  const registry = createAgentRunnerRegistry(captureSchedulerLogger(buffer));
  const first = fakeRunner("engineer");
  const second = fakeRunner("engineer");
  registry.register(first);
  registry.register(second);
  assertEquals(registry.get("engineer"), second);
  const replaceLines = buffer.filter((b) => b.event === "runner.replaced");
  assertEquals(replaceLines.length, 1);
  assertEquals(replaceLines[0]!.level, "info");
  assertEquals(replaceLines[0]!.fields.role, "engineer");
  // `roles()` order is unchanged after a replace
  assertEquals(registry.roles(), ["engineer"]);
});

Deno.test("registry — replace does not duplicate the role in roles()", () => {
  const buffer: SchedulerLogEntry[] = [];
  const registry = createAgentRunnerRegistry(captureSchedulerLogger(buffer));
  registry.register(fakeRunner("engineer"));
  registry.register(fakeRunner("po"));
  registry.register(fakeRunner("engineer")); // replace
  assertEquals(registry.roles(), ["engineer", "po"]);
});
