/**
 * Tests for the in-process {@link Mutex}: serialisation under
 * concurrent calls, error propagation, and lock release on throw.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createMutex } from "../../../src/concurrency/mutex.ts";

Deno.test("runExclusive serialises concurrent callers in arrival order", async () => {
  const mutex = createMutex();
  const order: string[] = [];

  const tasks = ["a", "b", "c", "d"].map((tag) =>
    mutex.runExclusive(async () => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`${tag}:end`);
      return tag;
    })
  );

  const results = await Promise.all(tasks);
  assertEquals(results, ["a", "b", "c", "d"]);
  assertEquals(order, [
    "a:start",
    "a:end",
    "b:start",
    "b:end",
    "c:start",
    "c:end",
    "d:start",
    "d:end",
  ]);
});

Deno.test("runExclusive releases the lock when the body throws", async () => {
  const mutex = createMutex();
  await assertRejects(
    () => mutex.runExclusive(() => Promise.reject(new Error("boom"))),
    Error,
    "boom",
  );
  assertEquals(mutex.isLocked(), false);

  const result = await mutex.runExclusive(() => Promise.resolve("ok"));
  assertEquals(result, "ok");
});

Deno.test("isLocked() reports true while a call is in flight", async () => {
  const mutex = createMutex();
  let release!: () => void;
  const blocker = new Promise<void>((r) => {
    release = r;
  });

  const inflight = mutex.runExclusive(async () => {
    await blocker;
    return "done";
  });

  assertEquals(mutex.isLocked(), true);
  release();
  await inflight;
  assertEquals(mutex.isLocked(), false);
});

Deno.test("a thrown body does not block subsequent callers", async () => {
  const mutex = createMutex();
  const calls: string[] = [];

  const failing = mutex.runExclusive(async () => {
    calls.push("fail-start");
    await new Promise((r) => setTimeout(r, 5));
    calls.push("fail-throw");
    throw new Error("nope");
  });
  const succeeding = mutex.runExclusive(() => {
    calls.push("ok");
    return "ok";
  });

  await assertRejects(() => failing, Error, "nope");
  const result = await succeeding;
  assertEquals(result, "ok");
  assertEquals(calls, ["fail-start", "fail-throw", "ok"]);
});

Deno.test("synchronous body return values are wrapped in a Promise", async () => {
  const mutex = createMutex();
  const out = mutex.runExclusive(() => 42);
  assert(out instanceof Promise);
  assertEquals(await out, 42);
});
