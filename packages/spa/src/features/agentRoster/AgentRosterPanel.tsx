/**
 * The agent roster panel — left rail of the dashboard.
 *
 * Owns:
 *   - the in-memory roster snapshot (REST result, mutated by `agent.state_changed` frames)
 *   - optimistic pause/resume with REST-envelope merge / rollback
 *   - debounced refetch on `activity.appended` bursts (`ROSTER_REFETCH_DEBOUNCE_MS`)
 *   - an unconditional refetch every time the events client transitions to `connected`
 *   - a `data-disconnected="true"` fallback that dims the cards but keeps the
 *     last-seen state visible
 *
 * No global store: the panel keeps everything in local React state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityAppendedPayload,
  AgentResponse,
  AgentStateChangedPayload,
  EventFrame,
} from "@keni/shared";
import { useApiClient } from "../../transport/ApiClientContext.tsx";
import { useEventsClient } from "../../transport/EventsClientContext.tsx";
import { KeniApiError } from "../../transport/apiClient.ts";
import type { EventsClientLifecycle } from "../../transport/eventsClient.ts";
import { AgentRosterCard } from "./AgentRosterCard.tsx";

// Component CSS lives in `src/index.css` (centralised at the entry).

/**
 * Window in which a burst of `activity.appended` frames coalesces into one
 * `listAgents()` refetch. Drift-checked in `tasks.md` §11.5: bumping this
 * value breaks the burst-collapse test.
 */
export const ROSTER_REFETCH_DEBOUNCE_MS = 250;

interface CardState {
  busy: boolean;
  interrupting: boolean;
  error: string | null;
}

export function AgentRosterPanel() {
  const apiClient = useApiClient();
  const eventsClient = useEventsClient();

  const [agents, setAgents] = useState<readonly AgentResponse[] | null>(null);
  const [error, setError] = useState<KeniApiError | Error | null>(null);
  const [disconnected, setDisconnected] = useState<boolean>(
    eventsClient.state === "disconnected",
  );
  const [cardStates, setCardStates] = useState<Record<string, CardState>>({});

  // Refs for handlers that need to read the latest values without re-subscribing.
  const agentsRef = useRef<readonly AgentResponse[] | null>(null);
  agentsRef.current = agents;

  const refetch = useCallback(async (): Promise<void> => {
    try {
      const envelope = await apiClient.listAgents();
      setAgents(envelope.data);
      setError(null);
    } catch (caught) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      setError(err);
    }
  }, [apiClient]);

  // Initial load.
  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Frame subscription — `agent.state_changed` direct-merge,
  // `activity.appended` debounced refetch.
  useEffect(() => {
    let debounceHandle: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefetch = () => {
      if (debounceHandle !== null) clearTimeout(debounceHandle);
      debounceHandle = setTimeout(() => {
        debounceHandle = null;
        void refetch();
      }, ROSTER_REFETCH_DEBOUNCE_MS);
    };

    const off = eventsClient.onEvent((frame: EventFrame) => {
      if (frame.event === "agent.state_changed") {
        const payload: AgentStateChangedPayload = frame.payload;
        setAgents((current) => {
          if (current === null) return current;
          const idx = current.findIndex((a) => a.id === payload.agent_id);
          if (idx < 0) return current;
          const target = current[idx];
          if (target === undefined) return current;
          const updated: AgentResponse = {
            ...target,
            paused: payload.paused,
            status: payload.status,
          };
          const next = current.slice();
          next[idx] = updated;
          return next;
        });
      } else if (frame.event === "activity.appended") {
        const payload: ActivityAppendedPayload = frame.payload;
        const known = agentsRef.current?.some((a) => a.id === payload.agent) ?? false;
        if (known) scheduleRefetch();
      }
    });

    return () => {
      off();
      if (debounceHandle !== null) clearTimeout(debounceHandle);
    };
  }, [eventsClient, refetch]);

  // Lifecycle subscription — refetch on `connected`, dim on `disconnected`.
  useEffect(() => {
    return eventsClient.onLifecycle((next: EventsClientLifecycle) => {
      if (next === "connected") {
        setDisconnected(false);
        void refetch();
      } else if (next === "disconnected") {
        setDisconnected(true);
      } else if (next === "connecting") {
        setDisconnected(false);
      }
    });
  }, [eventsClient, refetch]);

  const togglePause = useCallback(
    async (agent: AgentResponse, next: boolean): Promise<void> => {
      // Optimistic flip: update state immediately, then call REST. On
      // success, merge the server's authoritative envelope. On failure,
      // roll the local row back and surface the error.
      setCardStates((prev) => ({
        ...prev,
        [agent.id]: {
          busy: true,
          interrupting: prev[agent.id]?.interrupting ?? false,
          error: null,
        },
      }));
      setAgents((current) => {
        if (current === null) return current;
        const idx = current.findIndex((a) => a.id === agent.id);
        if (idx < 0) return current;
        const target = current[idx];
        if (target === undefined) return current;
        const updated: AgentResponse = { ...target, paused: next };
        const arr = current.slice();
        arr[idx] = updated;
        return arr;
      });

      try {
        const envelope = next
          ? await apiClient.pauseAgent(agent.id)
          : await apiClient.resumeAgent(agent.id);
        const authoritative = envelope.data;
        setAgents((current) => {
          if (current === null) return current;
          const idx = current.findIndex((a) => a.id === agent.id);
          if (idx < 0) return current;
          const arr = current.slice();
          arr[idx] = authoritative;
          return arr;
        });
        setCardStates((prev) => ({
          ...prev,
          [agent.id]: {
            busy: false,
            interrupting: prev[agent.id]?.interrupting ?? false,
            error: null,
          },
        }));
      } catch (caught) {
        // Rollback to the original `paused` flag.
        setAgents((current) => {
          if (current === null) return current;
          const idx = current.findIndex((a) => a.id === agent.id);
          if (idx < 0) return current;
          const target = current[idx];
          if (target === undefined) return current;
          const arr = current.slice();
          arr[idx] = { ...target, paused: agent.paused };
          return arr;
        });
        const message = caught instanceof KeniApiError
          ? caught.message
          : caught instanceof Error
          ? caught.message
          : String(caught);
        setCardStates((prev) => ({
          ...prev,
          [agent.id]: {
            busy: false,
            interrupting: prev[agent.id]?.interrupting ?? false,
            error: message,
          },
        }));
      }
    },
    [apiClient],
  );

  const interruptAgent = useCallback(
    async (agent: AgentResponse): Promise<void> => {
      // Non-optimistic: do NOT flip `status` locally; show busy +
      // "Interrupting…" and let the server's `agent.state_changed`
      // frame land authoritatively (`design.md` Decision 8).
      setCardStates((prev) => ({
        ...prev,
        [agent.id]: {
          busy: prev[agent.id]?.busy ?? false,
          interrupting: true,
          error: null,
        },
      }));
      try {
        const envelope = await apiClient.interruptAgent(agent.id);
        const authoritative = envelope.data;
        setAgents((current) => {
          if (current === null) return current;
          const idx = current.findIndex((a) => a.id === agent.id);
          if (idx < 0) return current;
          const arr = current.slice();
          arr[idx] = authoritative;
          return arr;
        });
        setCardStates((prev) => ({
          ...prev,
          [agent.id]: {
            busy: prev[agent.id]?.busy ?? false,
            interrupting: false,
            error: null,
          },
        }));
      } catch (caught) {
        const message = caught instanceof KeniApiError
          ? caught.message
          : caught instanceof Error
          ? caught.message
          : String(caught);
        setCardStates((prev) => ({
          ...prev,
          [agent.id]: {
            busy: prev[agent.id]?.busy ?? false,
            interrupting: false,
            error: message,
          },
        }));
      }
    },
    [apiClient],
  );

  const renderedCards = useMemo(() => {
    if (agents === null) return null;
    return agents.map((agent) => {
      const state = cardStates[agent.id];
      return (
        <AgentRosterCard
          key={agent.id}
          agent={agent}
          error={state?.error ?? null}
          busy={state?.busy ?? false}
          interrupting={state?.interrupting ?? false}
          onTogglePause={(next) => togglePause(agent, next)}
          onInterrupt={() => interruptAgent(agent)}
        />
      );
    });
  }, [agents, cardStates, togglePause, interruptAgent]);

  return (
    <section
      className="keni-roster"
      data-disconnected={disconnected.toString()}
      aria-busy={agents === null}
    >
      <header className="keni-roster__header">
        <h2 className="keni-roster__title">Agents</h2>
      </header>
      <div className="keni-roster__body">
        {agents === null && error === null
          ? <div className="keni-roster__loading" data-testid="roster-loading">Loading…</div>
          : null}
        {error !== null
          ? (
            <div className="keni-roster__error" data-testid="roster-error" role="alert">
              <p>Failed to load agents: {error.message}</p>
              <button
                type="button"
                onClick={() => {
                  setAgents(null);
                  setError(null);
                  void refetch();
                }}
              >
                Retry
              </button>
            </div>
          )
          : null}
        {agents !== null && agents.length === 0
          ? (
            <div className="keni-roster__empty" data-testid="roster-empty">
              No agents configured.
            </div>
          )
          : null}
        {agents !== null && agents.length > 0
          ? <div className="keni-roster__cards">{renderedCards}</div>
          : null}
      </div>
    </section>
  );
}
