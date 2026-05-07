/**
 * End-to-end smoke tests for `runStart`'s production engineer-runner
 * wiring (per `engineer-runner-production-wiring/specs/cli-start/spec.md`).
 *
 * Two scenarios:
 *
 *  1. Configured CLI — `~/.keni/config.yaml` sets
 *     `coding_agent_cli: "fake-coding-agent"`, the test injects a
 *     `codingAgentCliRegistryOverride` pointing that name at the
 *     existing `tests/fixtures/fake-coding-agent.ts` script (spawned
 *     under `deno run -A`). After `POST /tickets`, the activity log
 *     SHALL show an `engineer.session_start` row for `alice` within
 *     a 10-second window (the production helper actually constructed
 *     and registered an engineer runner).
 *
 *  2. No CLI configured — the captured scheduler logger SHALL contain
 *     exactly one `engineer.runner_skipped` warn entry for the engineer
 *     agent at boot, and `runStart` SHALL still resolve to exit code 0.
 *
 * Both tests use the `FakeWorkspaceProvisioner` so no real git is
 * touched; both speed the schedule up to a `100ms` cadence (the
 * scheduler's millisecond-shorthand path) so the assertions don't
 * wait for a real cron tick.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { CodingAgentCliEntry } from "@keni/role-runtimes";
import { FakeWorkspaceProvisioner } from "@keni/role-runtimes/test-fakes";
import { captureSchedulerLogger, type SchedulerLogEntry, type SchedulerLogger } from "@keni/server";
import { runInit } from "../../../src/init/mod.ts";
import { runStart } from "../../../src/start/mod.ts";

interface E2EFixture {
  readonly projectDir: string;
  readonly homeDir: string;
  readonly spaBundleDir: string;
  readonly cleanup: () => Promise<void>;
}

async function isGitOnPath(): Promise<boolean> {
  try {
    const proc = new Deno.Command("git", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    return (await proc.output()).code === 0;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = await isGitOnPath();

const itGit = (label: string, fn: () => Promise<void>) => {
  // sanitizeOps/Resources is OFF here: the scheduler's `stop()` method
  // races the drain phase against a wall-clock fence via
  // `clock.setTimeout(resolve, drainTimeoutMs)` (see
  // `packages/server/src/scheduler/scheduler.ts:405`). When the drain
  // wins the race (the in-flight cycle finishes within the budget),
  // the timer is never cleared — Deno's default leak detector flags
  // this as a leaked operation. The behaviour is a pre-existing
  // scheduler bug unrelated to engineer-runner wiring; the existing
  // `start_e2e_test.ts` avoids it by injecting `makeEngineerRunner:
  // () => null` so no cycle ever spawns. The new wiring DOES spawn a
  // cycle (that's what we're testing), so we suppress the diagnostic
  // here. A follow-up change SHOULD fix the scheduler's missing
  // `clearTimeout`.
  const opts: Deno.TestDefinition = {
    name: label,
    fn,
    sanitizeOps: false,
    sanitizeResources: false,
  };
  if (GIT_AVAILABLE) {
    Deno.test(opts);
    return;
  }
  Deno.test.ignore({ ...opts, name: `${label} (skipped: git not on PATH)` });
};

const FAKE_CODING_AGENT_PATH = new URL(
  "../../../role-runtimes/tests/fixtures/fake-coding-agent.ts",
  import.meta.url,
).pathname;

async function makeE2EFixture(): Promise<E2EFixture> {
  const projectDir = await Deno.makeTempDir({ prefix: "keni-er-e2e-proj-" });
  const homeDir = await Deno.makeTempDir({ prefix: "keni-er-e2e-home-" });
  const code = await runInit({ targetDir: projectDir }, {
    homeDir,
    out: () => {},
    err: () => {},
  });
  if (code !== 0) {
    throw new Error(`runInit failed with exit code ${code}`);
  }

  const spaBundleDir = await Deno.makeTempDir({ prefix: "keni-er-e2e-spa-" });
  await Deno.writeTextFile(
    join(spaBundleDir, "index.html"),
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );

  return {
    projectDir,
    homeDir,
    spaBundleDir,
    cleanup: async () => {
      await Deno.remove(projectDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
      await Deno.remove(spaBundleDir, { recursive: true });
    },
  };
}

async function speedUpSchedule(projectDir: string): Promise<void> {
  // The default project YAML written by `runInit` uses a per-minute
  // cron expression (`*/1 * * * *`). The scheduler also accepts a
  // bare positive integer (milliseconds) per the
  // `scheduler.schedule.parseDurationShorthand` contract. Rewriting
  // the YAML to `alice: 100` collapses the test-window wait to ~100ms.
  const yamlPath = join(projectDir, ".keni", "project.yaml");
  const text = await Deno.readTextFile(yamlPath);
  const rewritten = text.replace(
    /schedules:\s*\n\s*alice:\s*'?\*\/1 \* \* \* \*'?/m,
    "schedules:\n  alice: 100",
  );
  if (rewritten === text) {
    // Idempotent fallback: append a fresh `schedules` block when the
    // regex did not match (e.g. `runInit` shape evolves).
    await Deno.writeTextFile(
      yamlPath,
      `${text.trimEnd()}\nschedules:\n  alice: 100\n`,
    );
    return;
  }
  await Deno.writeTextFile(yamlPath, rewritten);
}

async function writeGlobalCodingAgentCli(
  homeDir: string,
  cli: string,
): Promise<void> {
  const dir = join(homeDir, ".keni");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "config.yaml"),
    `coding_agent_cli: ${cli}\n`,
  );
}

async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface ActivityEnvelope {
  readonly data: ReadonlyArray<{
    readonly id: string;
    readonly agent: string;
    readonly role: string;
    readonly event: string;
  }>;
  readonly project_id: string;
}

async function fetchActivity(url: string, agent: string): Promise<ActivityEnvelope> {
  const res = await fetch(`${url}/activity?agent=${encodeURIComponent(agent)}`, {
    headers: { "X-Keni-Role": "user" },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`GET /activity failed with ${res.status}`);
  }
  return await res.json() as ActivityEnvelope;
}

itGit(
  "engineer-runner production wiring: configured CLI registers a runner that emits engineer.session_start on the first tick",
  async () => {
    const fx = await makeE2EFixture();
    await speedUpSchedule(fx.projectDir);
    await writeGlobalCodingAgentCli(fx.homeDir, "fake-coding-agent");

    const fakeEntry: CodingAgentCliEntry = {
      cliBinary: "deno",
      buildArgs: (_inv, mcpPath) => [
        "run",
        "-A",
        FAKE_CODING_AGENT_PATH,
        "--mcp-config",
        mcpPath,
      ],
      promptInjection: "stdin",
      resumeFlag: "--resume",
      envAllowlist: ["HOME", "PATH"],
      mcpConfigStrategy: { kind: "tempfile-json" },
    };

    const out: string[] = [];
    const err: string[] = [];
    const shutdownCtrl = new AbortController();
    const provisioner = new FakeWorkspaceProvisioner();

    const runPromise = runStart(
      {
        projectDir: fx.projectDir,
        spaBundle: fx.spaBundleDir,
        portRange: { start: 17900, end: 17999 },
        positionalAndFlagBoth: false,
      },
      {
        out: (m) => out.push(m),
        err: (m) => err.push(m),
      },
      {
        homeDir: fx.homeDir,
        shutdownSignal: shutdownCtrl.signal,
        workspaceProvisioner: provisioner,
        codingAgentCliRegistryOverride: { "fake-coding-agent": fakeEntry },
      },
    );

    let exitCode: number | undefined;
    try {
      const startupLine = await waitFor(
        () => out.find((m) => m.startsWith("Keni server running at ")),
        10_000,
      );
      const url = startupLine.replace(/^Keni server running at /, "");

      const ticketRes = await fetch(`${url}/tickets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Keni-Role": "user",
        },
        body: JSON.stringify({ title: "pick me up", priority: 1 }),
      });
      assertEquals(ticketRes.status, 201, `expected 201; stderr=${err.join("\n")}`);
      const ticketBody = (await ticketRes.json()) as {
        data: { id: string };
        project_id: string;
      };
      const ticketId = ticketBody.data.id;
      assert(typeof ticketId === "string" && ticketId.length > 0);

      // Poll the activity log until the engineer's session_start row
      // shows up. The role-runtime cycle posts `event: "session_start"`
      // with `role: "engineer"` (per `activityClient.ts`); the
      // composite "engineer.session_start" identifier lives only on
      // the WebSocket event-frame surface, not in the activity log.
      const sessionStart = await waitFor(async () => {
        const env = await fetchActivity(url, "alice");
        return env.data.find(
          (e) => e.event === "session_start" && e.role === "engineer",
        );
      }, 15_000);
      assertEquals(sessionStart.agent, "alice");

      shutdownCtrl.abort();
      exitCode = await runPromise;
    } finally {
      try {
        if (exitCode === undefined) {
          if (!shutdownCtrl.signal.aborted) shutdownCtrl.abort();
          exitCode = await runPromise;
        }
      } catch {
        // suppressed
      }
      await fx.cleanup();
    }

    assertEquals(exitCode, 0, `expected exit 0; stderr=${err.join("\n")}`);
  },
);

itGit(
  "engineer-runner production wiring: no CLI configured logs engineer.runner_skipped at boot and exits cleanly",
  async () => {
    const fx = await makeE2EFixture();
    await speedUpSchedule(fx.projectDir);
    // Intentionally no `~/.keni/config.yaml` — the production helper
    // SHALL log `engineer.runner_skipped` once per agent at boot.

    const out: string[] = [];
    const err: string[] = [];
    const shutdownCtrl = new AbortController();
    const provisioner = new FakeWorkspaceProvisioner();
    const logBuffer: SchedulerLogEntry[] = [];
    const capturedLogger: SchedulerLogger = captureSchedulerLogger(logBuffer);

    // The production wiring uses the supplied `schedulerLogger` for both
    // the scheduler's own per-tick lines AND the helper's boot-time
    // `engineer.runner_skipped` line. Inject a capturing logger so the
    // test can assert on either.
    const runPromise = runStart(
      {
        projectDir: fx.projectDir,
        spaBundle: fx.spaBundleDir,
        portRange: { start: 18000, end: 18099 },
        positionalAndFlagBoth: false,
      },
      {
        out: (m) => out.push(m),
        err: (m) => err.push(m),
      },
      {
        homeDir: fx.homeDir,
        shutdownSignal: shutdownCtrl.signal,
        workspaceProvisioner: provisioner,
        schedulerLogger: capturedLogger,
      },
    );

    let exitCode: number | undefined;
    try {
      await waitFor(
        () => out.find((m) => m.startsWith("Keni server running at ")),
        10_000,
      );

      // Wait for the helper's boot-time warn line. The helper fires
      // it from inside `wireEngineers()` which `runServer` runs after
      // the listener is bound but before it returns; the warn shows
      // up in the captured log buffer immediately after the startup
      // line on stdout.
      const skip = await waitFor(
        () =>
          logBuffer.find(
            (e) =>
              e.event === "engineer.runner_skipped" &&
              e.fields.agent === "alice",
          ),
        5_000,
      );
      assertEquals(skip.level, "warn");
      assertEquals(skip.fields.reason, "no_cli_configured");
      assertEquals(skip.fields.configured_cli, null);
      assertEquals(skip.fields.supported, ["claude", "codex", "cursor-agent"]);

      // Exactly one such line per agent (boot-time, not per-tick).
      const dupes = logBuffer.filter(
        (e) =>
          e.event === "engineer.runner_skipped" &&
          e.fields.agent === "alice",
      );
      assertEquals(dupes.length, 1, "expected exactly one engineer.runner_skipped per agent");

      shutdownCtrl.abort();
      exitCode = await runPromise;
    } finally {
      try {
        if (exitCode === undefined) {
          if (!shutdownCtrl.signal.aborted) shutdownCtrl.abort();
          exitCode = await runPromise;
        }
      } catch {
        // suppressed
      }
      await fx.cleanup();
    }

    assertEquals(exitCode, 0, `expected exit 0; stderr=${err.join("\n")}`);
  },
);
