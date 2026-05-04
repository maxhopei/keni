/**
 * Tests for `shutdown.ts` — the graceful-shutdown sequence.
 *
 * Covers the seven scenarios in the `cli-start` capability spec's
 * "Graceful shutdown" requirement.
 */

import { assert, assertEquals } from "@std/assert";
import { clampShutdownGrace, runShutdownSequence, SHUTDOWN_GRACE_HARD_CAP_MS } from "./shutdown.ts";
import type {
  AgentRuntimeState,
  AgentRuntimeStateStore,
  InterruptResult,
  Scheduler,
} from "@keni/server";

interface RecordedCall {
  readonly kind: "stop" | "interrupt" | "abort";
  readonly id?: string;
  readonly at: number;
}

function makeFakes(opts: {
  agents: readonly { id: string; status: "idle" | "running" }[];
  interrupts?: Record<string, InterruptResult | Error>;
}): {
  readonly scheduler: Pick<Scheduler, "stop" | "interrupt">;
  readonly runtimeStore: Pick<AgentRuntimeStateStore, "list">;
  readonly serverHandle: { abort(): Promise<void> };
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let now = 0;
  const tick = () => {
    now += 1;
    return now;
  };
  return {
    calls,
    scheduler: {
      stop: () => {
        calls.push({ kind: "stop", at: tick() });
        return Promise.resolve();
      },
      interrupt: (id: string) => {
        calls.push({ kind: "interrupt", id, at: tick() });
        const outcome = opts.interrupts?.[id];
        if (outcome instanceof Error) return Promise.reject(outcome);
        if (outcome !== undefined) return Promise.resolve(outcome);
        return Promise.resolve({ interrupted: false, reason: "no_active_cycle" });
      },
    },
    runtimeStore: {
      list: () =>
        opts.agents.map((a): AgentRuntimeState => ({
          id: a.id,
          role: "engineer",
          status: a.status,
          last_activity: null,
          last_active_at: null,
          paused: false,
        })),
    },
    serverHandle: {
      abort: () => {
        calls.push({ kind: "abort", at: tick() });
        return Promise.resolve();
      },
    },
  };
}

Deno.test(
  "runShutdownSequence: clean run calls stop → interrupt(running) → abort and returns 0",
  async () => {
    const fakes = makeFakes({
      agents: [
        { id: "alice", status: "running" },
        { id: "qa-bob", status: "idle" },
        { id: "po", status: "running" },
      ],
    });
    const code = await runShutdownSequence({
      ...fakes,
      graceMs: 0,
      secondSignal: new AbortController().signal,
    });
    assertEquals(code, 0);
    const order = fakes.calls.map((c) => `${c.kind}:${c.id ?? ""}`);
    assertEquals(order, ["stop:", "interrupt:alice", "interrupt:po", "abort:"]);
  },
);

Deno.test(
  "runShutdownSequence: interrupts run in series (no overlap between two running agents)",
  async () => {
    const calls: string[] = [];
    let inFlight = 0;
    const scheduler: Pick<Scheduler, "stop" | "interrupt"> = {
      stop: () => Promise.resolve(),
      interrupt: async (id: string): Promise<InterruptResult> => {
        calls.push(`enter:${id}`);
        inFlight++;
        if (inFlight !== 1) {
          throw new Error("two interrupts overlapped — series guarantee violated");
        }
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        calls.push(`exit:${id}`);
        return { interrupted: false, reason: "no_active_cycle" };
      },
    };
    const fakes = makeFakes({
      agents: [
        { id: "alice", status: "running" },
        { id: "po", status: "running" },
      ],
    });
    const code = await runShutdownSequence({
      scheduler,
      runtimeStore: fakes.runtimeStore,
      serverHandle: fakes.serverHandle,
      graceMs: 0,
      secondSignal: new AbortController().signal,
    });
    assertEquals(code, 0);
    assertEquals(calls, ["enter:alice", "exit:alice", "enter:po", "exit:po"]);
  },
);

Deno.test(
  "runShutdownSequence: second signal short-circuits to 130 and skips abort",
  async () => {
    const fakes = makeFakes({
      agents: [{ id: "alice", status: "running" }],
    });
    const ctrl = new AbortController();
    ctrl.abort();
    const code = await runShutdownSequence({
      ...fakes,
      graceMs: 0,
      secondSignal: ctrl.signal,
    });
    assertEquals(code, 130);
    assert(!fakes.calls.some((c) => c.kind === "abort"), "abort must NOT run on forced shutdown");
  },
);

Deno.test(
  "runShutdownSequence: scheduler.interrupt rejection does not block the next agent",
  async () => {
    const fakes = makeFakes({
      agents: [
        { id: "alice", status: "running" },
        { id: "po", status: "running" },
      ],
      interrupts: { alice: new Error("boom") },
    });
    const warns: string[] = [];
    const code = await runShutdownSequence({
      ...fakes,
      graceMs: 0,
      secondSignal: new AbortController().signal,
      logSink: { warn: (m) => warns.push(m) },
    });
    assertEquals(code, 0);
    const interruptCalls = fakes.calls.filter((c) => c.kind === "interrupt").map((c) => c.id);
    assertEquals(interruptCalls, ["alice", "po"]);
    assert(warns.some((w) => w.includes("alice")));
  },
);

Deno.test(
  "runShutdownSequence: abort is called once when no agents are running",
  async () => {
    const fakes = makeFakes({
      agents: [{ id: "alice", status: "idle" }],
    });
    const code = await runShutdownSequence({
      ...fakes,
      graceMs: 0,
      secondSignal: new AbortController().signal,
    });
    assertEquals(code, 0);
    const order = fakes.calls.map((c) => c.kind);
    assertEquals(order, ["stop", "abort"]);
  },
);

Deno.test("clampShutdownGrace: returns the input when below the cap", () => {
  assertEquals(clampShutdownGrace(2_000), 2_000);
  assertEquals(clampShutdownGrace(SHUTDOWN_GRACE_HARD_CAP_MS), SHUTDOWN_GRACE_HARD_CAP_MS);
});

Deno.test("clampShutdownGrace: clamps values above the cap and warns", () => {
  const warns: string[] = [];
  const out = clampShutdownGrace(60_000, { warn: (m) => warns.push(m) });
  assertEquals(out, SHUTDOWN_GRACE_HARD_CAP_MS);
  assertEquals(warns.length, 1);
  assert(warns[0]!.includes("10000"));
});
