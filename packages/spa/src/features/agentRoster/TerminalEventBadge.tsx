/**
 * TerminalEventBadge — small status pill rendered next to an
 * `AgentRosterCard`'s last-activity row.
 *
 * Specced by the `interrupt-and-timeout-ux` capability:
 *   - derived purely from `AgentResponse.last_activity`
 *   - three visual variants:
 *     * `interrupted` — danger color (red), tooltip mentions the
 *       non-revert rule.
 *     * `timeout`     — warning color (amber), tooltip mentions the
 *       non-revert rule.
 *     * `idle`        — neutral, no non-revert callout (idle isn't
 *       an abort verb, just self-reported quiescence).
 *   - any other `last_activity` (including `null`, `"session_start"`,
 *     `"session_end"`, `"subprocess_stdout"`, etc.) renders nothing —
 *     the badge auto-clears when the next cycle begins.
 *
 * The component is a pure function of `lastActivity`; no internal
 * state, no effects.
 *
 * @module
 */

// Component CSS lives in `src/index.css` (centralised at the entry,
// matching the pattern documented on `AgentRosterCard.tsx`).

export interface TerminalEventBadgeProps {
  readonly lastActivity: string | null;
}

interface BadgeVariant {
  readonly variant: "interrupted" | "timeout" | "idle";
  readonly label: string;
  readonly title: string;
}

const NON_REVERT_TITLE = "ticket status not auto-reverted";

function variantFor(lastActivity: string | null): BadgeVariant | null {
  switch (lastActivity) {
    case "session_interrupted":
      return {
        variant: "interrupted",
        label: "Interrupted",
        title: `The agent was interrupted on its last cycle — ${NON_REVERT_TITLE}.`,
      };
    case "session_timeout":
      return {
        variant: "timeout",
        label: "Timed out",
        title: `The agent timed out on its last cycle — ${NON_REVERT_TITLE}.`,
      };
    case "idle":
      return {
        variant: "idle",
        label: "Idle",
        title: "The agent self-reported idle on its last cycle.",
      };
    default:
      return null;
  }
}

export function TerminalEventBadge(props: TerminalEventBadgeProps) {
  const v = variantFor(props.lastActivity);
  if (v === null) return null;
  return (
    <span
      className={`keni-terminal-badge keni-terminal-badge--${v.variant}`}
      title={v.title}
      data-testid={`terminal-badge-${v.variant}`}
    >
      {v.label}
    </span>
  );
}
