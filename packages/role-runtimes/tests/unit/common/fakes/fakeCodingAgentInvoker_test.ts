import { assertEquals, assertThrows } from "@std/assert";
import type { AgentId } from "@keni/shared";
import { createFakeCodingAgentInvoker } from "../../../fakes/common/fakeCodingAgentInvoker.ts";
import type {
  CodingAgentInvocation,
  CodingAgentLifecycle,
  CodingAgentOutcome,
} from "../../../../src/common/types.ts";

function baseInvocation(): CodingAgentInvocation {
  return {
    promptBody: "x",
    role: "engineer",
    agentId: "alice" as AgentId,
    projectName: "test",
    workspacePath: null,
    mcpServerConfig: { command: "echo", args: [] },
    resumeSessionId: null,
    envAllowlist: [],
  };
}

function makeLifecycle(): {
  readonly bag: CodingAgentLifecycle;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    bag: {
      onStdoutLine: (line) => {
        stdout.push(line);
      },
      onStderrLine: (line) => {
        stderr.push(line);
      },
    },
    stdout,
    stderr,
  };
}

Deno.test("fake — pushStdoutLine invokes lifecycle.onStdoutLine", async () => {
  const fake = createFakeCodingAgentInvoker();
  const lifecycle = makeLifecycle();
  const invokePromise = fake.invoker.invoke(baseInvocation(), lifecycle.bag);
  await fake.pushStdoutLine("line 1");
  await fake.pushStdoutLine("line 2");
  fake.resolveCompleted(0);
  const outcome = await invokePromise;
  assertEquals(lifecycle.stdout, ["line 1", "line 2"]);
  assertEquals(outcome.kind, "completed");
  assertEquals((outcome as Extract<CodingAgentOutcome, { kind: "completed" }>).exitCode, 0);
});

Deno.test("fake — pushStderrLine invokes lifecycle.onStderrLine", async () => {
  const fake = createFakeCodingAgentInvoker();
  const lifecycle = makeLifecycle();
  const invokePromise = fake.invoker.invoke(baseInvocation(), lifecycle.bag);
  await fake.pushStderrLine("warn");
  fake.resolveCompleted(0);
  await invokePromise;
  assertEquals(lifecycle.stderr, ["warn"]);
});

Deno.test("fake — resolveTerminated yields kind:terminated with the documented fields", async () => {
  const fake = createFakeCodingAgentInvoker();
  const lifecycle = makeLifecycle();
  const invokePromise = fake.invoker.invoke(baseInvocation(), lifecycle.bag);
  fake.resolveTerminated(143, "sigterm");
  const outcome = await invokePromise;
  assertEquals(outcome.kind, "terminated");
  const t = outcome as Extract<CodingAgentOutcome, { kind: "terminated" }>;
  assertEquals(t.exitCode, 143);
  assertEquals(t.terminatedBy, "sigterm");
});

Deno.test("fake — captures the invocation handed to invoke()", async () => {
  const fake = createFakeCodingAgentInvoker();
  const lifecycle = makeLifecycle();
  const invocation = baseInvocation();
  const invokePromise = fake.invoker.invoke(invocation, lifecycle.bag);
  fake.resolveCompleted(0);
  await invokePromise;
  assertEquals(fake.capturedInvocation(), invocation);
  assertEquals(fake.invocationCount(), 1);
});

Deno.test("fake — throwOnInvoke throws synchronously on invoke()", () => {
  const fake = createFakeCodingAgentInvoker();
  fake.throwOnInvoke(new Error("binary not found: claude"));
  const lifecycle = makeLifecycle();
  const err = assertThrows(
    () => {
      void fake.invoker.invoke(baseInvocation(), lifecycle.bag);
    },
    Error,
  );
  assertEquals(err.message, "binary not found: claude");
});

Deno.test("fake — fakePid is forwarded via lifecycle.onSpawn", async () => {
  const fake = createFakeCodingAgentInvoker({ fakePid: 4242 });
  const seen: number[] = [];
  const lifecycle: CodingAgentLifecycle = {
    onStdoutLine: () => {},
    onStderrLine: () => {},
    onSpawn: (info) => {
      seen.push(info.pid);
    },
  };
  const invokePromise = fake.invoker.invoke(baseInvocation(), lifecycle);
  fake.resolveCompleted(0);
  await invokePromise;
  assertEquals(seen, [4242]);
});
