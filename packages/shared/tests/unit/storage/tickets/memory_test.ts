import { assert, assertEquals } from "@std/assert";
import { runTicketStoreContract } from "../../../contracts/storage/tickets/ticketStoreContract.ts";
import { InMemoryTicketStore } from "../../../../src/storage/tickets/memory.ts";

runTicketStoreContract(
  "InMemoryTicketStore",
  () => Promise.resolve(new InMemoryTicketStore()),
);

Deno.test("InMemoryTicketStore — mutating returned ticket does not mutate the store", async () => {
  const store = new InMemoryTicketStore();
  const created = await store.create({ title: "T", priority: 100 });
  // Attempt to mutate via property descriptor (object is structurally a header,
  // even if marked `readonly` at the type level)
  (created.header as { title: string }).title = "MUTATED";
  const reread = await store.read(created.header.id);
  assertEquals(reread.header.title, "T");
});

Deno.test("InMemoryTicketStore — list returns a fresh array per call", async () => {
  const store = new InMemoryTicketStore();
  await store.create({ title: "A", priority: 100 });
  const a = await store.list();
  const b = await store.list();
  assert(a !== b, "expected list() to return a fresh array reference");
  assertEquals(a.length, b.length);
});

Deno.test("InMemoryTicketStore — list summary mutations do not mutate the store", async () => {
  const store = new InMemoryTicketStore();
  await store.create({ title: "T", priority: 100 });
  const summaries = await store.list();
  (summaries[0] as { title: string }).title = "MUTATED";
  const fresh = await store.list();
  assertEquals(fresh[0]?.title, "T");
});
