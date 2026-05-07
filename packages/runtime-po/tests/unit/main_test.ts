import { assertEquals } from "@std/assert";
import { packageName } from "../../src/main.ts";

Deno.test("@keni/runtime-po exposes its package name", () => {
  assertEquals(packageName, "@keni/runtime-po");
});
