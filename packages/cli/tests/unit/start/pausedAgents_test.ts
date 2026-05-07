/**
 * Tests for `pausedAgents.ts` — the `state.json` reader and persister.
 *
 * Covers the six scenarios in the `cli-start` capability spec's
 * "`paused_agents` boot handling" requirement.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { AgentConfig } from "@keni/shared";
import {
  persistPausedAgents,
  readPausedAgents,
  stateJsonPath,
} from "../../../src/start/pausedAgents.ts";

const ROSTER: readonly AgentConfig[] = [
  { id: "alice", role: "engineer" },
  { id: "qa-bob", role: "qa" },
];

interface Fixture {
  readonly projectDir: string;
  readonly cleanup: () => Promise<void>;
}

async function makeFixture(opts: { state?: unknown }): Promise<Fixture> {
  const projectDir = await Deno.makeTempDir({ prefix: "keni-paused-agents-" });
  await Deno.mkdir(join(projectDir, ".keni"), { recursive: true });
  if (opts.state !== undefined) {
    await Deno.writeTextFile(
      stateJsonPath(projectDir),
      typeof opts.state === "string" ? opts.state : JSON.stringify(opts.state),
    );
  }
  return {
    projectDir,
    async cleanup() {
      await Deno.remove(projectDir, { recursive: true });
    },
  };
}

Deno.test("readPausedAgents: file absent returns [] (no warn)", async () => {
  const fx = await makeFixture({});
  try {
    const warns: string[] = [];
    const out = await readPausedAgents({
      projectDir: fx.projectDir,
      roster: ROSTER,
      logSink: { warn: (m) => warns.push(m) },
    });
    assertEquals(out, []);
    assertEquals(warns, []);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("readPausedAgents: paused_agents key missing returns []", async () => {
  const fx = await makeFixture({ state: {} });
  try {
    const out = await readPausedAgents({
      projectDir: fx.projectDir,
      roster: ROSTER,
    });
    assertEquals(out, []);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("readPausedAgents: returns roster ids that appear in paused_agents", async () => {
  const fx = await makeFixture({ state: { paused_agents: ["alice"] } });
  try {
    const out = await readPausedAgents({
      projectDir: fx.projectDir,
      roster: ROSTER,
    });
    assertEquals(out, ["alice"]);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("readPausedAgents: drops unknown ids with one warn each", async () => {
  const fx = await makeFixture({
    state: { paused_agents: ["alice", "ghost", "qa-bob", "phantom"] },
  });
  try {
    const warns: string[] = [];
    const out = await readPausedAgents({
      projectDir: fx.projectDir,
      roster: ROSTER,
      logSink: { warn: (m) => warns.push(m) },
    });
    assertEquals(out, ["alice", "qa-bob"]);
    assertEquals(warns.length, 2);
    assert(warns.some((w) => w.includes("ghost")));
    assert(warns.some((w) => w.includes("phantom")));
  } finally {
    await fx.cleanup();
  }
});

Deno.test("readPausedAgents: malformed JSON returns [] with a warn", async () => {
  const fx = await makeFixture({ state: "{not json" });
  try {
    const warns: string[] = [];
    const out = await readPausedAgents({
      projectDir: fx.projectDir,
      roster: ROSTER,
      logSink: { warn: (m) => warns.push(m) },
    });
    assertEquals(out, []);
    assert(warns.length >= 1);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("readPausedAgents: paused_agents not an array returns [] with a warn", async () => {
  const fx = await makeFixture({ state: { paused_agents: "alice" } });
  try {
    const warns: string[] = [];
    const out = await readPausedAgents({
      projectDir: fx.projectDir,
      roster: ROSTER,
      logSink: { warn: (m) => warns.push(m) },
    });
    assertEquals(out, []);
    assert(warns.length >= 1);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("persistPausedAgents: writes the array preserving other top-level keys", async () => {
  const fx = await makeFixture({
    state: { project_id: "abc", paused_agents: [], other_key: "preserved" },
  });
  try {
    await persistPausedAgents({
      projectDir: fx.projectDir,
      paused: ["alice"],
    });
    const text = await Deno.readTextFile(stateJsonPath(fx.projectDir));
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assertEquals(parsed.project_id, "abc");
    assertEquals(parsed.other_key, "preserved");
    assertEquals(parsed.paused_agents, ["alice"]);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("persistPausedAgents: creates the key when absent", async () => {
  const fx = await makeFixture({ state: { project_id: "abc" } });
  try {
    await persistPausedAgents({
      projectDir: fx.projectDir,
      paused: ["alice", "qa-bob"],
    });
    const text = await Deno.readTextFile(stateJsonPath(fx.projectDir));
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assertEquals(parsed.paused_agents, ["alice", "qa-bob"]);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("persistPausedAgents: rejects on filesystem error (parent dir missing)", async () => {
  // Pointing the projectDir at a non-existent parent makes the
  // .keni/state.json write fail; the function rejects.
  await assertRejects(
    () =>
      persistPausedAgents({
        projectDir: "/this/does/not/exist/keni-test",
        paused: [],
      }),
  );
});

Deno.test("persistPausedAgents: replaces an existing array (not appends)", async () => {
  const fx = await makeFixture({
    state: { paused_agents: ["alice", "qa-bob"] },
  });
  try {
    await persistPausedAgents({
      projectDir: fx.projectDir,
      paused: ["qa-bob"],
    });
    const text = await Deno.readTextFile(stateJsonPath(fx.projectDir));
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assertEquals(parsed.paused_agents, ["qa-bob"]);
  } finally {
    await fx.cleanup();
  }
});
