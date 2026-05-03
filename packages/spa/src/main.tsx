import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createApiClient } from "./transport/apiClient.ts";
import { createEventsClient } from "./transport/eventsClient.ts";
import { ApiClientProvider } from "./transport/ApiClientContext.tsx";
import { EventsClientProvider } from "./transport/EventsClientContext.tsx";
import "./index.css";

const apiClient = createApiClient();
const eventsClient = createEventsClient();
eventsClient.start();

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("missing #root mount in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <ApiClientProvider value={apiClient}>
      <EventsClientProvider value={eventsClient}>
        <App />
      </EventsClientProvider>
    </ApiClientProvider>
  </StrictMode>,
);
