import "../../test_setup.ts";
import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ApiClientProvider } from "../../transport/ApiClientContext.tsx";
import { EventsClientProvider } from "../../transport/EventsClientContext.tsx";
import { KeniApiError } from "../../transport/apiClient.ts";
import type { ApiClient } from "../../transport/apiClient.ts";
import type { EventsClient, EventsClientLifecycle } from "../../transport/eventsClient.ts";
import { BOARD_COLUMN_ORDER, BoardView } from "./BoardView.tsx";
import { DRAG_MIME } from "./dragHelpers.ts";
import { unusedApiStubs } from "../shared/testStubs.ts";
import type {
  EventFrame,
  TicketEnvelope,
  TicketListResponse,
  TicketResponse,
  TicketSummaryResponse,
} from "@keni/shared";

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

interface FakeEventsHandle {
  client: EventsClient;
  pushFrame: (frame: EventFrame) => void;
  pushLifecycle: (state: EventsClientLifecycle) => void;
  eventListenerCount: () => number;
  lifecycleListenerCount: () => number;
}

function makeFakeEventsClient(): FakeEventsHandle {
  let state: EventsClientLifecycle = "disconnected";
  const eventListeners = new Set<(f: EventFrame) => void>();
  const lifecycleListeners = new Set<(s: EventsClientLifecycle) => void>();
  const client: EventsClient = {
    get state() {
      return state;
    },
    onEvent(l) {
      eventListeners.add(l);
      return () => eventListeners.delete(l);
    },
    onLifecycle(l) {
      lifecycleListeners.add(l);
      return () => lifecycleListeners.delete(l);
    },
    start: () => {},
    close: () => {},
  };
  return {
    client,
    pushFrame: (frame) => {
      for (const l of eventListeners) l(frame);
    },
    pushLifecycle: (next) => {
      state = next;
      for (const l of lifecycleListeners) l(next);
    },
    eventListenerCount: () => eventListeners.size,
    lifecycleListenerCount: () => lifecycleListeners.size,
  };
}

function ticketSummary(over: Partial<TicketSummaryResponse> = {}): TicketSummaryResponse {
  return {
    id: "ticket-0001",
    title: "Add login page",
    status: "open",
    assignee: null,
    priority: 100,
    change_request: null,
    created_at: "2026-05-04T00:00:00.000Z",
    updated_at: "2026-05-04T00:00:00.000Z",
    ...over,
  };
}

function ticketResponse(over: Partial<TicketResponse> = {}): TicketResponse {
  return { ...ticketSummary(), body: "", ...over };
}

interface RenderOpts {
  readonly client: ApiClient;
  readonly events: EventsClient;
  readonly initialPath?: string;
}

let currentLocation = "/";

function LocationTracker() {
  const loc = useLocation();
  currentLocation = loc.pathname;
  return null;
}

function renderBoard(opts: RenderOpts): ReturnType<typeof render> {
  currentLocation = opts.initialPath ?? "/";
  return render(
    <ApiClientProvider value={opts.client}>
      <EventsClientProvider value={opts.events}>
        <MemoryRouter initialEntries={[currentLocation]}>
          <Routes>
            <Route path="/" element={<BoardView />} />
            <Route
              path="/tickets/:id"
              element={<div data-testid="ticket-detail-stub">ticket-detail</div>}
            />
          </Routes>
          <LocationTracker />
        </MemoryRouter>
      </EventsClientProvider>
    </ApiClientProvider>,
  );
}

describe({
  name: "BoardView",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  afterEach(() => cleanup());

  // (1) Loading / empty / error / disconnected

  it("renders the loading indicator before listTickets resolves", () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () => new Promise(() => {}),
    };
    const events = makeFakeEventsClient();
    const { getByTestId, queryByTestId } = renderBoard({ client, events: events.client });
    assert(getByTestId("board-loading") !== null);
    assertEquals(queryByTestId("board"), null);
  });

  it("renders the empty state as twelve zero-count columns plus the create form", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () => Promise.resolve<TicketListResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderBoard({ client, events: events.client });
    await waitFor(() => screen.getByTestId("board"));
    for (const status of BOARD_COLUMN_ORDER) {
      const col = screen.getByTestId(`board-column-${status}`);
      assert(col.textContent?.includes("(0)"));
    }
    assert(screen.getByTestId("create-ticket-toggle") !== null);
  });

  it("renders the error state with the error code and a retry button that re-issues listTickets", async () => {
    let calls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(
            new KeniApiError(500, "internal_error", "boom"),
          );
        }
        return Promise.resolve<TicketListResponse>({
          data: [ticketSummary()],
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderBoard({ client, events: events.client });
    const panel = await waitFor(() => screen.getByTestId("board-error"));
    assert(panel.textContent?.includes("internal_error"));
    const retry = screen.getByRole("button", { name: "Retry" });
    await act(() => {
      fireEvent.click(retry);
    });
    await waitFor(() => screen.getByTestId("board"));
    assertEquals(calls, 2);
  });

  it('stamps data-disconnected="true" when the events client goes disconnected', async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () =>
        Promise.resolve<TicketListResponse>({
          data: [ticketSummary()],
          project_id: "proj-test",
        }),
    };
    const events = makeFakeEventsClient();
    renderBoard({ client, events: events.client });
    const board = await waitFor(() => screen.getByTestId("board"));
    assertEquals(board.getAttribute("data-disconnected"), "true");
    await act(() => {
      events.pushLifecycle("connected");
    });
    assertEquals(board.getAttribute("data-disconnected"), "false");
    await act(() => {
      events.pushLifecycle("disconnected");
    });
    assertEquals(board.getAttribute("data-disconnected"), "true");
  });

  // (2) Twelve columns in order

  it("renders twelve columns in the documented order", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () => Promise.resolve<TicketListResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    const { container } = renderBoard({ client, events: events.client });
    await waitFor(() => screen.getByTestId("board"));
    const columns = container.querySelectorAll("[data-status]");
    const statuses = Array.from(columns).map((c) => c.getAttribute("data-status"));
    assertEquals(statuses, [...BOARD_COLUMN_ORDER]);
  });

  // (3) ticket.created appends after refetch

  it("ticket.created triggers a getTicket refetch and appends the card", async () => {
    let getTicketCalls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () => Promise.resolve<TicketListResponse>({ data: [], project_id: "proj-test" }),
      getTicket: (id) => {
        getTicketCalls += 1;
        return Promise.resolve<TicketEnvelope>({
          data: ticketResponse({ id, status: "open" }),
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderBoard({ client, events: events.client });
    await waitFor(() => screen.getByTestId("board"));
    await act(() => {
      events.pushFrame({
        id: "01HW0000000000000000000001",
        event: "ticket.created",
        project_id: "proj-test",
        timestamp: "2026-05-04T00:00:00.000Z",
        payload: { ticket_id: "ticket-0001", status: "open" },
      });
    });
    await waitFor(() => {
      const col = screen.getByTestId("board-column-open");
      assert(col.textContent?.includes("ticket-0001"));
    });
    assertEquals(getTicketCalls, 1);
  });

  // (4) ticket.updated kind=transition moves in place (no refetch)

  it("ticket.updated with kind=transition moves the card without a refetch", async () => {
    let getTicketCalls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () =>
        Promise.resolve<TicketListResponse>({
          data: [ticketSummary()],
          project_id: "proj-test",
        }),
      getTicket: () => {
        getTicketCalls += 1;
        return Promise.resolve<TicketEnvelope>({
          data: ticketResponse(),
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderBoard({ client, events: events.client });
    await waitFor(() =>
      screen.getByTestId("board-column-open").textContent?.includes("ticket-0001")
    );
    await act(() => {
      events.pushFrame({
        id: "01HW0000000000000000000002",
        event: "ticket.updated",
        project_id: "proj-test",
        timestamp: "2026-05-04T00:00:00.000Z",
        payload: { ticket_id: "ticket-0001", status: "in_progress", kind: "transition" },
      });
    });
    await waitFor(() => {
      assert(
        screen.getByTestId("board-column-in_progress").textContent?.includes("ticket-0001"),
      );
    });
    assert(
      !screen.getByTestId("board-column-open").textContent?.includes("ticket-0001"),
    );
    assertEquals(getTicketCalls, 0);
  });

  // (5) ticket.updated kind=patch triggers getTicket refetch

  it("ticket.updated with kind=patch refetches and updates fields in place", async () => {
    let getTicketCalls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () =>
        Promise.resolve<TicketListResponse>({
          data: [ticketSummary({ title: "Old title" })],
          project_id: "proj-test",
        }),
      getTicket: (id) => {
        getTicketCalls += 1;
        return Promise.resolve<TicketEnvelope>({
          data: ticketResponse({ id, title: "New title" }),
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderBoard({ client, events: events.client });
    await waitFor(() => screen.getByTestId("board-column-open").textContent?.includes("Old title"));
    await act(() => {
      events.pushFrame({
        id: "01HW0000000000000000000003",
        event: "ticket.updated",
        project_id: "proj-test",
        timestamp: "2026-05-04T00:00:00.000Z",
        payload: { ticket_id: "ticket-0001", status: "open", kind: "patch" },
      });
    });
    await waitFor(() => {
      assert(
        screen.getByTestId("board-column-open").textContent?.includes("New title"),
      );
    });
    assertEquals(getTicketCalls, 1);
  });

  // (6) Successful drop calls transitionTicket and moves the card

  it("a successful drop calls transitionTicket and moves the card", async () => {
    const transitionCalls: { id: string; from: string; to: string }[] = [];
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () =>
        Promise.resolve<TicketListResponse>({
          data: [ticketSummary()],
          project_id: "proj-test",
        }),
      transitionTicket: (id, req) => {
        transitionCalls.push({ id, from: req.from, to: req.to });
        return Promise.resolve<TicketEnvelope>({
          data: ticketResponse({ id, status: req.to }),
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderBoard({ client, events: events.client });
    await waitFor(() =>
      screen.getByTestId("board-column-open").textContent?.includes("ticket-0001")
    );
    const targetColumn = screen.getByTestId("board-column-in_progress");
    const dragDataStore = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => dragDataStore.set(type, value),
      getData: (type: string) => dragDataStore.get(type) ?? "",
      effectAllowed: "none",
      dropEffect: "none",
    };
    dragDataStore.set(
      DRAG_MIME,
      JSON.stringify({ ticketId: "ticket-0001", fromStatus: "open" }),
    );
    await act(() => {
      fireEvent.dragOver(targetColumn, { dataTransfer });
    });
    assertEquals(targetColumn.getAttribute("data-drop-target"), "true");
    await act(() => {
      fireEvent.drop(targetColumn, { dataTransfer });
    });
    await waitFor(() =>
      screen.getByTestId("board-column-in_progress").textContent?.includes("ticket-0001")
    );
    assertEquals(transitionCalls, [{ id: "ticket-0001", from: "open", to: "in_progress" }]);
    assertEquals(targetColumn.getAttribute("data-drop-target"), null);
  });

  // (7) Failed drop leaves the card in place with data-error set

  it("a drop that rejects with KeniApiError leaves the card in its origin column with data-error set", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () =>
        Promise.resolve<TicketListResponse>({
          data: [ticketSummary()],
          project_id: "proj-test",
        }),
      transitionTicket: () =>
        Promise.reject(new KeniApiError(403, "status_graph_violation", "no edge")),
    };
    const events = makeFakeEventsClient();
    renderBoard({ client, events: events.client });
    const openCol = await waitFor(() => screen.getByTestId("board-column-open"));
    const testedCol = screen.getByTestId("board-column-tested");
    const dragDataStore = new Map<string, string>();
    dragDataStore.set(
      DRAG_MIME,
      JSON.stringify({ ticketId: "ticket-0001", fromStatus: "open" }),
    );
    const dataTransfer = {
      setData: (t: string, v: string) => dragDataStore.set(t, v),
      getData: (t: string) => dragDataStore.get(t) ?? "",
      effectAllowed: "none",
      dropEffect: "none",
    };
    await act(() => {
      fireEvent.drop(testedCol, { dataTransfer });
    });
    await waitFor(() => {
      const card = openCol.querySelector('[data-ticket-id="ticket-0001"]');
      assert(card !== null);
      assertEquals(card.getAttribute("data-error"), "status_graph_violation");
    });
    assert(!testedCol.textContent?.includes("ticket-0001"));
  });

  // (8) CreateTicketForm navigates on success and surfaces error on failure

  it("submitting the CreateTicketForm navigates to the new ticket's detail route on success", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () => Promise.resolve<TicketListResponse>({ data: [], project_id: "proj-test" }),
      createTicket: (input) =>
        Promise.resolve<TicketEnvelope>({
          data: ticketResponse({ id: "ticket-new", title: input.title }),
          project_id: "proj-test",
        }),
    };
    const events = makeFakeEventsClient();
    renderBoard({ client, events: events.client });
    await waitFor(() => screen.getByTestId("create-ticket-toggle"));
    await act(() => {
      fireEvent.click(screen.getByTestId("create-ticket-toggle"));
    });
    const titleInput = screen.getByTestId("create-ticket-title") as HTMLInputElement;
    await act(() => {
      fireEvent.change(titleInput, { target: { value: "Add login page" } });
    });
    await act(() => {
      fireEvent.submit(screen.getByTestId("create-ticket-form"));
    });
    await waitFor(() => screen.getByTestId("ticket-detail-stub"));
    assertEquals(currentLocation, "/tickets/ticket-new");
  });

  it("a KeniApiError from createTicket renders an inline error and keeps the form expanded", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () => Promise.resolve<TicketListResponse>({ data: [], project_id: "proj-test" }),
      createTicket: () => Promise.reject(new KeniApiError(400, "validation_failed", "bad")),
    };
    const events = makeFakeEventsClient();
    renderBoard({ client, events: events.client });
    await waitFor(() => screen.getByTestId("create-ticket-toggle"));
    await act(() => {
      fireEvent.click(screen.getByTestId("create-ticket-toggle"));
    });
    await act(() => {
      fireEvent.change(screen.getByTestId("create-ticket-title"), {
        target: { value: "Anything" },
      });
    });
    await act(() => {
      fireEvent.submit(screen.getByTestId("create-ticket-form"));
    });
    const err = await waitFor(() => screen.getByTestId("create-ticket-error"));
    assert(err.textContent?.includes("validation_failed"));
    assert(screen.getByTestId("create-ticket-form") !== null);
  });

  // (9) connected lifecycle triggers a refetch

  it("a connected lifecycle transition triggers an unconditional listTickets refetch", async () => {
    let listCalls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () => {
        listCalls += 1;
        return Promise.resolve<TicketListResponse>({ data: [], project_id: "proj-test" });
      },
    };
    const events = makeFakeEventsClient();
    renderBoard({ client, events: events.client });
    await waitFor(() => screen.getByTestId("board"));
    assertEquals(listCalls, 1);
    await act(() => {
      events.pushLifecycle("connected");
    });
    await waitFor(() => assertEquals(listCalls, 2));
  });

  // Unmount cleans up subscriptions

  it("unmount clears the event and lifecycle subscriptions", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listTickets: () => Promise.resolve<TicketListResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    const { unmount } = renderBoard({ client, events: events.client });
    await waitFor(() => screen.getByTestId("board"));
    assertEquals(events.eventListenerCount() > 0, true);
    assertEquals(events.lifecycleListenerCount() > 0, true);
    unmount();
    assertEquals(events.eventListenerCount(), 0);
    assertEquals(events.lifecycleListenerCount(), 0);
  });
});
