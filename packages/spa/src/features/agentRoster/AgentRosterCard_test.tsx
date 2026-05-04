/**
 * Tests for `<AgentRosterCard>` — the per-card surface that owns the
 * Interrupt button, the confirmation-dialog flow, the in-flight
 * `Interrupting…` state, and the `<TerminalEventBadge>` placement.
 *
 * The panel-level tests in `AgentRosterPanel_test.tsx` cover the
 * REST round-trip and the optimistic-state machinery; this file
 * keeps assertions narrowly scoped to the card's UI contract per
 * the `spa-agent-roster` capability spec delta.
 *
 * Coverage matrix (mirrors the spec):
 *   1. Interrupt button appears only when status === "running".
 *   2. Click on Interrupt opens the dialog, no API call yet.
 *   3. Cancel from the dialog leaves the API untouched.
 *   4. Confirm from the dialog calls `onInterrupt` exactly once.
 *   5. While `interrupting === true`, the button is disabled,
 *      carries `aria-busy="true"`, and reads `Interrupting…`.
 *   6. The `error` prop renders inside `data-testid="card-error"`.
 *   7. `last_activity` mapping for the four documented values.
 *   8. Badge `title` includes `ticket status not auto-reverted`
 *      for interrupted / timeout variants.
 */

import "../../test_setup.ts";
import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentResponse } from "@keni/shared";
import { AgentRosterCard } from "./AgentRosterCard.tsx";

const RUNNING_AGENT: AgentResponse = {
  id: "alice",
  role: "engineer",
  status: "running",
  last_activity: "session_start",
  last_active_at: "2026-05-04T07:00:00.000Z",
  paused: false,
};

const IDLE_AGENT: AgentResponse = {
  id: "alice",
  role: "engineer",
  status: "idle",
  last_activity: null,
  last_active_at: null,
  paused: false,
};

interface RecordingHandlers {
  togglePauseCalls: number;
  interruptCalls: number;
}

function makeHandlers(): {
  readonly onTogglePause: () => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly recorded: RecordingHandlers;
} {
  const recorded: RecordingHandlers = { togglePauseCalls: 0, interruptCalls: 0 };
  return {
    recorded,
    onTogglePause: () => {
      recorded.togglePauseCalls += 1;
      return Promise.resolve();
    },
    onInterrupt: () => {
      recorded.interruptCalls += 1;
      return Promise.resolve();
    },
  };
}

describe({
  name: "AgentRosterCard",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  afterEach(() => cleanup());

  it("does NOT render the Interrupt button when status === idle", () => {
    const { onTogglePause, onInterrupt } = makeHandlers();
    render(
      <AgentRosterCard
        agent={IDLE_AGENT}
        error={null}
        onTogglePause={onTogglePause}
        onInterrupt={onInterrupt}
      />,
    );
    const btn = screen.queryByTestId("agent-card-alice-interrupt");
    assertEquals(btn, null, "Interrupt button MUST be hidden for idle agents");
  });

  it("renders the Interrupt button when status === running", () => {
    const { onTogglePause, onInterrupt } = makeHandlers();
    render(
      <AgentRosterCard
        agent={RUNNING_AGENT}
        error={null}
        onTogglePause={onTogglePause}
        onInterrupt={onInterrupt}
      />,
    );
    const btn = screen.getByTestId("agent-card-alice-interrupt");
    assertEquals(btn.textContent, "Interrupt");
    assertEquals(btn.getAttribute("aria-label"), "Interrupt agent alice");
  });

  it("clicking Interrupt opens the confirmation dialog and does NOT call onInterrupt", () => {
    const { onTogglePause, onInterrupt, recorded } = makeHandlers();
    render(
      <AgentRosterCard
        agent={RUNNING_AGENT}
        error={null}
        onTogglePause={onTogglePause}
        onInterrupt={onInterrupt}
      />,
    );
    fireEvent.click(screen.getByTestId("agent-card-alice-interrupt"));
    assert(screen.getByTestId("confirm-interrupt-dialog") !== null);
    assertEquals(
      recorded.interruptCalls,
      0,
      "the click MUST gate the API call behind the confirmation dialog",
    );
  });

  it("Cancel in the dialog closes it and does NOT call onInterrupt", () => {
    const { onTogglePause, onInterrupt, recorded } = makeHandlers();
    render(
      <AgentRosterCard
        agent={RUNNING_AGENT}
        error={null}
        onTogglePause={onTogglePause}
        onInterrupt={onInterrupt}
      />,
    );
    fireEvent.click(screen.getByTestId("agent-card-alice-interrupt"));
    fireEvent.click(screen.getByTestId("confirm-interrupt-cancel"));
    assertEquals(screen.queryByTestId("confirm-interrupt-dialog"), null);
    assertEquals(recorded.interruptCalls, 0);
  });

  it("Confirm in the dialog closes it and calls onInterrupt exactly once", () => {
    const { onTogglePause, onInterrupt, recorded } = makeHandlers();
    render(
      <AgentRosterCard
        agent={RUNNING_AGENT}
        error={null}
        onTogglePause={onTogglePause}
        onInterrupt={onInterrupt}
      />,
    );
    fireEvent.click(screen.getByTestId("agent-card-alice-interrupt"));
    fireEvent.click(screen.getByTestId("confirm-interrupt-confirm"));
    assertEquals(screen.queryByTestId("confirm-interrupt-dialog"), null);
    assertEquals(recorded.interruptCalls, 1);
    assertEquals(recorded.togglePauseCalls, 0);
  });

  it("while interrupting, the button is disabled, aria-busy=true, and reads 'Interrupting…'", () => {
    const { onTogglePause, onInterrupt } = makeHandlers();
    render(
      <AgentRosterCard
        agent={RUNNING_AGENT}
        error={null}
        interrupting={true}
        onTogglePause={onTogglePause}
        onInterrupt={onInterrupt}
      />,
    );
    const btn = screen.getByTestId("agent-card-alice-interrupt") as HTMLButtonElement;
    assertEquals(btn.disabled, true);
    assertEquals(btn.getAttribute("aria-busy"), "true");
    assertEquals(btn.textContent, "Interrupting…");
  });

  it("the error prop renders inside data-testid=card-error", () => {
    const { onTogglePause, onInterrupt } = makeHandlers();
    render(
      <AgentRosterCard
        agent={RUNNING_AGENT}
        error="role_not_owner"
        onTogglePause={onTogglePause}
        onInterrupt={onInterrupt}
      />,
    );
    const cardError = screen.getByTestId("card-error");
    assertEquals(cardError.textContent, "role_not_owner");
  });

  // ───────── TerminalEventBadge integration ─────────

  it("renders the interrupted badge with non-revert tooltip when last_activity = session_interrupted", () => {
    const { onTogglePause, onInterrupt } = makeHandlers();
    render(
      <AgentRosterCard
        agent={{ ...IDLE_AGENT, last_activity: "session_interrupted" }}
        error={null}
        onTogglePause={onTogglePause}
        onInterrupt={onInterrupt}
      />,
    );
    const badge = screen.getByTestId("terminal-badge-interrupted");
    assertEquals(badge.textContent, "Interrupted");
    assert(
      badge.getAttribute("title")?.includes("ticket status not auto-reverted"),
    );
  });

  it("renders the timeout badge with non-revert tooltip when last_activity = session_timeout", () => {
    const { onTogglePause, onInterrupt } = makeHandlers();
    render(
      <AgentRosterCard
        agent={{ ...IDLE_AGENT, last_activity: "session_timeout" }}
        error={null}
        onTogglePause={onTogglePause}
        onInterrupt={onInterrupt}
      />,
    );
    const badge = screen.getByTestId("terminal-badge-timeout");
    assertEquals(badge.textContent, "Timed out");
    assert(
      badge.getAttribute("title")?.includes("ticket status not auto-reverted"),
    );
  });

  it("renders the idle badge (no non-revert phrase) when last_activity = idle", () => {
    const { onTogglePause, onInterrupt } = makeHandlers();
    render(
      <AgentRosterCard
        agent={{ ...IDLE_AGENT, last_activity: "idle" }}
        error={null}
        onTogglePause={onTogglePause}
        onInterrupt={onInterrupt}
      />,
    );
    assert(screen.getByTestId("terminal-badge-idle") !== null);
  });

  it("renders no badge for session_start (the next cycle starts cleanly)", () => {
    const { onTogglePause, onInterrupt } = makeHandlers();
    render(
      <AgentRosterCard
        agent={{ ...RUNNING_AGENT, last_activity: "session_start" }}
        error={null}
        onTogglePause={onTogglePause}
        onInterrupt={onInterrupt}
      />,
    );
    assertEquals(screen.queryByTestId("terminal-badge-interrupted"), null);
    assertEquals(screen.queryByTestId("terminal-badge-timeout"), null);
    assertEquals(screen.queryByTestId("terminal-badge-idle"), null);
  });
});
