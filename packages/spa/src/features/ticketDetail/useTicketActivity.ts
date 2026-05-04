/**
 * React hook that manages the activity list state for the ticket detail
 * view.
 *
 * Owns: the initial `listActivity({})` call, the debounced refetch when
 * `activity.appended` frames arrive (to collapse a burst of appends into
 * a single round-trip — `TICKET_ACTIVITY_REFETCH_DEBOUNCE_MS`), the
 * unconditional refetch on `"connected"` lifecycle, and the unmount
 * cleanup.
 *
 * The hook intentionally does NOT filter by `refs.ticket === id` — the
 * detail view renders two filtered views (status history and comment
 * thread) from the same unfiltered state and the filter is cheap enough
 * to run on every render.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityEntryResponse, EventFrame } from "@keni/shared";
import type { ApiClient } from "../../transport/apiClient.ts";
import type { EventsClient, EventsClientLifecycle } from "../../transport/eventsClient.ts";
// The debounce constant is declared in `TicketDetailView.tsx` so the spec's
// single-source-of-truth scenario ("the file TicketDetailView.tsx declares
// `const TICKET_ACTIVITY_REFETCH_DEBOUNCE_MS = 250` exactly once") holds
// literally; the hook consumes it from there.
import { TICKET_ACTIVITY_REFETCH_DEBOUNCE_MS } from "./TicketDetailView.tsx";

export interface UseTicketActivityResult {
  readonly entries: readonly ActivityEntryResponse[] | null;
  readonly error: Error | null;
  readonly refetch: () => void;
}

export function useTicketActivity(
  apiClient: ApiClient,
  eventsClient: EventsClient,
): UseTicketActivityResult {
  const [entries, setEntries] = useState<readonly ActivityEntryResponse[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback((): void => {
    apiClient.listActivity({})
      .then((envelope) => {
        setEntries(envelope.data);
        setError(null);
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      });
  }, [apiClient]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const off = eventsClient.onEvent((frame: EventFrame) => {
      if (frame.event !== "activity.appended") return;
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        refetch();
      }, TICKET_ACTIVITY_REFETCH_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [eventsClient, refetch]);

  useEffect(() => {
    return eventsClient.onLifecycle((next: EventsClientLifecycle) => {
      if (next === "connected") refetch();
    });
  }, [eventsClient, refetch]);

  return { entries, error, refetch };
}
