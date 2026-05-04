/**
 * One ticket card on the kanban board.
 *
 * The card is the unit of drag-and-drop: it sets the typed `DataTransfer`
 * payload on `dragstart` and defers everything else (drop target, column
 * layout, mutation) to `<BoardColumn>` and `<BoardView>`. Navigation is
 * a `<Link>` click — so clicking the card's body (but not the drag
 * handle itself on a cancelled drag) opens the ticket detail view.
 */

import type { DragEvent } from "react";
import { Link } from "react-router-dom";
import type { TicketSummaryResponse } from "@keni/shared";
import { packDragPayload } from "./dragHelpers.ts";

export interface BoardCardProps {
  readonly ticket: TicketSummaryResponse;
  readonly errorCode?: string | null;
}

export function BoardCard({ ticket, errorCode }: BoardCardProps) {
  function onDragStart(event: DragEvent<HTMLAnchorElement>) {
    packDragPayload(event.dataTransfer, {
      ticketId: ticket.id,
      fromStatus: ticket.status,
    });
  }

  return (
    <Link
      to={`/tickets/${ticket.id}`}
      className="keni-board-card"
      draggable
      onDragStart={onDragStart}
      data-testid="board-card"
      data-ticket-id={ticket.id}
      data-error={errorCode ?? undefined}
    >
      <div className="keni-board-card__row">
        <span className="keni-board-card__id">{ticket.id}</span>
        <span className="keni-board-card__priority" data-testid="board-card-priority">
          {ticket.priority}
        </span>
      </div>
      <div className="keni-board-card__title">{ticket.title}</div>
      <div className="keni-board-card__assignee">
        {ticket.assignee === null ? "—" : ticket.assignee}
      </div>
      {errorCode !== null && errorCode !== undefined
        ? (
          <div className="keni-board-card__error" role="alert">
            {errorCode}
          </div>
        )
        : null}
    </Link>
  );
}

export default BoardCard;
