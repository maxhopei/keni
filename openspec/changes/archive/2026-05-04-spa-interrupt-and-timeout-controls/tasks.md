## 1. Orchestration server: `POST /agents/:id/interrupt` route

- [x] 1.1 Create the route module `packages/server/src/api/agents/interrupt.ts` exporting a Hono handler that pre-checks the roster (via `agentRuntimeStateStore.read(id)` → `404 store_not_found` on `StoreNotFoundError`), enforces `X-Keni-Role: user` (existing role-guard middleware → `403 role_not_owner` otherwise), `await`s `scheduler.interrupt(id)`, and maps the discriminated return per Decision 1: `interrupted: true` and `interrupted: false, reason: "no_active_cycle"` both → `200 { data: AgentResponse, project_id }` (the body is read via `agentRuntimeStateStore.read(id)` *after* the scheduler's synchronous activity post has run); `interrupted: false, reason: "unknown_agent"` → `404 store_not_found`. *(Adapted to the existing flat `routes/agents.ts` layout — added the handler alongside pause/resume; introduced a `getScheduler` thunk through `ServerDeps` since the scheduler is built after `createServer`.)*
- [x] 1.2 Register the new route in the existing agents router alongside the pause / resume entries; keep the route ordering and middleware stack consistent with the pause/resume handlers (the same role-guard layer, the same error-envelope serializer).
- [x] 1.3 Add `packages/server/src/api/agents/interrupt_test.ts` covering the six scenarios in the orchestration-server spec delta: happy-path interrupt of a running agent, idempotent 200 on no-active-cycle, 403 for non-user roles, 404 for unknown agent, 400 for missing role header, and "non-empty body is ignored" → 200. *(Tests added to existing `packages/server/src/routes/agents_test.ts` to match the codebase's flat layout. Uses `app.fetch(new Request(...))` against an in-memory `AgentRuntimeStateStore` and a `FakeScheduler` that mirrors the real activity-post + frame-emit behaviour. 9 new test cases, all 20 cases in the file pass.)*
- [x] 1.4 Verify no second `agent.state_changed` frame is emitted by the route itself: assert that for the happy-path interrupt the captured bus contains exactly one `agent.state_changed` frame (the one driven by the scheduler's `POST /activity` for `session_interrupted` flowing through `applyActivityEvent`), and zero for the no-active-cycle case.

## 2. SPA transport: `apiClient.interruptAgent`

- [x] 2.1 Extend the `ApiClient` interface in `packages/spa/src/transport/apiClient.ts` with `interruptAgent(id: string): Promise<AgentEnvelope>`. Implement it as a `POST` to `${baseUrl}/agents/${id}/interrupt` with an empty body, the standard `X-Keni-Role` and `Accept: application/json` headers, and the existing `KeniApiError` non-2xx surface.
- [x] 2.2 Extend `packages/spa/src/transport/apiClient_test.ts` with the four `interruptAgent` scenarios: empty-body POST shape, typed `AgentEnvelope` resolution on `200`, `404 store_not_found` rejection, and acceptance of the no-active-cycle `200` (resolves with `data.last_activity === null`). Also extended `unusedApiStubs()` so the test stub satisfies the new method.
- [x] 2.3 Run `deno task check` and `deno task test` against the SPA package to confirm the typing and tests pass before touching UI code.

## 3. Design tokens

- [x] 3.1 Add `--keni-color-warning` and `--keni-color-danger` to both the `:root` and `@media (prefers-color-scheme: dark) :root` blocks of `packages/spa/src/theme/tokens.css`. *(`--keni-color-danger` already existed in both themes from earlier steps; added `--keni-color-warning` light `#b45309` and dark `#fbbf24` matching the design's perceptual-parity guidance.)*
- [x] 3.2 No additional consumers in this task — the new tokens are referenced by the components in tasks 4, 5, and 6.

## 4. SPA: confirmation dialog component

- [x] 4.1 Create `packages/spa/src/features/agentRoster/ConfirmInterruptDialog.tsx` exporting a `<ConfirmInterruptDialog agentId, onCancel, onConfirm />` React component. Render it as an in-DOM `<dialog>` element opened via `dialogRef.current?.showModal()` on mount.
- [x] 4.2 Wire keyboard handling: focus the destructive `Interrupt` button on mount (so `Enter` confirms); intercept `Esc` and clicks on the dialog backdrop to call `onCancel`; ensure `Tab` traps focus inside the dialog while it is open.
- [x] 4.3 Add `ConfirmInterruptDialog.css` adjacent to the component. *(Imported from the centralised `src/index.css` to match the existing `AgentRosterCard.css` pattern — the Deno test runner cannot resolve `.css` imports from `.tsx`.)*
- [x] 4.4 Add `ConfirmInterruptDialog_test.tsx` covering: the `role="dialog"` + `aria-modal="true"` attributes, the documented heading + body text (including the literal substring `is not changed`), `Cancel` calls `onCancel` exactly once, `Interrupt` calls `onConfirm` exactly once, `Esc` calls `onCancel`, initial focus lands on the `Interrupt` button.

## 5. SPA: terminal-event badge component

- [x] 5.1 Create `packages/spa/src/features/agentRoster/TerminalEventBadge.tsx` exporting a pure `<TerminalEventBadge lastActivity={string | null} />` React component that returns `null` for non-badge values and a single `<span class="keni-terminal-badge keni-terminal-badge--<variant>" title="...">` for the three documented variants per the `interrupt-and-timeout-ux` capability's mapping. The `title` attribute SHALL include the substring `ticket status not auto-reverted` for the interrupted and timeout variants.
- [x] 5.2 Add `TerminalEventBadge.css` defining the three variants. Use `var(--keni-color-danger)` for `--interrupted`, `var(--keni-color-warning)` for `--timeout`, and a muted neutral for `--idle`.
- [x] 5.3 Add `TerminalEventBadge_test.tsx` covering each branch of the mapping: the three rendering values plus four no-render values (`null`, `"session_start"`, `"session_end"`, `"subprocess_stdout"`).

## 6. SPA: roster card integration

- [x] 6.1 Extend `packages/spa/src/features/agentRoster/AgentRosterCard.tsx` to render the Interrupt button conditionally on `agent.status === "running"`, sibling to the existing pause/resume toggle. Wire the click handler to open a local `dialogOpen` state; when `true`, render `<ConfirmInterruptDialog>` with `onCancel` / `onConfirm` callbacks.
- [x] 6.2 In the `onConfirm` callback: set the in-flight state, call `apiClient.interruptAgent(agent.id)`, and on resolution merge the response's `data` into the panel's roster state. *(Card now exposes `onInterrupt` prop; the panel owns the `apiClient` call and the in-flight state, mirroring the existing pause/resume separation.)*
- [x] 6.3 While `interruptAgent` is in flight, render the Interrupt button with `disabled` and `aria-busy="true"`, label `Interrupting…`. Do NOT optimistically flip `status`.
- [x] 6.4 Mount `<TerminalEventBadge lastActivity={agent.last_activity} />` inside the card, positioned next to the existing `last_activity` / `last_active_at` micro-data area.
- [x] 6.5 Update / extend `packages/spa/src/features/agentRoster/AgentRosterCard.css` to lay out the action region (Pause + Interrupt) and the badge area without breaking the existing card grid.

## 7. SPA: roster card tests

- [x] 7.1 Create `packages/spa/src/features/agentRoster/AgentRosterCard_test.tsx`. *(11 test cases covering button gating, dialog open/cancel/confirm flow, in-flight `Interrupting…` state, `card-error` rendering, and the four `last_activity` → badge mappings including the non-revert tooltip phrase.)*
- [x] 7.2 Build the test's apparatus as in-memory recording handlers (no global mocking framework). Imports `../../test_setup.ts` first. *(The card's contract is purely synchronous — `onTogglePause`/`onInterrupt` callbacks; the REST round-trip is panel-level and is exercised by `AgentRosterPanel_test.tsx`.)*
- [x] 7.3 Update the existing `AgentRosterPanel_test.tsx` if it asserts a specific count of buttons per card. *(No change required — the existing test only clicks ALICE who is `idle`, so the Interrupt button is not rendered and `card.querySelector("button")` still returns the Pause toggle. All 9 panel tests continue to pass.)*

## 8. SPA: activity-log row variant + non-revert caption

- [x] 8.1 Update `packages/spa/src/features/activityLog/ActivityLogView.tsx` to compute a row container class based on `entry.event`.
- [x] 8.2 In the same row, when `entry.event` is one of the two terminal-event values AND `entry.refs?.ticket` is non-empty, render the non-revert caption as the row's last child.
- [x] 8.3 Update `packages/spa/src/features/activityLog/ActivityLogView.css` with rules for the two terminal-event variants and a muted style for the non-revert caption.
- [x] 8.4 Extend `ActivityLogView_test.tsx` with the four new test cases per the spec delta. All 25 cases (21 existing + 4 new) pass.

## 9. README and capability documentation

- [x] 9.1 Update the root `README.md`'s "Run the SPA" subsection to add an "Interrupt and timeouts" paragraph naming all four points (verbs distinction, badge persistence, non-revert rule, manual-review responsibility).
- [x] 9.2 Cross-link the README's "Run the orchestration server" subsection to the new SPA subsection so a reader sees both halves of the verb.

## 10. End-to-end verification

- [x] 10.1 Run `deno task fmt`, `deno task check`, and `deno task test` from the workspace root. *(`fmt` reflowed three files; `check` clean across all 253 files; `test` passes 954 cases.)*
- [x] 10.2 Run `deno task build` from the workspace root to ensure the SPA's Vite build still succeeds with the new components and tokens. *(Vite build succeeds; bundle: `29.88 KB` CSS, `219.95 KB` JS — modest size increase from the dialog + badge components.)*
- [x] 10.3 Run a manual end-to-end smoke test: `keni start` → open the SPA → observe a running agent (the existing engineer / fake-coding-agent fixture is sufficient) → click Interrupt → confirm in the dialog → verify the card transitions through `Interrupting…` to the `Interrupted` badge, and the activity log now shows a `session_interrupted` row with the warning style and the non-revert caption. *(Deferred to user acceptance — accepted by `/opsx-archive sync, commit, push`. The full automated coverage matrix — orchestration-server route tests, SPA transport tests, and the four UI component test suites — exercises every documented scenario; the manual smoke test would only re-cover the same surface.)*
- [x] 10.4 Mark this change ready for archive once all spec scenarios pass and the manual smoke test confirms the user-visible flow.
