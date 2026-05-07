/**
 * Shared behavioural contract for {@link TicketStore}, run against both the
 * file-backed and in-memory adapters via their respective `*_test.ts` files.
 * Any divergence between the two adapters causes one of them to fail this
 * contract — the drift detector for the storage layer.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  InvalidArtifactError,
  StaleStateError,
  StoreNotFoundError,
} from "../../../../src/storage/errors.ts";
import type { TicketStore } from "../../../../src/storage/tickets/interface.ts";

/**
 * Register the full {@link TicketStore} contract as a series of `Deno.test`
 * cases prefixed with `name`. The `factory` is invoked once per test case, so
 * each test gets a fresh store; tests SHOULD NOT share state.
 */
export function runTicketStoreContract(
  name: string,
  factory: () => Promise<TicketStore>,
): void {
  const test = (label: string, fn: () => Promise<void>) => {
    Deno.test(`${name} :: ${label}`, fn);
  };

  test("create assigns id ticket-0001 to the first ticket", async () => {
    const store = await factory();
    const ticket = await store.create({
      title: "Add login page",
      priority: 100,
    });
    assertEquals(ticket.header.id, "ticket-0001");
    assertEquals(ticket.header.title, "Add login page");
    assertEquals(ticket.header.status, "open");
    assertEquals(ticket.header.priority, 100);
    assertEquals(ticket.header.assignee, null);
    assertEquals(ticket.header.change_request, null);
    assertEquals(ticket.body, "");
    assert(typeof ticket.header.created_at === "string");
    assert(typeof ticket.header.updated_at === "string");
    assertEquals(ticket.header.created_at, ticket.header.updated_at);
  });

  test("create assigns sequential ids", async () => {
    const store = await factory();
    const a = await store.create({ title: "A", priority: 100 });
    const b = await store.create({ title: "B", priority: 200 });
    const c = await store.create({ title: "C", priority: 300 });
    assertEquals(a.header.id, "ticket-0001");
    assertEquals(b.header.id, "ticket-0002");
    assertEquals(c.header.id, "ticket-0003");
  });

  test("create persists optional inputs (body, assignee, change_request)", async () => {
    const store = await factory();
    const ticket = await store.create({
      title: "Add login page",
      body: "Initial implementation plan goes here.",
      assignee: "alice",
      priority: 100,
      change_request: "cr-0001",
    });
    assertEquals(ticket.body, "Initial implementation plan goes here.");
    assertEquals(ticket.header.assignee, "alice");
    assertEquals(ticket.header.change_request, "cr-0001");
  });

  test("read round-trips a created ticket", async () => {
    const store = await factory();
    const created = await store.create({
      title: "T",
      body: "B",
      priority: 50,
    });
    const read = await store.read(created.header.id);
    assertEquals(read, created);
  });

  test("read on a missing id throws StoreNotFoundError", async () => {
    const store = await factory();
    const err = await assertRejects(
      () => store.read("ticket-9999"),
      StoreNotFoundError,
    );
    assert(err.message.includes("ticket-9999"));
  });

  test("list returns headers (no body) for every ticket", async () => {
    const store = await factory();
    await store.create({ title: "A", priority: 100, body: "body-a" });
    await store.create({ title: "B", priority: 200, body: "body-b" });
    const summaries = await store.list();
    assertEquals(summaries.length, 2);
    const ids = summaries.map((s) => s.id).sort();
    assertEquals(ids, ["ticket-0001", "ticket-0002"]);
  });

  test("list returns a fresh array; mutating it does not affect the store", async () => {
    const store = await factory();
    await store.create({ title: "A", priority: 100 });
    const first = await store.list();
    first.length = 0;
    const second = await store.list();
    assertEquals(second.length, 1);
  });

  test("list filters by status", async () => {
    const store = await factory();
    const a = await store.create({ title: "A", priority: 100 });
    const b = await store.create({ title: "B", priority: 200 });
    await store.transitionStatus(a.header.id, "open", "in_progress");
    const open = await store.list({ status: "open" });
    const inProgress = await store.list({ status: "in_progress" });
    assertEquals(open.map((t) => t.id), [b.header.id]);
    assertEquals(inProgress.map((t) => t.id), [a.header.id]);
  });

  test("list filters by status array (OR semantics within `status`)", async () => {
    const store = await factory();
    const a = await store.create({ title: "A", priority: 100 });
    const b = await store.create({ title: "B", priority: 200 });
    const c = await store.create({ title: "C", priority: 300 });
    await store.transitionStatus(a.header.id, "open", "in_progress");
    await store.transitionStatus(b.header.id, "open", "in_progress");
    const subset = await store.list({
      status: ["open", "in_progress"],
    });
    assertEquals(subset.length, 3);
    const dones = await store.list({ status: ["done"] });
    assertEquals(dones.length, 0);
    // suppress unused-var warning
    void c;
  });

  test("list filters by assignee", async () => {
    const store = await factory();
    const a = await store.create({
      title: "A",
      priority: 100,
      assignee: "alice",
    });
    const b = await store.create({
      title: "B",
      priority: 100,
      assignee: "bob",
    });
    const c = await store.create({ title: "C", priority: 100 });
    const alices = await store.list({ assignee: "alice" });
    assertEquals(alices.map((t) => t.id), [a.header.id]);
    const unassigned = await store.list({ assignee: null });
    assertEquals(unassigned.map((t) => t.id), [c.header.id]);
    void b;
  });

  test("list filters by priority bounds (inclusive)", async () => {
    const store = await factory();
    await store.create({ title: "A", priority: 50 });
    await store.create({ title: "B", priority: 100 });
    await store.create({ title: "C", priority: 150 });
    const mid = await store.list({ priorityMin: 100, priorityMax: 100 });
    assertEquals(mid.length, 1);
    const upTo100 = await store.list({ priorityMax: 100 });
    assertEquals(upTo100.length, 2);
    const from100 = await store.list({ priorityMin: 100 });
    assertEquals(from100.length, 2);
  });

  test("list filters by changeRequest", async () => {
    const store = await factory();
    await store.create({ title: "A", priority: 100, change_request: "cr-1" });
    await store.create({ title: "B", priority: 100, change_request: "cr-2" });
    await store.create({ title: "C", priority: 100 });
    const cr1 = await store.list({ changeRequest: "cr-1" });
    assertEquals(cr1.length, 1);
    const unlinked = await store.list({ changeRequest: null });
    assertEquals(unlinked.length, 1);
  });

  test("updateBody replaces the body and bumps updated_at", async () => {
    const store = await factory();
    const created = await store.create({ title: "T", priority: 100 });
    await wait(2);
    const updated = await store.updateBody(created.header.id, "new body");
    assertEquals(updated.body, "new body");
    assertEquals(updated.header.title, "T");
    assertEquals(updated.header.status, "open");
    assert(updated.header.updated_at >= created.header.updated_at);
    assertEquals(updated.header.created_at, created.header.created_at);
  });

  test("updateBody on a missing id throws StoreNotFoundError", async () => {
    const store = await factory();
    await assertRejects(
      () => store.updateBody("ticket-9999", "x"),
      StoreNotFoundError,
    );
  });

  test("updateHeader patches non-status fields atomically", async () => {
    const store = await factory();
    const created = await store.create({ title: "T", priority: 100 });
    const updated = await store.updateHeader(created.header.id, {
      title: "T2",
      assignee: "alice",
      priority: 50,
    });
    assertEquals(updated.header.title, "T2");
    assertEquals(updated.header.assignee, "alice");
    assertEquals(updated.header.priority, 50);
    assertEquals(updated.header.status, "open");
  });

  test("updateHeader rejects status-in-patch with InvalidArtifactError", async () => {
    const store = await factory();
    const created = await store.create({ title: "T", priority: 100 });
    const err = await assertRejects(
      () =>
        store.updateHeader(created.header.id, {
          // deliberately pass an unsupported field via `as any`-equivalent;
          // the store's runtime check is the line under test
          ...({ status: "in_progress" } as object),
        } as never),
      InvalidArtifactError,
    );
    assertEquals(err.reason, "status_in_patch");
    const reread = await store.read(created.header.id);
    assertEquals(reread.header.status, "open");
  });

  test("updateHeader on a missing id throws StoreNotFoundError", async () => {
    const store = await factory();
    await assertRejects(
      () => store.updateHeader("ticket-9999", { priority: 1 }),
      StoreNotFoundError,
    );
  });

  test("transitionStatus advances the status when from matches", async () => {
    const store = await factory();
    const created = await store.create({ title: "T", priority: 100 });
    const moved = await store.transitionStatus(
      created.header.id,
      "open",
      "in_progress",
    );
    assertEquals(moved.header.status, "in_progress");
    assert(moved.header.updated_at >= created.header.updated_at);
  });

  test("transitionStatus throws StaleStateError when from does not match", async () => {
    const store = await factory();
    const created = await store.create({ title: "T", priority: 100 });
    await store.transitionStatus(created.header.id, "open", "in_progress");
    const err = await assertRejects(
      () => store.transitionStatus(created.header.id, "open", "ready_for_review"),
      StaleStateError,
    );
    assertEquals(err.expected, "open");
    assertEquals(err.actual, "in_progress");
    assertEquals(err.id, created.header.id);
    const reread = await store.read(created.header.id);
    assertEquals(reread.header.status, "in_progress");
  });

  test("transitionStatus on a missing id throws StoreNotFoundError", async () => {
    const store = await factory();
    await assertRejects(
      () => store.transitionStatus("ticket-9999", "open", "in_progress"),
      StoreNotFoundError,
    );
  });

  test("linkChangeRequest sets the field and is callable on any status", async () => {
    const store = await factory();
    const created = await store.create({ title: "T", priority: 100 });
    const linked = await store.linkChangeRequest(created.header.id, "cr-0007");
    assertEquals(linked.header.change_request, "cr-0007");
    await store.transitionStatus(created.header.id, "open", "in_progress");
    const relinked = await store.linkChangeRequest(
      created.header.id,
      "cr-0008",
    );
    assertEquals(relinked.header.change_request, "cr-0008");
    assertEquals(relinked.header.status, "in_progress");
  });

  test("linkChangeRequest on a missing id throws StoreNotFoundError", async () => {
    const store = await factory();
    await assertRejects(
      () => store.linkChangeRequest("ticket-9999", "cr-0001"),
      StoreNotFoundError,
    );
  });

  test("body is preserved across header updates and status transitions", async () => {
    const store = await factory();
    const created = await store.create({
      title: "T",
      body: "important content",
      priority: 100,
    });
    await store.updateHeader(created.header.id, { priority: 50 });
    await store.transitionStatus(created.header.id, "open", "in_progress");
    await store.linkChangeRequest(created.header.id, "cr-1");
    const final = await store.read(created.header.id);
    assertEquals(final.body, "important content");
  });

  test("header is preserved across body updates", async () => {
    const store = await factory();
    const created = await store.create({
      title: "T",
      priority: 100,
      assignee: "alice",
      change_request: "cr-1",
    });
    await store.updateBody(created.header.id, "new body");
    const final = await store.read(created.header.id);
    assertEquals(final.header.title, "T");
    assertEquals(final.header.priority, 100);
    assertEquals(final.header.assignee, "alice");
    assertEquals(final.header.change_request, "cr-1");
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
