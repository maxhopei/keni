/**
 * Tests for `restPrefixes.ts`. Locks the closed allowlist's exact contents
 * (so a contributor adding a new REST route group must update both
 * `createServer.ts` and this constant in lock-step) and exercises the
 * `isRestPrefixed` predicate against the documented matching rules.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { isRestPrefixed, REST_PREFIXES } from "./restPrefixes.ts";

Deno.test("REST_PREFIXES equals the documented closed list in registration order", () => {
  assertEquals(REST_PREFIXES, [
    "/agents",
    "/tickets",
    "/prs",
    "/activity",
    "/health",
    "/events",
  ]);
});

Deno.test("isRestPrefixed matches the prefix exactly", () => {
  assert(isRestPrefixed("/agents"));
  assert(isRestPrefixed("/tickets"));
  assert(isRestPrefixed("/prs"));
  assert(isRestPrefixed("/activity"));
  assert(isRestPrefixed("/health"));
  assert(isRestPrefixed("/events"));
});

Deno.test("isRestPrefixed matches sub-paths under a prefix", () => {
  assert(isRestPrefixed("/agents/alice"));
  assert(isRestPrefixed("/agents/alice/pause"));
  assert(isRestPrefixed("/tickets/ticket-0001"));
  assert(isRestPrefixed("/tickets/ticket-0001/transition"));
  assert(isRestPrefixed("/prs/pr-0001/merge"));
});

Deno.test("isRestPrefixed rejects partial matches that are not on a path boundary", () => {
  assertFalse(isRestPrefixed("/agentstore"));
  assertFalse(isRestPrefixed("/ticketsX"));
  assertFalse(isRestPrefixed("/prsfoo"));
});

Deno.test("isRestPrefixed rejects SPA-shaped paths", () => {
  assertFalse(isRestPrefixed("/"));
  assertFalse(isRestPrefixed("/some/spa/route"));
  assertFalse(isRestPrefixed("/assets/main-abc.js"));
  assertFalse(isRestPrefixed("/board"));
});
