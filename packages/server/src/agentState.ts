/**
 * In-memory runtime-state store for the project's configured agent roster.
 *
 * The store seeds itself from `projectConfig.agents` (an `AgentConfig[]`
 * read off `.keni/project.yaml`) and tracks four transient fields per
 * agent: `status` (`"idle" | "running"`), `last_activity` (last activity
 * log event name observed), `last_active_at` (ISO 8601 timestamp), and
 * `paused` (consumed by the future scheduler in step 08). Restart resets
 * every transient field — the activity log on disk remains the durable
 * record of what each agent did (`design.md` Decision 4 / capability
 * spec "in-memory persistence tier" requirement).
 *
 * The interface is the contract a future on-disk adapter would satisfy;
 * swapping the constructor argument is the only step needed to persist
 * state. The interface SHALL NOT change in this step.
 *
 * @module
 */

import {
  type ActivityEntryResponse,
  type AgentConfig,
  type AgentStatus,
  StoreNotFoundError,
} from "@keni/shared";

/**
 * Per-agent runtime state. Identity-shaped to {@link AgentResponse} on
 * the wire; the indirection leaves room for future divergence (e.g.,
 * project-config-only fields the runtime tier doesn't track).
 */
export interface AgentRuntimeState {
  readonly id: string;
  readonly role: string;
  readonly status: AgentStatus;
  readonly last_activity: string | null;
  readonly last_active_at: string | null;
  readonly paused: boolean;
}

/**
 * In-memory store interface. Methods that return `{ state, changed }`
 * give the calling route handler the information it needs to decide
 * whether to emit `agent.state_changed` (`design.md` Decision 11 — the
 * "debounce" rule).
 */
export interface AgentRuntimeStateStore {
  /** Snapshot of every roster row in seed order. Safe to iterate. */
  list(): readonly AgentRuntimeState[];

  /**
   * Read one row by id.
   *
   * @throws {StoreNotFoundError} when `id` is not in the seeded roster.
   */
  read(id: string): AgentRuntimeState;

  /**
   * Set the `paused` flag for one row. Returns `changed: true` only when
   * the flag actually flips; idempotent calls return `changed: false`.
   *
   * @throws {StoreNotFoundError} when `id` is not in the seeded roster.
   */
  setPaused(id: string, paused: boolean): {
    readonly state: AgentRuntimeState;
    readonly changed: boolean;
  };

  /**
   * Apply one persisted activity entry to the store. Updates
   * `last_activity` / `last_active_at` and conditionally toggles `status`
   * per the documented decision table (see source / `design.md`
   * Decision 4):
   *
   * | event                  | new status   |
   * | ---------------------- | ------------ |
   * | `session_start`        | `"running"`  |
   * | `session_end`          | `"idle"`     |
   * | `session_interrupted`  | `"idle"`     |
   * | `session_timeout`      | `"idle"`     |
   * | `idle`                 | `"idle"`     |
   * | (any other event)      | unchanged    |
   *
   * Returns `state: null, changed: false` for an unknown agent id (the
   * unknown-agent case is not an error — it is a normal "an agent
   * appeared in the activity log that isn't in `project.yaml` yet"
   * outcome; the route handler simply skips emitting
   * `agent.state_changed`).
   *
   * `changed` is `true` only when `status` or `paused` actually flip;
   * a non-state-changing event (e.g., `summary` for a running agent)
   * still updates `last_*` but returns `changed: false` so the route
   * handler does not emit `agent.state_changed`.
   */
  applyActivityEvent(entry: ActivityEntryResponse): {
    readonly state: AgentRuntimeState | null;
    readonly changed: boolean;
  };
}

/** Activity-log event names that flip an agent's status to `"running"`. */
const RUNNING_EVENTS: ReadonlySet<string> = new Set(["session_start"]);

/**
 * Activity-log event names that flip an agent's status to `"idle"`. The
 * literal `"idle"` event is also in this set (an agent self-reports idle).
 */
const IDLE_EVENTS: ReadonlySet<string> = new Set([
  "session_end",
  "session_interrupted",
  "session_timeout",
  "idle",
]);

/**
 * Build the in-memory `AgentRuntimeStateStore` seeded from the project
 * config's `agents:` list. Each entry starts `paused: false`,
 * `status: "idle"`, `last_activity: null`, `last_active_at: null`. The
 * order of `list()` matches the YAML declaration order.
 */
export function createInMemoryAgentRuntimeStateStore(
  roster: readonly AgentConfig[],
): AgentRuntimeStateStore {
  const order: string[] = [];
  const states = new Map<string, AgentRuntimeState>();
  for (const cfg of roster) {
    if (states.has(cfg.id)) continue;
    order.push(cfg.id);
    states.set(cfg.id, {
      id: cfg.id,
      role: cfg.role,
      status: "idle",
      last_activity: null,
      last_active_at: null,
      paused: false,
    });
  }

  function readOrThrow(id: string): AgentRuntimeState {
    const state = states.get(id);
    if (state === undefined) throw new StoreNotFoundError(id);
    return state;
  }

  return {
    list(): readonly AgentRuntimeState[] {
      return order.map((id) => states.get(id)!);
    },

    read(id: string): AgentRuntimeState {
      return readOrThrow(id);
    },

    setPaused(id: string, paused: boolean) {
      const current = readOrThrow(id);
      if (current.paused === paused) {
        return { state: current, changed: false };
      }
      const next: AgentRuntimeState = { ...current, paused };
      states.set(id, next);
      return { state: next, changed: true };
    },

    applyActivityEvent(entry: ActivityEntryResponse) {
      const current = states.get(entry.agent);
      if (current === undefined) {
        return { state: null, changed: false };
      }
      const nextStatus: AgentStatus = RUNNING_EVENTS.has(entry.event)
        ? "running"
        : IDLE_EVENTS.has(entry.event)
        ? "idle"
        : current.status;
      const next: AgentRuntimeState = {
        ...current,
        status: nextStatus,
        last_activity: entry.event,
        last_active_at: entry.timestamp,
      };
      states.set(entry.agent, next);
      const changed = nextStatus !== current.status;
      return { state: next, changed };
    },
  };
}
