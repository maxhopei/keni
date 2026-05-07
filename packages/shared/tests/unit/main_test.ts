import { assertEquals } from "@std/assert";
import { packageName } from "../../src/main.ts";

Deno.test("@keni/shared exposes its package name", () => {
  assertEquals(packageName, "@keni/shared");
});
