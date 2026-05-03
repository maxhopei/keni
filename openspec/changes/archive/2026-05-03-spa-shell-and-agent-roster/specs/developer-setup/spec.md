## MODIFIED Requirements

### Requirement: README documents the contributor onboarding path

The repository root SHALL contain a `README.md` whose first executable section describes, in one short paragraph, how to go from a fresh clone to a green build: the required Deno version, the `deno install` step, and the set of workspace-level tasks (`deno task lint`, `deno task fmt`, `deno task check`, `deno task test`, `deno task build`). The README SHALL also identify the five packages and what each is for, and state the SPA's stack — React + Vite via [`@deno/vite-plugin`](https://jsr.io/@deno/vite-plugin) — together with a "Run the SPA" subsection naming the `cd packages/spa && deno task dev` invocation, the `KENI_SERVER_URL` environment variable that points the dev server's proxy at a running orchestration server (default `http://127.0.0.1:8000`), the `deno task build` invocation that produces a production `dist/` bundle, and a one-line forward reference to step 13 (the `keni start` change) which will host the bundle from the orchestration server.

#### Scenario: README onboarding paragraph is runnable in order

- **WHEN** a contributor reads the README's setup paragraph top to bottom
- **AND** executes the commands it lists, in the order given
- **THEN** the repository reaches the green-build state without any undocumented step

#### Scenario: README lists the five packages

- **WHEN** a contributor reads the README's layout section
- **THEN** it names all five packages (`cli`, `server`, `spa`, `role-runtimes`, `shared`) and gives a one-line description of each

#### Scenario: README records the SPA stack decision

- **WHEN** a contributor reads the README
- **THEN** a sentence notes that the SPA (`packages/spa`) is built with React and Vite via `@deno/vite-plugin`
- **AND** the sentence does NOT defer the wiring to a later change (the wiring exists in this repo state)

#### Scenario: README documents the SPA dev workflow

- **WHEN** a contributor reads the README
- **THEN** a "Run the SPA" subsection documents `cd packages/spa && deno task dev` (Vite dev server), `deno task build` (production bundle to `packages/spa/dist/`), and `deno task preview` (preview the production bundle locally)
- **AND** the subsection names the `KENI_SERVER_URL` environment variable, its default `http://127.0.0.1:8000`, and how to point it at a server bound on a different port (e.g., the printed port from `--port 0`)
- **AND** the subsection cross-links both the `spa-shell` and `spa-agent-roster` capability specs

## ADDED Requirements

### Requirement: The SPA package's `build` task produces a real production bundle

The `@keni/spa` package's `build` task in `packages/spa/deno.json` SHALL invoke Vite (`vite build` via `deno run -A --node-modules-dir npm:vite build`) and SHALL produce a static bundle at `packages/spa/dist/` containing at least an `index.html` and one bundled `.js` chunk. The task SHALL NOT be `echo noop` or any other no-op. The workspace-root `deno task build` SHALL fan out to this task per the existing `developer-setup` requirement and SHALL exit non-zero when the SPA build fails.

#### Scenario: The SPA `build` task is a real Vite build

- **WHEN** the file `packages/spa/deno.json` is read
- **THEN** the `tasks.build` entry invokes Vite (the command string contains `vite build` directly or via the `npm:vite` specifier)
- **AND** the entry is not `echo noop`

#### Scenario: A clean `deno task build` produces a populated `dist/`

- **WHEN** `packages/spa/dist/` is removed and `deno task build` is invoked from the repository root
- **THEN** the workspace-aggregate exit status is 0
- **AND** `packages/spa/dist/index.html` exists after the run
- **AND** `packages/spa/dist/` contains at least one bundled `.js` chunk

#### Scenario: A SPA build failure fails the workspace `build`

- **WHEN** a contributor introduces a TypeScript / bundle error in a SPA source file (e.g., a syntactically invalid `main.tsx`)
- **AND** runs `deno task build` from the repository root
- **THEN** the workspace-aggregate exit status is non-zero
- **AND** the failure output identifies the SPA's `vite build` step

### Requirement: The SPA package contributes more than the placeholder test to `deno task test`

The `@keni/spa` package SHALL contribute its component- and unit-test files (`apiClient_test.ts`, `eventsClient_test.ts`, `AppShell_test.tsx`, `AgentRosterPanel_test.tsx`, `formatRelativeTime_test.ts`, and any peer test files added in this step) to the workspace `deno task test` run. The placeholder test file `packages/spa/src/main_test.ts` from step 01 SHALL be removed (the new tests collectively cover the package's behaviour and the existing `developer-setup` "at least one test" floor remains satisfied). The five-package contract from the existing `developer-setup` requirement SHALL be preserved: every other package (`cli`, `server`, `role-runtimes`, `shared`) is unchanged.

#### Scenario: The placeholder SPA test no longer exists

- **WHEN** the file system is inspected after this change lands
- **THEN** `packages/spa/src/main_test.ts` does not exist
- **AND** `packages/spa/src/main.ts` does not exist (replaced by `packages/spa/src/main.tsx`)

#### Scenario: `deno task test` discovers and runs the new SPA tests

- **WHEN** `deno task test` is invoked from the repository root
- **THEN** the SPA package's contribution to the aggregate `Deno.test` count is at least the documented test files (per the `spa-shell` and `spa-agent-roster` capabilities)
- **AND** removing every SPA test file makes `deno task test` no longer report a test for the `spa` package (the existing five-package contract still holds)

#### Scenario: The other four packages' test contributions are unchanged

- **WHEN** `deno task test` is invoked
- **THEN** the `cli`, `server`, `role-runtimes`, and `shared` packages each contribute at least one `Deno.test` (unchanged from the prior baseline)
