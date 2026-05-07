import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  __resetActivityIdState,
  generateActivityId,
  generatePrId,
  generateTicketId,
  isPrId,
  isTicketId,
  parsePrSequence,
  parseTicketSequence,
} from "../../../src/storage/ids.ts";

Deno.test("generateTicketId — empty list yields ticket-0001", () => {
  assertEquals(generateTicketId([]), "ticket-0001");
});

Deno.test("generatePrId — empty list yields pr-0001", () => {
  assertEquals(generatePrId([]), "pr-0001");
});

Deno.test("generateTicketId — skips gaps, uses max + 1", () => {
  assertEquals(
    generateTicketId(["ticket-0001", "ticket-0005", "ticket-0003"]),
    "ticket-0006",
  );
});

Deno.test("generateTicketId — ignores invalid entries", () => {
  assertEquals(
    generateTicketId([
      "ticket-0001",
      "not-a-ticket",
      "pr-0002",
      "ticket-abc",
      "ticket-0002",
    ]),
    "ticket-0003",
  );
});

Deno.test("generateTicketId — 9999 → 10000 widens the pad to five digits", () => {
  assertEquals(generateTicketId(["ticket-9999"]), "ticket-10000");
});

Deno.test("generatePrId — 9999 → 10000 widens the pad to five digits", () => {
  assertEquals(generatePrId(["pr-9999"]), "pr-10000");
});

Deno.test("generateTicketId — large gap keeps four-digit pad below 10000", () => {
  assertEquals(generateTicketId(["ticket-0042"]), "ticket-0043");
  assertEquals(generateTicketId(["ticket-0999"]), "ticket-1000");
});

Deno.test("isTicketId — accepts canonical format, rejects shape violations", () => {
  assert(isTicketId("ticket-0001"));
  assert(isTicketId("ticket-9999"));
  assert(isTicketId("ticket-10000"));
  assert(!isTicketId("ticket-1"));
  assert(!isTicketId("ticket-0001.md"));
  assert(!isTicketId("Ticket-0001"));
  assert(!isTicketId("ticket-abc"));
  assert(!isTicketId("pr-0001"));
  assert(!isTicketId(""));
});

Deno.test("isPrId — accepts canonical format, rejects shape violations", () => {
  assert(isPrId("pr-0001"));
  assert(isPrId("pr-10000"));
  assert(!isPrId("pr-1"));
  assert(!isPrId("pr-0001.md"));
  assert(!isPrId("PR-0001"));
  assert(!isPrId("ticket-0001"));
});

Deno.test("parseTicketSequence — round-trips through generateTicketId", () => {
  assertEquals(parseTicketSequence(generateTicketId([])), 1);
  assertEquals(parseTicketSequence("ticket-0042"), 42);
  assertEquals(parseTicketSequence("ticket-10000"), 10000);
});

Deno.test("parseTicketSequence — throws on invalid input", () => {
  assertThrows(() => parseTicketSequence("not-a-ticket"), Error);
  assertThrows(() => parseTicketSequence("pr-0001"), Error);
});

Deno.test("parsePrSequence — round-trips through generatePrId", () => {
  assertEquals(parsePrSequence(generatePrId([])), 1);
  assertEquals(parsePrSequence("pr-0042"), 42);
  assertEquals(parsePrSequence("pr-10000"), 10000);
});

Deno.test("parsePrSequence — throws on invalid input", () => {
  assertThrows(() => parsePrSequence("ticket-0001"), Error);
});

Deno.test("generateActivityId — uuidv7s sort lexicographically in creation order across 100 rapid calls", () => {
  __resetActivityIdState();
  const ids: string[] = [];
  for (let i = 0; i < 100; i++) {
    ids.push(generateActivityId());
  }
  const sorted = [...ids].sort();
  assertEquals(ids, sorted);
  const unique = new Set(ids);
  assertEquals(unique.size, ids.length);
});

Deno.test("generateActivityId — strict monotonicity holds across a 10 000-call tight loop", () => {
  __resetActivityIdState();
  let prev = generateActivityId();
  for (let i = 0; i < 10_000; i++) {
    const next = generateActivityId();
    assert(next > prev, `expected ${next} > ${prev} at iteration ${i}`);
    prev = next;
  }
});

Deno.test("generateActivityId — returns a string with uuid shape (8-4-4-4-12 hex)", () => {
  __resetActivityIdState();
  const id = generateActivityId();
  const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert(uuidShape.test(id), `expected uuid shape, got '${id}'`);
});

Deno.test("generateActivityId — preserves v7 version nibble after bump", () => {
  __resetActivityIdState();
  for (let i = 0; i < 100; i++) {
    const id = generateActivityId();
    const group3 = id.split("-")[2];
    assert(
      group3 !== undefined && group3.startsWith("7"),
      `expected v7 version nibble, got ${group3} in ${id}`,
    );
  }
});
