import { assertEquals } from "@std/assert";
import { InMemoryTicketStore, type TicketStore } from "@keni/shared";
import { packageName } from "./main.ts";

Deno.test("@keni/server exposes its package name", () => {
  assertEquals(packageName, "@keni/server");
});

Deno.test("@keni/server can import storage abstractions via bare specifier", async () => {
  const store: TicketStore = new InMemoryTicketStore();
  const created = await store.create({ title: "smoke", priority: 1 });
  assertEquals(created.header.title, "smoke");
});
