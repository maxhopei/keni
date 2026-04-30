import { assertEquals } from "@std/assert";
import { packageName } from "./main.ts";

Deno.test("@keni/spa exposes its package name", () => {
  assertEquals(packageName, "@keni/spa");
});
