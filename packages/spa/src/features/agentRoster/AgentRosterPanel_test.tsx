import "../../test_setup.ts";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiClientProvider } from "../../transport/ApiClientContext.tsx";
import { EventsClientProvider } from "../../transport/EventsClientContext.tsx";
import { KeniApiError } from "../../transport/apiClient.ts";
import { AgentRosterPanel, ROSTER_REFETCH_DEBOUNCE_MS } from "./AgentRosterPanel.tsx";
import type { ApiClient } from "../../transport/apiClient.ts";
import type { EventsClient, EventsClientLifecycle } from "../../transport/eventsClient.ts";
import { unusedApiStubs } from "../shared/testStubs.ts";
import type {
  ActivityAppendedPayload,
  AgentEnvelope,
  AgentListResponse,
  AgentResponse,
  AgentStateChangedPayload,
  EventFrame,
} from "@keni/shared";

const ALICE: AgentResponse = {
  id: "alice",
  role: "engineer",
  status: "idle",
  last_activity: null,
  last_active_at: null,
  paused: false,
};

const BOB: AgentResponse = {
  id: "bob",
  role: "qa",
  status: "running",
  last_activity: "session_start",
  last_active_at: "2026-05-03T17:59:00Z",
  paused: false,
};

interface Recorder {
  listAgentsCalls: number;
  pauseCalls: string[];
  resumeCalls: string[];
}

interface FakeApiOptions {
  readonly seedAgents: readonly AgentResponse[];
  readonly listAgentsImpl?: (call: number) => Promise<AgentListResponse>;
  readonly pauseImpl?: (id: string) => Promise<AgentEnvelope>;
  readonly resumeImpl?: (id: string) => Promise<AgentEnvelope>;
}

function makeFakeApiClient(opts: FakeApiOptions): { client: ApiClient; recorder: Recorder } {
  const recorder: Recorder = { listAgentsCalls: 0, pauseCalls: [], resumeCalls: [] };
  const defaultEnvelope = (data: readonly AgentResponse[]): AgentListResponse => ({
    data,
    project_id: "proj-test",
  });
  const client: ApiClient = {
    ...unusedApiStubs(),
    getProjectId: () => Promise.resolve("proj-test"),
    listAgents: () => {
      recorder.listAgentsCalls += 1;
      if (opts.listAgentsImpl) return opts.listAgentsImpl(recorder.listAgentsCalls);
      return Promise.resolve(defaultEnvelope(opts.seedAgents));
    },
    pauseAgent: (id) => {
      recorder.pauseCalls.push(id);
      if (opts.pauseImpl) return opts.pauseImpl(id);
      return Promise.resolve<AgentEnvelope>({
        data: { ...ALICE, id, paused: true },
        project_id: "proj-test",
      });
    },
    resumeAgent: (id) => {
      recorder.resumeCalls.push(id);
      if (opts.resumeImpl) return opts.resumeImpl(id);
      return Promise.resolve<AgentEnvelope>({
        data: { ...ALICE, id, paused: false },
        project_id: "proj-test",
      });
    },
  };
  return { client, recorder };
}

interface FakeEventsHandle {
  client: EventsClient;
  pushFrame: (frame: EventFrame) => void;
  pushLifecycle: (state: EventsClientLifecycle) => void;
}

function makeFakeEventsClient(): FakeEventsHandle {
  let state: EventsClientLifecycle = "disconnected";
  const eventListeners = new Set<(frame: EventFrame) => void>();
  const lifecycleListeners = new Set<(s: EventsClientLifecycle) => void>();
  const client: EventsClient = {
    get state() {
      return state;
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    start() {},
    close() {},
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
  };
}

function stateChangedFrame(payload: AgentStateChangedPayload): EventFrame {
  return {
    id: `frame-${payload.agent_id}-${payload.paused}`,
    event: "agent.state_changed",
    project_id: "proj-test",
    timestamp: "2026-05-03T18:00:00Z",
    payload,
  };
}

function activityFrame(payload: ActivityAppendedPayload): EventFrame {
  return {
    id: `frame-activity-${payload.entry_id}`,
    event: "activity.appended",
    project_id: "proj-test",
    timestamp: "2026-05-03T18:00:00Z",
    payload,
  };
}

function renderPanel(client: ApiClient, events: EventsClient) {
  return render(
    <ApiClientProvider value={client}>
      <EventsClientProvider value={events}>
        <AgentRosterPanel />
      </EventsClientProvider>
    </ApiClientProvider>,
  );
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// happy-dom's `AsyncTaskManager` internally schedules micro-task setTimeouts
// that outlive any individual test step. Deno's resource sanitizer flags
// these as leaks even though they are not application-side issues.
describe({
  name: "AgentRosterPanel",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  afterEach(() => cleanup());

  it("loads agents on mount and renders one card per row", async () => {
    const { client } = makeFakeApiClient({ seedAgents: [ALICE, BOB] });
    const events = makeFakeEventsClient();
    renderPanel(client, events.client);
    await act(async () => {
      await flushPromises();
    });
    assert(screen.getByTestId("agent-card-alice") !== null);
    assert(screen.getByTestId("agent-card-bob") !== null);
  });

  it("renders the empty state when listAgents returns []", async () => {
    const { client } = makeFakeApiClient({ seedAgents: [] });
    const events = makeFakeEventsClient();
    renderPanel(client, events.client);
    await act(async () => {
      await flushPromises();
    });
    assert(screen.getByTestId("roster-empty") !== null);
  });

  it("renders the error state and a working Retry button on listAgents rejection", async () => {
    let rejectFirst = true;
    const { client, recorder } = makeFakeApiClient({
      seedAgents: [ALICE],
      listAgentsImpl: () => {
        if (rejectFirst) {
          rejectFirst = false;
          return Promise.reject(
            new KeniApiError(500, "internal_error", "boom"),
          );
        }
        return Promise.resolve<AgentListResponse>({ data: [ALICE], project_id: "proj-test" });
      },
    });
    const events = makeFakeEventsClient();
    renderPanel(client, events.client);
    await act(async () => {
      await flushPromises();
    });
    const errorBlock = screen.getByTestId("roster-error");
    assert(errorBlock !== null);
    const retry = errorBlock.querySelector("button");
    assert(retry !== null);
    await act(async () => {
      fireEvent.click(retry);
      await flushPromises();
    });
    assert(screen.getByTestId("agent-card-alice") !== null);
    assertEquals(recorder.listAgentsCalls, 2);
  });

  it("flips a card status when an agent.state_changed frame arrives", async () => {
    const { client } = makeFakeApiClient({ seedAgents: [ALICE] });
    const events = makeFakeEventsClient();
    renderPanel(client, events.client);
    await act(async () => {
      await flushPromises();
    });
    let card = screen.getByTestId("agent-card-alice");
    assertEquals(card.getAttribute("data-status"), "idle");
    await act(async () => {
      events.pushFrame(stateChangedFrame({ agent_id: "alice", paused: false, status: "running" }));
      await flushPromises();
    });
    card = screen.getByTestId("agent-card-alice");
    assertEquals(card.getAttribute("data-status"), "running");
  });

  it("clicking the toggle calls pauseAgent and renders the optimistic state synchronously", async () => {
    let resolvePause: ((env: AgentEnvelope) => void) | null = null;
    const { client, recorder } = makeFakeApiClient({
      seedAgents: [ALICE],
      pauseImpl: (id) =>
        new Promise<AgentEnvelope>((resolve) => {
          resolvePause = (env) => resolve(env);
          // capture for later resolution; never auto-resolve.
          return id;
        }),
    });
    const events = makeFakeEventsClient();
    renderPanel(client, events.client);
    await act(async () => {
      await flushPromises();
    });
    const card = screen.getByTestId("agent-card-alice");
    const button = card.querySelector("button");
    assert(button !== null);
    assertEquals(card.getAttribute("data-paused"), "false");
    fireEvent.click(button);
    // Optimistic flip is synchronous — no await needed.
    assertEquals(card.getAttribute("data-paused"), "true");
    assertEquals(recorder.pauseCalls, ["alice"]);
    // Resolve to clean up the dangling promise.
    await act(async () => {
      resolvePause?.({ data: { ...ALICE, paused: true }, project_id: "proj-test" });
      await flushPromises();
    });
  });

  it("rolls back optimistic pause and shows card-error when REST rejects", async () => {
    const { client } = makeFakeApiClient({
      seedAgents: [ALICE],
      pauseImpl: () => Promise.reject(new KeniApiError(403, "role_not_owner", "engineer required")),
    });
    const events = makeFakeEventsClient();
    renderPanel(client, events.client);
    await act(async () => {
      await flushPromises();
    });
    const card = screen.getByTestId("agent-card-alice");
    const button = card.querySelector("button");
    assert(button !== null);
    await act(async () => {
      fireEvent.click(button);
      await flushPromises();
    });
    assertEquals(card.getAttribute("data-paused"), "false");
    const cardError = card.querySelector('[data-testid="card-error"]');
    assert(cardError !== null);
    assert(cardError.textContent?.includes("engineer required"));
  });

  it("collapses a burst of activity.appended frames into one debounced refetch", async () => {
    const time = new FakeTime(0);
    try {
      const { client, recorder } = makeFakeApiClient({ seedAgents: [ALICE] });
      const events = makeFakeEventsClient();
      renderPanel(client, events.client);
      await act(async () => {
        await time.tickAsync(0);
      });
      assertEquals(recorder.listAgentsCalls, 1, "initial mount refetch");
      await act(async () => {
        for (let i = 0; i < 5; i++) {
          events.pushFrame(
            activityFrame({
              entry_id: `entry-${i}` as ActivityAppendedPayload["entry_id"],
              agent: "alice",
              role: "engineer",
              event: "session_start",
            }),
          );
        }
        await time.tickAsync(0);
      });
      assertEquals(recorder.listAgentsCalls, 1, "no refetch yet — still inside debounce window");
      await act(async () => {
        await time.tickAsync(ROSTER_REFETCH_DEBOUNCE_MS);
      });
      assertEquals(recorder.listAgentsCalls, 2, "exactly one refetch after the debounce window");
    } finally {
      // Unmount the panel BEFORE restoring real timers so the effect's
      // `clearTimeout` cleanup runs against the fake clock that captured
      // the handle. Otherwise the orphaned fake timer trips Deno's
      // resource leak sanitizer in the next test.
      cleanup();
      time.restore();
    }
  });

  it("a connecting → connected lifecycle transition triggers an unconditional refetch", async () => {
    const { client, recorder } = makeFakeApiClient({ seedAgents: [ALICE] });
    const events = makeFakeEventsClient();
    renderPanel(client, events.client);
    await act(async () => {
      await flushPromises();
    });
    assertEquals(recorder.listAgentsCalls, 1);
    await act(async () => {
      events.pushLifecycle("connecting");
      events.pushLifecycle("connected");
      await flushPromises();
    });
    assertEquals(recorder.listAgentsCalls, 2);
  });

  it("a disconnected lifecycle event marks the panel and keeps the cards visible", async () => {
    const { client } = makeFakeApiClient({ seedAgents: [ALICE] });
    const events = makeFakeEventsClient();
    const { container } = renderPanel(client, events.client);
    await act(async () => {
      await flushPromises();
    });
    await act(async () => {
      events.pushLifecycle("disconnected");
      await flushPromises();
    });
    const panel = container.querySelector(".keni-roster");
    assert(panel !== null);
    assertEquals(panel.getAttribute("data-disconnected"), "true");
    assert(screen.getByTestId("agent-card-alice") !== null);
  });
});

// `beforeEach` is unused but imported to keep the BDD surface visible to
// future contributors who might extend the suite with stateful setup.
beforeEach;
