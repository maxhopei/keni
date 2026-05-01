/**
 * Tests for the `get_workspace_path` input schema — empty object accepted,
 * any non-empty input rejected (the spec's "rejects any input" scenario).
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import { GetWorkspacePathInputSchema } from "./workspace.ts";
import type { GetWorkspacePathInput, WorkspacePathResponse } from "./workspace.ts";

type Assignable<From, To> = From extends To ? true : false;
type Expect<T extends true> = T;

type _SchemaToInput = Expect<
  Assignable<z.infer<typeof GetWorkspacePathInputSchema>, GetWorkspacePathInput>
>;

Deno.test("GetWorkspacePathInputSchema accepts an empty object", () => {
  const parsed = GetWorkspacePathInputSchema.parse({});
  assertEquals(parsed, {});
});

Deno.test("GetWorkspacePathInputSchema rejects any extra key", () => {
  assertThrows(
    () => (GetWorkspacePathInputSchema as z.ZodType).parse({ path: "/anywhere" }),
    z.ZodError,
  );
});

Deno.test("GetWorkspacePathInputSchema rejects a non-object input", () => {
  assertThrows(() => (GetWorkspacePathInputSchema as z.ZodType).parse(42), z.ZodError);
});

Deno.test("WorkspacePathResponse is the documented `{ path: string }` shape", () => {
  const value: WorkspacePathResponse = { path: "/some/abs/path" };
  assertEquals(typeof value.path, "string");
});
