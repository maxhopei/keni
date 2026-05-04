/**
 * The kanban board — root of the `/` route.
 *
 * Owns the ticket summary list in local React state. The list is seeded
 * by `apiClient.listTickets()` on mount and reconciled by three
 * mechanisms:
 *
 *   - per-event targeted updates for `ticket.created` / `ticket.updated`
 *     frames on the `eventsClient` (design.md Decision 6),
 *   - an unconditional `listTickets()` refetch on every `"connected"`
 *     lifecycle transition (the reconnect tier that reconciles any
 *     frames missed during a disconnect window),
 *   - drop-driven `apiClient.transitionTicket(...)` calls whose
 *     successful envelope is written back into the list in-place.
 *
 * The board does not issue any REST call outside `apiClient`; the card-
 * level error state is keyed by ticket id so a second failed drop on a
 * different card does not clobber the first card's error.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EventFrame,
  TicketCreatedPayload,
  TicketId,
  TicketStatus,
  TicketSummaryResponse,
  TicketUpdatedPayload,
} from "@keni/shared";
import { useApiClient } from "../../transport/ApiClientContext.tsx";
import { useEventsClient } from "../../transport/EventsClientContext.tsx";
import { KeniApiError } from "../../transport/apiClient.ts";
import type { EventsClientLifecycle } from "../../transport/eventsClient.ts";
import { BoardColumn } from "./BoardColumn.tsx";
import { CreateTicketForm } from "./CreateTicketForm.tsx";

/**
 * The twelve columns rendered on the board, in the order specified by
 * the `spa-board` capability spec. This is deliberately a module-level
 * constant (not derived from the status graph) because the render order
 * is a UX decision — the graph is an implementation detail.
 */
export const BOARD_COLUMN_ORDER: readonly TicketStatus[] = [
  "open",
  "in_progress",
  "ready_for_review",
  "in_review",
  "has_comments",
  "approved",
  "merged",
  "ready_for_test",
  "in_testing",
  "tested",
  "test_failed",
  "done",
] as const;

/**
 * Reduces the full ticket list to a summary snapshot. Used when a
 * `getTicket` refetch returns the full `TicketResponse` and we only want
 * to keep the summary fields in our local state (the board renders the
 * summary only; the detail view fetches the body itself).
 */
function toSummary(
  ticket: TicketSummaryResponse & { readonly body?: string },
): TicketSummaryResponse {
  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    assignee: ticket.assignee,
    priority: ticket.priority,
    change_request: ticket.change_request,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
  };
}

export function BoardView() {
  const apiClient = useApiClient();
  const eventsClient = useEventsClient();

  const [tickets, setTickets] = useState<readonly TicketSummaryResponse[] | null>(null);
  const [error, setError] = useState<KeniApiError | Error | null>(null);
  const [disconnected, setDisconnected] = useState<boolean>(
    eventsClient.state === "disconnected",
  );
  const [cardErrors, setCardErrors] = useState<Readonly<Record<string, string | null>>>({});

  const ticketsRef = useRef<readonly TicketSummaryResponse[] | null>(null);
  ticketsRef.current = tickets;

  const refetch = useCallback(async (): Promise<void> => {
    try {
      const envelope = await apiClient.listTickets();
      setTickets(envelope.data);
      setError(null);
    } catch (caught) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      setError(err);
    }
  }, [apiClient]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const off = eventsClient.onEvent((frame: EventFrame) => {
      if (frame.event === "ticket.created") {
        handleTicketCreated(frame.payload);
      } else if (frame.event === "ticket.updated") {
        handleTicketUpdated(frame.payload);
      }
    });

    function handleTicketCreated(payload: TicketCreatedPayload) {
      const current = ticketsRef.current;
      if (current === null) return;
      if (current.some((t) => t.id === payload.ticket_id)) return;
      void apiClient.getTicket(payload.ticket_id).then((envelope) => {
        setTickets((latest) => {
          if (latest === null) return latest;
          if (latest.some((t) => t.id === envelope.data.id)) return latest;
          return [...latest, toSummary(envelope.data)];
        });
      }).catch((caught) => {
        console.warn("Failed to fetch created ticket", payload.ticket_id, caught);
      });
    }

    function handleTicketUpdated(payload: TicketUpdatedPayload) {
      const current = ticketsRef.current;
      if (current === null) return;
      if (payload.kind === "transition") {
        const idx = current.findIndex((t) => t.id === payload.ticket_id);
        if (idx >= 0) {
          setTickets((latest) => {
            if (latest === null) return latest;
            const next = latest.slice();
            const target = next[idx];
            if (target === undefined) return latest;
            next[idx] = { ...target, status: payload.status };
            return next;
          });
        } else {
          void apiClient.getTicket(payload.ticket_id).then((envelope) => {
            setTickets((latest) => {
              if (latest === null) return latest;
              if (latest.some((t) => t.id === envelope.data.id)) return latest;
              return [...latest, toSummary(envelope.data)];
            });
          }).catch((caught) => {
            console.warn("Failed to fetch updated ticket", payload.ticket_id, caught);
          });
        }
      } else {
        void apiClient.getTicket(payload.ticket_id).then((envelope) => {
          setTickets((latest) => {
            if (latest === null) return latest;
            const i = latest.findIndex((t) => t.id === envelope.data.id);
            if (i < 0) return latest;
            const next = latest.slice();
            next[i] = toSummary(envelope.data);
            return next;
          });
        }).catch((caught) => {
          console.warn("Failed to fetch patched ticket", payload.ticket_id, caught);
        });
      }
    }

    return off;
  }, [eventsClient, apiClient]);

  useEffect(() => {
    return eventsClient.onLifecycle((next: EventsClientLifecycle) => {
      if (next === "connected") {
        setDisconnected(false);
        void refetch();
      } else if (next === "disconnected") {
        setDisconnected(true);
      } else if (next === "connecting") {
        setDisconnected(false);
      }
    });
  }, [eventsClient, refetch]);

  const onDrop = useCallback(
    async (from: TicketStatus, to: TicketStatus, ticketId: string) => {
      if (from === to) return;
      setCardErrors((prev) => {
        const next = { ...prev };
        delete next[ticketId];
        return next;
      });
      try {
        const envelope = await apiClient.transitionTicket(ticketId, { from, to });
        const summary = toSummary(envelope.data);
        setTickets((latest) => {
          if (latest === null) return latest;
          const idx = latest.findIndex((t) => t.id === ticketId);
          if (idx < 0) return latest;
          const next = latest.slice();
          next[idx] = summary;
          return next;
        });
      } catch (caught) {
        const code = caught instanceof KeniApiError
          ? caught.code
          : caught instanceof Error
          ? caught.message
          : String(caught);
        setCardErrors((prev) => ({ ...prev, [ticketId]: code }));
      }
    },
    [apiClient],
  );

  if (tickets === null && error === null) {
    return (
      <div className="keni-board" data-testid="board-loading">
        Loading…
      </div>
    );
  }

  if (error !== null) {
    const code = error instanceof KeniApiError ? error.code : error.message;
    return (
      <div className="keni-board" data-testid="board-error" role="alert">
        <p>Failed to load tickets: {code}</p>
        <button
          type="button"
          onClick={() => {
            setTickets(null);
            setError(null);
            void refetch();
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const list = tickets ?? [];
  const byStatus = new Map<TicketStatus, TicketSummaryResponse[]>();
  for (const status of BOARD_COLUMN_ORDER) byStatus.set(status, []);
  for (const ticket of list) {
    const bucket = byStatus.get(ticket.status);
    if (bucket !== undefined) bucket.push(ticket);
  }

  // Normalise the card-error map so we only pass through errors for
  // tickets still present in the list (a transition moves the card to a
  // different column, which clears the error; a ticket that vanishes
  // from the list should not leak its error either).
  const visibleCardErrors: Record<string, string | null> = {};
  for (const ticket of list) {
    const v = cardErrors[ticket.id as TicketId];
    if (v !== undefined) visibleCardErrors[ticket.id] = v;
  }

  return (
    <div
      className="keni-board"
      data-disconnected={disconnected.toString()}
      data-testid="board"
    >
      <CreateTicketForm />
      <div className="keni-board__columns">
        {BOARD_COLUMN_ORDER.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tickets={byStatus.get(status) ?? []}
            cardErrors={visibleCardErrors}
            onDrop={onDrop}
          />
        ))}
      </div>
    </div>
  );
}

export default BoardView;
