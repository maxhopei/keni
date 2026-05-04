import { useState } from "react";
import type { AgentResponse } from "@keni/shared";
import { formatRelativeTime } from "./formatRelativeTime.ts";
import { ConfirmInterruptDialog } from "./ConfirmInterruptDialog.tsx";
import { TerminalEventBadge } from "./TerminalEventBadge.tsx";

// Component CSS lives in `src/index.css` (centralised at the entry).

export interface AgentRosterCardProps {
  readonly agent: AgentResponse;
  readonly onTogglePause: (next: boolean) => Promise<void> | void;
  /**
   * Issue an interrupt against this agent. The card opens the
   * confirmation dialog and only invokes this callback after the
   * user confirms; the parent panel is responsible for the actual
   * `apiClient.interruptAgent(...)` call and for surfacing any
   * resulting `KeniApiError` via the `error` prop. The card flips
   * its in-flight state to `"Interrupting…"` while this promise is
   * pending (`design.md` Decision 8 — interrupt UX is non-optimistic).
   */
  readonly onInterrupt: () => Promise<void> | void;
  readonly error: string | null;
  /** Test seam for `formatRelativeTime`. Defaults to `new Date()`. */
  readonly now?: Date;
  /** True while pause / resume is in flight (existing prop). */
  readonly busy?: boolean;
  /** True while interrupt is in flight (new). */
  readonly interrupting?: boolean;
}

export function AgentRosterCard(props: AgentRosterCardProps) {
  const { agent, onTogglePause, onInterrupt, error, busy, interrupting } = props;
  const now = props.now ?? new Date();
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);
  const statusLabel = agent.status === "running" ? "Running" : "Idle";
  const lastActiveLabel = agent.last_active_at === null
    ? "—"
    : formatRelativeTime(agent.last_active_at, now);
  const lastActivityLabel = agent.last_activity ?? "—";
  const buttonLabel = agent.paused ? "Resume" : "Pause";
  const isRunning = agent.status === "running";

  return (
    <article
      className="keni-agent-card"
      data-testid={`agent-card-${agent.id}`}
      data-status={agent.status}
      data-paused={agent.paused.toString()}
    >
      <header className="keni-agent-card__header">
        <span className="keni-agent-card__id">{agent.id}</span>
        <span className="keni-agent-card__role">{agent.role}</span>
      </header>
      <dl className="keni-agent-card__body">
        <div className="keni-agent-card__row">
          <dt>Status</dt>
          <dd>
            <span
              className="keni-agent-card__status-dot"
              data-status={agent.status}
              aria-hidden="true"
            />
            {statusLabel}
          </dd>
        </div>
        <div className="keni-agent-card__row">
          <dt>Last activity</dt>
          <dd className="keni-agent-card__activity-event">
            <span>{lastActivityLabel}</span>
            <TerminalEventBadge lastActivity={agent.last_activity} />
          </dd>
        </div>
        <div className="keni-agent-card__row">
          <dt>Last seen</dt>
          <dd>{lastActiveLabel}</dd>
        </div>
      </dl>
      <footer className="keni-agent-card__footer">
        <button
          type="button"
          className="keni-agent-card__toggle"
          aria-label={`${buttonLabel} agent ${agent.id}`}
          aria-pressed={agent.paused}
          disabled={busy === true}
          onClick={() => {
            void onTogglePause(!agent.paused);
          }}
        >
          {buttonLabel}
        </button>
        {isRunning
          ? (
            <button
              type="button"
              className="keni-agent-card__interrupt"
              data-testid={`agent-card-${agent.id}-interrupt`}
              aria-label={`Interrupt agent ${agent.id}`}
              aria-busy={interrupting === true}
              disabled={interrupting === true}
              onClick={() => setDialogOpen(true)}
            >
              {interrupting === true ? "Interrupting…" : "Interrupt"}
            </button>
          )
          : null}
      </footer>
      {dialogOpen
        ? (
          <ConfirmInterruptDialog
            agentId={agent.id}
            onCancel={() => setDialogOpen(false)}
            onConfirm={() => {
              setDialogOpen(false);
              void onInterrupt();
            }}
          />
        )
        : null}
      {error !== null
        ? (
          <div className="keni-agent-card__error" data-testid="card-error" role="alert">
            {error}
          </div>
        )
        : null}
    </article>
  );
}
