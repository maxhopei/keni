/**
 * Tests for `mapHttpErrorToToolResult` and `wrapToolSuccess`.
 *
 * The closed `ErrorCode` enum is walked once: every code is wrapped as an
 * `McpHttpError`, mapped, and the result's text is asserted to start with
 * the `[<code>]` prefix. This is the load-bearing test for the spec's
 * "every error code surfaces with the documented prefix" guarantees.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ERROR_CODES } from "@keni/shared";
import {
  mapHttpErrorToToolResult,
  McpHttpError,
  wrapToolSuccess,
} from "../../../src/mcp/errors.ts";

Deno.test("McpHttpError carries code, message, details, and httpStatus", () => {
  const err = new McpHttpError("store_not_found", "ticket not found", { id: "ticket-9999" }, 404);
  assertEquals(err.name, "McpHttpError");
  assertEquals(err.code, "store_not_found");
  assertEquals(err.message, "ticket not found");
  assertEquals(err.details, { id: "ticket-9999" });
  assertEquals(err.httpStatus, 404);
  assert(err instanceof Error);
});

for (const code of ERROR_CODES) {
  Deno.test(`mapHttpErrorToToolResult prefixes [${code}] for an McpHttpError of that code`, () => {
    const err = new McpHttpError(code, `boom from ${code}`, undefined, 418);
    const result = mapHttpErrorToToolResult(err);
    assertEquals(result.isError, true);
    assertEquals(result.content.length, 1);
    assertEquals(result.content[0]!.type, "text");
    assertStringIncludes(result.content[0]!.text, `[${code}]`);
    assertStringIncludes(result.content[0]!.text, `boom from ${code}`);
    assertStringIncludes(result.content[0]!.text, "(HTTP 418)");
  });
}

Deno.test("mapHttpErrorToToolResult renders details as indented JSON when present", () => {
  const err = new McpHttpError(
    "stale_state",
    "status drifted",
    { id: "ticket-0001", expected: "open", actual: "in_progress" },
    409,
  );
  const result = mapHttpErrorToToolResult(err);
  assertStringIncludes(result.content[0]!.text, "Details: {");
  assertStringIncludes(result.content[0]!.text, '"expected": "open"');
  assertStringIncludes(result.content[0]!.text, '"actual": "in_progress"');
});

Deno.test("mapHttpErrorToToolResult omits Details when details is undefined", () => {
  const err = new McpHttpError("missing_role", "no role header", undefined, 400);
  const result = mapHttpErrorToToolResult(err);
  assertEquals(result.content[0]!.text.includes("Details:"), false);
});

Deno.test("mapHttpErrorToToolResult treats a TypeError as [internal_error]", () => {
  const err = new TypeError("JSON.parse barfed on column 7");
  const result = mapHttpErrorToToolResult(err);
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0]!.text, "[internal_error]");
  assertStringIncludes(result.content[0]!.text, "JSON.parse barfed on column 7");
});

Deno.test("mapHttpErrorToToolResult wraps a string thrown as a non-Error value", () => {
  const result = mapHttpErrorToToolResult("naked string");
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0]!.text, "[internal_error]");
  assertStringIncludes(result.content[0]!.text, "naked string");
});

Deno.test("mapHttpErrorToToolResult wraps a non-Error object thrown value", () => {
  const result = mapHttpErrorToToolResult({ weird: "object" });
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0]!.text, "[internal_error]");
});

Deno.test("mapHttpErrorToToolResult covers an internal_error McpHttpError too", () => {
  const err = new McpHttpError(
    "internal_error",
    "Network error talking to http://x:1/tickets: ECONNREFUSED",
    undefined,
    0,
  );
  const result = mapHttpErrorToToolResult(err);
  assertStringIncludes(result.content[0]!.text, "[internal_error]");
  assertStringIncludes(result.content[0]!.text, "(HTTP 0)");
  assertStringIncludes(result.content[0]!.text, "ECONNREFUSED");
});

Deno.test("wrapToolSuccess returns content without an isError key", () => {
  const result = wrapToolSuccess({ id: "ticket-0001", body: "hi" });
  assertEquals("isError" in result, false);
  assertEquals(result.content.length, 1);
  assertEquals(result.content[0]!.type, "text");
  assertStringIncludes(result.content[0]!.text, '"id": "ticket-0001"');
  assertStringIncludes(result.content[0]!.text, '"body": "hi"');
});

Deno.test("wrapToolSuccess pretty-prints with two-space indent", () => {
  const result = wrapToolSuccess({ a: 1, b: 2 });
  assertEquals(result.content[0]!.text, '{\n  "a": 1,\n  "b": 2\n}');
});
