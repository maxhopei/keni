import { assertEquals } from "@std/assert";
import { extractSummaryLine } from "../../src/summaryLine.ts";

Deno.test("extractSummaryLine — empty buffer returns null", () => {
  assertEquals(extractSummaryLine([]), null);
});

Deno.test("extractSummaryLine — single non-empty line is returned verbatim", () => {
  assertEquals(extractSummaryLine(["hello"]), "hello");
});

Deno.test("extractSummaryLine — trailing whitespace-only line is skipped", () => {
  assertEquals(extractSummaryLine(["work in progress", "summary line", "  ", ""]), "summary line");
});

Deno.test("extractSummaryLine — all-whitespace buffer returns null", () => {
  assertEquals(extractSummaryLine(["", "  ", "\t"]), null);
});

Deno.test("extractSummaryLine — leading whitespace on the chosen line is preserved", () => {
  assertEquals(extractSummaryLine(["  hello"]), "  hello");
});

Deno.test("extractSummaryLine — last non-empty line wins", () => {
  assertEquals(extractSummaryLine(["line 1", "line 2", "summary"]), "summary");
});
