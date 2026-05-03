/**
 * `ConfigStore` — interface and types for project- and global-level
 * configuration (`spec.md` §5.1, §5.2).
 *
 * Project config lives at `<root>/.keni/project.yaml` and is committed.
 * Global config lives at `~/.keni/config.yaml` and is per-user. The
 * effective ("resolved") config is a shallow merge with project fields
 * overriding global ones.
 *
 * The field set documented here is the **starting** schema for prototype
 * scope. Later steps (`project-and-global-layout-with-init`,
 * `coding-agent-cli-spec`, etc.) will additively extend each interface;
 * unknown keys round-trip via the YAML parser without loss.
 *
 * @module
 */

/** Per-agent configuration entry (prototype scope). */
export interface AgentConfig {
  readonly id: string;
  readonly role: string;
  /** Optional override for the global `coding_agent_cli`. */
  readonly cli?: string;
}

/**
 * Project-scoped configuration, persisted at `<root>/.keni/project.yaml`.
 *
 * Field set tracks `spec.md` §5.1; later steps extend additively.
 */
export interface ProjectConfig {
  readonly project_id: string;
  readonly name: string;
  /** Free-form stack tag, e.g. `"deno-rest"`, `"node-react"`. */
  readonly stack?: string;
  readonly agents?: readonly AgentConfig[];
  /** Cron-like schedules per agent or role. */
  readonly schedules?: Readonly<Record<string, string>>;
  /**
   * Per-role / per-agent session timeouts consumed by the scheduler
   * (`step 08 — cron-scheduler-with-pause`). Key is an agent id or a role;
   * value is a duration shorthand (`"5s"`, `"30m"`, `"1h"`) or a positive
   * integer interpreted as milliseconds. Resolution order is
   * `timeouts[agentId] ?? timeouts[role] ?? defaultForRole(role)`. The
   * `scheduler` capability spec governs the parsing rules and per-role
   * defaults; the storage layer round-trips the field verbatim.
   */
  readonly timeouts?: Readonly<Record<string, string | number>>;
}

/**
 * Per-user global configuration, persisted at `~/.keni/config.yaml`.
 *
 * Field set tracks `spec.md` §5.2; later steps extend additively.
 */
export interface GlobalConfig {
  /** Default coding-agent CLI binary, e.g. `"claude"`, `"cursor-agent"`. */
  readonly coding_agent_cli?: string;
  /** Two-element `[start, end]` inclusive port range for engineer dev servers. */
  readonly default_port_range?: readonly [number, number];
  readonly log_level?: "debug" | "info" | "warn" | "error";
}

/**
 * The effective config seen by a single Keni process: shallow merge of
 * global + project, with project fields overriding global fields when both
 * are set. Field set is the union of `ProjectConfig` and `GlobalConfig`,
 * with every field optional because either layer may omit it.
 *
 * Callers that want to inspect a single layer in isolation should use
 * {@link ConfigStore.readProjectConfig} / {@link ConfigStore.readGlobalConfig}
 * directly.
 */
export interface ResolvedConfig extends Partial<GlobalConfig>, Partial<ProjectConfig> {}

/**
 * Storage interface for configuration.
 *
 * **Atomicity:** both `writeProjectConfig` and `writeGlobalConfig` are atomic
 * via `writeFileAtomic` (write-to-sibling-tempfile then `rename()`). A
 * concurrent reader observes either the pre-write or the post-write state,
 * never a partial write.
 *
 * **Single-writer-per-artifact:** the file-backed adapter does not lock
 * concurrent writers to the same config file from different processes;
 * higher layers (the `keni init` CLI is structurally a single writer; future
 * config-edit flows are expected to serialise) own that responsibility. See
 * `packages/shared/src/storage/README.md`.
 *
 * **Defaults:** `readGlobalConfig` returns `{}` when the file does not
 * exist; the schema is fully optional, so `{}` is a valid `GlobalConfig`.
 * `readProjectConfig` throws {@link StoreNotFoundError} when the file does
 * not exist (project config is mandatory once a project is initialised).
 */
export interface ConfigStore {
  /**
   * Read the project config from `.keni/project.yaml`.
   *
   * @throws {StoreNotFoundError} if the file does not exist.
   * @throws {InvalidArtifactError} if the file is malformed.
   */
  readProjectConfig(): Promise<ProjectConfig>;

  /**
   * Read the global config from `~/.keni/config.yaml`. Returns `{}` if the
   * file does not exist (callers that need explicit defaults can layer them
   * on top).
   *
   * @throws {InvalidArtifactError} if the file exists but is malformed.
   */
  readGlobalConfig(): Promise<GlobalConfig>;

  /**
   * Read both configs and return their shallow merge: project fields
   * override global fields field-by-field. Per `spec.md` §5.2, this is the
   * effective view a Keni process operates against.
   *
   * @throws {StoreNotFoundError} if the project config is missing.
   * @throws {InvalidArtifactError} if either file is malformed.
   */
  resolve(): Promise<ResolvedConfig>;

  /**
   * Atomically write the project config. Replaces the on-disk file. The
   * file-backed adapter writes via `writeFileAtomic` (rename-based);
   * partial-write states are not observable.
   */
  writeProjectConfig(config: ProjectConfig): Promise<void>;

  /**
   * Atomically write the global config to `~/.keni/config.yaml`. Replaces
   * the on-disk file. The file-backed adapter lazy-creates the parent
   * `~/.keni/` directory on first write, then performs a `writeFileAtomic`
   * with a same-directory temp file so the rename is same-filesystem.
   *
   * Used by `keni init` to bootstrap the global directory on first use
   * (`spec.md` §7.1) and by future user-level config-edit flows.
   *
   * Subject to the single-writer-per-artifact contract documented above.
   */
  writeGlobalConfig(config: GlobalConfig): Promise<void>;
}
