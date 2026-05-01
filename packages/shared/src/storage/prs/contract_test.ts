/**
 * Shared behavioural contract for {@link PRStore}, run against both adapters.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { StaleStateError, StoreNotFoundError } from "../errors.ts";
import type { PRStore } from "./interface.ts";

export function runPRStoreContract(
  name: string,
  factory: () => Promise<PRStore>,
): void {
  const test = (label: string, fn: () => Promise<void>) => {
    Deno.test(`${name} :: ${label}`, fn);
  };

  test("create assigns id pr-0001 to the first PR", async () => {
    const store = await factory();
    const pr = await store.create({
      title: "Add login page",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    assertEquals(pr.header.id, "pr-0001");
    assertEquals(pr.header.status, "open");
    assertEquals(pr.header.ticket, "ticket-0001");
    assertEquals(pr.header.branch, "ticket-0001");
    assertEquals(pr.header.author, "alice");
    assertEquals(pr.body, "");
    assertEquals(pr.header.created_at, pr.header.updated_at);
  });

  test("create assigns sequential ids", async () => {
    const store = await factory();
    const a = await store.create({
      title: "A",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    const b = await store.create({
      title: "B",
      ticket: "ticket-0002",
      branch: "ticket-0002",
      author: "alice",
    });
    assertEquals(a.header.id, "pr-0001");
    assertEquals(b.header.id, "pr-0002");
  });

  test("create persists optional body", async () => {
    const store = await factory();
    const pr = await store.create({
      title: "T",
      body: "intent goes here",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    assertEquals(pr.body, "intent goes here");
  });

  test("read round-trips a created PR", async () => {
    const store = await factory();
    const created = await store.create({
      title: "T",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    const read = await store.read(created.header.id);
    assertEquals(read, created);
  });

  test("read on missing id throws StoreNotFoundError", async () => {
    const store = await factory();
    await assertRejects(() => store.read("pr-9999"), StoreNotFoundError);
  });

  test("list returns headers for every PR", async () => {
    const store = await factory();
    await store.create({
      title: "A",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    await store.create({
      title: "B",
      ticket: "ticket-0002",
      branch: "ticket-0002",
      author: "bob",
    });
    const summaries = await store.list();
    assertEquals(summaries.length, 2);
  });

  test("list returns a fresh array per call", async () => {
    const store = await factory();
    await store.create({
      title: "A",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    const first = await store.list();
    first.length = 0;
    const second = await store.list();
    assertEquals(second.length, 1);
  });

  test("list filters by status (single + array)", async () => {
    const store = await factory();
    const a = await store.create({
      title: "A",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    await store.create({
      title: "B",
      ticket: "ticket-0002",
      branch: "ticket-0002",
      author: "alice",
    });
    await store.updateStatus(a.header.id, "open", "in_review");
    const open = await store.list({ status: "open" });
    assertEquals(open.length, 1);
    const both = await store.list({ status: ["open", "in_review"] });
    assertEquals(both.length, 2);
  });

  test("list filters by ticket", async () => {
    const store = await factory();
    await store.create({
      title: "A",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    await store.create({
      title: "B",
      ticket: "ticket-0002",
      branch: "ticket-0002",
      author: "alice",
    });
    const filtered = await store.list({ ticket: "ticket-0001" });
    assertEquals(filtered.length, 1);
    assertEquals(filtered[0]?.ticket, "ticket-0001");
  });

  test("list filters by author", async () => {
    const store = await factory();
    await store.create({
      title: "A",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    await store.create({
      title: "B",
      ticket: "ticket-0002",
      branch: "ticket-0002",
      author: "bob",
    });
    const alices = await store.list({ author: "alice" });
    assertEquals(alices.length, 1);
  });

  test("updateIntent replaces the body atomically and bumps updated_at", async () => {
    const store = await factory();
    const created = await store.create({
      title: "T",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    await wait(2);
    const updated = await store.updateIntent(
      created.header.id,
      "new description",
    );
    assertEquals(updated.body, "new description");
    assert(updated.header.updated_at >= created.header.updated_at);
  });

  test("updateIntent on missing id throws StoreNotFoundError", async () => {
    const store = await factory();
    await assertRejects(
      () => store.updateIntent("pr-9999", "x"),
      StoreNotFoundError,
    );
  });

  test("updateStatus advances when from matches", async () => {
    const store = await factory();
    const created = await store.create({
      title: "T",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    const moved = await store.updateStatus(
      created.header.id,
      "open",
      "in_review",
    );
    assertEquals(moved.header.status, "in_review");
  });

  test("updateStatus throws StaleStateError when from does not match", async () => {
    const store = await factory();
    const created = await store.create({
      title: "T",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    await store.updateStatus(created.header.id, "open", "in_review");
    const err = await assertRejects(
      () => store.updateStatus(created.header.id, "open", "approved"),
      StaleStateError,
    );
    assertEquals(err.expected, "open");
    assertEquals(err.actual, "in_review");
  });

  test("updateStatus on missing id throws StoreNotFoundError", async () => {
    const store = await factory();
    await assertRejects(
      () => store.updateStatus("pr-9999", "open", "in_review"),
      StoreNotFoundError,
    );
  });

  test("body is preserved across status transitions", async () => {
    const store = await factory();
    const created = await store.create({
      title: "T",
      body: "intent",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    await store.updateStatus(created.header.id, "open", "in_review");
    const reread = await store.read(created.header.id);
    assertEquals(reread.body, "intent");
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
