import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname } from "@std/path";
import { __setPreRenameHook, writeFileAtomic } from "../../../../src/storage/atomic.ts";
import { resolveGlobalPaths, resolveProjectPaths } from "../../../../src/storage/paths.ts";
import {
  type ConfigStoreFixture,
  runConfigStoreContract,
} from "../../../contracts/storage/config/configStoreContract.ts";
import { FileConfigStore } from "../../../../src/storage/config/file.ts";

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

Deno.test("FileConfigStore — writeGlobalConfig lazy-creates `<home>/.keni/`", async () => {
  const home = await Deno.makeTempDir({ prefix: "keni-config-global-mkdir-" });
  try {
    const root = await Deno.makeTempDir({ prefix: "keni-config-root-" });
    try {
      const projectPaths = resolveProjectPaths(root);
      const globalPaths = resolveGlobalPaths(home);
      // Confirm the parent dir does not exist yet.
      await assertRejects(() => Deno.stat(globalPaths.keni), Deno.errors.NotFound);
      const store = new FileConfigStore(projectPaths, globalPaths);
      await store.writeGlobalConfig({ log_level: "info" });
      const parentStat = await Deno.stat(globalPaths.keni);
      assert(parentStat.isDirectory, "<home>/.keni/ must exist after writeGlobalConfig");
      const fileStat = await Deno.stat(globalPaths.globalConfig);
      assert(fileStat.isFile, "global config file must exist after writeGlobalConfig");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("FileConfigStore — writeGlobalConfig uses a same-directory temp file", async () => {
  const home = await Deno.makeTempDir({ prefix: "keni-config-global-tmp-" });
  try {
    const root = await Deno.makeTempDir({ prefix: "keni-config-root-" });
    try {
      const projectPaths = resolveProjectPaths(root);
      const globalPaths = resolveGlobalPaths(home);
      const store = new FileConfigStore(projectPaths, globalPaths);
      // Pre-seed the directory so we can list it.
      await Deno.mkdir(dirname(globalPaths.globalConfig), { recursive: true });

      let observedTempDir: string | undefined;
      __setPreRenameHook(async () => {
        for await (const entry of Deno.readDir(globalPaths.keni)) {
          if (entry.name.startsWith(".keni-tmp-")) {
            observedTempDir = globalPaths.keni;
            break;
          }
        }
        throw new Error("abort for observation");
      });
      try {
        await assertRejects(() => store.writeGlobalConfig({}), Error);
      } finally {
        __setPreRenameHook(undefined);
      }
      assertEquals(
        observedTempDir,
        globalPaths.keni,
        "temp file must be in `<home>/.keni/`, not /tmp",
      );
      // Confirm temp residue cleaned up.
      const residue: string[] = [];
      for await (const entry of Deno.readDir(globalPaths.keni)) {
        if (entry.name.startsWith(".keni-tmp-")) residue.push(entry.name);
      }
      assertEquals(residue, [], "no temp residue must remain after the failed write");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("FileConfigStore — pre-rename crash during writeGlobalConfig preserves prior version", async () => {
  const home = await Deno.makeTempDir({ prefix: "keni-config-global-crash-" });
  try {
    const root = await Deno.makeTempDir({ prefix: "keni-config-root-" });
    try {
      const projectPaths = resolveProjectPaths(root);
      const globalPaths = resolveGlobalPaths(home);
      const store = new FileConfigStore(projectPaths, globalPaths);
      await store.writeGlobalConfig({ log_level: "info" });
      const before = await Deno.readTextFile(globalPaths.globalConfig);

      __setPreRenameHook(() => {
        throw new Error("simulated mid-write crash");
      });
      try {
        await assertRejects(
          () => store.writeGlobalConfig({ log_level: "debug" }),
          Error,
          "simulated mid-write crash",
        );
      } finally {
        __setPreRenameHook(undefined);
      }
      const after = await Deno.readTextFile(globalPaths.globalConfig);
      assertEquals(after, before, "global config must be byte-identical");
      const reread = await store.readGlobalConfig();
      assertEquals(reread.log_level, "info");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("FileConfigStore — writeGlobalConfig idempotent overwrite leaves no residue", async () => {
  const home = await Deno.makeTempDir({ prefix: "keni-config-global-idem-" });
  try {
    const root = await Deno.makeTempDir({ prefix: "keni-config-root-" });
    try {
      const projectPaths = resolveProjectPaths(root);
      const globalPaths = resolveGlobalPaths(home);
      const store = new FileConfigStore(projectPaths, globalPaths);
      await store.writeGlobalConfig({ log_level: "info" });
      const first = await Deno.readTextFile(globalPaths.globalConfig);
      await store.writeGlobalConfig({ log_level: "info" });
      const second = await Deno.readTextFile(globalPaths.globalConfig);
      assertEquals(first, second, "two identical writes must produce identical files");
      const residue: string[] = [];
      for await (const entry of Deno.readDir(globalPaths.keni)) {
        if (entry.name.startsWith(".keni-tmp-")) residue.push(entry.name);
      }
      assertEquals(residue, [], "no temp residue must remain after a successful write");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
