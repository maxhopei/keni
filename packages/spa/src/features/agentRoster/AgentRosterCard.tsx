import type { AgentResponse } from "@keni/shared";
import { formatRelativeTime } from "./formatRelativeTime.ts";

// Component CSS lives in `src/index.css` (centralised at the entry).

export interface AgentRosterCardProps {
  readonly agent: AgentResponse;
  readonly onTogglePause: (next: boolean) => Promise<void> | void;
  readonly error: string | null;
  /** Test seam for `formatRelativeTime`. Defaults to `new Date()`. */
  readonly now?: Date;
  readonly busy?: boolean;
}

export function AgentRosterCard(props: AgentRosterCardProps) {
  const { agent, onTogglePause, error, busy } = props;
  const now = props.now ?? new Date();
  const statusLabel = agent.status === "running" ? "Running" : "Idle";
  const lastActiveLabel = agent.last_active_at === null
    ? "—"
    : formatRelativeTime(agent.last_active_at, now);
  const lastActivityLabel = agent.last_activity ?? "—";
  const buttonLabel = agent.paused ? "Resume" : "Pause";

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
          <dd className="keni-agent-card__activity-event">{lastActivityLabel}</dd>
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
      </footer>
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
