import { assertEquals } from "@std/assert";
import { packageName } from "./main.ts";

Deno.test("@keni/cli exposes its package name", () => {
  assertEquals(packageName, "@keni/cli");
});
