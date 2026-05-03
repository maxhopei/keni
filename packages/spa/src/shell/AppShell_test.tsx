import "../test_setup.ts";
import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell.tsx";
import { BoardPlaceholder } from "./BoardPlaceholder.tsx";
import RoutePlaceholder from "../routes/RoutePlaceholder.tsx";
import { NotFound } from "../routes/NotFound.tsx";
import { ApiClientProvider } from "../transport/ApiClientContext.tsx";
import { EventsClientProvider } from "../transport/EventsClientContext.tsx";
import type { ApiClient } from "../transport/apiClient.ts";
import type { EventsClient } from "../transport/eventsClient.ts";
import type {
  ActivityQueryResponse,
  AgentEnvelope,
  AgentListResponse,
  PRListResponse,
  TicketListResponse,
} from "@keni/shared";

function fakeApiClient(): ApiClient {
  return {
    getProjectId: () => Promise.resolve("proj-test"),
    listAgents: () => Promise.resolve<AgentListResponse>({ data: [], project_id: "proj-test" }),
    pauseAgent: (id: string) =>
      Promise.resolve<AgentEnvelope>({
        data: {
          id,
          role: "engineer",
          status: "idle",
          last_activity: null,
          last_active_at: null,
          paused: true,
        },
        project_id: "proj-test",
      }),
    resumeAgent: (id: string) =>
      Promise.resolve<AgentEnvelope>({
        data: {
          id,
          role: "engineer",
          status: "idle",
          last_activity: null,
          last_active_at: null,
          paused: false,
        },
        project_id: "proj-test",
      }),
    listTickets: () => Promise.resolve<TicketListResponse>({ data: [], project_id: "proj-test" }),
    listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
    listActivity: () =>
      Promise.resolve<ActivityQueryResponse>({ data: [], project_id: "proj-test" }),
  };
}

function fakeEventsClient(): EventsClient {
  return {
    state: "disconnected",
    onEvent: () => () => {},
    onLifecycle: () => () => {},
    start: () => {},
    close: () => {},
  };
}

function renderShell(opts: {
  initialPath: string;
  chatPanelEnabledOverride?: boolean;
}) {
  return render(
    <ApiClientProvider value={fakeApiClient()}>
      <EventsClientProvider value={fakeEventsClient()}>
        <MemoryRouter initialEntries={[opts.initialPath]}>
          <Routes>
            <Route element={<AppShell chatPanelEnabledOverride={opts.chatPanelEnabledOverride} />}>
              <Route index element={<BoardPlaceholder />} />
              <Route
                path="tickets/:id"
                element={<RoutePlaceholder title="Ticket detail" stepRef="step 11" />}
              />
              <Route
                path="prs/:id"
                element={<RoutePlaceholder title="PR detail" stepRef="step 11" />}
              />
              <Route
                path="activity"
                element={<RoutePlaceholder title="Activity log" stepRef="step 11" />}
              />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </MemoryRouter>
      </EventsClientProvider>
    </ApiClientProvider>,
  );
}

// See `AgentRosterPanel_test.tsx`: happy-dom's task manager leaves stray
// timers across tests; disable Deno's resource sanitizer for this DOM suite.
describe({
  name: "AppShell + routing",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  afterEach(() => cleanup());

  function directChildrenByTag(parent: Element, tag: string): Element[] {
    return Array.from(parent.children).filter(
      (child) => child.tagName.toLowerCase() === tag,
    );
  }

  it("renders the three-region grid when the chat panel is hidden", () => {
    const { container } = renderShell({ initialPath: "/", chatPanelEnabledOverride: false });
    const shell = container.querySelector(".keni-app-shell");
    assert(shell !== null);
    assertEquals(shell.getAttribute("data-chat-visible"), "false");
    assertEquals(directChildrenByTag(shell, "header").length, 1);
    assertEquals(directChildrenByTag(shell, "aside").length, 1);
    assertEquals(directChildrenByTag(shell, "main").length, 1);
  });

  it("renders the chat region as a second <aside> when enabled", () => {
    const { container } = renderShell({ initialPath: "/", chatPanelEnabledOverride: true });
    const shell = container.querySelector(".keni-app-shell");
    assert(shell !== null);
    assertEquals(shell.getAttribute("data-chat-visible"), "true");
    assertEquals(directChildrenByTag(shell, "aside").length, 2);
  });

  it("index route shows the board placeholder", () => {
    const { getByTestId } = renderShell({ initialPath: "/" });
    assert(getByTestId("board-placeholder") !== null);
  });

  it("/tickets/:id surfaces the param via RoutePlaceholder", () => {
    const { getByTestId } = renderShell({ initialPath: "/tickets/abc" });
    const node = getByTestId("route-placeholder");
    assert(node.textContent?.includes("Ticket detail"));
    const param = getByTestId("route-param-id");
    assert(param.textContent?.includes("abc"));
  });

  it("unknown path renders the NotFound page", () => {
    const { getByTestId } = renderShell({ initialPath: "/totally-unknown" });
    assert(getByTestId("not-found") !== null);
  });
});
