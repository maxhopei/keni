## ADDED Requirements

### Requirement: The engineer prompt is a TypeScript string constant exported from `packages/role-runtimes/src/engineer/prompts/engineer.ts`

The package SHALL export, from `packages/role-runtimes/src/engineer/prompts/engineer.ts`, two constants: `export const ENGINEER_PROMPT_NAME = "engineer" as const` and `export const ENGINEER_PROMPT_BODY: string`. Both SHALL be re-exported from `packages/role-runtimes/src/main.ts` so downstream consumers and `/opsx:verify` test fixtures can import them via `import { ENGINEER_PROMPT_BODY, ENGINEER_PROMPT_NAME } from "@keni/role-runtimes"`. The body SHALL be a single literal (no template interpolation, no concatenation from environment variables, no runtime assembly) so the value at module load time is identical across every server invocation. The body SHALL be at least 500 characters and at most 8 KB (a soft ceiling that keeps the prompt comfortably under typical coding-agent context budgets and rejects accidental empty or unbounded growth).

#### Scenario: Both constants are importable from `@keni/role-runtimes`

- **WHEN** a consumer writes `import { ENGINEER_PROMPT_NAME, ENGINEER_PROMPT_BODY } from "@keni/role-runtimes"`
- **THEN** both names resolve without error
- **AND** `ENGINEER_PROMPT_NAME` is the string literal `"engineer"`
- **AND** `ENGINEER_PROMPT_BODY` is a non-empty string

#### Scenario: The body is a single string literal, not a template

- **WHEN** the source file `packages/role-runtimes/src/engineer/prompts/engineer.ts` is inspected
- **THEN** `ENGINEER_PROMPT_BODY` is declared as a `const` initialised with a string literal (template literal allowed *only* if it contains no `${...}` interpolations)
- **AND** no `Deno.env.get(...)` call appears in the file
- **AND** no `Deno.readTextFile` or `Deno.readFile` call appears in the file
- **AND** no `import.meta.resolve` call appears in the file

#### Scenario: The body length is within the documented bounds

- **WHEN** `ENGINEER_PROMPT_BODY.length` is read at module load time
- **THEN** the value is greater than or equal to 500
- **AND** the value is less than or equal to 8192 (8 KB)

### Requirement: The engineer prompt body contains the eight numbered sections documented in design.md Decision 9

`ENGINEER_PROMPT_BODY` SHALL contain, in order, eight discoverable section headings recognisable to both humans and string-matching tests. Each section heading SHALL be a single line beginning with `## ` followed by an integer index (1 through 8) and a section title. The section titles and order SHALL be exactly:

1. `## 1. Identity`
2. `## 2. Workspace`
3. `## 3. MCP tools`
4. `## 4. The loop`
5. `## 5. Self-review`
6. `## 6. Integration tests`
7. `## 7. Summary line`
8. `## 8. Refusals`

A `/opsx:verify` test SHALL parse the body, locate each heading, and assert the documented order. Editorial freedom inside each section is preserved (the prompt content is expected to evolve per `spec.md` §10's prompt-customisation note); the section structure is the stable contract this capability spec pins.

#### Scenario: All eight section headings are present in the body, in order

- **WHEN** the body is split on `\n` into lines
- **AND** lines beginning with `## ` followed by an integer-and-period are extracted in arrival order
- **THEN** the extracted sequence is exactly `["## 1. Identity", "## 2. Workspace", "## 3. MCP tools", "## 4. The loop", "## 5. Self-review", "## 6. Integration tests", "## 7. Summary line", "## 8. Refusals"]`

#### Scenario: A missing or reordered section fails the structural test

- **WHEN** an instrumented test moves the `## 7. Summary line` heading above `## 6. Integration tests` (only) and re-runs the structural check
- **THEN** the test fails
- **AND** the failure message names the offending section and its actual position

### Requirement: Section 1 (Identity) names the role, the agent-id env var, and the `keni init`-set git identity

The body's `## 1. Identity` section SHALL contain text that: (a) names the role as `"engineer"` (so the agent self-identifies on the first line of every reply); (b) names the env var `KENI_MCP_AGENT` as the source of the agent's id (e.g., `alice`); (c) names the env var `KENI_MCP_SERVER_URL` as the orchestration-server URL the agent's MCP tools are configured against; (d) reminds the agent that all commits made inside the workspace are attributed to `<agentId> <<agentId>@keni.invalid>` via the workspace's per-clone git identity, so the agent SHOULD NOT manually `git config user.name` or `git config user.email` from inside the workspace.

#### Scenario: Section 1 names the role and identity env vars

- **WHEN** the body's `## 1. Identity` section content (text between this heading and the next `## ` heading) is extracted
- **THEN** the content contains the literal string `"engineer"`
- **AND** the content contains the literal string `"KENI_MCP_AGENT"`
- **AND** the content contains the literal string `"KENI_MCP_SERVER_URL"`

#### Scenario: Section 1 reminds the agent not to override git identity

- **WHEN** the body's `## 1. Identity` section content is extracted
- **THEN** the content contains both `git config` and `user.name` (or `user.email`) within the same paragraph, accompanied by a refusal verb (`do not`, `must not`, or `never`)

### Requirement: Section 2 (Workspace) documents the `KENI_MCP_WORKSPACE` env var and the `.keni/`-invisible invariant

The body's `## 2. Workspace` section SHALL contain text that: (a) names the env var `KENI_MCP_WORKSPACE` as the absolute path of the engineer's workspace directory; (b) tells the agent every git, build, and test command runs from inside this directory; (c) explicitly states that `.keni/` is **not** present in the workspace (the sparse checkout excludes it) and that the agent SHOULD NOT attempt to read or write any `.keni/`-prefixed path; (d) names the MCP `get_workspace_path` tool as the canonical way to query the path at runtime (the env var is the same value, surfaced two ways for redundancy).

#### Scenario: Section 2 names the workspace env var and the `.keni/` invariant

- **WHEN** the body's `## 2. Workspace` section content is extracted
- **THEN** the content contains the literal string `"KENI_MCP_WORKSPACE"`
- **AND** the content contains the literal string `".keni/"`
- **AND** the content contains the literal string `"get_workspace_path"`

#### Scenario: Section 2 prohibits `.keni/` writes

- **WHEN** the body's `## 2. Workspace` section content is extracted
- **THEN** the content contains a refusal verb (`do not`, `must not`, or `never`) within the same paragraph as `.keni/`

### Requirement: Section 3 (MCP tools) lists every engineer MCP tool by name with a one-line role

The body's `## 3. MCP tools` section SHALL list each engineer-facing MCP tool by name, exactly once per tool, with a one-line description naming when to use it. The required tool names (drawn from the `mcp-engineer-surface` capability plus the new `merge_pr` tool added by this change) SHALL be: `list_tickets`, `read_ticket`, `update_ticket_body`, `transition_ticket_status`, `append_activity_entry`, `query_activity`, `get_workspace_path`, `merge_pr`. The section SHALL NOT include any tool that is not part of the engineer's MCP surface (e.g., no `update_pr_status` if the change has not added it; no PO-only tools). The section SHALL NOT teach REST-via-`fetch` paths for actions covered by an MCP tool (the prompt's preference is "MCP first, REST only when no MCP tool exists"), with the documented exceptions of `POST /prs` (PR record creation) and `POST /prs/:id/transition` (PR record state transitions) — both deferred to the prompt body explicitly because the change does not add MCP tools for them.

#### Scenario: Section 3 lists exactly the eight engineer tool names

- **WHEN** the body's `## 3. MCP tools` section content is extracted
- **AND** every backticked or whitespace-bounded identifier matching `/[a-z_]+(?=\b)/` is collected as the section's tool-name set
- **THEN** the set contains exactly `{"list_tickets", "read_ticket", "update_ticket_body", "transition_ticket_status", "append_activity_entry", "query_activity", "get_workspace_path", "merge_pr"}`
- **AND** no PO-only tool names (e.g., `propose_change`, `chat_send`) appear

#### Scenario: Section 3 documents the REST exception for PR creation and transition

- **WHEN** the body's `## 3. MCP tools` section content is extracted
- **THEN** the content contains a paragraph that names `POST /prs` (PR creation) and `POST /prs/:id/transition` (PR state transitions) as the only REST endpoints the agent is expected to call directly via `fetch`, citing `KENI_MCP_SERVER_URL` and the role/agent headers (`X-Keni-Role: engineer`, `X-Keni-Agent: <agentId>`)

### Requirement: Section 4 (The loop) teaches the per-cycle playbook from `spec.md` §3 (Engineer) and §4.1

The body's `## 4. The loop` section SHALL teach the engineer's per-cycle playbook as a numbered list of at least seven steps. The steps SHALL include, in order:

1. **Pick a ticket.** "Call `list_tickets` to find a ticket assigned to you in `in_progress` / `ready_for_review` / `in_review` / `has_comments` / `approved` / `merged`. If none, call `list_tickets` with `assignee: null` and `status: ["open", "test_failed", "has_comments"]` and pick the highest-priority one."
2. **Self-assign and start.** "Use `update_ticket_body` to set `assignee` … (wait — `update_ticket_body` cannot change header fields; the prompt teaches the agent to update header via `PATCH /tickets/:id` REST or to wait for a future `update_ticket_header` tool — see Section 8 for the refusal). For `open` tickets, transition `open → in_progress` via `transition_ticket_status`."
3. **Plan + code.** "Write a brief plan in the ticket body via `update_ticket_body`. Implement the change in your workspace. Use `git checkout -b ticket-NNNN` (the convention) before committing."
4. **Run integration tests.** "Run `docker-compose -f $(git rev-parse --show-toplevel)/docker-compose.yml run --rm tests` from inside your workspace. See Section 6 for the contract."
5. **Push and submit PR.** "Push your branch with `git push origin ticket-NNNN`. Create the PR record via `POST /prs` (REST — see Section 3) with body `{ title, ticket: <ticket id>, branch: <branch>, author: <agent id> }`. Transition `in_progress → ready_for_review` via `transition_ticket_status`."
6. **Yield to next cycle for self-review.** "Emit your summary line and exit. Your *next* cycle (a fresh subprocess) picks the same ticket up in `ready_for_review` and reviews it. See Section 5."
7. **Self-review (next cycle).** "If the ticket is in `ready_for_review` and assigned to you, transition `ready_for_review → in_review`, read the PR diff, run the integration tests, and either: (a) approve — transition `in_review → approved`, call `merge_pr` with the PR id, transition `approved → merged`, transition `merged → ready_for_test`, emit summary, exit; or (b) request changes — write a critique in the ticket body via `update_ticket_body`, transition `in_review → has_comments`, emit summary, exit."
8. **Address comments (subsequent cycle).** "If the ticket is in `has_comments` and assigned to you, transition `has_comments → in_progress`, address the comments, and resume from step 3."

The text in this section SHALL emphasise the "one ticket per session" rule from `spec.md` §11#7 — the agent SHALL handle exactly one ticket per cycle and SHALL NOT pick up a second ticket within the same cycle even if the first finishes early.

#### Scenario: Section 4 contains at least seven numbered steps in the documented order

- **WHEN** the body's `## 4. The loop` section content is extracted
- **AND** lines starting with an integer-and-period are extracted as the playbook steps
- **THEN** the count is at least 7
- **AND** the first step contains both `list_tickets` and a reference to the in-flight or pickup queue
- **AND** a step contains the literal string `transition_ticket_status` and the literal string `open`-to-`in_progress` (or equivalent transition naming)
- **AND** a step contains the literal string `merge_pr`
- **AND** a step contains both the literal string `merged` and the literal string `ready_for_test` together (the post-merge transition)

#### Scenario: Section 4 names the "one ticket per session" invariant

- **WHEN** the body's `## 4. The loop` section content is extracted
- **THEN** the content contains a phrase explicitly naming "one ticket per session" or "one ticket per cycle" (case-insensitive)

### Requirement: Section 5 (Self-review) names the fresh-session contract from `spec.md` §11#4

The body's `## 5. Self-review` section SHALL contain text that: (a) names the fresh-session rule explicitly — "self-review happens in a *new* subprocess on a later cycle, not within the same cycle as the implementation"; (b) reminds the agent that it cannot tell from inside its current cycle whether the previous cycle was its own implementation or someone else's review (the only signal is the ticket's current status); (c) directs the agent to use the PR diff (`git diff main...ticket-NNNN` from inside the workspace) plus the ticket body's plan section as the review surface.

#### Scenario: Section 5 names the fresh-session rule

- **WHEN** the body's `## 5. Self-review` section content is extracted
- **THEN** the content contains the literal phrase `"fresh session"` (case-insensitive) or the literal phrase `"new subprocess"` (case-insensitive)
- **AND** the content names the ticket's status field as the cross-cycle signal

### Requirement: Section 6 (Integration tests) documents the docker-compose contract from design.md Decision 10

The body's `## 6. Integration tests` section SHALL contain text that: (a) names `<project>/docker-compose.yml` as the project-level integration-test entry point, with a `tests` service whose `command` runs the suite; (b) gives the canonical invocation `docker-compose -f $(git rev-parse --show-toplevel)/docker-compose.yml run --rm tests` (the `$(git rev-parse …)` resolves the workspace root from inside any subdirectory); (c) tells the agent to write the `docker-compose.yml` itself if it does not yet exist (consistent with "the engineer is the one who decides how to test"), as part of the first ticket that needs integration tests; (d) reminds the agent that stdout / stderr from this command is captured by the role runtime as activity-log entries (so verbose output is fine, but a noisy command will fill the log).

#### Scenario: Section 6 names the docker-compose contract

- **WHEN** the body's `## 6. Integration tests` section content is extracted
- **THEN** the content contains the literal string `"docker-compose"`
- **AND** the content contains the literal string `"docker-compose.yml"`
- **AND** the content contains the literal string `"run --rm tests"` (or a near-equivalent flag combination, allowing for prompt evolution: an `/opsx:verify` test asserts the substring `"--rm"` and the substring `"tests"` are both present in the same paragraph)

### Requirement: Section 7 (Summary line) names the `spec.md` §6.3 single-line summary contract

The body's `## 7. Summary line` section SHALL contain text that: (a) names the rule "your final stdout line is captured verbatim as the cycle's summary"; (b) gives a soft length cap (the prompt SHOULD recommend ≤ 200 characters; the role-runtime cycle's hard truncation cap is 3 KB per the role-runtime spec, but a 200-character recommendation keeps the SPA readable); (c) gives at least two example summary lines that name the ticket id and the action taken (e.g., `"ticket-0001 in_progress: implemented login form"` and `"ticket-0001 ready_for_test: merged PR-3"`); (d) reminds the agent that the summary line SHALL be the *last* non-empty stdout line it emits (per the role-runtime cycle's `extractSummaryLine` rule).

#### Scenario: Section 7 names the summary-line contract

- **WHEN** the body's `## 7. Summary line` section content is extracted
- **THEN** the content contains the literal phrase `"final stdout line"` (case-insensitive) or the literal phrase `"last non-empty"` (case-insensitive)
- **AND** the content contains at least two backticked or quoted example summary lines, each containing both `"ticket-"` and a status name

### Requirement: Section 8 (Refusals) enumerates the engineer's hard "do not" list

The body's `## 8. Refusals` section SHALL contain a bulleted or numbered list of refusals. The list SHALL include, at minimum:

- "Never write to `.keni/` (you cannot see it; the sparse checkout excludes it)."
- "Never run `git push origin main` directly from your workspace; use the `merge_pr` MCP tool."
- "Never call `transition_ticket_status` for a status outside the engineer's owning roles (`in_progress`, `ready_for_review`, `in_review`, `has_comments`, `approved`, `merged`, `ready_for_test`)."
- "Never modify the host's `~/.gitconfig` or any system-level git config from inside your workspace."
- "Never spawn a long-running process you don't await (no `&`-suffixed shell commands; the orchestration server's session timeout will kill orphans, but they pollute the activity log)."

#### Scenario: Section 8 names every documented refusal

- **WHEN** the body's `## 8. Refusals` section content is extracted
- **THEN** the content contains the literal string `".keni/"` paired with a refusal verb
- **AND** the content contains the literal string `"git push"` paired with `"main"` and a refusal verb
- **AND** the content contains the literal string `"transition_ticket_status"` paired with the engineer-owned-status enumeration (or a clear reference to it)
- **AND** the content contains the literal string `"~/.gitconfig"` paired with a refusal verb

### Requirement: A `/opsx:verify` test fixture pins the prompt's structural contract

`packages/role-runtimes/src/engineer/prompts/engineer_test.ts` SHALL load `ENGINEER_PROMPT_BODY` and run the structural assertions documented above (eight sections in order, each section's required substrings present, length within bounds, no template interpolation). The test SHALL be the source of truth for "what changes to the prompt break the contract" — a future prompt edit that touches wording but preserves structure SHALL pass; an edit that drops a section or removes a required substring SHALL fail with a clear message naming the offending section and the missing substring. The test SHALL NOT lock the *exact* wording of any section beyond the documented required substrings (per `spec.md` §10's prompt-customisation note).

#### Scenario: The structural test passes against the v1 body

- **WHEN** `deno test packages/role-runtimes/src/engineer/prompts/engineer_test.ts` is run against the v1 prompt body shipped with this change
- **THEN** every assertion passes
- **AND** the test exits with code 0

#### Scenario: The structural test fails when a section is dropped

- **WHEN** an instrumented variant of the prompt body removes the `## 6. Integration tests` heading and the section's content is concatenated into Section 5's body
- **AND** the structural test runs against the variant
- **THEN** the test fails
- **AND** the failure message names section 6 and the missing heading

#### Scenario: The structural test fails when a required substring is removed

- **WHEN** an instrumented variant of the prompt body removes every occurrence of `"docker-compose"` from Section 6
- **AND** the structural test runs against the variant
- **THEN** the test fails
- **AND** the failure message names Section 6 and the missing `docker-compose` substring

### Requirement: The bundled prompt is the only engineer prompt — no path-based loader, no per-project override in the prototype

The prototype SHALL ship exactly one engineer prompt: `ENGINEER_PROMPT_BODY` from `packages/role-runtimes/src/engineer/prompts/engineer.ts`. The change SHALL NOT introduce any path-based prompt loader for the engineer (no `loadEngineerPromptFromFile`, no env var that points at an alternative prompt body), and SHALL NOT introduce any per-project override (no `engineer_prompt` field in `project.yaml` reserved for a future feature). Future per-project prompt customisation lands in a later step (a follow-up to `spec.md` §10's customisation note); this capability spec is the gate that future change must amend.

#### Scenario: No path-based engineer-prompt loader exists in production source

- **WHEN** the source files under `packages/role-runtimes/src/engineer/prompts/` (excluding `*_test.ts`) are scanned for `Deno.readTextFile`, `Deno.readFile`, `import.meta.resolve`, or any path literal beginning with `.keni/` or `~/.keni/`
- **THEN** no occurrence is found

#### Scenario: `project.yaml` has no `engineer_prompt` field

- **WHEN** the `ProjectConfig` type in `@keni/shared/storage/config/interface.ts` is inspected
- **THEN** no `engineer_prompt` (or similarly-named) field is declared
