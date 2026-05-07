/**
 * Unit tests for `startCycle.ts` against the fake invoker (group 8) and
 * a fake activity-log client (a small in-memory test double). Covers
 * every outcome plus the documented edge cases (resume id plumbing,
 * per-stream cap, no mutation of params, role-agnosticism).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { ActivityAppendRequest, AgentId } from "@keni/shared";
import { createFakeCodingAgentInvoker } from "../fakes/fakeCodingAgentInvoker.ts";
import { startCycle } from "../../src/startCycle.ts";
import type { ActivityLogClient } from "../../src/activityClient.ts";
import { RoleRuntimeError } from "../../src/types.ts";
import type {
  BundledPrompt,
  CyclePrepCtx,
  PrecheckResult,
  RoleCycleParams,
} from "../../src/types.ts";

interface RecordedCall {
  readonly method: string;
  readonly args: Record<string, unknown>;
}

interface FakeClientHandle {
  readonly client: ActivityLogClient;
  readonly calls: () => readonly RecordedCall[];
  readonly setError: (method: string, error: Error) => void;
}

function createFakeActivityLogClient(): FakeClientHandle {
  const calls: RecordedCall[] = [];
  const errors = new Map<string, Error>();
  const record = <T>(method: string, args: T): Promise<void> => {
    calls.push({ method, args: args as unknown as Record<string, unknown> });
    const err = errors.get(method);
    if (err !== undefined) return Promise.reject(err);
    return Promise.resolve();
  };
  const client: ActivityLogClient = {
    appendSessionStart: (input) => record("appendSessionStart", input),
    appendSessionEnd: (input) => record("appendSessionEnd", input),
    appendIdle: (input) => record("appendIdle", input),
    appendSubprocessOutput: (input) => record("appendSubprocessOutput", input),
    appendSubprocessOutputTruncated: (input) => record("appendSubprocessOutputTruncated", input),
    appendRaw: (input: ActivityAppendRequest) => record("appendRaw", input),
  };
  return {
    client,
    calls: () => calls.slice(),
    setError: (method, error) => {
      errors.set(method, error);
    },
  };
}

const PLACEHOLDER_PROMPT: BundledPrompt = { name: "placeholder", body: "PROMPT BODY\n" };

function baseParams(
  override: Partial<RoleCycleParams> = {},
  precheckResult: PrecheckResult = { kind: "proceed", roleContext: { summary: null } },
): RoleCycleParams {
  return {
    role: "engineer",
    agentId: "alice" as AgentId,
    serverUrl: "http://127.0.0.1:9999",
    projectName: "test-project",
    mcpServerConfig: { command: "echo", args: [] },
    precheck: () => precheckResult,
    promptResolver: () => PLACEHOLDER_PROMPT,
    codingAgentInvoker: { invoke: () => Promise.reject(new Error("not configured")) },
    ...override,
  };
}

Deno.test("startCycle — completed: emits session_start + N subprocess_stdout + session_end", async () => {
  const fakeInvoker = createFakeCodingAgentInvoker();
  const fakeClient = createFakeActivityLogClient();
  const params = baseParams({ codingAgentInvoker: fakeInvoker.invoker });
  const cyclePromise = startCycle(params, { createClient: () => fakeClient.client });
  // Wait a tick so the cycle reaches the invoker
  await wait(0);
  for (let i = 0; i < 5; i++) {
    await fakeInvoker.pushStdoutLine(i === 4 ? "summary line" : `line ${i}`);
  }
  fakeInvoker.resolveCompleted(0);
  const result = await cyclePromise;
  assertEquals(result.outcome, "completed");
  if (result.outcome === "completed") {
    assertEquals(result.exitCode, 0);
    assertEquals(result.summary, "summary line");
  }
  const calls = fakeClient.calls();
  assertEquals(calls[0]!.method, "appendSessionStart");
  for (let i = 1; i <= 5; i++) {
    assertEquals(calls[i]!.method, "appendSubprocessOutput");
  }
  assertEquals(calls[6]!.method, "appendSessionEnd");
  assertEquals(calls.length, 7);
});

Deno.test("startCycle — idle: emits appendSessionStart and appendIdle, no session_end", async () => {
  const fakeInvoker = createFakeCodingAgentInvoker();
  const fakeClient = createFakeActivityLogClient();
  const params = baseParams({
    codingAgentInvoker: fakeInvoker.invoker,
    idleThresholdMs: 5000,
  });
  const cyclePromise = startCycle(params, { createClient: () => fakeClient.client });
  await wait(0);
  fakeInvoker.resolveCompleted(0);
  const result = await cyclePromise;
  assertEquals(result.outcome, "idle");
  const calls = fakeClient.calls();
  assertEquals(calls.map((c) => c.method), ["appendSessionStart", "appendIdle"]);
});

Deno.test("startCycle — precheck_skipped: no activity-log calls", async () => {
  const fakeInvoker = createFakeCodingAgentInvoker();
  const fakeClient = createFakeActivityLogClient();
  const params = baseParams({ codingAgentInvoker: fakeInvoker.invoker }, {
    kind: "skip",
    reason: "no_work",
  });
  const result = await startCycle(params, { createClient: () => fakeClient.client });
  assertEquals(result.outcome, "precheck_skipped");
  if (result.outcome === "precheck_skipped") {
    assertEquals(result.reason, "no_work");
  }
  assertEquals(fakeClient.calls().length, 0);
  assertEquals(fakeInvoker.invocationCount(), 0);
});

Deno.test("startCycle — terminated: appendSessionEnd carries refs.terminated_by:sigterm", async () => {
  const fakeInvoker = createFakeCodingAgentInvoker();
  const fakeClient = createFakeActivityLogClient();
  const params = baseParams({ codingAgentInvoker: fakeInvoker.invoker });
  const cyclePromise = startCycle(params, { createClient: () => fakeClient.client });
  await wait(0);
  await fakeInvoker.pushStdoutLine("partial line");
  fakeInvoker.resolveTerminated(143, "sigterm");
  const result = await cyclePromise;
  assertEquals(result.outcome, "terminated");
  if (result.outcome === "terminated") {
    assertEquals(result.terminatedBy, "sigterm");
    assertEquals(result.exitCode, 143);
  }
  const sessionEnd = fakeClient.calls().find((c) => c.method === "appendSessionEnd");
  assert(sessionEnd !== undefined);
  const args = sessionEnd!.args as Record<string, unknown>;
  assertEquals(args.terminatedBy, "sigterm");
  assertEquals((args.refs as Record<string, string>)?.exit_code, undefined);
  // sessionEnd refs is built by activityClient (not by the cycle); the cycle
  // hands `terminatedBy` to the typed method, so refs at this layer is `{}`.
});

Deno.test("startCycle — spawn_failed: invoker throws synchronously, final session_end with refs.spawn_failed and refs.error", async () => {
  const fakeInvoker = createFakeCodingAgentInvoker();
  fakeInvoker.throwOnInvoke(new Error("binary not found: claude"));
  const fakeClient = createFakeActivityLogClient();
  const params = baseParams({ codingAgentInvoker: fakeInvoker.invoker });
  const result = await startCycle(params, { createClient: () => fakeClient.client });
  assertEquals(result.outcome, "spawn_failed");
  if (result.outcome === "spawn_failed") {
    assertEquals(result.error.message, "binary not found: claude");
  }
  const calls = fakeClient.calls();
  assertEquals(calls[0]!.method, "appendSessionStart");
  const sessionEnd = calls.find((c) => c.method === "appendSessionEnd");
  assert(sessionEnd !== undefined);
  const seArgs = sessionEnd!.args as Record<string, unknown>;
  const refs = seArgs.refs as Record<string, string>;
  assertEquals(refs.spawn_failed, "true");
  // The cycle MUST surface the failure cause in the activity-log entry
  // itself so an operator can diagnose without grepping the scheduler
  // stderr; both the human-readable summary and the structured `error`
  // ref carry the message.
  assertEquals(refs.error, "Error: binary not found: claude");
  assertEquals(seArgs.summary, "binary not found: claude");
});

Deno.test("startCycle — resume id plumbed: refs.resume_session_id present, invocation field set, sessions distinct", async () => {
  const fakeInvoker = createFakeCodingAgentInvoker();
  const fakeClient = createFakeActivityLogClient();
  const params = baseParams({
    codingAgentInvoker: fakeInvoker.invoker,
    resumeSessionId: "cli-id-A",
  });
  const cyclePromise = startCycle(params, { createClient: () => fakeClient.client });
  await wait(0);
  fakeInvoker.resolveCompleted(0);
  const result = await cyclePromise;

  // session_start refs include resume_session_id
  const sessionStart = fakeClient.calls()[0]!;
  const sessionStartArgs = sessionStart.args as Record<string, unknown>;
  const refs = sessionStartArgs.refs as Record<string, string>;
  assertEquals(refs.resume_session_id, "cli-id-A");

  // captured invocation has resumeSessionId verbatim
  const invocation = fakeInvoker.capturedInvocation();
  assert(invocation !== null);
  assertEquals(invocation!.resumeSessionId, "cli-id-A");

  // runtime sessionId is distinct from the resumed CLI session id
  assert("sessionId" in result);
  assertNotEquals((result as { sessionId: string }).sessionId, "cli-id-A");
});

Deno.test("startCycle — empty resumeSessionId rejected at the cycle boundary", async () => {
  const fakeInvoker = createFakeCodingAgentInvoker();
  const fakeClient = createFakeActivityLogClient();
  const params = baseParams({
    codingAgentInvoker: fakeInvoker.invoker,
    resumeSessionId: "",
  });
  const result = await startCycle(params, { createClient: () => fakeClient.client });
  assertEquals(result.outcome, "spawn_failed");
  if (result.outcome === "spawn_failed") {
    assert(result.error instanceof RoleRuntimeError);
    const e = result.error as RoleRuntimeError;
    assertEquals(e.code, "invalid_resume_session_id");
  }
  // No POST /activity issued for the rejected resume id.
  assertEquals(fakeClient.calls().length, 0);
});

Deno.test("startCycle — no resume id ⇒ no refs.resume_session_id, no invocation.resumeSessionId", async () => {
  const fakeInvoker = createFakeCodingAgentInvoker();
  const fakeClient = createFakeActivityLogClient();
  const params = baseParams({ codingAgentInvoker: fakeInvoker.invoker });
  const cyclePromise = startCycle(params, { createClient: () => fakeClient.client });
  await wait(0);
  fakeInvoker.resolveCompleted(0);
  await cyclePromise;
  const sessionStart = fakeClient.calls()[0]!;
  const refs = (sessionStart.args as Record<string, unknown>).refs;
  assertEquals(refs, undefined);
  const invocation = fakeInvoker.capturedInvocation();
  assertEquals(invocation!.resumeSessionId, null);
});

Deno.test("startCycle — per-stream cap: 1500 lines emit 1000 + one truncated entry, summary is line 1499", async () => {
  const fakeInvoker = createFakeCodingAgentInvoker();
  const fakeClient = createFakeActivityLogClient();
  const params = baseParams({ codingAgentInvoker: fakeInvoker.invoker });
  const cyclePromise = startCycle(params, { createClient: () => fakeClient.client });
  await wait(0);
  for (let i = 0; i < 1500; i++) {
    await fakeInvoker.pushStdoutLine(`line ${i}`);
  }
  fakeInvoker.resolveCompleted(0);
  const result = await cyclePromise;
  assertEquals(result.outcome, "completed");
  if (result.outcome === "completed") {
    assertEquals(result.summary, "line 1499");
  }
  const stdoutEmissions = fakeClient.calls().filter((c) => c.method === "appendSubprocessOutput");
  assertEquals(stdoutEmissions.length, 1000);
  const truncatedEmissions = fakeClient.calls().filter((c) =>
    c.method === "appendSubprocessOutputTruncated"
  );
  assertEquals(truncatedEmissions.length, 1);
  assertEquals(
    (truncatedEmissions[0]!.args as Record<string, unknown>).droppedCount,
    500,
  );
});

Deno.test("startCycle — params bag is not mutated across two invocations", async () => {
  const fakeInvoker1 = createFakeCodingAgentInvoker();
  const fakeInvoker2 = createFakeCodingAgentInvoker();
  const fakeClient = createFakeActivityLogClient();
  const params = baseParams({
    codingAgentInvoker: fakeInvoker1.invoker,
  });
  const before = JSON.stringify(structuralSnapshot(params));
  const cyclePromise = startCycle(params, { createClient: () => fakeClient.client });
  await wait(0);
  fakeInvoker1.resolveCompleted(0);
  await cyclePromise;
  const after1 = JSON.stringify(structuralSnapshot(params));
  assertEquals(after1, before);
  // Second invocation against same params (with a new fake invoker swapped via cast).
  const params2 = { ...params, codingAgentInvoker: fakeInvoker2.invoker };
  const cyclePromise2 = startCycle(params2, { createClient: () => fakeClient.client });
  await wait(0);
  fakeInvoker2.resolveCompleted(0);
  await cyclePromise2;
  const after2 = JSON.stringify(structuralSnapshot(params));
  assertEquals(after2, before);
});

Deno.test("startCycle — stderr does not contribute to summary; stderr-only completed produces summary:null", async () => {
  const fakeInvoker = createFakeCodingAgentInvoker();
  const fakeClient = createFakeActivityLogClient();
  const params = baseParams({
    codingAgentInvoker: fakeInvoker.invoker,
    idleThresholdMs: 0, // force non-idle path even on a fast cycle
  });
  const cyclePromise = startCycle(params, { createClient: () => fakeClient.client });
  await wait(0);
  await fakeInvoker.pushStderrLine("err 1");
  await fakeInvoker.pushStderrLine("err 2");
  // Wait a hair so wallTime > idleThreshold of 0 reliably
  await wait(5);
  fakeInvoker.resolveCompleted(0);
  const result = await cyclePromise;
  assertEquals(result.outcome, "completed");
  if (result.outcome === "completed") {
    assertEquals(result.summary, null);
  }
});

Deno.test("startCycle — same code path runs for engineer and po roles (role is a parameter, not a code path)", async () => {
  for (const role of ["engineer", "po"] as const) {
    const fakeInvoker = createFakeCodingAgentInvoker();
    const fakeClient = createFakeActivityLogClient();
    const params = baseParams({ role, codingAgentInvoker: fakeInvoker.invoker });
    const cyclePromise = startCycle(params, { createClient: () => fakeClient.client });
    await wait(0);
    await fakeInvoker.pushStdoutLine("done");
    fakeInvoker.resolveCompleted(0);
    const result = await cyclePromise;
    assertEquals(result.outcome, "completed");
    const calls = fakeClient.calls();
    // Identical step sequence regardless of role.
    assertEquals(calls.map((c) => c.method), [
      "appendSessionStart",
      "appendSubprocessOutput",
      "appendSessionEnd",
    ]);
  }
});

Deno.test("startCycle — activity-log POST failure surfaces as spawn_failed", async () => {
  const fakeInvoker = createFakeCodingAgentInvoker();
  const fakeClient = createFakeActivityLogClient();
  fakeClient.setError("appendSessionStart", new Error("ECONNREFUSED"));
  const params = baseParams({ codingAgentInvoker: fakeInvoker.invoker });
  const result = await startCycle(params, { createClient: () => fakeClient.client });
  assertEquals(result.outcome, "spawn_failed");
});

Deno.test("startCycle — empty prompt body throws inside the cycle and surfaces as spawn_failed", async () => {
  const fakeInvoker = createFakeCodingAgentInvoker();
  const fakeClient = createFakeActivityLogClient();
  const params = baseParams({
    codingAgentInvoker: fakeInvoker.invoker,
    promptResolver: () => ({ name: "placeholder", body: "" }),
  });
  const result = await startCycle(params, { createClient: () => fakeClient.client });
  assertEquals(result.outcome, "spawn_failed");
  // The cycle issued session_start before the prompt resolver threw; followed
  // by a best-effort session_end with refs.spawn_failed:"true".
  const calls = fakeClient.calls();
  assertEquals(calls[0]!.method, "appendSessionStart");
  const sessionEnd = calls.find((c) => c.method === "appendSessionEnd");
  assert(sessionEnd !== undefined);
});

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function structuralSnapshot(params: RoleCycleParams): Record<string, unknown> {
  return {
    role: params.role,
    agentId: params.agentId,
    serverUrl: params.serverUrl,
    projectName: params.projectName,
    workspacePath: params.workspacePath,
    resumeSessionId: params.resumeSessionId,
    expectedPromptName: params.expectedPromptName,
    idleThresholdMs: params.idleThresholdMs,
    terminationGraceMs: params.terminationGraceMs,
    maxLinesPerStream: params.maxLinesPerStream,
    envAllowlist: params.envAllowlist,
    mcpServerConfig: params.mcpServerConfig,
  };
}

// Ensure unused imports stay used.
const _typeRefs: [CyclePrepCtx | null] = [null];
if (_typeRefs[0] !== null) throw new Error("unreachable");
