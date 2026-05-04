/**
 * Tests for `<ConfirmInterruptDialog>` — the modal confirmation
 * required before any `apiClient.interruptAgent` call. Specced by
 * `interrupt-and-timeout-ux`.
 *
 * Coverage matrix (mirrors the capability spec):
 *   - role / aria-modal accessibility attributes
 *   - the heading carries the agent id
 *   - the body contains the literal substring `is not changed`
 *   - Cancel calls `onCancel` exactly once
 *   - Interrupt calls `onConfirm` exactly once
 *   - Esc calls `onCancel`
 *   - initial focus lands on the destructive `Interrupt` button
 */

import "../../test_setup.ts";
import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmInterruptDialog } from "./ConfirmInterruptDialog.tsx";

interface CallCounter {
  count: number;
}

function counter(): { fn: () => void; calls: CallCounter } {
  const calls: CallCounter = { count: 0 };
  return {
    fn: () => {
      calls.count += 1;
    },
    calls,
  };
}

describe({
  name: "ConfirmInterruptDialog",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  afterEach(() => cleanup());

  it("renders a role=dialog, aria-modal=true element", () => {
    const cancel = counter();
    const confirm = counter();
    render(
      <ConfirmInterruptDialog
        agentId="alice"
        onCancel={cancel.fn}
        onConfirm={confirm.fn}
      />,
    );
    const dialog = screen.getByTestId("confirm-interrupt-dialog");
    assertEquals(dialog.getAttribute("role"), "dialog");
    assertEquals(dialog.getAttribute("aria-modal"), "true");
  });

  it("heading carries the agent id and the body explains the non-revert rule", () => {
    const cancel = counter();
    const confirm = counter();
    render(
      <ConfirmInterruptDialog
        agentId="alice"
        onCancel={cancel.fn}
        onConfirm={confirm.fn}
      />,
    );
    const dialog = screen.getByTestId("confirm-interrupt-dialog");
    // Heading mentions the agent.
    assert(dialog.textContent?.includes("alice"), "heading should name the agent");
    assert(dialog.textContent?.includes("Interrupt"), "heading should say Interrupt");
    // Body mentions SIGTERM / SIGKILL and the literal non-revert phrase.
    assert(
      dialog.textContent?.includes("SIGTERM"),
      "body should explain SIGTERM termination",
    );
    assert(
      dialog.textContent?.includes("SIGKILL"),
      "body should explain SIGKILL termination",
    );
    assert(
      dialog.textContent?.includes("is not changed"),
      "body MUST contain the literal substring 'is not changed' (non-revert rule)",
    );
  });

  it("clicking Cancel calls onCancel exactly once and never onConfirm", () => {
    const cancel = counter();
    const confirm = counter();
    render(
      <ConfirmInterruptDialog
        agentId="alice"
        onCancel={cancel.fn}
        onConfirm={confirm.fn}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-interrupt-cancel"));
    assertEquals(cancel.calls.count, 1);
    assertEquals(confirm.calls.count, 0);
  });

  it("clicking Interrupt calls onConfirm exactly once and never onCancel", () => {
    const cancel = counter();
    const confirm = counter();
    render(
      <ConfirmInterruptDialog
        agentId="alice"
        onCancel={cancel.fn}
        onConfirm={confirm.fn}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-interrupt-confirm"));
    assertEquals(confirm.calls.count, 1);
    assertEquals(cancel.calls.count, 0);
  });

  it("pressing Esc calls onCancel", () => {
    const cancel = counter();
    const confirm = counter();
    render(
      <ConfirmInterruptDialog
        agentId="alice"
        onCancel={cancel.fn}
        onConfirm={confirm.fn}
      />,
    );
    const dialog = screen.getByTestId("confirm-interrupt-dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    assertEquals(cancel.calls.count, 1);
    assertEquals(confirm.calls.count, 0);
  });

  it("initial focus lands on the destructive Interrupt button", () => {
    const cancel = counter();
    const confirm = counter();
    render(
      <ConfirmInterruptDialog
        agentId="alice"
        onCancel={cancel.fn}
        onConfirm={confirm.fn}
      />,
    );
    const interruptBtn = screen.getByTestId("confirm-interrupt-confirm");
    // happy-dom returns the focused element via document.activeElement.
    assertEquals(
      document.activeElement,
      interruptBtn,
      "Interrupt button should receive initial focus so Enter confirms",
    );
  });
});
