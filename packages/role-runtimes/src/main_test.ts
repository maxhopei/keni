import { assertEquals } from "@std/assert";
import { packageName } from "./main.ts";

Deno.test("@keni/role-runtimes exposes its package name", () => {
  assertEquals(packageName, "@keni/role-runtimes");
});
