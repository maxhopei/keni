/**
 * Tests for `loadEnv.ts` — the minimal `.env` parser and overlay.
 *
 * Covers the seven scenarios in the `cli-start` capability spec's
 * "`.env` integration" requirement.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { applyEnvOverlay, inMemoryEnv, loadEnvFile } from "./loadEnv.ts";

interface Fixture {
  readonly projectDir: string;
  readonly cleanup: () => Promise<void>;
}

async function makeFixture(envContents?: string): Promise<Fixture> {
  const projectDir = await Deno.makeTempDir({ prefix: "keni-loadenv-" });
  if (envContents !== undefined) {
    await Deno.writeTextFile(join(projectDir, ".env"), envContents);
  }
  return {
    projectDir,
    async cleanup() {
      await Deno.remove(projectDir, { recursive: true });
    },
  };
}

Deno.test("loadEnvFile: absent .env returns {} (no warn)", async () => {
  const fx = await makeFixture();
  try {
    const warns: string[] = [];
    const parsed = await loadEnvFile({
      projectDir: fx.projectDir,
      logSink: { warn: (m) => warns.push(m) },
    });
    assertEquals(parsed, {});
    assertEquals(warns, []);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("loadEnvFile: parses simple KEY=value lines", async () => {
  const fx = await makeFixture("FOO=bar\nBAZ=qux\n");
  try {
    const parsed = await loadEnvFile({ projectDir: fx.projectDir });
    assertEquals(parsed, { FOO: "bar", BAZ: "qux" });
  } finally {
    await fx.cleanup();
  }
});

Deno.test("loadEnvFile: strips surrounding double quotes", async () => {
  const fx = await makeFixture('GREETING="hello world"\nBARE=plain\n');
  try {
    const parsed = await loadEnvFile({ projectDir: fx.projectDir });
    assertEquals(parsed, { GREETING: "hello world", BARE: "plain" });
  } finally {
    await fx.cleanup();
  }
});

Deno.test("loadEnvFile: ignores blank lines and lines starting with '#'", async () => {
  const fx = await makeFixture("\n# comment\n  # indented comment\nFOO=1\n\nBAR=2\n");
  try {
    const parsed = await loadEnvFile({ projectDir: fx.projectDir });
    assertEquals(parsed, { FOO: "1", BAR: "2" });
  } finally {
    await fx.cleanup();
  }
});

Deno.test("loadEnvFile: malformed lines warn and are skipped", async () => {
  const fx = await makeFixture("FOO=ok\nnotanenvline\nBAR=ok\n123=invalid\n");
  try {
    const warns: string[] = [];
    const parsed = await loadEnvFile({
      projectDir: fx.projectDir,
      logSink: { warn: (m) => warns.push(m) },
    });
    assertEquals(parsed, { FOO: "ok", BAR: "ok" });
    assertEquals(warns.length, 2);
    assert(warns[0]!.includes("malformed"));
    assert(warns[1]!.includes("malformed"));
  } finally {
    await fx.cleanup();
  }
});

Deno.test(
  "loadEnvFile: multiline / interpolation are NOT supported (taken verbatim, warned if malformed)",
  async () => {
    // The literal text `${FOO}` is preserved as-is; the parser does
    // not interpret it. Multiline values are NOT supported either — a
    // line break terminates the value.
    const fx = await makeFixture("TEMPLATE=${FOO}\nFOO=hello\n");
    try {
      const parsed = await loadEnvFile({ projectDir: fx.projectDir });
      assertEquals(parsed.TEMPLATE, "${FOO}");
      assertEquals(parsed.FOO, "hello");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test("applyEnvOverlay: parsed values seed the env when key is absent", () => {
  const env = inMemoryEnv();
  applyEnvOverlay({ FOO: "bar" }, env);
  assertEquals(env.get("FOO"), "bar");
});

Deno.test("applyEnvOverlay: calling shell wins over .env", () => {
  const env = inMemoryEnv({ FOO: "from-shell" });
  applyEnvOverlay({ FOO: "from-env-file" }, env);
  assertEquals(env.get("FOO"), "from-shell");
});

Deno.test("applyEnvOverlay: leaves keys with empty-string shell value alone (also wins)", () => {
  const env = inMemoryEnv({ FOO: "" });
  applyEnvOverlay({ FOO: "fallback" }, env);
  // The shell explicitly set FOO to the empty string; we treat it as
  // "set" (the key exists). The .env fallback does not overwrite.
  assertEquals(env.get("FOO"), "");
});
