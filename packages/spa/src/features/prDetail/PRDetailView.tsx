/**
 * PR detail view — root of the `/prs/:id` route.
 *
 * Mirrors `<TicketDetailView />`'s shape (fetch-on-mount, lifecycle
 * refetch, per-frame refetch) with three PR-specific capabilities:
 *
 *   - intent edit via `patchPrIntent(id, { intent })`
 *   - "Advanced: transition" panel against `SPA_PR_STATUS_TRANSITIONS`
 *   - "Merge" button, confirm-gated, which calls `mergePr(id)` and
 *     surfaces `merge_conflict` as a prominent inline panel
 *
 * Server-confirmed mutations all the way down (design.md Decision 4).
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { EventFrame, PREnvelope, PRResponse, PRStatus } from "@keni/shared";
import { useApiClient } from "../../transport/ApiClientContext.tsx";
import { useEventsClient } from "../../transport/EventsClientContext.tsx";
import { KeniApiError } from "../../transport/apiClient.ts";
import type { EventsClientLifecycle } from "../../transport/eventsClient.ts";
import { SPA_PR_STATUS_TRANSITIONS } from "../shared/statusGraph.ts";
import { formatRelativeTime } from "../agentRoster/formatRelativeTime.ts";

function titleCase(status: string): string {
  const raw = status.replaceAll("_", " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ---------------------------------------------------------------------------
// Intent editor
// ---------------------------------------------------------------------------

interface IntentEditorProps {
  readonly intent: string;
  readonly onSave: (next: string) => Promise<void>;
}

function IntentEditor({ intent, onSave }: IntentEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(intent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(intent);
  }, [editing, intent]);

  async function save() {
    if (draft === intent) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (caught) {
      setError(
        caught instanceof KeniApiError
          ? caught.code
          : caught instanceof Error
          ? caught.message
          : String(caught),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="keni-pr-detail__intent">
        <div className="keni-pr-detail__intent-text" data-testid="pr-intent">{intent}</div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          data-testid="pr-intent-edit"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div className="keni-pr-detail__intent keni-pr-detail__intent--editing">
      <textarea
        value={draft}
        disabled={busy}
        rows={6}
        onChange={(e) => setDraft(e.target.value)}
        data-testid="pr-intent-input"
      />
      <div className="keni-pr-detail__intent-actions">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          data-testid="pr-intent-save"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(intent);
            setEditing(false);
            setError(null);
          }}
          disabled={busy}
          data-testid="pr-intent-cancel"
        >
          Cancel
        </button>
      </div>
      {error !== null
        ? (
          <span
            className="keni-pr-detail__field-error"
            role="alert"
            data-testid="pr-intent-error"
          >
            {error}
          </span>
        )
        : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transition panel
// ---------------------------------------------------------------------------

interface TransitionPanelProps {
  readonly status: PRStatus;
  readonly onTransition: (to: PRStatus) => Promise<void>;
}

function TransitionPanel({ status, onTransition }: TransitionPanelProps) {
  const reachable = SPA_PR_STATUS_TRANSITIONS[status];
  const [target, setTarget] = useState<PRStatus | "">(reachable[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTarget(reachable[0] ?? "");
  }, [reachable]);

  const terminal = reachable.length === 0;

  async function submit() {
    if (terminal || target === "") return;
    setBusy(true);
    setError(null);
    try {
      await onTransition(target);
    } catch (caught) {
      setError(
        caught instanceof KeniApiError
          ? caught.code
          : caught instanceof Error
          ? caught.message
          : String(caught),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="keni-pr-detail__transition" data-testid="pr-transition-panel">
      <summary>Advanced: transition (prototype only)</summary>
      <p className="keni-pr-detail__caveat" data-testid="pr-transition-caveat">
        This is the raw override path. It does not confirm the transition or record a
        manual_override activity entry. Step 25 will replace this panel with a confirmation flow.
      </p>
      <div className="keni-pr-detail__transition-form">
        <label>
          <span>From</span>
          <input type="text" value={status} readOnly data-testid="pr-transition-from" />
        </label>
        <label>
          <span>To</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as PRStatus)}
            disabled={terminal}
            data-testid="pr-transition-to"
          >
            {terminal
              ? <option value="">— no transitions —</option>
              : reachable.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={terminal || busy}
          data-testid="pr-transition-submit"
        >
          {busy ? "Transitioning…" : "Transition"}
        </button>
      </div>
      {error !== null
        ? (
          <div
            className="keni-pr-detail__field-error"
            role="alert"
            data-testid="pr-transition-error"
          >
            {error}
          </div>
        )
        : null}
    </details>
  );
}

// ---------------------------------------------------------------------------
// Merge button
// ---------------------------------------------------------------------------

interface MergeButtonProps {
  readonly prId: string;
  readonly onMerge: () => Promise<void>;
}

function MergeButton({ prId, onMerge }: MergeButtonProps) {
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ message: string; details?: unknown } | null>(null);
  const [otherError, setOtherError] = useState<string | null>(null);

  async function handleClick() {
    const ok = globalThis.confirm(
      `Merge ${prId}? This will fast-forward the PR branch onto main.`,
    );
    if (!ok) return;
    setBusy(true);
    setConflict(null);
    setOtherError(null);
    try {
      await onMerge();
    } catch (caught) {
      if (caught instanceof KeniApiError && caught.code === "merge_conflict") {
        setConflict({ message: caught.message, details: caught.details });
      } else {
        setOtherError(
          caught instanceof KeniApiError
            ? caught.code
            : caught instanceof Error
            ? caught.message
            : String(caught),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="keni-pr-detail__merge">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={busy}
        data-testid="pr-merge-button"
      >
        {busy ? "Merging…" : "Merge"}
      </button>
      {conflict !== null
        ? (
          <div
            className="keni-pr-detail__conflict"
            role="alert"
            data-testid="pr-merge-conflict"
          >
            <strong>merge_conflict</strong>: {conflict.message}
            {conflict.details !== undefined
              ? (
                <pre className="keni-pr-detail__conflict-details">
                  {JSON.stringify(conflict.details, null, 2)}
                </pre>
              )
              : null}
          </div>
        )
        : null}
      {otherError !== null
        ? (
          <span
            className="keni-pr-detail__field-error"
            role="alert"
            data-testid="pr-merge-error"
          >
            {otherError}
          </span>
        )
        : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function PRDetailView() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = rawId ?? "";
  const apiClient = useApiClient();
  const eventsClient = useEventsClient();

  const [pr, setPr] = useState<PRResponse | null>(null);
  const [prError, setPrError] = useState<KeniApiError | null>(null);
  const [disconnected, setDisconnected] = useState<boolean>(
    eventsClient.state === "disconnected",
  );

  const refetch = useCallback(async () => {
    if (id === "") return;
    try {
      const envelope = await apiClient.getPr(id);
      setPr(envelope.data);
      setPrError(null);
    } catch (caught) {
      if (caught instanceof KeniApiError) setPrError(caught);
      else setPrError(new KeniApiError(500, "internal_error", String(caught)));
    }
  }, [apiClient, id]);

  useEffect(() => {
    setPr(null);
    setPrError(null);
    void refetch();
  }, [refetch]);

  useEffect(() => {
    return eventsClient.onEvent((frame: EventFrame) => {
      if (frame.event === "pr.updated" && frame.payload.pr_id === id) {
        void refetch();
      }
    });
  }, [eventsClient, id, refetch]);

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

  const saveIntent = useCallback(async (intent: string) => {
    const envelope = await apiClient.patchPrIntent(id, { intent });
    applyEnvelope(envelope);
  }, [apiClient, id]);

  const transition = useCallback(async (to: PRStatus) => {
    if (pr === null) return;
    const envelope = await apiClient.transitionPr(id, { from: pr.status, to });
    applyEnvelope(envelope);
  }, [apiClient, id, pr]);

  const merge = useCallback(async () => {
    await apiClient.mergePr(id);
    await refetch();
  }, [apiClient, id, refetch]);

  function applyEnvelope(envelope: PREnvelope) {
    setPr(envelope.data);
  }

  if (prError !== null && prError.code === "store_not_found") {
    return (
      <div className="keni-pr-detail" data-testid="pr-not-found">
        <p>PR {id} does not exist.</p>
      </div>
    );
  }

  if (prError !== null) {
    return (
      <div className="keni-pr-detail" data-testid="pr-error" role="alert">
        <p>Failed to load PR: {prError.code}</p>
        <button type="button" onClick={() => void refetch()}>Retry</button>
      </div>
    );
  }

  if (pr === null) {
    return (
      <div className="keni-pr-detail" data-testid="pr-loading">
        Loading…
      </div>
    );
  }

  return (
    <div
      className="keni-pr-detail"
      data-disconnected={disconnected.toString()}
      data-testid="pr-detail"
    >
      <header className="keni-pr-detail__header">
        <span className="keni-pr-detail__id" data-testid="pr-id">{pr.id}</span>
        <h1 className="keni-pr-detail__title" data-testid="pr-title">{pr.title}</h1>
        <span
          className="keni-pr-detail__status-pill"
          data-status={pr.status}
          data-testid="pr-status"
        >
          {titleCase(pr.status)}
        </span>
      </header>
      {pr.status === "approved" ? <MergeButton prId={pr.id} onMerge={merge} /> : null}
      <dl className="keni-pr-detail__meta">
        <dt>Linked ticket</dt>
        <dd>
          <Link to={`/tickets/${pr.ticket}`} data-testid="pr-linked-ticket">
            {pr.ticket}
          </Link>
        </dd>
        <dt>Branch</dt>
        <dd>
          <code data-testid="pr-branch">{pr.branch}</code>
        </dd>
        <dt>Author</dt>
        <dd data-testid="pr-author">{pr.author}</dd>
        <dt>Updated</dt>
        <dd title={pr.updated_at}>{formatRelativeTime(pr.updated_at, new Date())}</dd>
        <dt>Created</dt>
        <dd title={pr.created_at}>{pr.created_at}</dd>
      </dl>
      <section className="keni-pr-detail__intent-section">
        <h2>Intent</h2>
        <IntentEditor intent={pr.body} onSave={saveIntent} />
      </section>
      <TransitionPanel status={pr.status} onTransition={transition} />
    </div>
  );
}

export default PRDetailView;
