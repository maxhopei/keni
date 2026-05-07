import { assertEquals } from "@std/assert";
import { runPRStoreContract } from "../../../contracts/storage/prs/prStoreContract.ts";
import { InMemoryPRStore } from "../../../../src/storage/prs/memory.ts";

runPRStoreContract(
  "InMemoryPRStore",
  () => Promise.resolve(new InMemoryPRStore()),
);

Deno.test("InMemoryPRStore — mutating returned PR does not mutate the store", async () => {
  const store = new InMemoryPRStore();
  const created = await store.create({
    title: "T",
    ticket: "ticket-0001",
    branch: "ticket-0001",
    author: "alice",
  });
  (created.header as { title: string }).title = "MUTATED";
  const reread = await store.read(created.header.id);
  assertEquals(reread.header.title, "T");
});
