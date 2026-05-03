/**
 * React Context wiring for the singleton `ApiClient`.
 *
 * Constructed once in `main.tsx`, threaded through `<ApiClientProvider>`,
 * and consumed via `useApiClient()`. Calling `useApiClient()` outside the
 * provider throws a clear error.
 */

import { createContext, type ReactNode, useContext } from "react";
import type { ApiClient } from "./apiClient.ts";

const ApiClientContext = createContext<ApiClient | null>(null);

export interface ApiClientProviderProps {
  readonly value: ApiClient;
  readonly children: ReactNode;
}

export function ApiClientProvider(props: ApiClientProviderProps) {
  return (
    <ApiClientContext.Provider value={props.value}>
      {props.children}
    </ApiClientContext.Provider>
  );
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === null) {
    throw new Error(
      "useApiClient() called outside <ApiClientProvider>. " +
        "Wrap your component tree in <ApiClientProvider value={apiClient}> in main.tsx.",
    );
  }
  return client;
}
