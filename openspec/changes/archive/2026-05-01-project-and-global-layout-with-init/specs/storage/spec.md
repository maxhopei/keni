## ADDED Requirements

### Requirement: `ConfigStore` exposes `writeGlobalConfig` for atomic global-layer writes

`ConfigStore` SHALL expose a `writeGlobalConfig(config: GlobalConfig): Promise<void>` method that atomically persists the supplied `GlobalConfig` to the global-layer storage location. The file-backed adapter SHALL write `~/.keni/config.yaml` via the same write-and-rename mechanism documented for `writeProjectConfig` (`writeFileAtomic`), with the temp file created in the same directory as the target so the rename is same-filesystem. The file-backed adapter SHALL lazy-create the parent `~/.keni/` directory if it does not exist. The in-memory adapter SHALL replace its in-memory `GlobalConfig` snapshot with a deep clone of the supplied config so that subsequent mutations of the caller's object cannot leak into the store. Both adapters SHALL behave identically with respect to the contract test: a `writeGlobalConfig(c)` followed by `readGlobalConfig()` SHALL return a config equal in shape and content to `c` (but not the same object reference). The single-writer-per-artifact rule documented for project config in `packages/shared/src/storage/README.md` SHALL extend to the global config; the README SHALL be updated to make this explicit.

#### Scenario: `writeGlobalConfig` followed by `readGlobalConfig` round-trips

- **WHEN** a caller invokes `writeGlobalConfig({ log_level: "debug", coding_agent_cli: "claude" })`
- **AND** subsequently invokes `readGlobalConfig()`
- **THEN** the returned `GlobalConfig` has `log_level === "debug"`
- **AND** has `coding_agent_cli === "claude"`
- **AND** the returned object is not the same reference as the object originally passed to `writeGlobalConfig`

#### Scenario: `writeGlobalConfig({})` produces a readable empty config

- **WHEN** a caller invokes `writeGlobalConfig({})` against a `FileConfigStore` rooted at a temp directory
- **THEN** the file `<temp-home>/.keni/config.yaml` exists after the call
- **AND** the file parses as YAML to an empty mapping
- **AND** a subsequent `readGlobalConfig()` returns `{}` (an empty `GlobalConfig`)

#### Scenario: `writeGlobalConfig` lazy-creates the parent directory

- **WHEN** the directory `<temp-home>/.keni/` does not exist before the call
- **AND** a caller invokes `writeGlobalConfig({})` on a `FileConfigStore` resolved against `<temp-home>`
- **THEN** the directory `<temp-home>/.keni/` exists after the call
- **AND** the file `<temp-home>/.keni/config.yaml` exists after the call
- **AND** the call resolved without throwing

#### Scenario: `writeGlobalConfig` writes atomically using a same-directory temp file

- **WHEN** a `FileConfigStore` writes `<temp-home>/.keni/config.yaml`
- **THEN** the temp file used for the write is created inside `<temp-home>/.keni/`
- **AND** the subsequent rename operates within that directory
- **AND** no `.keni-tmp-*` file remains in `<temp-home>/.keni/` after the call completes successfully

#### Scenario: A pre-rename crash during `writeGlobalConfig` preserves the prior version

- **WHEN** a `FileConfigStore` has previously written `<temp-home>/.keni/config.yaml` with value V1
- **AND** a subsequent `writeGlobalConfig(V2)` is interrupted by an injected pre-rename failure
- **THEN** a follow-up `readGlobalConfig()` returns V1 (the prior version)
- **AND** no `.keni-tmp-*` file remains in `<temp-home>/.keni/`

#### Scenario: In-memory adapter deep-clones on write

- **WHEN** a caller constructs a mutable object `c = { log_level: "info" }`
- **AND** invokes `writeGlobalConfig(c)` on an `InMemoryConfigStore`
- **AND** then mutates the original object: `c.log_level = "warn"`
- **AND** then invokes `readGlobalConfig()`
- **THEN** the returned config has `log_level === "info"` (the value at write time)
- **AND** the in-memory store is unaffected by the post-write mutation
