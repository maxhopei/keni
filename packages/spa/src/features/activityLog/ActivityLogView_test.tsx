import "../../test_setup.ts";
import { afterEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { assert, assertEquals } from "@std/assert";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiClientProvider } from "../../transport/ApiClientContext.tsx";
import { EventsClientProvider } from "../../transport/EventsClientContext.tsx";
import { KeniApiError } from "../../transport/apiClient.ts";
import type { ApiClient, ListActivityFilter } from "../../transport/apiClient.ts";
import type { EventsClient, EventsClientLifecycle } from "../../transport/eventsClient.ts";
import { ACTIVITY_FILTER_DEBOUNCE_MS, ActivityLogView } from "./ActivityLogView.tsx";
import { unusedApiStubs } from "../shared/testStubs.ts";
import type { ActivityEntryResponse, ActivityQueryResponse, EventFrame } from "@keni/shared";

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

function entry(over: Partial<ActivityEntryResponse> = {}): ActivityEntryResponse {
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

function renderView(opts: {
  readonly client: ApiClient;
  readonly events: EventsClient;
}): ReturnType<typeof render> {
  return render(
    <ApiClientProvider value={opts.client}>
      <EventsClientProvider value={opts.events}>
        <MemoryRouter initialEntries={["/activity"]}>
          <Routes>
            <Route path="/activity" element={<ActivityLogView />} />
            <Route
              path="/tickets/:id"
              element={<div data-testid="ticket-detail-stub">ticket-detail</div>}
            />
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
  name: "ActivityLogView",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  afterEach(() => cleanup());

  // ───────── (1) loading / error / empty / disconnected ─────────

  it("renders the loading state before listActivity resolves", () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: () => new Promise(() => {}),
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    assert(screen.getByTestId("activity-loading") !== null);
  });

  it("renders the error state and retries on click", async () => {
    let calls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new KeniApiError(500, "internal_error", "boom"));
        }
        return Promise.resolve<ActivityQueryResponse>({
          data: [entry({ id: "A" })],
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    const panel = await waitFor(() => screen.getByTestId("activity-error"));
    assert(panel.textContent?.includes("internal_error"));
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => {
      assertEquals(screen.getAllByTestId("activity-row").length, 1);
    });
  });

  it("renders the empty state for a resolved empty list", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: () =>
        Promise.resolve<ActivityQueryResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    await waitFor(() => screen.getByTestId("activity-empty"));
    assertEquals(screen.getByTestId("activity-empty").textContent, "No activity.");
  });

  it("sets data-disconnected=true on the container when the events client is disconnected", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: () =>
        Promise.resolve<ActivityQueryResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    await waitFor(() => screen.getByTestId("activity-log"));
    assertEquals(
      screen.getByTestId("activity-log").getAttribute("data-disconnected"),
      "false",
    );
    await act(() => {
      events.pushLifecycle("disconnected");
    });
    assertEquals(
      screen.getByTestId("activity-log").getAttribute("data-disconnected"),
      "true",
    );
  });

  // ───────── (2) default filter is {} and changing filters re-issues ─────────

  it("mount calls listActivity({}) exactly once with the default filter", async () => {
    const calls: ListActivityFilter[] = [];
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: (f) => {
        calls.push(f ?? {});
        return Promise.resolve<ActivityQueryResponse>({ data: [], project_id: "proj-test" });
      },
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    await waitFor(() => screen.getByTestId("activity-empty"));
    assertEquals(calls, [{}]);
  });

  it("typing into the agent input debounces into one listActivity call", async () => {
    const calls: ListActivityFilter[] = [];
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: (f) => {
        calls.push(f ?? {});
        return Promise.resolve<ActivityQueryResponse>({ data: [], project_id: "proj-test" });
      },
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    await waitFor(() => screen.getByTestId("activity-empty"));
    assertEquals(calls.length, 1);

    const input = screen.getByTestId("activity-filter-agent") as HTMLInputElement;
    const time = new FakeTime(new Date("2026-05-04T07:00:00.000Z"));
    try {
      await act(async () => {
        for (const c of "alice") {
          fireEvent.change(input, { target: { value: input.value + c } });
          await time.tickAsync(50);
        }
      });
      await act(async () => {
        await time.tickAsync(ACTIVITY_FILTER_DEBOUNCE_MS + 10);
      });
      // Allow the promise chain for listActivity to settle.
      await act(async () => {
        await Promise.resolve();
      });
      assertEquals(calls.length, 2);
      assertEquals(calls[1], { agent: "alice" });
    } finally {
      time.restore();
    }
  });

  it("selecting a role issues listActivity({ role })", async () => {
    const calls: ListActivityFilter[] = [];
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: (f) => {
        calls.push(f ?? {});
        return Promise.resolve<ActivityQueryResponse>({ data: [], project_id: "proj-test" });
      },
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    await waitFor(() => screen.getByTestId("activity-empty"));

    const select = screen.getByTestId("activity-filter-role") as HTMLSelectElement;
    const time = new FakeTime(new Date("2026-05-04T07:00:00.000Z"));
    try {
      await act(() => {
        fireEvent.change(select, { target: { value: "engineer" } });
      });
      await act(async () => {
        await time.tickAsync(ACTIVITY_FILTER_DEBOUNCE_MS + 10);
      });
      await act(async () => {
        await Promise.resolve();
      });
      assertEquals(calls.length, 2);
      assertEquals(calls[1], { role: "engineer" });
    } finally {
      time.restore();
    }
  });

  // ───────── (3) Clear filters resets every input ─────────

  it("Clear filters resets every input and re-issues listActivity({})", async () => {
    const calls: ListActivityFilter[] = [];
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: (f) => {
        calls.push(f ?? {});
        return Promise.resolve<ActivityQueryResponse>({ data: [], project_id: "proj-test" });
      },
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    await waitFor(() => screen.getByTestId("activity-empty"));

    const agent = screen.getByTestId("activity-filter-agent") as HTMLInputElement;
    const role = screen.getByTestId("activity-filter-role") as HTMLSelectElement;
    const time = new FakeTime(new Date("2026-05-04T07:00:00.000Z"));
    try {
      await act(() => {
        fireEvent.change(agent, { target: { value: "alice" } });
        fireEvent.change(role, { target: { value: "engineer" } });
      });
      await act(async () => {
        await time.tickAsync(ACTIVITY_FILTER_DEBOUNCE_MS + 10);
      });
      await act(async () => {
        await Promise.resolve();
      });
      // Baseline: mount + committed filter => 2 calls.
      assertEquals(calls.length >= 2, true);

      await act(() => {
        fireEvent.click(screen.getByTestId("activity-filter-clear"));
      });
      await act(async () => {
        await time.tickAsync(ACTIVITY_FILTER_DEBOUNCE_MS + 10);
      });
      await act(async () => {
        await Promise.resolve();
      });
      assertEquals(agent.value, "");
      assertEquals(role.value, "");
      assertEquals(calls.at(-1), {});
    } finally {
      time.restore();
    }
  });

  // ───────── (4) Rows render newest-first + every field ─────────

  it("renders rows in reverse-chronological order with every documented field", async () => {
    const rows = [
      entry({ id: "A", timestamp: "2026-05-04T07:00:00.000Z", agent: "alice" }),
      entry({ id: "B", timestamp: "2026-05-04T07:01:00.000Z", agent: "bob" }),
      entry({ id: "C", timestamp: "2026-05-04T07:02:00.000Z", agent: "carol" }),
    ];
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: () =>
        Promise.resolve<ActivityQueryResponse>({ data: rows, project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    await waitFor(() => screen.getByTestId("activity-list"));
    const rendered = screen.getAllByTestId("activity-row");
    assertEquals(rendered.length, 3);
    // Newest (C) topmost, then B, then A.
    assert(rendered[0]?.textContent?.includes("carol"));
    assert(rendered[1]?.textContent?.includes("bob"));
    assert(rendered[2]?.textContent?.includes("alice"));
  });

  it("a row renders every documented field including ticket refs as links", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: () =>
        Promise.resolve<ActivityQueryResponse>({
          data: [
            entry({
              id: "01HWSOMETHING",
              timestamp: "2026-05-04T07:00:00.000Z",
              agent: "alice",
              role: "engineer",
              event: "session_start",
              summary: "Started session",
              refs: { ticket: "ticket-0001" },
            }),
          ],
          project_id: "proj-test",
        }),
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    const list = await waitFor(() => screen.getByTestId("activity-list"));
    assert(list.textContent?.includes("alice"));
    assert(list.textContent?.includes("engineer"));
    assert(list.textContent?.includes("session_start"));
    assert(list.textContent?.includes("Started session"));
    const link = screen.getByTestId("activity-ref-ticket-ticket-0001") as HTMLAnchorElement;
    assertEquals(link.getAttribute("href"), "/tickets/ticket-0001");
  });

  // ───────── (5) activity.appended matching + debounce ─────────

  it("a matching activity.appended frame triggers a debounced refetch", async () => {
    let calls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: () => {
        calls += 1;
        return Promise.resolve<ActivityQueryResponse>({
          data: [],
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    await waitFor(() => screen.getByTestId("activity-empty"));
    assertEquals(calls, 1);

    const time = new FakeTime(new Date("2026-05-04T07:00:00.000Z"));
    try {
      await act(() => {
        events.pushFrame({
          id: "01HW1",
          event: "activity.appended",
          project_id: "proj-test",
          timestamp: "2026-05-04T07:00:01.000Z",
          payload: {
            entry_id: "ent-1",
            agent: "alice",
            role: "engineer",
            event: "ticket_comment",
          },
        });
      });
      await act(async () => {
        await time.tickAsync(ACTIVITY_FILTER_DEBOUNCE_MS + 10);
      });
      await act(async () => {
        await Promise.resolve();
      });
      assertEquals(calls, 2);
    } finally {
      time.restore();
    }
  });

  it("a non-matching activity.appended frame is ignored", async () => {
    let calls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: () => {
        calls += 1;
        return Promise.resolve<ActivityQueryResponse>({
          data: [],
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    await waitFor(() => screen.getByTestId("activity-empty"));
    const input = screen.getByTestId("activity-filter-agent") as HTMLInputElement;
    const time = new FakeTime(new Date("2026-05-04T07:00:00.000Z"));
    try {
      await act(() => {
        fireEvent.change(input, { target: { value: "alice" } });
      });
      await act(async () => {
        await time.tickAsync(ACTIVITY_FILTER_DEBOUNCE_MS + 10);
      });
      await act(async () => {
        await Promise.resolve();
      });
      const beforeFrame = calls;

      // Non-matching frame: agent=bob vs. filter.agent=alice.
      await act(() => {
        events.pushFrame({
          id: "01HW1",
          event: "activity.appended",
          project_id: "proj-test",
          timestamp: "2026-05-04T07:00:01.000Z",
          payload: {
            entry_id: "ent-1",
            agent: "bob",
            role: "engineer",
            event: "ticket_comment",
          },
        });
      });
      await act(async () => {
        await time.tickAsync(ACTIVITY_FILTER_DEBOUNCE_MS + 10);
      });
      await act(async () => {
        await Promise.resolve();
      });
      assertEquals(calls, beforeFrame);
    } finally {
      time.restore();
    }
  });

  it("a burst of matching frames collapses into one debounced refetch", async () => {
    let calls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: () => {
        calls += 1;
        return Promise.resolve<ActivityQueryResponse>({
          data: [],
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    await waitFor(() => screen.getByTestId("activity-empty"));
    assertEquals(calls, 1);

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
        await time.tickAsync(ACTIVITY_FILTER_DEBOUNCE_MS + 10);
      });
      await act(async () => {
        await Promise.resolve();
      });
      assertEquals(calls, 2);
    } finally {
      time.restore();
    }
  });

  // ───────── (6) connected lifecycle refetch ─────────

  it("connected lifecycle refetches with the current filter", async () => {
    const calls: ListActivityFilter[] = [];
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: (f) => {
        calls.push(f ?? {});
        return Promise.resolve<ActivityQueryResponse>({ data: [], project_id: "proj-test" });
      },
    };
    const events = makeFakeEventsClient();
    renderView({ client, events: events.client });
    await waitFor(() => screen.getByTestId("activity-empty"));
    const time = new FakeTime(new Date("2026-05-04T07:00:00.000Z"));
    try {
      await act(() => {
        fireEvent.change(screen.getByTestId("activity-filter-role"), {
          target: { value: "engineer" },
        });
      });
      await act(async () => {
        await time.tickAsync(ACTIVITY_FILTER_DEBOUNCE_MS + 10);
      });
      await act(async () => {
        await Promise.resolve();
      });
      const before = calls.length;
      await act(() => {
        events.pushLifecycle("connected");
      });
      await act(async () => {
        await Promise.resolve();
      });
      assertEquals(calls.length, before + 1);
      assertEquals(calls.at(-1), { role: "engineer" });
    } finally {
      time.restore();
    }
  });

  // ───────── (7) unmount cleanup ─────────

  it("unmount releases event and lifecycle subscriptions", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      listActivity: () =>
        Promise.resolve<ActivityQueryResponse>({ data: [], project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    const { unmount } = renderView({ client, events: events.client });
    await waitFor(() => screen.getByTestId("activity-empty"));
    assertEquals(events.eventListenerCount() > 0, true);
    assertEquals(events.lifecycleListenerCount() > 0, true);
    unmount();
    assertEquals(events.eventListenerCount(), 0);
    assertEquals(events.lifecycleListenerCount(), 0);
  });
});
