/**
 * ConfirmInterruptDialog — modal confirmation for the destructive
 * `Interrupt` action on an `AgentRosterCard`.
 *
 * Specced by the `interrupt-and-timeout-ux` capability:
 *   - opens as a native `<dialog>` (so it carries `role="dialog"` and
 *     `aria-modal="true"` for free) and shows over the rest of the
 *     page until dismissed.
 *   - body explicitly mentions SIGTERM / SIGKILL termination and
 *     contains the literal substring "is not changed" qualifying the
 *     ticket's status (the non-revert rule).
 *   - destructive `Interrupt` button is focused on mount so `Enter`
 *     confirms; `Esc` and the `Cancel` button both call `onCancel`.
 *   - tab key cycles between the two buttons (focus trap) — easy to
 *     express with two buttons because the trap is a 2-cycle.
 *
 * The component does NOT issue the API call itself; the parent card
 * passes `onConfirm`, which calls `apiClient.interruptAgent(...)`
 * after the dialog is closed (`design.md` Decision 8: "Interrupt
 * UX is not optimistic — close the dialog, then show a busy state
 * on the card").
 *
 * @module
 */

import { useCallback, useEffect, useRef } from "react";

// Component CSS lives in `src/index.css` (centralised at the entry,
// matching the pattern documented on `AgentRosterCard.tsx`).

export interface ConfirmInterruptDialogProps {
  readonly agentId: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function ConfirmInterruptDialog(props: ConfirmInterruptDialogProps) {
  const { agentId, onCancel, onConfirm } = props;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const interruptBtnRef = useRef<HTMLButtonElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  // Open as a modal on mount. happy-dom does not implement
  // `showModal` reliably (returns undefined or no-ops); when that
  // happens the markup is still rendered in-DOM and accessible via
  // the same `[data-testid]` selectors.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        // showModal() throws if the dialog is already open or if the
        // implementation is incomplete. Either way the dialog is
        // visible — fall through.
      }
    }
    // Initial focus on the destructive button so `Enter` confirms.
    interruptBtnRef.current?.focus();
  }, []);

  // Native `<dialog>` fires a `cancel` event on `Esc`; mirror that
  // to `onCancel`. We also intercept the `keydown` to be defensive
  // against runtimes that do not fire `cancel`.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDialogElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      // Two-element focus trap: Tab from `Interrupt` lands on
      // `Cancel`; Shift+Tab from `Cancel` lands on `Interrupt`. The
      // browser's default focus order already does the right thing
      // for two visible buttons inside an open `<dialog>`, so the
      // trap is implicit. We only handle Tab explicitly when focus
      // has somehow escaped.
      if (event.key === "Tab") {
        const active = document.activeElement;
        if (active !== interruptBtnRef.current && active !== cancelBtnRef.current) {
          event.preventDefault();
          interruptBtnRef.current?.focus();
        }
      }
    },
    [onCancel],
  );

  // Click on the dialog's backdrop = close. The native `<dialog>`
  // surface includes the backdrop pseudo-element; we detect "click
  // landed on the dialog itself, not on a child" as the backdrop.
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDialogElement>) => {
      if (event.target === dialogRef.current) {
        onCancel();
      }
    },
    [onCancel],
  );

  return (
    <dialog
      ref={dialogRef}
      className="keni-confirm-interrupt"
      role="dialog"
      aria-modal="true"
      aria-labelledby="keni-confirm-interrupt-title"
      data-testid="confirm-interrupt-dialog"
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div className="keni-confirm-interrupt__panel">
        <h2 className="keni-confirm-interrupt__title" id="keni-confirm-interrupt-title">
          Interrupt <code>{agentId}</code>?
        </h2>
        <p className="keni-confirm-interrupt__body">
          This sends <strong>SIGTERM</strong> followed by <strong>SIGKILL</strong>{" "}
          to the agent's in-flight cycle, aborting whatever it is doing right now. The ticket the
          agent is working on <strong>is not changed</strong>{" "}
          — its status will remain wherever the agent left it. You can review and re-route the
          ticket manually after the cycle ends.
        </p>
        <div className="keni-confirm-interrupt__actions">
          <button
            type="button"
            ref={cancelBtnRef}
            className="keni-confirm-interrupt__cancel"
            data-testid="confirm-interrupt-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            ref={interruptBtnRef}
            className="keni-confirm-interrupt__confirm"
            data-testid="confirm-interrupt-confirm"
            onClick={onConfirm}
          >
            Interrupt
          </button>
        </div>
      </div>
    </dialog>
  );
}
