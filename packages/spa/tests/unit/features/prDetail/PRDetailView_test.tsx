import "../../../../src/test_setup.ts";
import { afterEach, describe, it } from "@std/testing/bdd";
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
import { PRDetailView } from "../../../../src/features/prDetail/PRDetailView.tsx";
import { unusedApiStubs } from "../../../../src/features/shared/testStubs.ts";
import type { EventFrame, MergePrEnvelope, PREnvelope, PRResponse } from "@keni/shared";

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

function prResponse(over: Partial<PRResponse> = {}): PRResponse {
  return {
    id: "pr-0001",
    title: "Login form",
    status: "approved",
    ticket: "ticket-0001",
    branch: "ticket-0001",
    author: "alice",
    created_at: "2026-05-04T00:00:00.000Z",
    updated_at: "2026-05-04T07:00:00.000Z",
    body: "Implements the login page",
    ...over,
  };
}

function renderPr(
  opts: { readonly client: ApiClient; readonly events: EventsClient; readonly path?: string },
): ReturnType<typeof render> {
  return render(
    <ApiClientProvider value={opts.client}>
      <EventsClientProvider value={opts.events}>
        <MemoryRouter initialEntries={[opts.path ?? "/prs/pr-0001"]}>
          <Routes>
            <Route path="/prs/:id" element={<PRDetailView />} />
            <Route
              path="/tickets/:id"
              element={<div data-testid="ticket-detail-stub">ticket-detail</div>}
            />
          </Routes>
        </MemoryRouter>
      </EventsClientProvider>
    </ApiClientProvider>,
  );
}

describe({
  name: "PRDetailView",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  afterEach(() => cleanup());

  // (1) loading / error / not-found / disconnected

  it("renders loading, error, not-found and disconnected states", async () => {
    // not-found
    {
      const client: ApiClient = {
        ...unusedApiStubs(),
        getPr: () => Promise.reject(new KeniApiError(404, "store_not_found", "nope")),
      };
      const events = makeFakeEventsClient();
      renderPr({ client, events: events.client, path: "/prs/pr-9999" });
      const nf = await waitFor(() => screen.getByTestId("pr-not-found"));
      assert(nf.textContent?.includes("pr-9999 does not exist"));
      cleanup();
    }
    // generic error
    {
      let calls = 0;
      const client: ApiClient = {
        ...unusedApiStubs(),
        getPr: () => {
          calls += 1;
          if (calls === 1) {
            return Promise.reject(new KeniApiError(500, "internal_error", "boom"));
          }
          return Promise.resolve<PREnvelope>({ data: prResponse(), project_id: "proj-test" });
        },
      };
      const events = makeFakeEventsClient();
      renderPr({ client, events: events.client });
      const panel = await waitFor(() => screen.getByTestId("pr-error"));
      assert(panel.textContent?.includes("internal_error"));
      await act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      });
      await waitFor(() => screen.getByTestId("pr-detail"));
      cleanup();
    }
    // loading (pending)
    {
      const client: ApiClient = { ...unusedApiStubs(), getPr: () => new Promise(() => {}) };
      const events = makeFakeEventsClient();
      renderPr({ client, events: events.client });
      assert(screen.getByTestId("pr-loading") !== null);
      cleanup();
    }
    // disconnected
    {
      const client: ApiClient = {
        ...unusedApiStubs(),
        getPr: () => Promise.resolve<PREnvelope>({ data: prResponse(), project_id: "proj-test" }),
      };
      const events = makeFakeEventsClient();
      renderPr({ client, events: events.client });
      const view = await waitFor(() => screen.getByTestId("pr-detail"));
      await act(() => {
        events.pushLifecycle("disconnected");
      });
      assertEquals(view.getAttribute("data-disconnected"), "true");
    }
  });

  // (2) every field rendered + linked ticket link navigates

  it("renders every PRResponse field and the linked-ticket link navigates", async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      getPr: () => Promise.resolve<PREnvelope>({ data: prResponse(), project_id: "proj-test" }),
    };
    const events = makeFakeEventsClient();
    renderPr({ client, events: events.client });
    await waitFor(() => screen.getByTestId("pr-detail"));
    assertEquals(screen.getByTestId("pr-id").textContent, "pr-0001");
    assertEquals(screen.getByTestId("pr-title").textContent, "Login form");
    assertEquals(screen.getByTestId("pr-status").textContent, "Approved");
    assertEquals(screen.getByTestId("pr-author").textContent, "alice");
    assertEquals(screen.getByTestId("pr-branch").textContent, "ticket-0001");
    assertEquals(screen.getByTestId("pr-intent").textContent, "Implements the login page");
    const link = screen.getByTestId("pr-linked-ticket");
    assertEquals(link.getAttribute("href"), "/tickets/ticket-0001");
    await act(() => {
      fireEvent.click(link);
    });
    await waitFor(() => screen.getByTestId("ticket-detail-stub"));
  });

  // (3) intent edit

  it("intent Save calls patchPrIntent with the typed body and surfaces errors inline", async () => {
    const calls: { id: string; req: unknown }[] = [];
    let current = prResponse();
    let rejectNext = false;
    const client: ApiClient = {
      ...unusedApiStubs(),
      getPr: () => Promise.resolve<PREnvelope>({ data: current, project_id: "proj-test" }),
      patchPrIntent: (id, req) => {
        calls.push({ id, req });
        if (rejectNext) {
          return Promise.reject(new KeniApiError(422, "invalid_artifact", "size"));
        }
        current = { ...current, body: req.intent };
        return Promise.resolve<PREnvelope>({ data: current, project_id: "proj-test" });
      },
    };
    const events = makeFakeEventsClient();
    renderPr({ client, events: events.client });
    await waitFor(() => screen.getByTestId("pr-detail"));

    // Success path.
    await act(() => {
      fireEvent.click(screen.getByTestId("pr-intent-edit"));
    });
    await act(() => {
      fireEvent.change(screen.getByTestId("pr-intent-input"), {
        target: { value: "Updated intent" },
      });
    });
    await act(() => {
      fireEvent.click(screen.getByTestId("pr-intent-save"));
    });
    await waitFor(() =>
      assertEquals(screen.getByTestId("pr-intent").textContent, "Updated intent")
    );
    assertEquals(calls, [{ id: "pr-0001", req: { intent: "Updated intent" } }]);

    // Failure path.
    rejectNext = true;
    await act(() => {
      fireEvent.click(screen.getByTestId("pr-intent-edit"));
    });
    await act(() => {
      fireEvent.change(screen.getByTestId("pr-intent-input"), {
        target: { value: "Oversize intent" },
      });
    });
    await act(() => {
      fireEvent.click(screen.getByTestId("pr-intent-save"));
    });
    const err = await waitFor(() => screen.getByTestId("pr-intent-error"));
    assert(err.textContent?.includes("invalid_artifact"));
  });

  // (4) transition panel

  it("transition panel is collapsed by default, lists reachable statuses, and a successful transition updates the view", async () => {
    let current = prResponse({ status: "in_review" });
    const calls: { id: string; req: unknown }[] = [];
    const client: ApiClient = {
      ...unusedApiStubs(),
      getPr: () => Promise.resolve<PREnvelope>({ data: current, project_id: "proj-test" }),
      transitionPr: (id, req) => {
        calls.push({ id, req });
        current = { ...current, status: req.to };
        return Promise.resolve<PREnvelope>({ data: current, project_id: "proj-test" });
      },
    };
    const events = makeFakeEventsClient();
    renderPr({ client, events: events.client });
    await waitFor(() => screen.getByTestId("pr-detail"));
    const details = screen.getByTestId("pr-transition-panel") as HTMLDetailsElement;
    assertEquals(details.open, false);
    await act(() => {
      details.open = true;
    });
    const select = screen.getByTestId("pr-transition-to") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    assertEquals(options, ["has_comments", "approved"]);
    assert(screen.getByTestId("pr-transition-caveat").textContent?.includes("raw override path"));
    assert(screen.getByTestId("pr-transition-caveat").textContent?.includes("Step 25"));
    await act(() => {
      fireEvent.change(select, { target: { value: "approved" } });
    });
    await act(() => {
      fireEvent.click(screen.getByTestId("pr-transition-submit"));
    });
    await waitFor(() => assertEquals(screen.getByTestId("pr-status").textContent, "Approved"));
    assertEquals(calls, [{ id: "pr-0001", req: { from: "in_review", to: "approved" } }]);
  });

  // (5a) Merge button hidden when not approved

  it('the Merge button is hidden when pr.status !== "approved"', async () => {
    const client: ApiClient = {
      ...unusedApiStubs(),
      getPr: () =>
        Promise.resolve<PREnvelope>({
          data: prResponse({ status: "in_review" }),
          project_id: "proj-test",
        }),
    };
    const events = makeFakeEventsClient();
    renderPr({ client, events: events.client });
    await waitFor(() => screen.getByTestId("pr-detail"));
    assertEquals(screen.queryByTestId("pr-merge-button"), null);
  });

  // (5b) cancelled confirm skips the merge

  it("a cancelled window.confirm skips the merge call", async () => {
    const originalConfirm = globalThis.confirm;
    let mergeCalls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      getPr: () => Promise.resolve<PREnvelope>({ data: prResponse(), project_id: "proj-test" }),
      mergePr: () => {
        mergeCalls += 1;
        return Promise.resolve<MergePrEnvelope>({
          data: { merge_commit_sha: "deadbeef" },
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    try {
      globalThis.confirm = () => false;
      renderPr({ client, events: events.client });
      await waitFor(() => screen.getByTestId("pr-merge-button"));
      await act(() => {
        fireEvent.click(screen.getByTestId("pr-merge-button"));
      });
      assertEquals(mergeCalls, 0);
    } finally {
      globalThis.confirm = originalConfirm;
    }
  });

  // (5c) successful merge refetches and hides the button

  it("a confirmed merge refetches and hides the Merge button when the status flips to merged", async () => {
    const originalConfirm = globalThis.confirm;
    let getCalls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      getPr: () => {
        getCalls += 1;
        return Promise.resolve<PREnvelope>({
          data: getCalls === 1 ? prResponse() : prResponse({ status: "merged" }),
          project_id: "proj-test",
        });
      },
      mergePr: () =>
        Promise.resolve<MergePrEnvelope>({
          data: { merge_commit_sha: "deadbeef" },
          project_id: "proj-test",
        }),
    };
    const events = makeFakeEventsClient();
    try {
      globalThis.confirm = () => true;
      renderPr({ client, events: events.client });
      await waitFor(() => screen.getByTestId("pr-merge-button"));
      await act(() => {
        fireEvent.click(screen.getByTestId("pr-merge-button"));
      });
      await waitFor(() => assertEquals(screen.getByTestId("pr-status").textContent, "Merged"));
      assertEquals(screen.queryByTestId("pr-merge-button"), null);
    } finally {
      globalThis.confirm = originalConfirm;
    }
  });

  // (5d) merge_conflict renders a prominent error

  it("a merge_conflict response renders a prominent conflict panel and re-enables the button", async () => {
    const originalConfirm = globalThis.confirm;
    const client: ApiClient = {
      ...unusedApiStubs(),
      getPr: () => Promise.resolve<PREnvelope>({ data: prResponse(), project_id: "proj-test" }),
      mergePr: () =>
        Promise.reject(
          new KeniApiError(409, "merge_conflict", "non fast-forward", {
            reason: "non_fast_forward",
          }),
        ),
    };
    const events = makeFakeEventsClient();
    try {
      globalThis.confirm = () => true;
      renderPr({ client, events: events.client });
      await waitFor(() => screen.getByTestId("pr-merge-button"));
      await act(() => {
        fireEvent.click(screen.getByTestId("pr-merge-button"));
      });
      const panel = await waitFor(() => screen.getByTestId("pr-merge-conflict"));
      assert(panel.textContent?.includes("merge_conflict"));
      const btn = screen.getByTestId("pr-merge-button") as HTMLButtonElement;
      assertEquals(btn.disabled, false);
    } finally {
      globalThis.confirm = originalConfirm;
    }
  });

  // (6) pr.updated refetch

  it("a pr.updated frame for this PR refetches via getPr", async () => {
    let call = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      getPr: () => {
        call += 1;
        return Promise.resolve<PREnvelope>({
          data: prResponse({ status: call === 1 ? "approved" : "merged" }),
          project_id: "proj-test",
        });
      },
    };
    const events = makeFakeEventsClient();
    renderPr({ client, events: events.client });
    await waitFor(() => screen.getByTestId("pr-detail"));
    await act(() => {
      events.pushFrame({
        id: "01HW",
        event: "pr.updated",
        project_id: "proj-test",
        timestamp: "2026-05-04T07:00:00.000Z",
        payload: { pr_id: "pr-0001", status: "merged", kind: "transition" },
      });
    });
    await waitFor(() => assertEquals(screen.getByTestId("pr-status").textContent, "Merged"));
  });

  it("a pr.updated frame for another PR is ignored", async () => {
    let getCalls = 0;
    const client: ApiClient = {
      ...unusedApiStubs(),
      getPr: () => {
        getCalls += 1;
        return Promise.resolve<PREnvelope>({ data: prResponse(), project_id: "proj-test" });
      },
    };
    const events = makeFakeEventsClient();
    renderPr({ client, events: events.client });
    await waitFor(() => screen.getByTestId("pr-detail"));
    assertEquals(getCalls, 1);
    await act(() => {
      events.pushFrame({
        id: "01HW",
        event: "pr.updated",
        project_id: "proj-test",
        timestamp: "2026-05-04T07:00:00.000Z",
        payload: { pr_id: "pr-9999", status: "merged", kind: "transition" },
      });
    });
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(getCalls, 1);
  });
});
