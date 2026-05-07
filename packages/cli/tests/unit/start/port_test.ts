/**
 * Tests for `port.ts` — the port-range walker.
 *
 * Covers the four scenarios in the `cli-start` capability spec's
 * "Port handling" requirement.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { bindPortInRange, PortRangeExhaustedError } from "../../../src/start/port.ts";

interface FakeStartCall {
  readonly host: string;
  readonly port: number;
}

function makeFakeStartServer(
  outcomes: readonly ("ok" | "in_use" | "denied")[],
): {
  readonly start: (opts: { host: string; port: number }) => Promise<{ port: number }>;
  readonly calls: FakeStartCall[];
} {
  const calls: FakeStartCall[] = [];
  let cursor = 0;
  return {
    calls,
    start: (opts) => {
      calls.push(opts);
      const outcome = outcomes[cursor++];
      if (outcome === "ok") return Promise.resolve({ port: opts.port });
      if (outcome === "in_use") {
        return Promise.reject(new Deno.errors.AddrInUse(`busy ${opts.port}`));
      }
      if (outcome === "denied") {
        return Promise.reject(new Deno.errors.PermissionDenied(`denied ${opts.port}`));
      }
      return Promise.reject(new Error(`no outcome staged at index ${cursor - 1}`));
    },
  };
}

Deno.test("bindPortInRange: walks past a busy first port to the next free one", async () => {
  const fake = makeFakeStartServer(["in_use", "ok"]);
  const handle = await bindPortInRange({
    startServer: fake.start,
    host: "127.0.0.1",
    range: { start: 7777, end: 7787 },
  });
  assertEquals(handle.port, 7778);
  assertEquals(fake.calls.length, 2);
  assertEquals(fake.calls[0]!.port, 7777);
  assertEquals(fake.calls[1]!.port, 7778);
});

Deno.test(
  "bindPortInRange: range exhaustion throws PortRangeExhaustedError",
  async () => {
    const fake = makeFakeStartServer(["in_use", "in_use", "in_use"]);
    await assertRejects(
      () =>
        bindPortInRange({
          startServer: fake.start,
          host: "127.0.0.1",
          range: { start: 7777, end: 7779 },
        }),
      PortRangeExhaustedError,
    );
    assertEquals(fake.calls.length, 3);
  },
);

Deno.test("bindPortInRange: --port n (single-port range) does not retry on busy", async () => {
  const fake = makeFakeStartServer(["in_use"]);
  await assertRejects(
    () =>
      bindPortInRange({
        startServer: fake.start,
        host: "127.0.0.1",
        range: { start: 8080, end: 8080 },
      }),
    PortRangeExhaustedError,
    "8080",
  );
  assertEquals(fake.calls.length, 1);
});

Deno.test(
  "bindPortInRange: non-AddrInUse errors (e.g., PermissionDenied) do not retry",
  async () => {
    const fake = makeFakeStartServer(["denied"]);
    let thrown: unknown;
    try {
      await bindPortInRange({
        startServer: fake.start,
        host: "127.0.0.1",
        range: { start: 80, end: 90 },
      });
    } catch (e) {
      thrown = e;
    }
    assert(
      thrown instanceof Deno.errors.PermissionDenied,
      `expected PermissionDenied, got ${thrown}`,
    );
    assertEquals(fake.calls.length, 1);
  },
);

Deno.test("bindPortInRange: warns the supplied LogSink on each AddrInUse skip", async () => {
  const warns: string[] = [];
  const fake = makeFakeStartServer(["in_use", "in_use", "ok"]);
  await bindPortInRange({
    startServer: fake.start,
    host: "127.0.0.1",
    range: { start: 7777, end: 7779 },
    logSink: { warn: (m) => warns.push(m) },
  });
  assertEquals(warns.length, 2);
  assert(warns[0]!.includes("7777"));
  assert(warns[1]!.includes("7778"));
});
