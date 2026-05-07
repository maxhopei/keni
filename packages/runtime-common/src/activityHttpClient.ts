/**
 * `ActivityHttpClient` — role-agnostic activity-HTTP-client interface
 * every role's wire receives via {@link WireInput}.
 *
 * The shape is the *union* of every role's HTTP needs at precheck
 * time. Today the engineer's precheck calls `listTickets(filter)`;
 * other roles MAY add methods in future (the interface is open for
 * extension). No role-specific field name appears here — every
 * method is named after the wire-protocol resource it queries.
 *
 * Each role package narrows the type to the methods its precheck
 * actually uses (TypeScript structural typing makes this free). The
 * legacy `EngineerActivityHttpClient` is gone; everywhere it was
 * referenced now imports {@link ActivityHttpClient} from
 * `@keni/runtime-common`.
 *
 * @module
 */

import type { TicketFilter, TicketSummary } from "@keni/shared";

export interface ActivityHttpClient {
  /**
   * GET /tickets?status=...&assignee=... — return the typed envelope's
   * `tickets` array for the supplied filter. Today this is the engineer
   * precheck's only HTTP call; future role packages MAY rely on
   * additional methods declared here.
   */
  listTickets(filter: TicketFilter): Promise<readonly TicketSummary[]>;
}
