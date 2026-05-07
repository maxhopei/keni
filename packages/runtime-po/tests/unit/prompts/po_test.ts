import { assertEquals, assertGreaterOrEqual, assertStringIncludes } from "@std/assert";
import { PO_PROMPT_BODY, PO_PROMPT_NAME } from "../../../src/prompts/po.ts";

Deno.test("PO_PROMPT_NAME is the literal 'po'", () => {
  assertEquals(PO_PROMPT_NAME, "po");
});

Deno.test("PO_PROMPT_BODY is at least 500 characters long", () => {
  assertGreaterOrEqual(PO_PROMPT_BODY.length, 500);
});

Deno.test("PO_PROMPT_BODY's first non-empty line contains 'STUB IMPLEMENTATION'", () => {
  const firstNonEmpty = PO_PROMPT_BODY.split("\n").find((line) => line.trim().length > 0);
  assertEquals(typeof firstNonEmpty, "string");
  assertStringIncludes(firstNonEmpty as string, "STUB IMPLEMENTATION");
});
