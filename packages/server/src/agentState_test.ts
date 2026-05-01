/**
 * Tests for the in-memory `AgentRuntimeStateStore`. Covers seeding,
 * `read` not-found, `setPaused` debounce, and the full
 * `applyActivityEvent` decision table.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { type ActivityEntryResponse, type AgentConfig, StoreNotFoundError } from "@keni/shared";
import { createInMemoryAgentRuntimeStateStore } from "./agentState.ts";

const ROSTER: readonly AgentConfig[] = [
  { id: "alice", role: "engineer" },
  { id: "qa-bob", role: "qa" },
];

function entry(partial: {
  agent: string;
  event: string;
  timestamp?: string;
  role?: string;
  session_id?: string;
}): ActivityEntryResponse {
  return {
    id: `01900000-0000-7000-8000-${Date.now().toString(16).padStart(12, "0")}`,
    timestamp: partial.timestamp ?? "2026-05-01T10:00:00.000Z",
    session_id: partial.session_id ?? "s1",
    agent: partial.agent,
    role: partial.role ?? "engineer",
    event: partial.event,
    summary: null,
    refs: {},
  };
}

Deno.test("list() returns the seeded roster in declaration order with default fields", () => {
  const store = createInMemoryAgentRuntimeStateStore(ROSTER);
  const list = store.list();
  assertEquals(list.length, 2);
  assertEquals(list[0]!.id, "alice");
  assertEquals(list[0]!.role, "engineer");
  assertEquals(list[0]!.status, "idle");
  assertEquals(list[0]!.last_activity, null);
  assertEquals(list[0]!.last_active_at, null);
  assertEquals(list[0]!.paused, false);
  assertEquals(list[1]!.id, "qa-bob");
});

Deno.test("list() on an empty roster returns an empty array", () => {
  const store = createInMemoryAgentRuntimeStateStore([]);
  assertEquals(store.list(), []);
});

Deno.test("read(unknown) throws StoreNotFoundError", () => {
  const store = createInMemoryAgentRuntimeStateStore(ROSTER);
  assertThrows(() => store.read("ghost"), StoreNotFoundError);
});

Deno.test("setPaused flips the flag and reports changed: true", () => {
  const store = createInMemoryAgentRuntimeStateStore(ROSTER);
  const { state, changed } = store.setPaused("alice", true);
  assertEquals(changed, true);
  assertEquals(state.paused, true);
  assertEquals(store.read("alice").paused, true);
});

Deno.test("setPaused is debounced — same value reports changed: false", () => {
  const store = createInMemoryAgentRuntimeStateStore(ROSTER);
  store.setPaused("alice", true);
  const second = store.setPaused("alice", true);
  assertEquals(second.changed, false);
  assertEquals(second.state.paused, true);
});

Deno.test("setPaused on unknown id throws StoreNotFoundError", () => {
  const store = createInMemoryAgentRuntimeStateStore(ROSTER);
  assertThrows(() => store.setPaused("ghost", true), StoreNotFoundError);
});

Deno.test("applyActivityEvent — session_start flips status to running and reports changed", () => {
  const store = createInMemoryAgentRuntimeStateStore(ROSTER);
  const { state, changed } = store.applyActivityEvent(
    entry({ agent: "alice", event: "session_start" }),
  );
  assertEquals(changed, true);
  assert(state !== null);
  assertEquals(state.status, "running");
  assertEquals(state.last_activity, "session_start");
  assertEquals(state.last_active_at, "2026-05-01T10:00:00.000Z");
});

Deno.test("applyActivityEvent — session_end flips status to idle and reports changed", () => {
  const store = createInMemoryAgentRuntimeStateStore(ROSTER);
  store.applyActivityEvent(entry({ agent: "alice", event: "session_start" }));
  const { state, changed } = store.applyActivityEvent(
    entry({ agent: "alice", event: "session_end", timestamp: "2026-05-01T10:01:00.000Z" }),
  );
  assertEquals(changed, true);
  assert(state !== null);
  assertEquals(state.status, "idle");
  assertEquals(state.last_activity, "session_end");
});

Deno.test("applyActivityEvent — session_interrupted, session_timeout, idle all map to idle", () => {
  for (const event of ["session_interrupted", "session_timeout", "idle"]) {
    const store = createInMemoryAgentRuntimeStateStore(ROSTER);
    store.applyActivityEvent(entry({ agent: "alice", event: "session_start" }));
    const { state, changed } = store.applyActivityEvent(
      entry({ agent: "alice", event, timestamp: "2026-05-01T10:01:00.000Z" }),
    );
    assertEquals(changed, true, `event=${event} should flip running → idle`);
    assert(state !== null);
    assertEquals(state.status, "idle");
    assertEquals(state.last_activity, event);
  }
});

Deno.test("applyActivityEvent — non-state-changing event updates last_* but reports changed: false", () => {
  const store = createInMemoryAgentRuntimeStateStore(ROSTER);
  store.applyActivityEvent(entry({ agent: "alice", event: "session_start" }));
  const { state, changed } = store.applyActivityEvent(
    entry({ agent: "alice", event: "summary", timestamp: "2026-05-01T10:00:30.000Z" }),
  );
  assertEquals(changed, false);
  assert(state !== null);
  assertEquals(state.status, "running");
  assertEquals(state.last_activity, "summary");
  assertEquals(state.last_active_at, "2026-05-01T10:00:30.000Z");
});

Deno.test("applyActivityEvent — already-idle agent receiving session_end reports changed: false", () => {
  const store = createInMemoryAgentRuntimeStateStore(ROSTER);
  const { changed } = store.applyActivityEvent(
    entry({ agent: "alice", event: "session_end" }),
  );
  assertEquals(changed, false);
});

Deno.test("applyActivityEvent — unknown agent returns null state and changed: false", () => {
  const store = createInMemoryAgentRuntimeStateStore(ROSTER);
  const { state, changed } = store.applyActivityEvent(
    entry({ agent: "ghost", event: "session_start" }),
  );
  assertEquals(state, null);
  assertEquals(changed, false);
  assert(
    !store.list().some((s) => s.id === "ghost"),
    "unknown agent must not be added to the roster",
  );
});

Deno.test("applyActivityEvent does not flip paused; setPaused does not flip status", () => {
  const store = createInMemoryAgentRuntimeStateStore(ROSTER);
  store.setPaused("alice", true);
  const { state } = store.applyActivityEvent(
    entry({ agent: "alice", event: "session_start" }),
  );
  assert(state !== null);
  assertEquals(state.paused, true);
  assertEquals(state.status, "running");
});
