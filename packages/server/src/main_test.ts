import { assertEquals } from "@std/assert";
import { packageName } from "./main.ts";

Deno.test("@keni/server exposes its package name", () => {
  assertEquals(packageName, "@keni/server");
});
