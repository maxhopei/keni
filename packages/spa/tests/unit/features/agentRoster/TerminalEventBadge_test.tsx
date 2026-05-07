/**
 * Tests for `<TerminalEventBadge>` — covers each branch of the
 * `last_activity` → variant mapping documented by the
 * `interrupt-and-timeout-ux` capability.
 *
 *   render values  : `session_interrupted`, `session_timeout`, `idle`
 *   no-render values : `null`, `"session_start"`, `"session_end"`,
 *                       `"subprocess_stdout"`
 *
 * Every render-value case asserts the badge's `title` includes the
 * documented substring; the `interrupted` and `timeout` titles MUST
 * also include `ticket status not auto-reverted` so the non-revert
 * rule is conveyed even on hover.
 */

import "../../../../src/test_setup.ts";
import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { cleanup, render, screen } from "@testing-library/react";
import { TerminalEventBadge } from "../../../../src/features/agentRoster/TerminalEventBadge.tsx";

describe({
  name: "TerminalEventBadge",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  afterEach(() => cleanup());

  it("renders the danger variant with non-revert tooltip on session_interrupted", () => {
    render(<TerminalEventBadge lastActivity="session_interrupted" />);
    const el = screen.getByTestId("terminal-badge-interrupted");
    assert(el !== null);
    assert(el.classList.contains("keni-terminal-badge--interrupted"));
    assert(
      el.getAttribute("title")?.includes("ticket status not auto-reverted"),
      "title MUST include the non-revert phrase",
    );
    assertEquals(el.textContent, "Interrupted");
  });

  it("renders the warning variant with non-revert tooltip on session_timeout", () => {
    render(<TerminalEventBadge lastActivity="session_timeout" />);
    const el = screen.getByTestId("terminal-badge-timeout");
    assert(el.classList.contains("keni-terminal-badge--timeout"));
    assert(
      el.getAttribute("title")?.includes("ticket status not auto-reverted"),
      "title MUST include the non-revert phrase",
    );
    assertEquals(el.textContent, "Timed out");
  });

  it("renders the neutral variant on idle (no non-revert phrase)", () => {
    render(<TerminalEventBadge lastActivity="idle" />);
    const el = screen.getByTestId("terminal-badge-idle");
    assert(el.classList.contains("keni-terminal-badge--idle"));
    assertEquals(el.textContent, "Idle");
    // `idle` is self-reported quiescence, not an abort verb — no
    // non-revert phrase required.
    assertEquals(
      el.getAttribute("title")?.includes("ticket status not auto-reverted"),
      false,
    );
  });

  it("renders nothing for null", () => {
    const { container } = render(<TerminalEventBadge lastActivity={null} />);
    assertEquals(container.querySelector(".keni-terminal-badge"), null);
  });

  it("renders nothing for session_start (the next cycle clears the badge)", () => {
    const { container } = render(<TerminalEventBadge lastActivity="session_start" />);
    assertEquals(container.querySelector(".keni-terminal-badge"), null);
  });

  it("renders nothing for session_end", () => {
    const { container } = render(<TerminalEventBadge lastActivity="session_end" />);
    assertEquals(container.querySelector(".keni-terminal-badge"), null);
  });

  it("renders nothing for subprocess_stdout", () => {
    const { container } = render(<TerminalEventBadge lastActivity="subprocess_stdout" />);
    assertEquals(container.querySelector(".keni-terminal-badge"), null);
  });
});
