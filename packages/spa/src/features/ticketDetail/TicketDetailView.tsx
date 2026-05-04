/**
 * Ticket detail view — root of the `/tickets/:id` route.
 *
 * Owns: a fetched `TicketResponse`, the activity list (via
 * `useTicketActivity`), a linked-PR list, plus the edit / transition /
 * comment sub-forms. Everything is local React state — no global store.
 *
 * Decisions baked in here:
 *   - server-confirmed mutations (design.md Decision 4): the user sees
 *     changes only after the server returns the authoritative envelope;
 *     a failed mutation surfaces inline and the existing state stays
 *     put.
 *   - client-side activity filtering (Decision 8): the status history
 *     and comment thread filter the shared activity list on render.
 *   - status-graph mirror (Decision 10): the transition dropdown's
 *     options come from `SPA_TICKET_STATUS_TRANSITIONS` — drift-checked
 *     against the server's constant at test time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  ActivityEntryResponse,
  EventFrame,
  PRSummaryResponse,
  TicketEnvelope,
  TicketResponse,
  TicketStatus,
} from "@keni/shared";
import { useApiClient } from "../../transport/ApiClientContext.tsx";
import { useEventsClient } from "../../transport/EventsClientContext.tsx";
import { KeniApiError } from "../../transport/apiClient.ts";
import type { EventsClientLifecycle } from "../../transport/eventsClient.ts";
import { SPA_TICKET_STATUS_TRANSITIONS } from "../shared/statusGraph.ts";
import { formatRelativeTime } from "../agentRoster/formatRelativeTime.ts";
import { useTicketActivity } from "./useTicketActivity.ts";

/** Max summary length per `appendActivity` body — `spec.md` §4.3. */
const COMMENT_MAX_LENGTH = 3800;

/** Single source of truth for the debounced-refetch window (see spec scenario). */
export const TICKET_ACTIVITY_REFETCH_DEBOUNCE_MS = 250;

function titleCaseStatus(status: TicketStatus | string): string {
  const raw = String(status).replaceAll("_", " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function orDash(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return value;
}

// ---------------------------------------------------------------------------
// Title / body edit sub-forms (inline so the view is self-contained)
// ---------------------------------------------------------------------------

interface TitleEditorProps {
  readonly title: string;
  readonly onCommit: (next: string) => Promise<void>;
  readonly error: string | null;
}

function TitleEditor({ title, onCommit, error }: TitleEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [editing, title]);

  async function commit() {
    if (draft === title) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onCommit(draft);
      setEditing(false);
    } catch {
      // Error surfaces via `error` prop; editor stays in edit mode so the
      // user can retry without losing their input.
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(title);
      setEditing(false);
    }
  }

  if (!editing) {
    return (
      <h1
        className="keni-ticket-detail__title"
        data-testid="ticket-title"
        onClick={() => setEditing(true)}
      >
        {title}
      </h1>
    );
  }

  return (
    <div className="keni-ticket-detail__title-edit">
      <input
        type="text"
        value={draft}
        disabled={busy}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        data-testid="ticket-title-input"
      />
      <button
        type="button"
        onClick={() => void commit()}
        disabled={busy}
        data-testid="ticket-title-commit"
      >
        Save
      </button>
      {error !== null
        ? (
          <span
            className="keni-ticket-detail__field-error"
            role="alert"
            data-testid="ticket-title-error"
          >
            {error}
          </span>
        )
        : null}
    </div>
  );
}

interface BodyEditorProps {
  readonly body: string;
  readonly onCommit: (next: string) => Promise<void>;
  readonly error: string | null;
}

function BodyEditor({ body, onCommit, error }: BodyEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(body);
  }, [editing, body]);

  async function save() {
    if (draft === body) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onCommit(draft);
      setEditing(false);
    } catch {
      // Error surfaces via `error` prop; textarea stays open for retry.
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="keni-ticket-detail__body">
        <div className="keni-ticket-detail__body-text" data-testid="ticket-body">{body}</div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          data-testid="ticket-body-edit"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div className="keni-ticket-detail__body keni-ticket-detail__body--editing">
      <textarea
        value={draft}
        disabled={busy}
        rows={8}
        onChange={(e) => setDraft(e.target.value)}
        data-testid="ticket-body-input"
      />
      <div className="keni-ticket-detail__body-actions">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          data-testid="ticket-body-save"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(body);
            setEditing(false);
          }}
          disabled={busy}
          data-testid="ticket-body-cancel"
        >
          Cancel
        </button>
      </div>
      {error !== null
        ? (
          <span
            className="keni-ticket-detail__field-error"
            role="alert"
            data-testid="ticket-body-error"
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
  readonly status: TicketStatus;
  readonly onTransition: (to: TicketStatus) => Promise<void>;
  readonly error: string | null;
}

function TransitionPanel({ status, onTransition, error }: TransitionPanelProps) {
  const reachable = SPA_TICKET_STATUS_TRANSITIONS[status];
  const firstTarget = reachable[0];
  const [target, setTarget] = useState<TicketStatus | "">(firstTarget ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTarget(reachable[0] ?? "");
  }, [reachable]);

  const terminal = reachable.length === 0;

  async function submit() {
    if (terminal || target === "") return;
    setBusy(true);
    try {
      await onTransition(target);
    } catch {
      // Error surfaces via `error` prop; panel stays expanded.
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="keni-ticket-detail__transition" data-testid="ticket-transition-panel">
      <summary>Advanced: transition (prototype only)</summary>
      <p className="keni-ticket-detail__caveat" data-testid="ticket-transition-caveat">
        This is the raw override path. It does not confirm the transition or record a
        manual_override activity entry. Step 25 will replace this panel with a confirmation flow.
      </p>
      <div className="keni-ticket-detail__transition-form">
        <label>
          <span>From</span>
          <input type="text" value={status} readOnly data-testid="ticket-transition-from" />
        </label>
        <label>
          <span>To</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as TicketStatus)}
            disabled={terminal}
            data-testid="ticket-transition-to"
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
          data-testid="ticket-transition-submit"
        >
          {busy ? "Transitioning…" : "Transition"}
        </button>
      </div>
      {error !== null
        ? (
          <div
            className="keni-ticket-detail__field-error"
            role="alert"
            data-testid="ticket-transition-error"
          >
            {error}
          </div>
        )
        : null}
    </details>
  );
}

// ---------------------------------------------------------------------------
// Post-comment form
// ---------------------------------------------------------------------------

interface PostCommentFormProps {
  readonly onSubmit: (text: string) => Promise<void>;
}

function PostCommentForm({ onSubmit }: PostCommentFormProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const disabled = busy || text.length === 0 || text.length > COMMENT_MAX_LENGTH;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
      setText("");
    } catch (caught) {
      const code = caught instanceof KeniApiError
        ? caught.code
        : caught instanceof Error
        ? caught.message
        : String(caught);
      setError(code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="keni-ticket-detail__post-comment"
      onSubmit={handleSubmit}
      data-testid="post-comment-form"
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        data-testid="post-comment-textarea"
        aria-label="Write a comment"
      />
      <div className="keni-ticket-detail__post-comment-actions">
        <span
          className="keni-ticket-detail__char-counter"
          data-testid="post-comment-counter"
        >
          {text.length}/{COMMENT_MAX_LENGTH}
        </span>
        <button
          type="submit"
          disabled={disabled}
          data-testid="post-comment-submit"
        >
          {busy ? "Posting…" : "Post"}
        </button>
      </div>
      {error !== null
        ? (
          <span
            className="keni-ticket-detail__field-error"
            role="alert"
            data-testid="post-comment-error"
          >
            {error}
          </span>
        )
        : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function TicketDetailView() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = rawId ?? "";
  const apiClient = useApiClient();
  const eventsClient = useEventsClient();

  const [ticket, setTicket] = useState<TicketResponse | null>(null);
  const [ticketError, setTicketError] = useState<KeniApiError | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [linkedPrs, setLinkedPrs] = useState<readonly PRSummaryResponse[] | null>(null);
  const [disconnected, setDisconnected] = useState<boolean>(
    eventsClient.state === "disconnected",
  );

  const linkedPrsRef = useRef<readonly PRSummaryResponse[] | null>(null);
  linkedPrsRef.current = linkedPrs;

  const refetchTicket = useCallback(async () => {
    if (id === "") return;
    try {
      const envelope = await apiClient.getTicket(id);
      setTicket(envelope.data);
      setTicketError(null);
    } catch (caught) {
      if (caught instanceof KeniApiError) setTicketError(caught);
      else setTicketError(new KeniApiError(500, "internal_error", String(caught)));
    }
  }, [apiClient, id]);

  const refetchLinkedPrs = useCallback(async () => {
    if (id === "") return;
    try {
      const envelope = await apiClient.listPrs({ ticket: id });
      setLinkedPrs(envelope.data);
    } catch {
      // Silent: the linked-PR section is supplementary and its error is
      // represented by an empty list; the ticket-level error path owns
      // the primary failure surface.
      setLinkedPrs([]);
    }
  }, [apiClient, id]);

  useEffect(() => {
    setTicket(null);
    setTicketError(null);
    setLinkedPrs(null);
    void refetchTicket();
    void refetchLinkedPrs();
  }, [refetchTicket, refetchLinkedPrs]);

  const { entries: activity } = useTicketActivity(apiClient, eventsClient);

  useEffect(() => {
    const off = eventsClient.onEvent((frame: EventFrame) => {
      if (frame.event === "ticket.updated") {
        if (frame.payload.ticket_id === id) void refetchTicket();
      } else if (frame.event === "pr.created") {
        if (frame.payload.ticket === id) void refetchLinkedPrs();
      } else if (frame.event === "pr.updated") {
        const known = linkedPrsRef.current?.some((p) => p.id === frame.payload.pr_id) ?? false;
        if (known) void refetchLinkedPrs();
      }
    });
    return off;
  }, [eventsClient, id, refetchTicket, refetchLinkedPrs]);

  useEffect(() => {
    return eventsClient.onLifecycle((next: EventsClientLifecycle) => {
      if (next === "connected") {
        setDisconnected(false);
        void refetchTicket();
        void refetchLinkedPrs();
      } else if (next === "disconnected") {
        setDisconnected(true);
      } else if (next === "connecting") {
        setDisconnected(false);
      }
    });
  }, [eventsClient, refetchTicket, refetchLinkedPrs]);

  // Each commit rethrows on failure so the inline editor can keep the
  // input open for retry. The view still captures the error code via a
  // setter-side catch so the editor's `error` prop renders the inline
  // message.
  const commitTitle = useCallback(async (nextTitle: string): Promise<void> => {
    setTitleError(null);
    try {
      const envelope = await apiClient.patchTicket(id, { title: nextTitle });
      applyEnvelope(envelope);
    } catch (caught) {
      setTitleError(errorCode(caught));
      throw caught;
    }
  }, [apiClient, id]);

  const commitBody = useCallback(async (nextBody: string): Promise<void> => {
    setBodyError(null);
    try {
      const envelope = await apiClient.patchTicket(id, { body: nextBody });
      applyEnvelope(envelope);
    } catch (caught) {
      setBodyError(errorCode(caught));
      throw caught;
    }
  }, [apiClient, id]);

  const commitTransition = useCallback(async (to: TicketStatus): Promise<void> => {
    if (ticket === null) return;
    setTransitionError(null);
    try {
      const envelope = await apiClient.transitionTicket(id, { from: ticket.status, to });
      applyEnvelope(envelope);
    } catch (caught) {
      setTransitionError(errorCode(caught));
      throw caught;
    }
  }, [apiClient, id, ticket]);

  const postComment = useCallback(async (text: string): Promise<void> => {
    await apiClient.appendActivity({
      session_id: "ui",
      agent: "user",
      role: "user",
      event: "ticket_comment",
      summary: text,
      refs: { ticket: id },
    });
  }, [apiClient, id]);

  function applyEnvelope(envelope: TicketEnvelope) {
    setTicket(envelope.data);
  }

  const filteredActivity = useMemo(() => {
    if (activity === null) return null;
    return activity.filter((e) => e.refs?.ticket === id);
  }, [activity, id]);

  const comments = useMemo(() => {
    if (filteredActivity === null) return null;
    return filteredActivity.filter((e) => e.event === "ticket_comment");
  }, [filteredActivity]);

  if (ticketError !== null && ticketError.code === "store_not_found") {
    return (
      <div className="keni-ticket-detail" data-testid="ticket-not-found">
        <p>Ticket {id} does not exist.</p>
      </div>
    );
  }

  if (ticketError !== null) {
    return (
      <div className="keni-ticket-detail" data-testid="ticket-error" role="alert">
        <p>Failed to load ticket: {ticketError.code}</p>
        <button type="button" onClick={() => void refetchTicket()}>Retry</button>
      </div>
    );
  }

  if (ticket === null) {
    return (
      <div className="keni-ticket-detail" data-testid="ticket-loading">
        Loading…
      </div>
    );
  }

  return (
    <div
      className="keni-ticket-detail"
      data-disconnected={disconnected.toString()}
      data-testid="ticket-detail"
    >
      <header className="keni-ticket-detail__header">
        <span className="keni-ticket-detail__id" data-testid="ticket-id">{ticket.id}</span>
        <TitleEditor title={ticket.title} onCommit={commitTitle} error={titleError} />
        <span
          className="keni-ticket-detail__status-pill"
          data-status={ticket.status}
          data-testid="ticket-status"
        >
          {titleCaseStatus(ticket.status)}
        </span>
      </header>
      <dl className="keni-ticket-detail__meta">
        <dt>Assignee</dt>
        <dd data-testid="ticket-assignee">{orDash(ticket.assignee)}</dd>
        <dt>Priority</dt>
        <dd data-testid="ticket-priority">{ticket.priority}</dd>
        <dt>Change request</dt>
        <dd data-testid="ticket-change-request">{orDash(ticket.change_request)}</dd>
        <dt>Updated</dt>
        <dd title={ticket.updated_at}>{formatRelativeTime(ticket.updated_at, new Date())}</dd>
        <dt>Created</dt>
        <dd title={ticket.created_at}>{ticket.created_at}</dd>
      </dl>
      <BodyEditor body={ticket.body} onCommit={commitBody} error={bodyError} />
      <TransitionPanel
        status={ticket.status}
        onTransition={commitTransition}
        error={transitionError}
      />
      <section className="keni-ticket-detail__linked-prs" data-testid="linked-prs">
        <h2>Linked PRs</h2>
        {linkedPrs === null
          ? <p>Loading…</p>
          : linkedPrs.length === 0
          ? <p data-testid="no-linked-pr">No pull requests yet.</p>
          : (
            <ul>
              {linkedPrs.map((pr) => (
                <li key={pr.id}>
                  <Link to={`/prs/${pr.id}`} data-testid={`linked-pr-${pr.id}`}>
                    <span>{pr.id}</span> · <span>{pr.title}</span> ·{" "}
                    <span>{titleCaseStatus(pr.status)}</span> · <span>{pr.author}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
      </section>
      <section className="keni-ticket-detail__history" data-testid="ticket-history">
        <h2>Status history</h2>
        {filteredActivity === null
          ? <p>Loading…</p>
          : filteredActivity.length === 0
          ? <p data-testid="history-empty">No activity yet.</p>
          : (
            <ul>
              {filteredActivity.map((e) => <HistoryRow key={e.id} entry={e} />)}
            </ul>
          )}
      </section>
      <section className="keni-ticket-detail__comments" data-testid="ticket-comments">
        <h2>Comments</h2>
        {comments === null
          ? <p>Loading…</p>
          : comments.length === 0
          ? <p data-testid="comments-empty">No comments yet.</p>
          : (
            <ul>
              {comments.map((e) => <CommentRow key={e.id} entry={e} />)}
            </ul>
          )}
        <PostCommentForm onSubmit={postComment} />
      </section>
    </div>
  );
}

function HistoryRow({ entry }: { readonly entry: ActivityEntryResponse }) {
  return (
    <li className="keni-ticket-detail__history-row" data-testid="history-row">
      <span className="keni-ticket-detail__history-time" title={entry.timestamp}>
        {formatRelativeTime(entry.timestamp, new Date())}
      </span>
      <span className="keni-ticket-detail__history-agent">{entry.agent}</span>
      <span className="keni-ticket-detail__history-role">{entry.role}</span>
      <span className="keni-ticket-detail__history-event">
        <strong>{entry.event}</strong>
      </span>
      <span className="keni-ticket-detail__history-summary">{orDash(entry.summary)}</span>
    </li>
  );
}

function CommentRow({ entry }: { readonly entry: ActivityEntryResponse }) {
  return (
    <li className="keni-ticket-detail__comment" data-testid="comment-row">
      <div className="keni-ticket-detail__comment-header">
        <span className="keni-ticket-detail__comment-agent">{entry.agent}</span>
        <span className="keni-ticket-detail__comment-role">{entry.role}</span>
        <span
          className="keni-ticket-detail__comment-time"
          title={entry.timestamp}
        >
          {formatRelativeTime(entry.timestamp, new Date())}
        </span>
      </div>
      <div className="keni-ticket-detail__comment-body">{entry.summary}</div>
    </li>
  );
}

function errorCode(caught: unknown): string {
  return caught instanceof KeniApiError
    ? caught.code
    : caught instanceof Error
    ? caught.message
    : String(caught);
}

export default TicketDetailView;
