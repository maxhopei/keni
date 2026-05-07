import { assertEquals } from "@std/assert";
import { packageName } from "../../src/main.ts";

Deno.test("@keni/runtime-engineer exposes its package name", () => {
  assertEquals(packageName, "@keni/runtime-engineer");
});
