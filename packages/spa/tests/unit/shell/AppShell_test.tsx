import "../../../src/test_setup.ts";
import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "../../../src/shell/AppShell.tsx";
import { BoardView } from "../../../src/features/board/BoardView.tsx";
import { TicketDetailView } from "../../../src/features/ticketDetail/TicketDetailView.tsx";
import { PRDetailView } from "../../../src/features/prDetail/PRDetailView.tsx";
import { ActivityLogView } from "../../../src/features/activityLog/ActivityLogView.tsx";
import { NotFound } from "../../../src/routes/NotFound.tsx";
import { ApiClientProvider } from "../../../src/transport/ApiClientContext.tsx";
import { EventsClientProvider } from "../../../src/transport/EventsClientContext.tsx";
import { unusedApiStubs } from "../../../src/features/shared/testStubs.ts";
import type { ApiClient } from "../../../src/transport/apiClient.ts";
import type { EventsClient } from "../../../src/transport/eventsClient.ts";

function fakeApiClient(): ApiClient {
  return unusedApiStubs();
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
              <Route index element={<BoardView />} />
              <Route path="tickets/:id" element={<TicketDetailView />} />
              <Route path="prs/:id" element={<PRDetailView />} />
              <Route path="activity" element={<ActivityLogView />} />
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

  it("renders the three-region grid when the chat panel is hidden", async () => {
    const { container } = renderShell({ initialPath: "/", chatPanelEnabledOverride: false });
    const shell = container.querySelector(".keni-app-shell");
    assert(shell !== null);
    assertEquals(shell.getAttribute("data-chat-visible"), "false");
    assertEquals(directChildrenByTag(shell, "header").length, 1);
    assertEquals(directChildrenByTag(shell, "aside").length, 1);
    assertEquals(directChildrenByTag(shell, "main").length, 1);
    await waitFor(() => {
      assert(container.querySelector('[data-testid="board"]') !== null);
    });
  });

  it("renders the chat region as a second <aside> when enabled", async () => {
    const { container } = renderShell({ initialPath: "/", chatPanelEnabledOverride: true });
    const shell = container.querySelector(".keni-app-shell");
    assert(shell !== null);
    assertEquals(shell.getAttribute("data-chat-visible"), "true");
    assertEquals(directChildrenByTag(shell, "aside").length, 2);
    await waitFor(() => {
      assert(container.querySelector('[data-testid="board"]') !== null);
    });
  });

  it("index route mounts the BoardView and renders its loading state initially", () => {
    const { getByTestId } = renderShell({ initialPath: "/" });
    // listTickets resolves asynchronously via unusedApiStubs, so on the
    // first synchronous render the loading element is present.
    assert(getByTestId("board-loading") !== null);
  });

  it("/tickets/:id mounts the TicketDetailView", async () => {
    const { getByTestId } = renderShell({ initialPath: "/tickets/ticket-0001" });
    assert(getByTestId("ticket-loading") !== null);
    // Once getTicket resolves, the detail container renders.
    await waitFor(() => {
      assert(getByTestId("ticket-detail") !== null);
    });
  });

  it("/prs/:id mounts the PRDetailView", async () => {
    const { getByTestId } = renderShell({ initialPath: "/prs/pr-0001" });
    assert(getByTestId("pr-loading") !== null);
    await waitFor(() => {
      assert(getByTestId("pr-detail") !== null);
    });
  });

  it("/activity mounts the ActivityLogView", async () => {
    const { getByTestId } = renderShell({ initialPath: "/activity" });
    assert(getByTestId("activity-loading") !== null);
    await waitFor(() => {
      assert(getByTestId("activity-log") !== null);
    });
  });

  it("unknown path renders the NotFound page", () => {
    const { getByTestId } = renderShell({ initialPath: "/totally-unknown" });
    assert(getByTestId("not-found") !== null);
  });
});
