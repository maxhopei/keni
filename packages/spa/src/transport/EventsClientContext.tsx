/**
 * React Context wiring for the singleton `EventsClient`.
 *
 * Constructed once in `main.tsx`, threaded through `<EventsClientProvider>`,
 * and consumed via `useEventsClient()`. Throws a clear error when used
 * outside the provider.
 */

import { createContext, type ReactNode, useContext } from "react";
import type { EventsClient } from "./eventsClient.ts";

const EventsClientContext = createContext<EventsClient | null>(null);

export interface EventsClientProviderProps {
  readonly value: EventsClient;
  readonly children: ReactNode;
}

export function EventsClientProvider(props: EventsClientProviderProps) {
  return (
    <EventsClientContext.Provider value={props.value}>
      {props.children}
    </EventsClientContext.Provider>
  );
}

export function useEventsClient(): EventsClient {
  const client = useContext(EventsClientContext);
  if (client === null) {
    throw new Error(
      "useEventsClient() called outside <EventsClientProvider>. " +
        "Wrap your component tree in <EventsClientProvider value={eventsClient}> in main.tsx.",
    );
  }
  return client;
}
