import { assertEquals } from "@std/assert";
import { formatRelativeTime } from "./formatRelativeTime.ts";

const NOW = new Date("2026-05-03T18:00:00Z");

function at(deltaSeconds: number): string {
  return new Date(NOW.getTime() - deltaSeconds * 1000).toISOString();
}

Deno.test("0 s ago renders as 'now'", () => {
  assertEquals(formatRelativeTime(at(0), NOW), "now");
});

Deno.test("1 s ago renders as 'now' (under the 5s floor)", () => {
  assertEquals(formatRelativeTime(at(1), NOW), "now");
});

Deno.test("5 s ago renders as '5s ago' (boundary)", () => {
  assertEquals(formatRelativeTime(at(5), NOW), "5s ago");
});

Deno.test("59 s ago renders as '59s ago'", () => {
  assertEquals(formatRelativeTime(at(59), NOW), "59s ago");
});

Deno.test("60 s ago renders as '1m ago' (minute boundary)", () => {
  assertEquals(formatRelativeTime(at(60), NOW), "1m ago");
});

Deno.test("3599 s ago renders as '59m ago'", () => {
  assertEquals(formatRelativeTime(at(3599), NOW), "59m ago");
});

Deno.test("3600 s ago renders as '1h ago' (hour boundary)", () => {
  assertEquals(formatRelativeTime(at(3600), NOW), "1h ago");
});

Deno.test("86399 s ago renders as '23h ago'", () => {
  assertEquals(formatRelativeTime(at(86399), NOW), "23h ago");
});

Deno.test("86400 s ago renders as '1d ago' (day boundary)", () => {
  assertEquals(formatRelativeTime(at(86400), NOW), "1d ago");
});

Deno.test("5 days ago renders as '5d ago'", () => {
  assertEquals(formatRelativeTime(at(5 * 86400), NOW), "5d ago");
});

Deno.test("future timestamps render as 'now' (clock-skew tolerance)", () => {
  assertEquals(formatRelativeTime(at(-30), NOW), "now");
});
