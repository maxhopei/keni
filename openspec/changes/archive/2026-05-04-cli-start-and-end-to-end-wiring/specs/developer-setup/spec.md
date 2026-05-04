## ADDED Requirements

### Requirement: README documents the `keni start` Quickstart as the first-class user entry point

The repository's root `README.md` SHALL contain, inside the existing top-level "Getting started" section, a new "Quickstart with `keni start`" subsection that is the canonical entry point for a user (not a contributor) running Keni for the first time. The subsection SHALL document, in order: (1) the prerequisite — a `keni init`-produced project (cross-link to the existing "Initialise a Keni project" subsection); (2) the build prerequisite — `deno task build` to produce the SPA bundle (named explicitly because step 13's production-mode SPA serving requires it); (3) the invocation — `deno run -A packages/cli/src/main.ts start [path]` (the prototype's pre-binary form), with a one-line note that a future packaged binary will provide `keni start`; (4) the expected stdout — exactly one line `Keni server running at http://127.0.0.1:<port>` (with the format byte-for-byte stable per the `cli-start` capability); (5) the next step — open the printed URL in a browser to load the SPA; (6) the `.env` seam — `<projectDir>/.env` is overlaid onto `Deno.env` with the calling-shell-wins rule; (7) the layered-config seam — `~/.keni/config.yaml` provides defaults the project's `.keni/project.yaml` overrides per top-level key; (8) the port-range default and override flags (`--port`, `--port-range`); (9) the shutdown contract — first SIGINT/SIGTERM runs the documented graceful sequence, second forces exit `130`; (10) a cross-link to the `cli-start` capability spec for the full contract.

The subsection SHALL appear AFTER the existing "Initialise a Keni project (`keni init`)" subsection and BEFORE the existing "Run the orchestration server" subsection (the existing direct-`deno run` invocation is preserved as a "Direct invocation (development)" subsection — see the next requirement). The subsection SHALL NOT duplicate the orchestration-server spec's trust-model paragraph (it cross-links instead).

#### Scenario: README's "Getting started" section names `keni start` as the entry point

- **WHEN** a contributor reads the README's "Getting started" section top-to-bottom
- **THEN** the section contains a "Quickstart with `keni start`" subsection
- **AND** the subsection appears after "Initialise a Keni project (`keni init`)" and before "Run the orchestration server"
- **AND** the subsection names the `deno task build` prerequisite explicitly

#### Scenario: README documents the expected stdout line byte-for-byte

- **WHEN** a contributor reads the "Quickstart with `keni start`" subsection
- **THEN** the documented stdout line is `Keni server running at http://127.0.0.1:<port>`
- **AND** the format is named as byte-for-byte stable
- **AND** the documented `--port-range` default is `7777..7787`

#### Scenario: README cross-links the `cli-start` capability spec

- **WHEN** a contributor reads the "Quickstart with `keni start`" subsection
- **THEN** a sentence in the subsection links to the `cli-start` capability spec
- **AND** the link target is `./openspec/changes/cli-start-and-end-to-end-wiring/specs/cli-start/spec.md` (during the in-progress phase) or `./openspec/specs/cli-start/spec.md` (after archive — both forms are documented as valid)

#### Scenario: README documents the second-signal exit-130 contract

- **WHEN** a contributor reads the "Quickstart with `keni start`" subsection
- **THEN** the shutdown paragraph names the documented sequence (scheduler stop → interrupt-running → grace → server abort)
- **AND** the paragraph names the second-signal escape hatch and the exit code `130`

### Requirement: README contains a top-level "End-to-end smoke test" runbook section

The README SHALL contain a top-level section titled "End-to-end smoke test" (peer to "Conventions" and "Repository layout") that captures the prototype's exit-criterion runbook (`spec.md` §8). The section SHALL list, in order, the four user-driven steps: (1) `keni init` an empty folder; (2) `keni start`; (3) open the printed URL in a browser; (4) create a ticket via the SPA's "New ticket" form and observe the engineer drive it through `in_progress → ready_for_review → in_review → approved → merged → ready_for_test`. The section SHALL state the expected wall-clock duration (under five minutes on a fresh laptop with the workspace cloned and `deno install` run). The section SHALL cross-link the automated `start_e2e_test` (the file path) and explicitly distinguish the manual runbook (the user's exit criterion) from the automated test (Keni's own regression net per the `cli-start` capability).

The section SHALL include one paragraph naming the prerequisites (Deno installed, `deno install` and `deno task build` already run, an `OPENAI_API_KEY` (or the relevant coding-agent's API key) exported in the shell or written to `<projectDir>/.env`). The section SHALL NOT replace any existing per-package documentation; it SHALL be a runbook on top of the existing Quickstart.

#### Scenario: README contains the "End-to-end smoke test" section

- **WHEN** a contributor reads the README from top to bottom
- **THEN** a top-level section titled "End-to-end smoke test" exists
- **AND** the section is a peer of "Conventions" and "Repository layout" (i.e., a `## ` heading)

#### Scenario: The runbook lists the four documented steps in order

- **WHEN** a contributor reads the "End-to-end smoke test" section
- **THEN** the section lists four steps in this order: `keni init`, `keni start`, open the printed URL, create a ticket via the UI
- **AND** the section names the expected lifecycle progression (`in_progress → ready_for_review → ... → ready_for_test`)
- **AND** the section names the expected wall-clock duration (under five minutes)

#### Scenario: The runbook cross-links the automated smoke test

- **WHEN** a contributor reads the "End-to-end smoke test" section
- **THEN** a sentence in the section links to `packages/cli/src/start/start_e2e_test.ts`
- **AND** the section explicitly distinguishes the manual runbook from the automated test

### Requirement: README's existing "Run the orchestration server" subsection is restructured to demote the direct invocation to "Direct invocation (development)"

The existing "Run the orchestration server" subsection's lead paragraph SHALL be updated to name `keni start` as the user-facing entry point (cross-link to the new "Quickstart with `keni start`" subsection) and SHALL preserve the existing direct-`deno run` invocation under a new "Direct invocation (development)" sub-subsection. The trust-model paragraph (`127.0.0.1` only, no auth, role headers trusted) SHALL be unchanged. The `curl -H "X-Keni-Role: user"` smoke-test snippet SHALL be unchanged. The `/health` endpoint's existence SHALL be added to the "Run the orchestration server" subsection in one sentence (the canonical reference is the `orchestration-server` capability spec's delta).

#### Scenario: "Run the orchestration server" names `keni start` as the user-facing entry point

- **WHEN** a contributor reads the "Run the orchestration server" subsection
- **THEN** the lead paragraph names `keni start` and links to the "Quickstart with `keni start`" subsection
- **AND** the existing direct-`deno run` invocation is preserved under a "Direct invocation (development)" sub-subsection
- **AND** the trust-model paragraph is unchanged byte-for-byte

#### Scenario: `/health` is documented in the orchestration-server subsection

- **WHEN** a contributor reads the "Run the orchestration server" subsection
- **THEN** a sentence names the `GET /health` endpoint and its role-header exemption
- **AND** the sentence cross-links the `orchestration-server` capability spec for the full contract
