# `@keni/runtime-workspace`

Role-agnostic workspace-provisioner interface and the production `GitWorkspaceProvisioner` default.

`WorkspaceProvisioner` is the seam between `@keni/server`'s `runServer` (which holds one shared
provisioner instance and hands it to every role's `wire(input)` via
`WireInput.workspaceProvisioner`) and the per-role wires that decide whether to call
`ensureProvisioned(opts)` at boot. Each role supplies its own `sparseCheckoutPattern` so the same
provisioner can serve engineer (`["/*", "!.keni/"]`), QA, PO, or writer wirings without holding
role-specific compile-time knowledge.

## Public surface

Re-exported from `src/main.ts`:

- **Interfaces.** `WorkspaceProvisioner`, `EnsureProvisionedOpts`, `WorkspaceLogger`,
  `WorkspaceLogLevel`.
- **Errors.** `WorkspaceProvisioningError` (class) plus the `WorkspaceProvisioningErrorCode` and
  `WorkspaceProvisioningErrorDetails` types. The `sparse_pattern_invalid` code rejects an empty or
  malformed pattern at provisioning time.
- **Production default.** `GitWorkspaceProvisioner` (class) with `GitWorkspaceProvisionerOpts`. It
  parks each agent's clone at `<homeDir>/.keni/workspaces/<projectId>/<agentId>/`, applies the
  caller-supplied sparse pattern verbatim, and pins per-workspace local git identity (`<agentId>` /
  `<agentId>@keni.invalid`) without touching the host's `~/.gitconfig`.

The package re-exports zero engineer-specific symbols — the engineer's sparse pattern, runner, and
prompt all live in `@keni/runtime-engineer`.

## Test fakes (`./test-fakes` entry)

Cross-package consumers import the in-memory provisioner from `@keni/runtime-workspace/test-fakes`:

- `FakeWorkspaceProvisioner` — records `ensureProvisioned` / `pullMain` / `discardProvisioned` calls
  (including the supplied `sparseCheckoutPattern`) for assertion. Performs no I/O. Used by the
  engineer's unit / integration tests, the server's `runServer` tests, and the PO stub's end-to-end
  test.

## Authoritative spec

The detailed contract lives in `openspec/specs/runtime-workspace/spec.md`.
