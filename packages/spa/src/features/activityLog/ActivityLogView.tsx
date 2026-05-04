/**
 * Activity log view — root of the `/activity` route.
 *
 * Owns a filtered activity list plus a filter form (agent / role /
 * from / to). The view follows the same transport-seam rule every
 * other SPA feature does: every REST call goes through `apiClient`
 * and every live update comes through `eventsClient`. No global
 * store; state is local.
 *
 * Decisions baked in here:
 *   - server-confirmed mutations aren't relevant for a read-only
 *     view; instead the live channel's `activity.appended` frames
 *     drive a debounced refetch so a burst of appends collapses to
 *     a single round-trip (design.md Decision 11).
 *   - client-side reverse order: the server returns entries in
 *     increasing-id (chronological) order; we reverse for display
 *     so the newest entry is always at the top.
 *   - debounced filter edits: typing `alice` into the agent input
 *     issues one REST call, not five (Decision 12).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityAppendedPayload,
  ActivityEntryResponse,
  EventFrame,
  Role,
} from "@keni/shared";
import { useApiClient } from "../../transport/ApiClientContext.tsx";
import { useEventsClient } from "../../transport/EventsClientContext.tsx";
import { KeniApiError, type ListActivityFilter } from "../../transport/apiClient.ts";
import type { EventsClientLifecycle } from "../../transport/eventsClient.ts";
import { formatRelativeTime } from "../agentRoster/formatRelativeTime.ts";
import { ActivityRefs } from "./formatActivityRefs.tsx";

/** Single source of truth for the filter-input / append-frame debounce. */
export const ACTIVITY_FILTER_DEBOUNCE_MS = 250;

const ROLES: readonly Role[] = ["user", "engineer", "qa", "po", "writer"];

interface FilterDraft {
  readonly agent: string;
  readonly role: string;
  readonly from: string;
  readonly to: string;
}

const EMPTY_DRAFT: FilterDraft = { agent: "", role: "", from: "", to: "" };

/**
 * Translate an `<input type="datetime-local">` value (local time,
 * no timezone) to a UTC ISO 8601 string with trailing `Z`. An empty
 * input returns `undefined`.
 */
function toIso(value: string): string | undefined {
  if (value === "") return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function toFilter(draft: FilterDraft): ListActivityFilter {
  const filter: Record<string, string | undefined> = {};
  if (draft.agent !== "") filter.agent = draft.agent;
  if (draft.role !== "") filter.role = draft.role;
  const from = toIso(draft.from);
  if (from !== undefined) filter.from = from;
  const to = toIso(draft.to);
  if (to !== undefined) filter.to = to;
  return filter as ListActivityFilter;
}

function filtersEqual(a: ListActivityFilter, b: ListActivityFilter): boolean {
  return a.agent === b.agent && a.role === b.role &&
    a.from === b.from && a.to === b.to;
}

/**
 * True if an `activity.appended` frame matches the current filter.
 * The frame carries minimal fields (`agent`, `role`) plus an envelope
 * `timestamp` — not `refs`, not `summary` — so `ticket` / `pr` filters
 * are not expressible here (and the spec does not require them).
 */
function frameMatches(
  frame: EventFrame & { readonly event: "activity.appended" },
  filter: ListActivityFilter,
): boolean {
  const payload: ActivityAppendedPayload = frame.payload;
  if (filter.agent !== undefined && payload.agent !== filter.agent) return false;
  if (filter.role !== undefined && payload.role !== filter.role) return false;
  if (filter.from !== undefined && frame.timestamp < filter.from) return false;
  if (filter.to !== undefined && frame.timestamp > filter.to) return false;
  return true;
}

export function ActivityLogView() {
  const apiClient = useApiClient();
  const eventsClient = useEventsClient();

  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT);
  const [filter, setFilter] = useState<ListActivityFilter>({});
  const [entries, setEntries] = useState<readonly ActivityEntryResponse[] | null>(null);
  const [error, setError] = useState<KeniApiError | null>(null);
  const [disconnected, setDisconnected] = useState<boolean>(
    eventsClient.state === "disconnected",
  );

  const filterRef = useRef<ListActivityFilter>(filter);
  filterRef.current = filter;

  const refetch = useCallback((f: ListActivityFilter): void => {
    apiClient.listActivity(f)
      .then((envelope) => {
        setEntries(envelope.data);
        setError(null);
      })
      .catch((caught) => {
        if (caught instanceof KeniApiError) setError(caught);
        else setError(new KeniApiError(500, "internal_error", String(caught)));
      });
  }, [apiClient]);

  // Mount + filter-change refetch. Note: the filter object is
  // committed from the draft by the debounced effect below, so
  // typing into the agent input does not fire per-keystroke calls.
  useEffect(() => {
    refetch(filter);
  }, [filter, refetch]);

  // Debounce the draft -> filter commit.
  useEffect(() => {
    const next = toFilter(draft);
    if (filtersEqual(next, filter)) return;
    const handle = setTimeout(() => {
      setFilter(next);
    }, ACTIVITY_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [draft, filter]);

  // Debounced refetch on matching `activity.appended` frames.
  const appendDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const off = eventsClient.onEvent((frame: EventFrame) => {
      if (frame.event !== "activity.appended") return;
      if (!frameMatches(frame, filterRef.current)) return;
      if (appendDebounceRef.current !== null) clearTimeout(appendDebounceRef.current);
      appendDebounceRef.current = setTimeout(() => {
        appendDebounceRef.current = null;
        refetch(filterRef.current);
      }, ACTIVITY_FILTER_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (appendDebounceRef.current !== null) {
        clearTimeout(appendDebounceRef.current);
        appendDebounceRef.current = null;
      }
    };
  }, [eventsClient, refetch]);

  useEffect(() => {
    return eventsClient.onLifecycle((next: EventsClientLifecycle) => {
      if (next === "connected") {
        setDisconnected(false);
        refetch(filterRef.current);
      } else if (next === "disconnected") {
        setDisconnected(true);
      } else if (next === "connecting") {
        setDisconnected(false);
      }
    });
  }, [eventsClient, refetch]);

  const clearFilters = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setFilter({});
  }, []);

  const reverseChronological = useMemo(() => {
    if (entries === null) return null;
    return entries.slice().reverse();
  }, [entries]);

  return (
    <div
      className="keni-activity-log"
      data-disconnected={disconnected.toString()}
      data-testid="activity-log"
    >
      <FilterForm draft={draft} onDraftChange={setDraft} onClear={clearFilters} />
      {entries === null && error === null
        ? <div data-testid="activity-loading">Loading…</div>
        : error !== null
        ? (
          <div data-testid="activity-error" role="alert" className="keni-activity-log__error">
            <p>Failed to load activity: {error.code}</p>
            <button type="button" onClick={() => refetch(filter)}>Retry</button>
          </div>
        )
        : reverseChronological !== null && reverseChronological.length === 0
        ? (
          <p data-testid="activity-empty" className="keni-activity-log__empty">
            No activity.
          </p>
        )
        : (
          <ul className="keni-activity-log__list" data-testid="activity-list">
            {reverseChronological?.map((entry) => (
              <ActivityEntryRow
                key={entry.id}
                entry={entry}
              />
            ))}
          </ul>
        )}
    </div>
  );
}

interface FilterFormProps {
  readonly draft: FilterDraft;
  readonly onDraftChange: (next: FilterDraft) => void;
  readonly onClear: () => void;
}

function FilterForm({ draft, onDraftChange, onClear }: FilterFormProps) {
  return (
    <form
      className="keni-activity-log__filters"
      data-testid="activity-filters"
      onSubmit={(e) => e.preventDefault()}
    >
      <label>
        <span>Agent</span>
        <input
          type="text"
          value={draft.agent}
          onChange={(e) => onDraftChange({ ...draft, agent: e.target.value })}
          data-testid="activity-filter-agent"
        />
      </label>
      <label>
        <span>Role</span>
        <select
          value={draft.role}
          onChange={(e) => onDraftChange({ ...draft, role: e.target.value })}
          data-testid="activity-filter-role"
        >
          <option value="">{"<any>"}</option>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label>
        <span>From</span>
        <input
          type="datetime-local"
          value={draft.from}
          onChange={(e) => onDraftChange({ ...draft, from: e.target.value })}
          data-testid="activity-filter-from"
        />
      </label>
      <label>
        <span>To</span>
        <input
          type="datetime-local"
          value={draft.to}
          onChange={(e) => onDraftChange({ ...draft, to: e.target.value })}
          data-testid="activity-filter-to"
        />
      </label>
      <button
        type="button"
        onClick={onClear}
        data-testid="activity-filter-clear"
      >
        Clear filters
      </button>
    </form>
  );
}

interface ActivityEntryRowProps {
  readonly entry: ActivityEntryResponse;
}

function ActivityEntryRow({ entry }: ActivityEntryRowProps) {
  return (
    <li className="keni-activity-log__row" data-testid="activity-row">
      <span
        className="keni-activity-log__time"
        title={entry.timestamp}
        data-testid={`activity-time-${entry.id}`}
      >
        {formatRelativeTime(entry.timestamp, new Date())}
      </span>
      <span className="keni-activity-log__agent">{entry.agent}</span>
      <span className="keni-activity-log__role">{entry.role}</span>
      <span className="keni-activity-log__event">
        <strong>{entry.event}</strong>
      </span>
      <span className="keni-activity-log__summary">
        {entry.summary === null ? "—" : entry.summary}
      </span>
      <ActivityRefs refs={entry.refs} />
    </li>
  );
}

export default ActivityLogView;
