/**
 * Tests for `loadConfig.ts` — the layered global + project + flags loader.
 *
 * Covers the seven scenarios in the `cli-start` capability spec's
 * "Layered configuration" requirement.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { ProjectStateError } from "../init/errors.ts";
import { applyFlagOverrides, type KeniStartConfig, loadKeniConfig } from "./loadConfig.ts";
import type { ParsedStartArgs } from "./args.ts";

interface Fixture {
  readonly projectDir: string;
  readonly homeDir: string;
  readonly cleanup: () => Promise<void>;
}

async function makeFixture(opts: {
  global?: Record<string, unknown>;
  project?: Record<string, unknown>;
}): Promise<Fixture> {
  const projectDir = await Deno.makeTempDir({ prefix: "keni-loadconfig-proj-" });
  const homeDir = await Deno.makeTempDir({ prefix: "keni-loadconfig-home-" });
  // The project YAML MUST exist for the loader; supply at least the
  // canonical fields when the test does not override them.
  const projectYaml: Record<string, unknown> = {
    project_id: "00000000-0000-4000-8000-000000000001",
    name: "test-project",
    ...(opts.project ?? {}),
  };
  await Deno.mkdir(join(projectDir, ".keni"), { recursive: true });
  await Deno.writeTextFile(
    join(projectDir, ".keni", "project.yaml"),
    stringifyYaml(projectYaml),
  );
  if (opts.global !== undefined) {
    await Deno.mkdir(join(homeDir, ".keni"), { recursive: true });
    await Deno.writeTextFile(
      join(homeDir, ".keni", "config.yaml"),
      stringifyYaml(opts.global),
    );
  }
  return {
    projectDir,
    homeDir,
    async cleanup() {
      await Deno.remove(projectDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    },
  };
}

const NO_FLAGS: ParsedStartArgs = {
  projectDir: "/unused",
  positionalAndFlagBoth: false,
};

Deno.test("loadKeniConfig: defaults apply when neither YAML specifies anything", async () => {
  const fx = await makeFixture({});
  try {
    const { startConfig } = await loadKeniConfig({
      projectDir: fx.projectDir,
      homeDir: fx.homeDir,
    });
    assertEquals(startConfig.port_range, { start: 7777, end: 7787 });
    assertEquals(startConfig.host, "127.0.0.1");
    assertEquals(startConfig.shutdown_grace_ms, 2000);
    assertEquals(startConfig.spa, { mode: "bundled" });
  } finally {
    await fx.cleanup();
  }
});

Deno.test("loadKeniConfig: project YAML wins over global YAML on a top-level key", async () => {
  const fx = await makeFixture({
    global: { port_range: { start: 8000, end: 8010 } },
    project: { port_range: { start: 9000, end: 9010 } },
  });
  try {
    const { startConfig } = await loadKeniConfig({
      projectDir: fx.projectDir,
      homeDir: fx.homeDir,
    });
    assertEquals(startConfig.port_range, { start: 9000, end: 9010 });
  } finally {
    await fx.cleanup();
  }
});

Deno.test(
  "loadKeniConfig: global YAML applies when project YAML does not specify the key",
  async () => {
    const fx = await makeFixture({
      global: { host: "0.0.0.0" },
    });
    try {
      const { startConfig } = await loadKeniConfig({
        projectDir: fx.projectDir,
        homeDir: fx.homeDir,
      });
      assertEquals(startConfig.host, "0.0.0.0");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test("loadKeniConfig: missing global YAML is treated as {} (no error)", async () => {
  const fx = await makeFixture({});
  try {
    const { startConfig } = await loadKeniConfig({
      projectDir: fx.projectDir,
      homeDir: fx.homeDir,
    });
    assertEquals(startConfig.host, "127.0.0.1");
  } finally {
    await fx.cleanup();
  }
});

Deno.test("loadKeniConfig: missing project YAML throws ProjectStateError", async () => {
  const projectDir = await Deno.makeTempDir({ prefix: "keni-loadconfig-noproj-" });
  const homeDir = await Deno.makeTempDir({ prefix: "keni-loadconfig-nohome-" });
  try {
    await assertRejects(
      () => loadKeniConfig({ projectDir, homeDir }),
      ProjectStateError,
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

Deno.test("loadKeniConfig: top-level keys are replaced, not deep-merged", async () => {
  // Global says start: 8000, end: 8010.
  // Project says ONLY start: 9000 (no end).
  // Replacement (not merge) means project's invalid spec falls back to defaults.
  const fx = await makeFixture({
    global: { port_range: { start: 8000, end: 8010 } },
    project: { port_range: { start: 9000 } as Record<string, unknown> },
  });
  try {
    const { startConfig } = await loadKeniConfig({
      projectDir: fx.projectDir,
      homeDir: fx.homeDir,
    });
    // Project's port_range is invalid (missing end) so it's treated as
    // "not specified"; the global wins.
    assertEquals(startConfig.port_range, { start: 8000, end: 8010 });
  } finally {
    await fx.cleanup();
  }
});

Deno.test("applyFlagOverrides: --port collapses port_range to a single-port pin", () => {
  const base: KeniStartConfig = {
    port_range: { start: 7777, end: 7787 },
    host: "127.0.0.1",
    shutdown_grace_ms: 2000,
    spa: { mode: "bundled" },
  };
  const out = applyFlagOverrides(base, { ...NO_FLAGS, portPin: 8080 });
  assertEquals(out.port_range, { start: 8080, end: 8080 });
});

Deno.test("applyFlagOverrides: --port-range replaces the merged range", () => {
  const base: KeniStartConfig = {
    port_range: { start: 7777, end: 7787 },
    host: "127.0.0.1",
    shutdown_grace_ms: 2000,
    spa: { mode: "bundled" },
  };
  const out = applyFlagOverrides(base, {
    ...NO_FLAGS,
    portRange: { start: 9000, end: 9005 },
  });
  assertEquals(out.port_range, { start: 9000, end: 9005 });
});

Deno.test("applyFlagOverrides: --host overrides the merged host", () => {
  const base: KeniStartConfig = {
    port_range: { start: 7777, end: 7787 },
    host: "127.0.0.1",
    shutdown_grace_ms: 2000,
    spa: { mode: "bundled" },
  };
  const out = applyFlagOverrides(base, { ...NO_FLAGS, host: "192.168.1.1" });
  assertEquals(out.host, "192.168.1.1");
});

Deno.test("applyFlagOverrides: --spa-dev-url switches spa.mode to 'dev'", () => {
  const base: KeniStartConfig = {
    port_range: { start: 7777, end: 7787 },
    host: "127.0.0.1",
    shutdown_grace_ms: 2000,
    spa: { mode: "bundled" },
  };
  const out = applyFlagOverrides(base, {
    ...NO_FLAGS,
    spaDevUrl: "http://localhost:5173",
  });
  assertEquals(out.spa, { mode: "dev", dev_url: "http://localhost:5173" });
});

Deno.test("applyFlagOverrides: --shutdown-grace-ms overrides the merged value", () => {
  const base: KeniStartConfig = {
    port_range: { start: 7777, end: 7787 },
    host: "127.0.0.1",
    shutdown_grace_ms: 2000,
    spa: { mode: "bundled" },
  };
  const out = applyFlagOverrides(base, { ...NO_FLAGS, shutdownGraceMs: 5000 });
  assertEquals(out.shutdown_grace_ms, 5000);
});
