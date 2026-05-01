import { assertEquals } from "@std/assert";
import { writeFileAtomic } from "../atomic.ts";
import { resolveGlobalPaths, resolveProjectPaths } from "../paths.ts";
import { type ConfigStoreFixture, runConfigStoreContract } from "./contract_test.ts";
import { FileConfigStore } from "./file.ts";

const ACTIVE_TEMP_DIRS = new Set<string>();

async function freshFixture(): Promise<ConfigStoreFixture> {
  const root = await Deno.makeTempDir({ prefix: "keni-config-test-" });
  ACTIVE_TEMP_DIRS.add(root);
  const home = await Deno.makeTempDir({
    prefix: "keni-config-home-",
  });
  ACTIVE_TEMP_DIRS.add(home);
  const projectPaths = resolveProjectPaths(root);
  const globalPaths = resolveGlobalPaths(home);
  const store = new FileConfigStore(projectPaths, globalPaths);
  return {
    store,
    writeRawProjectConfig: (raw) => writeFileAtomic(projectPaths.projectConfig, raw),
    writeRawGlobalConfig: (raw) => writeFileAtomic(globalPaths.globalConfig, raw),
    seedGlobalConfig: null,
  };
}

runConfigStoreContract("FileConfigStore", freshFixture);

Deno.test("FileConfigStore :: cleanup — remove every test temp dir", async () => {
  for (const dir of ACTIVE_TEMP_DIRS) {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort
    }
  }
  ACTIVE_TEMP_DIRS.clear();
});

Deno.test("FileConfigStore — writeProjectConfig produces a YAML-readable file", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-config-format-" });
  try {
    const projectPaths = resolveProjectPaths(root);
    const globalPaths = resolveGlobalPaths(root);
    const store = new FileConfigStore(projectPaths, globalPaths);
    await store.writeProjectConfig({
      project_id: "p-001",
      name: "Test",
      stack: "deno-rest",
    });
    const text = await Deno.readTextFile(projectPaths.projectConfig);
    // YAML output shape — the @std/yaml stringifier emits `key: value` per line
    if (
      !text.includes("project_id: p-001") ||
      !text.includes("name: Test") ||
      !text.includes("stack: deno-rest")
    ) {
      throw new Error(`unexpected YAML output:\n${text}`);
    }
    assertEquals(text.endsWith("\n"), true, "YAML must end with a newline");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
