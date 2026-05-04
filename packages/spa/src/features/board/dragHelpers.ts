/**
 * Serialisation helpers for the board's HTML5 drag-and-drop payload.
 *
 * Keeping the marshalling in one tiny pure module (no React, no DOM APIs
 * beyond `DataTransfer`) makes the JSON shape testable in isolation and
 * ensures `BoardCard` / `BoardColumn` share exactly one encoding (a
 * typo'd MIME type or JSON-shape change on either side would break the
 * drop silently; a shared helper + unit test catches that at CI time).
 */

import type { TicketId, TicketStatus } from "@keni/shared";

/**
 * Custom MIME type for the drag payload. Any string that starts with
 * `application/` works here — the browser treats it opaquely. A domain-
 * specific type (rather than `text/plain`) avoids colliding with other
 * drag sources in a future embed (e.g., drags from the OS file picker).
 */
export const DRAG_MIME = "application/keni-ticket-drag";

export interface DragPayload {
  readonly ticketId: TicketId;
  readonly fromStatus: TicketStatus;
}

/**
 * Writes the typed payload into the drag's `DataTransfer`. Callers invoke
 * this from an `onDragStart` handler.
 */
export function packDragPayload(dt: DataTransfer, payload: DragPayload): void {
  dt.setData(DRAG_MIME, JSON.stringify(payload));
  dt.effectAllowed = "move";
}

/**
 * Parses the payload from the drop's `DataTransfer`. Returns `null` when
 * the MIME type is absent or the JSON is malformed — callers treat a
 * `null` as "not one of our drags" and no-op.
 */
export function unpackDragPayload(dt: DataTransfer): DragPayload | null {
  const raw = dt.getData(DRAG_MIME);
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const ticketId = (parsed as { ticketId?: unknown }).ticketId;
  const fromStatus = (parsed as { fromStatus?: unknown }).fromStatus;
  if (typeof ticketId !== "string" || typeof fromStatus !== "string") {
    return null;
  }
  return { ticketId: ticketId as TicketId, fromStatus: fromStatus as TicketStatus };
}
