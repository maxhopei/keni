import "../../../../src/test_setup.ts";
import { afterEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { assert, assertEquals } from "@std/assert";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiClientProvider } from "../../../../src/transport/ApiClientContext.tsx";
import { EventsClientProvider } from "../../../../src/transport/EventsClientContext.tsx";
import { KeniApiError } from "../../../../src/transport/apiClient.ts";
import type { ApiClient } from "../../../../src/transport/apiClient.ts";
import type {
  EventsClient,
  EventsClientLifecycle,
} from "../../../../src/transport/eventsClient.ts";
import {
  TICKET_ACTIVITY_REFETCH_DEBOUNCE_MS,
  TicketDetailView,
} from "../../../../src/features/ticketDetail/TicketDetailView.tsx";
import { unusedApiStubs } from "../../../../src/features/shared/testStubs.ts";
import type {
  ActivityEntryResponse,
  ActivityQueryResponse,
  EventFrame,
  PRListResponse,
  PRSummaryResponse,
  TicketEnvelope,
  TicketResponse,
} from "@keni/shared";

interface FakeEventsHandle {
  client: EventsClient;
  pushFrame: (f: EventFrame) => void;
  pushLifecycle: (s: EventsClientLifecycle) => void;
  eventListenerCount: () => number;
  lifecycleListenerCount: () => number;
}

function makeFakeEventsClient(): FakeEventsHandle {
  let state: EventsClientLifecycle = "connected";
  const ev = new Set<(f: EventFrame) => void>();
  const lc = new Set<(s: EventsClientLifecycle) => void>();
  const client: EventsClient = {
    get state() {
      return state;
    },
    onEvent(l) {
      ev.add(l);
      return () => ev.delete(l);
    },
    onLifecycle(l) {
      lc.add(l);
      return () => lc.delete(l);
    },
    start: () => {},
    close: () => {},
  };
  return {
    client,
    pushFrame: (f) => {
      for (const l of ev) l(f);
    },
    pushLifecycle: (s) => {
      state = s;
      for (const l of lc) l(s);
    },
    eventListenerCount: () => ev.size,
    lifecycleListenerCount: () => lc.size,
  };
}

function ticketResponse(over: Partial<TicketResponse> = {}): TicketResponse {
  return {
    id: "ticket-0001",
    title: "Add login page",
    status: "open",
    assignee: null,
    priority: 100,
    change_request: null,
    created_at: "2026-05-04T00:00:00.000Z",
    updated_at: "2026-05-04T07:00:00.000Z",
    body: "Users should be able to log in",
    ...over,
  };
}

function activityEntry(over: Partial<ActivityEntryResponse> = {}): ActivityEntryResponse {
  return {
    id: "01HW000000000000000000AAAA",
    timestamp: "2026-05-04T07:00:00.000Z",
    session_id: "s1",
    agent: "user",
    role: "user",
    event: "session_start",
    summary: null,
    refs: {},
    ...over,
  };
}

function renderTicket(
  opts: {
    readonly client: ApiClient;
    readonly events: EventsClient;
    readonly path?: string;
  },
): ReturnType<typeof render> {
  return render(
    <ApiClientProvider value={opts.client}>
      <EventsClientProvider value={opts.events}>
        <MemoryRouter initialEntries={[opts.path ?? "/tickets/ticket-0001"]}>
          <Routes>
            <Route path="/tickets/:id" element={<TicketDetailView />} />
            <Route
              path="/prs/:id"
              element={<div data-testid="pr-detail-stub">pr-detail</div>}
            />
          </Routes>
        </MemoryRouter>
      </EventsClientProvider>
    </ApiClientProvider>,
  );
}

describe({
  name: "TicketDetailView",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  afterEach(() => cleanup());

  // (1) loading / error / not-found / disconnected

  it("renders the loading state before getTicket resolves", () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () => new Promise(() => {}),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    assert(screen.getByTestId("ticket-loading") !== null);
  });

  it("renders the not-found state on 404 store_not_found", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () => Promise.reject(new KeniApiError(404, "store_not_found", "nope")),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    const nf = await waitFor(() => screen.getByTestId("ticket-not-found"));
    assert(nf.textContent?.includes("ticket-0001 does not exist"));
  });

  it("renders the generic error state and retries on click", async () => {
    let calls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new KeniApiError(500, "internal_error", "boom"));
        }
        return Promise.resolve<TicketEnvelope>({
          data: ticketResponse(),
          project_id: "proj-test",
        });
      },
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    const panel = await waitFor(() => screen.getByTestId("ticket-error"));
    assert(panel.textContent?.includes("internal_error"));
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => screen.getByTestId("ticket-detail"));
    assertEquals(calls, 2);
  });

  // (2) every field rendered with fallbacks

  it("renders every field of TicketResponse with documented fallbacks", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () =>
        Promise.resolve<TicketEnvelope>({
          data: ticketResponse({
            assignee: "alice",
            change_request: "cr-0003",
            status: "in_progress",
          }),
          project_id: "proj-test",
        }),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    await waitFor(() => screen.getByTestId("ticket-detail"));
    assertEquals(screen.getByTestId("ticket-id").textContent, "ticket-0001");
    assertEquals(screen.getByTestId("ticket-title").textContent, "Add login page");
    assertEquals(screen.getByTestId("ticket-status").textContent, "In progress");
    assertEquals(screen.getByTestId("ticket-assignee").textContent, "alice");
    assertEquals(screen.getByTestId("ticket-priority").textContent, "100");
    assertEquals(screen.getByTestId("ticket-change-request").textContent, "cr-0003");
    assertEquals(
      screen.getByTestId("ticket-body").textContent,
      "Users should be able to log in",
    );
  });

  it("renders — for null assignee and null change_request", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () =>
        Promise.resolve<TicketEnvelope>({
          data: ticketResponse(),
          project_id: "proj-test",
        }),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    await waitFor(() => screen.getByTestId("ticket-detail"));
    assertEquals(screen.getByTestId("ticket-assignee").textContent, "—");
    assertEquals(screen.getByTestId("ticket-change-request").textContent, "—");
  });

  // (3) title / body edits

  it("title Enter commits patchTicket({ title }) and surfaces errors inline", async () => {
    const patchCalls: { id: string; patch: unknown }[] = [];
    let current = ticketResponse();
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () => Promise.resolve<TicketEnvelope>({ data: current, project_id: "proj-test" }),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
      patchTicket: (id, patch) => {
        patchCalls.push({ id, patch });
        if (patchCalls.length === 1) {
          current = { ...current, title: (patch as { title: string }).title };
          return Promise.resolve<TicketEnvelope>({ data: current, project_id: "proj-test" });
        }
        return Promise.reject(
          new KeniApiError(422, "invalid_artifact", "size_exceeded"),
        );
      },
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    await waitFor(() => screen.getByTestId("ticket-detail"));

    await act(() => {
      fireEvent.click(screen.getByTestId("ticket-title"));
    });
    const input = screen.getByTestId("ticket-title-input") as HTMLInputElement;
    await act(() => {
      fireEvent.change(input, { target: { value: "New title" } });
    });
    await act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => assertEquals(screen.getByTestId("ticket-title").textContent, "New title"));
    assertEquals(patchCalls, [{ id: "ticket-0001", patch: { title: "New title" } }]);

    // Second commit rejects — error surfaces inline.
    await act(() => {
      fireEvent.click(screen.getByTestId("ticket-title"));
    });
    const input2 = screen.getByTestId("ticket-title-input") as HTMLInputElement;
    await act(() => {
      fireEvent.change(input2, { target: { value: "Oversize title" } });
    });
    await act(() => {
      fireEvent.keyDown(input2, { key: "Enter" });
    });
    const err = await waitFor(() => screen.getByTestId("ticket-title-error"));
    assert(err.textContent?.includes("invalid_artifact"));
  });

  it("body Save commits patchTicket({ body })", async () => {
    const patchCalls: { id: string; patch: unknown }[] = [];
    let current = ticketResponse();
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () => Promise.resolve<TicketEnvelope>({ data: current, project_id: "proj-test" }),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
      patchTicket: (id, patch) => {
        patchCalls.push({ id, patch });
        current = { ...current, body: (patch as { body: string }).body };
        return Promise.resolve<TicketEnvelope>({ data: current, project_id: "proj-test" });
      },
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    await waitFor(() => screen.getByTestId("ticket-detail"));

    await act(() => {
      fireEvent.click(screen.getByTestId("ticket-body-edit"));
    });
    const textarea = screen.getByTestId("ticket-body-input") as HTMLTextAreaElement;
    await act(() => {
      fireEvent.change(textarea, { target: { value: "Updated body" } });
    });
    await act(() => {
      fireEvent.click(screen.getByTestId("ticket-body-save"));
    });
    await waitFor(() =>
      assertEquals(screen.getByTestId("ticket-body").textContent, "Updated body")
    );
    assertEquals(patchCalls, [{ id: "ticket-0001", patch: { body: "Updated body" } }]);
  });

  // (4) Transition panel

  it("transition panel is collapsed by default and lists only reachable statuses", async () => {
    let current = ticketResponse({ status: "in_review" });
    const transitionCalls: { id: string; req: unknown }[] = [];
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () => Promise.resolve<TicketEnvelope>({ data: current, project_id: "proj-test" }),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
      transitionTicket: (id, req) => {
        transitionCalls.push({ id, req });
        current = { ...current, status: req.to };
        return Promise.resolve<TicketEnvelope>({ data: current, project_id: "proj-test" });
      },
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    await waitFor(() => screen.getByTestId("ticket-detail"));
    const details = screen.getByTestId("ticket-transition-panel") as HTMLDetailsElement;
    assertEquals(details.open, false);

    // Expand and inspect options. Happy-dom honours `details.open = true`
    // synchronously and the inner controls render on the next layout tick.
    await act(() => {
      details.open = true;
    });
    const select = screen.getByTestId("ticket-transition-to") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    assertEquals(options, ["has_comments", "approved"]);
    assert(
      screen.getByTestId("ticket-transition-caveat").textContent?.includes("raw override path"),
    );
    assert(screen.getByTestId("ticket-transition-caveat").textContent?.includes("Step 25"));

    // Pick approved and submit.
    await act(() => {
      fireEvent.change(select, { target: { value: "approved" } });
    });
    await act(() => {
      fireEvent.click(screen.getByTestId("ticket-transition-submit"));
    });
    await waitFor(() => assertEquals(screen.getByTestId("ticket-status").textContent, "Approved"));
    assertEquals(transitionCalls, [{
      id: "ticket-0001",
      req: { from: "in_review", to: "approved" },
    }]);
  });

  it("terminal status (done) disables the transition control", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () =>
        Promise.resolve<TicketEnvelope>({
          data: ticketResponse({ status: "done" }),
          project_id: "proj-test",
        }),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    await waitFor(() => screen.getByTestId("ticket-detail"));
    const submit = screen.getByTestId("ticket-transition-submit") as HTMLButtonElement;
    const select = screen.getByTestId("ticket-transition-to") as HTMLSelectElement;
    assertEquals(submit.disabled, true);
    assertEquals(select.options[0]?.text, "— no transitions —");
  });

  // (5) history + comments

  it("renders status history for matching entries and comments for ticket_comment", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () =>
        Promise.resolve<TicketEnvelope>({
          data: ticketResponse(),
          project_id: "proj-test",
        }),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
      listActivity: () =>
        Promise.resolve<ActivityQueryResponse>({
          data: [
            activityEntry({ id: "A", event: "session_start", refs: { ticket: "ticket-0001" } }),
            activityEntry({
              id: "B",
              event: "ticket_comment",
              summary: "Please add a forgot-password link",
              refs: { ticket: "ticket-0001" },
            }),
            activityEntry({
              id: "C",
              event: "ticket_comment",
              summary: "Unrelated",
              refs: { ticket: "ticket-0002" },
            }),
          ],
          project_id: "proj-test",
        }),
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    await waitFor(() => screen.getByTestId("ticket-detail"));
    await waitFor(() => {
      assertEquals(screen.getAllByTestId("history-row").length, 2);
      assertEquals(screen.getAllByTestId("comment-row").length, 1);
    });
    assert(
      screen.getByTestId("ticket-comments").textContent?.includes(
        "Please add a forgot-password link",
      ),
    );
  });

  // (6) post comment

  it("posting a comment calls appendActivity with the documented payload and clears the textarea", async () => {
    const appendCalls: unknown[] = [];
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () =>
        Promise.resolve<TicketEnvelope>({
          data: ticketResponse(),
          project_id: "proj-test",
        }),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
      listActivity: () =>
        Promise.resolve<ActivityQueryResponse>({ data: [], project_id: "proj-test" }),
      appendActivity: (input) => {
        appendCalls.push(input);
        return Promise.resolve({
          data: activityEntry({
            id: "D",
            event: "ticket_comment",
            summary: "Nice work",
            refs: { ticket: "ticket-0001" },
          }),
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    await waitFor(() => screen.getByTestId("ticket-detail"));
    const textarea = screen.getByTestId("post-comment-textarea") as HTMLTextAreaElement;
    await act(() => {
      fireEvent.change(textarea, { target: { value: "Nice work" } });
    });
    await act(() => {
      fireEvent.submit(screen.getByTestId("post-comment-form"));
    });
    await waitFor(() => assertEquals(textarea.value, ""));
    assertEquals(appendCalls, [{
      session_id: "ui",
      agent: "user",
      role: "user",
      event: "ticket_comment",
      summary: "Nice work",
      refs: { ticket: "ticket-0001" },
    }]);
  });

  // (7) ticket.updated refetch

  it("a ticket.updated frame for this ticket refetches via getTicket", async () => {
    let call = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () => {
        call += 1;
        return Promise.resolve<TicketEnvelope>({
          data: ticketResponse({
            status: call === 1 ? "open" : "in_review",
          }),
          project_id: "proj-test",
        });
      },
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    await waitFor(() => screen.getByTestId("ticket-detail"));
    await act(() => {
      events.pushFrame({
        id: "01HW",
        event: "ticket.updated",
        project_id: "proj-test",
        timestamp: "2026-05-04T07:00:00.000Z",
        payload: { ticket_id: "ticket-0001", status: "in_review", kind: "transition" },
      });
    });
    await waitFor(() => assertEquals(screen.getByTestId("ticket-status").textContent, "In review"));
  });

  // (8) activity.appended burst -> one debounced refetch

  it("a burst of activity.appended frames collapses into one debounced listActivity refetch", async () => {
    let listCalls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () =>
        Promise.resolve<TicketEnvelope>({
          data: ticketResponse(),
          project_id: "proj-test",
        }),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
      listActivity: () => {
        listCalls += 1;
        return Promise.resolve<ActivityQueryResponse>({
          data: [],
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    // Use real timers for the initial mount so testing-library's waitFor
    // (internally a setTimeout polling loop) completes. Switch to FakeTime
    // only for the debounce window we actually care about.
    await waitFor(() => screen.getByTestId("ticket-detail"));
    assertEquals(listCalls, 1);

    const time = new FakeTime(new Date("2026-05-04T07:00:00.000Z"));
    try {
      await act(async () => {
        for (let i = 0; i < 5; i += 1) {
          events.pushFrame({
            id: `01HW${i}`,
            event: "activity.appended",
            project_id: "proj-test",
            timestamp: "2026-05-04T07:00:00.000Z",
            payload: {
              entry_id: `ent-${i}`,
              agent: "user",
              role: "user",
              event: "ticket_comment",
            },
          });
          await time.tickAsync(50);
        }
      });
      await act(async () => {
        await time.tickAsync(TICKET_ACTIVITY_REFETCH_DEBOUNCE_MS + 10);
      });
      assertEquals(listCalls, 2);
    } finally {
      time.restore();
    }
  });

  // (9) Linked PR section

  it("renders a linked PR with a navigating link and refetches on pr.created", async () => {
    const pr: PRSummaryResponse = {
      id: "pr-0001",
      title: "Login form",
      status: "open",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
      created_at: "2026-05-04T00:00:00.000Z",
      updated_at: "2026-05-04T00:00:00.000Z",
    };
    let listPrsCalls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () =>
        Promise.resolve<TicketEnvelope>({
          data: ticketResponse(),
          project_id: "proj-test",
        }),
      listPrs: () => {
        listPrsCalls += 1;
        return Promise.resolve<PRListResponse>({
          data: listPrsCalls === 1 ? [pr] : [pr],
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    await waitFor(() => screen.getByTestId("linked-pr-pr-0001"));

    await act(() => {
      events.pushFrame({
        id: "01HWXX",
        event: "pr.created",
        project_id: "proj-test",
        timestamp: "2026-05-04T07:00:00.000Z",
        payload: { pr_id: "pr-0002", status: "open", ticket: "ticket-0001" },
      });
    });
    await waitFor(() => assertEquals(listPrsCalls, 2));
  });

  it("empty linked-PR result renders the empty-state element", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () =>
        Promise.resolve<TicketEnvelope>({
          data: ticketResponse(),
          project_id: "proj-test",
        }),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderTicket({ client, events: events.client });
    await waitFor(() => screen.getByTestId("no-linked-pr"));
  });

  // unmount cleanup

  it("unmount releases event and lifecycle subscriptions", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      getTicket: () =>
        Promise.resolve<TicketEnvelope>({
          data: ticketResponse(),
          project_id: "proj-test",
        }),
      listPrs: () => Promise.resolve<PRListResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    const { unmount } = renderTicket({ client, events: events.client });
    await waitFor(() => screen.getByTestId("ticket-detail"));
    assertEquals(events.eventListenerCount() > 0, true);
    assertEquals(events.lifecycleListenerCount() > 0, true);
    unmount();
    assertEquals(events.eventListenerCount(), 0);
    assertEquals(events.lifecycleListenerCount(), 0);
  });
});
