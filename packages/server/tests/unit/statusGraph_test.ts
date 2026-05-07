/**
 * Tests for `statusGraph.ts`. Walk every documented edge and every
 * documented owner from `spec.md` §4.1 / §4.2 once, plus a handful of
 * negative assertions to lock down the §4.2 owning-role rule.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  isPRRoleOwner,
  isPRTransitionReachable,
  isTicketRoleOwner,
  isTicketTransitionReachable,
  PR_STATUS_OWNING_ROLES,
  PR_STATUS_TRANSITIONS,
  TICKET_STATUS_OWNING_ROLES,
  TICKET_STATUS_TRANSITIONS,
  USER_OVERRIDE_ALLOWED,
} from "../../src/statusGraph.ts";
import { TICKET_STATUSES } from "../../src/wire/tickets.ts";
import { PR_STATUSES } from "../../src/wire/prs.ts";

Deno.test("TICKET_STATUS_TRANSITIONS has an entry for every TicketStatus", () => {
  for (const status of TICKET_STATUSES) {
    assert(
      Object.prototype.hasOwnProperty.call(TICKET_STATUS_TRANSITIONS, status),
      `TICKET_STATUS_TRANSITIONS missing entry for "${status}"`,
    );
  }
});

Deno.test("TICKET_STATUS_OWNING_ROLES has an entry for every TicketStatus", () => {
  for (const status of TICKET_STATUSES) {
    assert(
      Object.prototype.hasOwnProperty.call(TICKET_STATUS_OWNING_ROLES, status),
      `TICKET_STATUS_OWNING_ROLES missing entry for "${status}"`,
    );
  }
});

Deno.test("TICKET_STATUS_TRANSITIONS encodes every §4.1 edge in order", () => {
  assertEquals(TICKET_STATUS_TRANSITIONS.open, ["in_progress"]);
  assertEquals(TICKET_STATUS_TRANSITIONS.in_progress, ["ready_for_review"]);
  assertEquals(TICKET_STATUS_TRANSITIONS.ready_for_review, ["in_review"]);
  assertEquals(TICKET_STATUS_TRANSITIONS.in_review, ["has_comments", "approved"]);
  assertEquals(TICKET_STATUS_TRANSITIONS.has_comments, ["in_progress"]);
  assertEquals(TICKET_STATUS_TRANSITIONS.approved, ["merged"]);
  assertEquals(TICKET_STATUS_TRANSITIONS.merged, ["ready_for_test"]);
  assertEquals(TICKET_STATUS_TRANSITIONS.ready_for_test, ["in_testing"]);
  assertEquals(TICKET_STATUS_TRANSITIONS.in_testing, ["tested", "test_failed"]);
  assertEquals(TICKET_STATUS_TRANSITIONS.tested, ["done"]);
  assertEquals(TICKET_STATUS_TRANSITIONS.test_failed, ["in_progress"]);
  assertEquals(TICKET_STATUS_TRANSITIONS.done, []);
});

Deno.test("TICKET_STATUS_TRANSITIONS — `done` is terminal", () => {
  assertEquals(TICKET_STATUS_TRANSITIONS.done.length, 0);
});

Deno.test("isTicketTransitionReachable mirrors the table", () => {
  assert(isTicketTransitionReachable("open", "in_progress"));
  assert(isTicketTransitionReachable("in_review", "approved"));
  assert(isTicketTransitionReachable("test_failed", "in_progress"));
  assertFalse(isTicketTransitionReachable("open", "merged"));
  assertFalse(isTicketTransitionReachable("done", "open"));
  assertFalse(isTicketTransitionReachable("merged", "approved"));
});

Deno.test("TICKET_STATUS_OWNING_ROLES encodes the §4.2 ownership", () => {
  assertEquals(TICKET_STATUS_OWNING_ROLES.open, []);
  assertEquals(TICKET_STATUS_OWNING_ROLES.in_progress, ["engineer"]);
  assertEquals(TICKET_STATUS_OWNING_ROLES.ready_for_review, ["engineer"]);
  assertEquals(TICKET_STATUS_OWNING_ROLES.in_review, ["engineer"]);
  assertEquals(TICKET_STATUS_OWNING_ROLES.has_comments, ["engineer"]);
  assertEquals(TICKET_STATUS_OWNING_ROLES.approved, ["engineer"]);
  assertEquals(TICKET_STATUS_OWNING_ROLES.merged, ["engineer"]);
  assertEquals(TICKET_STATUS_OWNING_ROLES.ready_for_test, ["engineer"]);
  assertEquals(TICKET_STATUS_OWNING_ROLES.in_testing, ["qa"]);
  assertEquals(TICKET_STATUS_OWNING_ROLES.tested, ["qa"]);
  assertEquals(TICKET_STATUS_OWNING_ROLES.test_failed, ["qa"]);
  assertEquals(TICKET_STATUS_OWNING_ROLES.done, ["po"]);
});

Deno.test("isTicketRoleOwner — user is allowed to set every target (§4.2 override)", () => {
  for (const target of TICKET_STATUSES) {
    assert(isTicketRoleOwner("user", target), `user must be allowed to set ${target}`);
  }
});

Deno.test("isTicketRoleOwner — engineer is rejected on `tested`", () => {
  assertFalse(isTicketRoleOwner("engineer", "tested"));
});

Deno.test("isTicketRoleOwner — qa is rejected on `done`", () => {
  assertFalse(isTicketRoleOwner("qa", "done"));
});

Deno.test("isTicketRoleOwner — po is rejected on `merged`", () => {
  assertFalse(isTicketRoleOwner("po", "merged"));
});

Deno.test("isTicketRoleOwner — writer is rejected everywhere", () => {
  for (const target of TICKET_STATUSES) {
    if (target === "open") continue;
    assertFalse(isTicketRoleOwner("writer", target), `writer must NOT be allowed to set ${target}`);
  }
});

Deno.test("USER_OVERRIDE_ALLOWED contains exactly the user role", () => {
  assertEquals(USER_OVERRIDE_ALLOWED, ["user"]);
});

Deno.test("PR_STATUS_TRANSITIONS encodes the engineer-only PR lifecycle", () => {
  assertEquals(PR_STATUS_TRANSITIONS.open, ["in_review"]);
  assertEquals(PR_STATUS_TRANSITIONS.in_review, ["has_comments", "approved"]);
  assertEquals(PR_STATUS_TRANSITIONS.has_comments, ["in_review"]);
  assertEquals(PR_STATUS_TRANSITIONS.approved, ["merged"]);
  assertEquals(PR_STATUS_TRANSITIONS.merged, []);
});

Deno.test("PR_STATUS_TRANSITIONS has an entry for every PRStatus and `merged` is terminal", () => {
  for (const status of PR_STATUSES) {
    assert(Object.prototype.hasOwnProperty.call(PR_STATUS_TRANSITIONS, status));
  }
  assertEquals(PR_STATUS_TRANSITIONS.merged.length, 0);
});

Deno.test("isPRTransitionReachable mirrors the table", () => {
  assert(isPRTransitionReachable("open", "in_review"));
  assert(isPRTransitionReachable("has_comments", "in_review"));
  assertFalse(isPRTransitionReachable("open", "merged"));
  assertFalse(isPRTransitionReachable("merged", "approved"));
});

Deno.test("PR_STATUS_OWNING_ROLES — engineer owns every transition target", () => {
  assertEquals(PR_STATUS_OWNING_ROLES.in_review, ["engineer"]);
  assertEquals(PR_STATUS_OWNING_ROLES.has_comments, ["engineer"]);
  assertEquals(PR_STATUS_OWNING_ROLES.approved, ["engineer"]);
  assertEquals(PR_STATUS_OWNING_ROLES.merged, ["engineer"]);
  assertEquals(PR_STATUS_OWNING_ROLES.open, []);
});

Deno.test("isPRRoleOwner — user is allowed to set every target", () => {
  for (const target of PR_STATUSES) {
    assert(isPRRoleOwner("user", target), `user must be allowed to set ${target}`);
  }
});

Deno.test("isPRRoleOwner — qa, po, writer rejected everywhere", () => {
  for (const target of PR_STATUSES) {
    if (target === "open") continue;
    assertFalse(isPRRoleOwner("qa", target), `qa must NOT set PR target ${target}`);
    assertFalse(isPRRoleOwner("po", target), `po must NOT set PR target ${target}`);
    assertFalse(isPRRoleOwner("writer", target), `writer must NOT set PR target ${target}`);
  }
});
