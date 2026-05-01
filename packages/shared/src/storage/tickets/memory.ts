/**
 * In-memory `TicketStore` adapter — drop-in replacement for the file-backed
 * adapter in unit tests. Same behavioural contract; no filesystem.
 *
 * @module
 */

import { InvalidArtifactError, StaleStateError, StoreNotFoundError } from "../errors.ts";
import { generateTicketId } from "../ids.ts";
import type {
  Ticket,
  TicketCreateInput,
  TicketFilter,
  TicketHeader,
  TicketHeaderPatch,
  TicketId,
  TicketStatus,
  TicketStore,
  TicketSummary,
} from "./interface.ts";
import { matchTicket, validateHeaderPatch } from "./shared.ts";

/**
 * In-memory `TicketStore`. See `./interface.ts` for the full contract;
 * behavioural equivalence with `FileTicketStore` is enforced by
 * `./contract_test.ts`.
 */
export class InMemoryTicketStore implements TicketStore {
  readonly #tickets = new Map<TicketId, Ticket>();

  list(filter?: TicketFilter): Promise<TicketSummary[]> {
    const out: TicketSummary[] = [];
    for (const t of this.#tickets.values()) {
      if (matchTicket(t.header, filter)) {
        out.push(cloneHeader(t.header));
      }
    }
    return Promise.resolve(out);
  }

  read(id: TicketId): Promise<Ticket> {
    const t = this.#tickets.get(id);
    if (!t) return Promise.reject(new StoreNotFoundError(id));
    return Promise.resolve(cloneTicket(t));
  }

  create(input: TicketCreateInput): Promise<Ticket> {
    const id = generateTicketId([...this.#tickets.keys()]);
    const now = new Date().toISOString();
    const ticket: Ticket = {
      header: {
        id,
        title: input.title,
        status: "open",
        assignee: input.assignee ?? null,
        priority: input.priority,
        change_request: input.change_request ?? null,
        created_at: now,
        updated_at: now,
      },
      body: input.body ?? "",
    };
    this.#tickets.set(id, ticket);
    return Promise.resolve(cloneTicket(ticket));
  }

  updateBody(id: TicketId, body: string): Promise<Ticket> {
    const existing = this.#tickets.get(id);
    if (!existing) return Promise.reject(new StoreNotFoundError(id));
    const updated: Ticket = {
      header: { ...existing.header, updated_at: new Date().toISOString() },
      body,
    };
    this.#tickets.set(id, updated);
    return Promise.resolve(cloneTicket(updated));
  }

  updateHeader(id: TicketId, patch: TicketHeaderPatch): Promise<Ticket> {
    try {
      validateHeaderPatch(patch);
    } catch (err) {
      if (err instanceof InvalidArtifactError) return Promise.reject(err);
      throw err;
    }
    const existing = this.#tickets.get(id);
    if (!existing) return Promise.reject(new StoreNotFoundError(id));
    const newHeader: TicketHeader = {
      ...existing.header,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.change_request !== undefined ? { change_request: patch.change_request } : {}),
      updated_at: new Date().toISOString(),
    };
    const updated: Ticket = { header: newHeader, body: existing.body };
    this.#tickets.set(id, updated);
    return Promise.resolve(cloneTicket(updated));
  }

  transitionStatus(
    id: TicketId,
    from: TicketStatus,
    to: TicketStatus,
  ): Promise<Ticket> {
    const existing = this.#tickets.get(id);
    if (!existing) return Promise.reject(new StoreNotFoundError(id));
    if (existing.header.status !== from) {
      return Promise.reject(
        new StaleStateError(id, from, existing.header.status),
      );
    }
    const updated: Ticket = {
      header: {
        ...existing.header,
        status: to,
        updated_at: new Date().toISOString(),
      },
      body: existing.body,
    };
    this.#tickets.set(id, updated);
    return Promise.resolve(cloneTicket(updated));
  }

  linkChangeRequest(
    id: TicketId,
    changeRequestId: string,
  ): Promise<Ticket> {
    const existing = this.#tickets.get(id);
    if (!existing) return Promise.reject(new StoreNotFoundError(id));
    const updated: Ticket = {
      header: {
        ...existing.header,
        change_request: changeRequestId,
        updated_at: new Date().toISOString(),
      },
      body: existing.body,
    };
    this.#tickets.set(id, updated);
    return Promise.resolve(cloneTicket(updated));
  }
}

function cloneHeader(h: TicketHeader): TicketHeader {
  return { ...h };
}

function cloneTicket(t: Ticket): Ticket {
  return { header: cloneHeader(t.header), body: t.body };
}
