import { assertEquals } from "@std/assert";
import { packageName } from "../../src/main.ts";

Deno.test("@keni/runtime-workspace exposes its package name", () => {
  assertEquals(packageName, "@keni/runtime-workspace");
});
