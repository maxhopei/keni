import { assertEquals } from "@std/assert";
import { packageName } from "./main.ts";

Deno.test("@keni/shared exposes its package name", () => {
  assertEquals(packageName, "@keni/shared");
});
