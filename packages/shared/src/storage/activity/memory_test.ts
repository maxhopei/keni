import { assertEquals } from "@std/assert";
import { runActivityLogStoreContract } from "./contract_test.ts";
import { InMemoryActivityLogStore } from "./memory.ts";

runActivityLogStoreContract(
  "InMemoryActivityLogStore",
  () => Promise.resolve(new InMemoryActivityLogStore()),
);

Deno.test("InMemoryActivityLogStore — refs map is cloned on append and on query", async () => {
  const store = new InMemoryActivityLogStore();
  const refs = { ticket: "ticket-0001" };
  const appended = await store.append({
    session_id: "s",
    agent: "alice",
    role: "engineer",
    event: "x",
    refs,
  });
  (appended.refs as Record<string, string>).ticket = "MUTATED";
  const collected = [];
  for await (const e of store.query()) collected.push(e);
  assertEquals(collected[0]?.refs.ticket, "ticket-0001");
});
