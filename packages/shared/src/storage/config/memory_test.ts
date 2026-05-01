import { assertEquals } from "@std/assert";
import { type ConfigStoreFixture, runConfigStoreContract } from "./contract_test.ts";
import { InMemoryConfigStore } from "./memory.ts";

runConfigStoreContract("InMemoryConfigStore", () => {
  const store = new InMemoryConfigStore();
  const fixture: ConfigStoreFixture = {
    store,
    writeRawProjectConfig: null,
    writeRawGlobalConfig: null,
    seedGlobalConfig: (global) => store.seedGlobalConfig(global),
  };
  return Promise.resolve(fixture);
});

Deno.test("InMemoryConfigStore — seeded initial values are returned", async () => {
  const store = new InMemoryConfigStore({
    project: {
      project_id: "p",
      name: "n",
    },
    global: { coding_agent_cli: "claude" },
  });
  assertEquals((await store.readProjectConfig()).name, "n");
  assertEquals(await store.readGlobalConfig(), { coding_agent_cli: "claude" });
});

Deno.test("InMemoryConfigStore — writeProjectConfig stores a deep copy (mutating input does not affect the store)", async () => {
  const store = new InMemoryConfigStore();
  const config = {
    project_id: "p",
    name: "n",
    agents: [{ id: "a", role: "engineer" }],
  };
  await store.writeProjectConfig(config);
  config.name = "MUTATED";
  (config.agents[0] as { role: string }).role = "po";
  const reread = await store.readProjectConfig();
  assertEquals(reread.name, "n");
  assertEquals(reread.agents?.[0]?.role, "engineer");
});

Deno.test("InMemoryConfigStore — writeGlobalConfig before any read does not throw and persists", async () => {
  const store = new InMemoryConfigStore();
  await store.writeGlobalConfig({ log_level: "warn" });
  assertEquals(await store.readGlobalConfig(), { log_level: "warn" });
});

Deno.test("InMemoryConfigStore — writeGlobalConfig stores a deep copy (mutating input does not affect the store)", async () => {
  const store = new InMemoryConfigStore();
  const input: { log_level?: "debug" | "info" | "warn" | "error" } = {
    log_level: "info",
  };
  await store.writeGlobalConfig(input);
  input.log_level = "debug";
  const reread = await store.readGlobalConfig();
  assertEquals(reread.log_level, "info");
});
