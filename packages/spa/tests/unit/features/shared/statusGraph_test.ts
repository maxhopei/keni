/**
 * Drift-check: the SPA mirror of the ticket/PR status graph must stay in
 * lock-step with the server's authoritative constants. A maintainer who
 * adds a server edge (e.g., `done → archived`) but forgets to update the
 * SPA mirror will fail this test.
 */

import { assertEquals } from "@std/assert";
// Direct cross-package file import (test-only): avoids pulling the full
// `@keni/server` barrel — and with it `packages/role-runtimes/**` — into
// the SPA's type-check graph. The relative path is brittle by design: if
// either file moves, this drift-check fails loudly at test time.
import {
  PR_STATUS_TRANSITIONS,
  TICKET_STATUS_TRANSITIONS,
} from "../../../../../server/src/statusGraph.ts";
import {
  SPA_PR_STATUS_TRANSITIONS,
  SPA_TICKET_STATUS_TRANSITIONS,
} from "../../../../src/features/shared/statusGraph.ts";

Deno.test("SPA ticket status transitions mirror the server's TICKET_STATUS_TRANSITIONS", () => {
  assertEquals(SPA_TICKET_STATUS_TRANSITIONS, TICKET_STATUS_TRANSITIONS);
});

Deno.test("SPA PR status transitions mirror the server's PR_STATUS_TRANSITIONS", () => {
  assertEquals(SPA_PR_STATUS_TRANSITIONS, PR_STATUS_TRANSITIONS);
});
