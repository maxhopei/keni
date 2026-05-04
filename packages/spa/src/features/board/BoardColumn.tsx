/**
 * One kanban column.
 *
 * Drop logic is owned here because the target-column info (`data-status`)
 * is local to this element. The column extracts the typed drag payload,
 * computes the target status from its own `status` prop, and delegates
 * the actual mutation to a parent-supplied `onDrop` callback so the
 * view's local state (and the `apiClient.transitionTicket` call) stays
 * colocated with the ticket list.
 */

import { useState } from "react";
import type { DragEvent } from "react";
import type { TicketStatus, TicketSummaryResponse } from "@keni/shared";
import { BoardCard } from "./BoardCard.tsx";
import { unpackDragPayload } from "./dragHelpers.ts";

function titleCase(status: TicketStatus): string {
  // `in_progress` → `In progress`; `ready_for_review` → `Ready for review`.
  const raw = status.replaceAll("_", " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export interface BoardColumnProps {
  readonly status: TicketStatus;
  readonly tickets: readonly TicketSummaryResponse[];
  readonly cardErrors: Readonly<Record<string, string | null>>;
  readonly onDrop: (from: TicketStatus, to: TicketStatus, ticketId: string) => void;
}

export function BoardColumn({ status, tickets, cardErrors, onDrop }: BoardColumnProps) {
  const [isDropTarget, setIsDropTarget] = useState(false);

  function handleDragOver(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!isDropTarget) setIsDropTarget(true);
  }

  function handleDragLeave(_event: DragEvent<HTMLElement>) {
    setIsDropTarget(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDropTarget(false);
    const payload = unpackDragPayload(event.dataTransfer);
    if (payload === null) return;
    onDrop(payload.fromStatus, status, payload.ticketId);
  }

  return (
    <section
      className="keni-board-column"
      data-status={status}
      data-drop-target={isDropTarget ? "true" : undefined}
      data-testid={`board-column-${status}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="keni-board-column__header">
        <span className="keni-board-column__title">{titleCase(status)}</span>
        <span className="keni-board-column__count">({tickets.length})</span>
      </header>
      <div className="keni-board-column__cards">
        {tickets.map((ticket) => (
          <BoardCard
            key={ticket.id}
            ticket={ticket}
            errorCode={cardErrors[ticket.id] ?? null}
          />
        ))}
      </div>
    </section>
  );
}

export default BoardColumn;
