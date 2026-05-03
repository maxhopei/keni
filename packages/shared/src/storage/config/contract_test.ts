/**
 * Shared behavioural contract for {@link ConfigStore}.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { InvalidArtifactError, StoreNotFoundError } from "../errors.ts";
import type { ConfigStore, ProjectConfig } from "./interface.ts";

/**
 * Per-test setup: returns a `ConfigStore` plus optional helpers that lets
 * the test harness corrupt the project config file (file adapter only) or
 * pre-seed the global config. Adapters that cannot perform a particular
 * setup may pass `null` for the helper; the corresponding test is then
 * skipped.
 */
export interface ConfigStoreFixture {
  readonly store: ConfigStore;
  /** Write a raw YAML string at the project config path (file adapter only). */
  readonly writeRawProjectConfig: ((raw: string) => Promise<void>) | null;
  /** Write a raw YAML string at the global config path (file adapter only). */
  readonly writeRawGlobalConfig: ((raw: string) => Promise<void>) | null;
  /** Seed the global config (in-memory adapter only). */
  readonly seedGlobalConfig:
    | ((globalConfig: Partial<{ coding_agent_cli: string }>) => void)
    | null;
}

const SAMPLE_PROJECT: ProjectConfig = {
  project_id: "p-001",
  name: "Test Project",
  stack: "deno-rest",
  agents: [{ id: "alice", role: "engineer" }],
  schedules: { engineer: "*/5 * * * *" },
  timeouts: { engineer: "30m", po: 300000 },
};

export function runConfigStoreContract(
  name: string,
  factory: () => Promise<ConfigStoreFixture>,
): void {
  const test = (label: string, fn: () => Promise<void>) => {
    Deno.test(`${name} :: ${label}`, fn);
  };

  test("readProjectConfig throws StoreNotFoundError when project config is missing", async () => {
    const { store } = await factory();
    await assertRejects(
      () => store.readProjectConfig(),
      StoreNotFoundError,
    );
  });

  test("readGlobalConfig returns an empty object when global config is missing", async () => {
    const { store } = await factory();
    const globalConfig = await store.readGlobalConfig();
    assertEquals(globalConfig, {});
  });

  test("writeProjectConfig + readProjectConfig round-trip preserves every field", async () => {
    const { store } = await factory();
    await store.writeProjectConfig(SAMPLE_PROJECT);
    const read = await store.readProjectConfig();
    assertEquals(read, SAMPLE_PROJECT);
  });

  test("writeProjectConfig replaces the file (last write wins)", async () => {
    const { store } = await factory();
    await store.writeProjectConfig(SAMPLE_PROJECT);
    const updated: ProjectConfig = { ...SAMPLE_PROJECT, name: "Renamed" };
    await store.writeProjectConfig(updated);
    const read = await store.readProjectConfig();
    assertEquals(read.name, "Renamed");
  });

  test("resolve produces a flat shallow-merged view (project overrides global)", async () => {
    const { store, seedGlobalConfig, writeRawGlobalConfig } = await factory();
    await store.writeProjectConfig(SAMPLE_PROJECT);
    if (seedGlobalConfig) {
      seedGlobalConfig({ coding_agent_cli: "claude" });
    } else if (writeRawGlobalConfig) {
      await writeRawGlobalConfig("coding_agent_cli: claude\n");
    } else {
      throw new Error("fixture must provide one of the global-config setters");
    }
    const resolved = await store.resolve();
    // global-only field present
    assertEquals(resolved.coding_agent_cli, "claude");
    // project-only fields present
    assertEquals(resolved.project_id, "p-001");
    assertEquals(resolved.name, SAMPLE_PROJECT.name);
    assertEquals(resolved.stack, SAMPLE_PROJECT.stack);
  });

  test("resolve omits global fields when the global file is absent", async () => {
    const { store } = await factory();
    await store.writeProjectConfig(SAMPLE_PROJECT);
    const resolved = await store.resolve();
    assertEquals(resolved.coding_agent_cli, undefined);
    assertEquals(resolved.project_id, "p-001");
  });

  test("resolve gives project fields precedence on overlap", async () => {
    const { store, seedGlobalConfig, writeRawGlobalConfig } = await factory();
    // both layers provide `name` — project should win
    await store.writeProjectConfig({
      ...SAMPLE_PROJECT,
      name: "from-project",
    });
    if (seedGlobalConfig) {
      // GlobalConfig type does not declare `name`; cast through unknown
      // for the purposes of the merge precedence test
      seedGlobalConfig(
        { name: "from-global" } as unknown as Parameters<
          typeof seedGlobalConfig
        >[0],
      );
    } else if (writeRawGlobalConfig) {
      await writeRawGlobalConfig("name: from-global\n");
    } else {
      throw new Error("fixture must provide one of the global-config setters");
    }
    const resolved = await store.resolve();
    assertEquals(resolved.name, "from-project");
  });

  test("resolve throws StoreNotFoundError when project config is missing", async () => {
    const { store } = await factory();
    await assertRejects(() => store.resolve(), StoreNotFoundError);
  });

  test("readProjectConfig throws InvalidArtifactError on malformed YAML", async () => {
    const { store, writeRawProjectConfig } = await factory();
    if (!writeRawProjectConfig) return; // skip for adapters with no raw setter
    await writeRawProjectConfig("project_id: p-001\nname: 'unclosed");
    const err = await assertRejects(
      () => store.readProjectConfig(),
      InvalidArtifactError,
    );
    assert(err.path !== undefined, "InvalidArtifactError must carry a path");
  });

  test("readGlobalConfig throws InvalidArtifactError on malformed YAML", async () => {
    const { store, writeRawGlobalConfig } = await factory();
    if (!writeRawGlobalConfig) return;
    await writeRawGlobalConfig("coding_agent_cli: 'unclosed");
    const err = await assertRejects(
      () => store.readGlobalConfig(),
      InvalidArtifactError,
    );
    assert(err.path !== undefined);
  });

  test("readProjectConfig rejects an empty / non-mapping YAML body", async () => {
    const { store, writeRawProjectConfig } = await factory();
    if (!writeRawProjectConfig) return;
    await writeRawProjectConfig("- not\n- a\n- mapping\n");
    await assertRejects(
      () => store.readProjectConfig(),
      InvalidArtifactError,
    );
  });

  test("writeProjectConfig persists unknown extra fields (forward compat)", async () => {
    const { store } = await factory();
    const extended = {
      ...SAMPLE_PROJECT,
      future_field: "hello",
    } as unknown as ProjectConfig;
    await store.writeProjectConfig(extended);
    const read = await store.readProjectConfig();
    assertEquals(
      (read as unknown as { future_field: string }).future_field,
      "hello",
    );
  });

  test("writeGlobalConfig + readGlobalConfig round-trips equal-but-not-same-reference", async () => {
    const { store } = await factory();
    const input = { log_level: "debug", coding_agent_cli: "claude" } as const;
    await store.writeGlobalConfig({ ...input });
    const read = await store.readGlobalConfig();
    assertEquals(read, input);
  });

  test("writeGlobalConfig({}) produces a readable empty config", async () => {
    const { store } = await factory();
    await store.writeGlobalConfig({});
    const read = await store.readGlobalConfig();
    assertEquals(read, {});
  });

  test("writeGlobalConfig deep-copies on write (caller mutation does not leak)", async () => {
    const { store } = await factory();
    const input: { log_level?: "debug" | "info" | "warn" | "error" } = {
      log_level: "info",
    };
    await store.writeGlobalConfig(input);
    input.log_level = "warn";
    const read = await store.readGlobalConfig();
    assertEquals(read.log_level, "info");
  });

  test("writeGlobalConfig replaces the previous value (last write wins)", async () => {
    const { store } = await factory();
    await store.writeGlobalConfig({ log_level: "info" });
    await store.writeGlobalConfig({ log_level: "debug" });
    const read = await store.readGlobalConfig();
    assertEquals(read, { log_level: "debug" });
  });

  test("resolve sees the global values written via writeGlobalConfig", async () => {
    const { store } = await factory();
    await store.writeProjectConfig(SAMPLE_PROJECT);
    await store.writeGlobalConfig({ coding_agent_cli: "cursor-agent" });
    const resolved = await store.resolve();
    assertEquals(resolved.coding_agent_cli, "cursor-agent");
    assertEquals(resolved.project_id, "p-001");
  });
}
