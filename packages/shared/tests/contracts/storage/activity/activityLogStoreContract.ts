/**
 * Shared behavioural contract for {@link ActivityLogStore}.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { InvalidArtifactError } from "../../../../src/storage/errors.ts";
import type {
  ActivityEntry,
  ActivityLogStore,
} from "../../../../src/storage/activity/interface.ts";

export function runActivityLogStoreContract(
  name: string,
  factory: () => Promise<ActivityLogStore>,
): void {
  const test = (label: string, fn: () => Promise<void>) => {
    Deno.test(`${name} :: ${label}`, fn);
  };

  test("append assigns a uuidv7 id", async () => {
    const store = await factory();
    const entry = await store.append({
      session_id: "s1",
      agent: "alice",
      role: "engineer",
      event: "session_start",
    });
    assert(typeof entry.id === "string");
    const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    assert(uuidShape.test(entry.id), `expected uuid shape, got '${entry.id}'`);
  });

  test("append assigns a timestamp when one is not supplied", async () => {
    const store = await factory();
    const before = new Date().toISOString();
    const entry = await store.append({
      session_id: "s1",
      agent: "alice",
      role: "engineer",
      event: "x",
    });
    const after = new Date().toISOString();
    assert(entry.timestamp >= before);
    assert(entry.timestamp <= after);
  });

  test("append preserves a supplied timestamp", async () => {
    const store = await factory();
    const ts = "2026-04-30T17:00:00.000Z";
    const entry = await store.append({
      timestamp: ts,
      session_id: "s1",
      agent: "alice",
      role: "engineer",
      event: "x",
    });
    assertEquals(entry.timestamp, ts);
  });

  test("append normalises optional fields (summary defaults null, refs defaults {})", async () => {
    const store = await factory();
    const entry = await store.append({
      session_id: "s1",
      agent: "alice",
      role: "engineer",
      event: "x",
    });
    assertEquals(entry.summary, null);
    assertEquals(entry.refs, {});
  });

  test("two successive appends produce ids that sort lexicographically in append order", async () => {
    const store = await factory();
    const a = await store.append({
      session_id: "s",
      agent: "a",
      role: "r",
      event: "x",
    });
    const b = await store.append({
      session_id: "s",
      agent: "a",
      role: "r",
      event: "x",
    });
    assert(b.id > a.id, `expected ${b.id} > ${a.id}`);
  });

  test("query yields appended entries in id order", async () => {
    const store = await factory();
    for (let i = 0; i < 5; i++) {
      await store.append({
        session_id: "s1",
        agent: "alice",
        role: "engineer",
        event: `e${i}`,
      });
    }
    const collected = await drain(store.query());
    assertEquals(collected.length, 5);
    const ids = collected.map((e) => e.id);
    const sorted = [...ids].sort();
    assertEquals(ids, sorted);
  });

  test("query filters by agent", async () => {
    const store = await factory();
    await store.append({
      session_id: "s",
      agent: "alice",
      role: "engineer",
      event: "x",
    });
    await store.append({
      session_id: "s",
      agent: "bob",
      role: "engineer",
      event: "x",
    });
    const alices = await drain(store.query({ agent: "alice" }));
    assertEquals(alices.length, 1);
    assertEquals(alices[0]?.agent, "alice");
  });

  test("query filters by role", async () => {
    const store = await factory();
    await store.append({
      session_id: "s",
      agent: "alice",
      role: "engineer",
      event: "x",
    });
    await store.append({
      session_id: "s",
      agent: "alice",
      role: "qa",
      event: "x",
    });
    const qas = await drain(store.query({ role: "qa" }));
    assertEquals(qas.length, 1);
    assertEquals(qas[0]?.role, "qa");
  });

  test("query filters by date range (inclusive `from` and `to`)", async () => {
    const store = await factory();
    await store.append({
      timestamp: "2026-04-29T12:00:00.000Z",
      session_id: "s",
      agent: "alice",
      role: "engineer",
      event: "x",
    });
    await store.append({
      timestamp: "2026-04-30T12:00:00.000Z",
      session_id: "s",
      agent: "alice",
      role: "engineer",
      event: "x",
    });
    await store.append({
      timestamp: "2026-05-01T12:00:00.000Z",
      session_id: "s",
      agent: "alice",
      role: "engineer",
      event: "x",
    });
    const onlyApr30 = await drain(
      store.query({
        from: "2026-04-30T00:00:00.000Z",
        to: "2026-04-30T23:59:59.999Z",
      }),
    );
    assertEquals(onlyApr30.length, 1);
    assertEquals(onlyApr30[0]?.timestamp, "2026-04-30T12:00:00.000Z");
  });

  test("query yields nothing for an empty store", async () => {
    const store = await factory();
    const collected = await drain(store.query());
    assertEquals(collected, []);
  });

  test("append rejects an entry whose serialised JSON exceeds 4096 bytes", async () => {
    const store = await factory();
    const big = "x".repeat(5000);
    const err = await assertRejects(
      () =>
        store.append({
          session_id: "s",
          agent: "alice",
          role: "engineer",
          event: "x",
          summary: big,
        }),
      InvalidArtifactError,
    );
    assertEquals(err.reason, "size_exceeded");
    const collected = await drain(store.query());
    assertEquals(collected, []);
  });

  test("query returns refs map from appended entries", async () => {
    const store = await factory();
    await store.append({
      session_id: "s",
      agent: "alice",
      role: "engineer",
      event: "summary",
      summary: "merged",
      refs: { ticket: "ticket-0001", pr: "pr-0001" },
    });
    const collected = await drain(store.query());
    assertEquals(collected.length, 1);
    assertEquals(collected[0]?.refs, {
      ticket: "ticket-0001",
      pr: "pr-0001",
    });
    assertEquals(collected[0]?.summary, "merged");
  });
}

async function drain(
  iter: AsyncIterable<ActivityEntry>,
): Promise<ActivityEntry[]> {
  const out: ActivityEntry[] = [];
  for await (const entry of iter) {
    out.push(entry);
  }
  return out;
}
