/**
 * End-to-end smoke test for `keni start`.
 *
 * Boots `runStart` against a temp-dir fixture (built by an in-test
 * `runInit` from `packages/cli/src/init/mod.ts` plus a stub SPA
 * `dist/` directory) and asserts:
 *
 *  - The startup line `Keni server running at http://127.0.0.1:<port>`
 *    is printed on stdout.
 *  - `GET /health` against the printed URL returns the documented
 *    {@link HealthEnvelope} envelope (status `ok`, non-negative
 *    `uptime_ms`, the project's `project_id`).
 *  - `GET /` returns 200 with `Content-Type: text/html` and the body
 *    contains `id="root"`.
 *  - `GET /assets/<file>` returns the immutable cache header and the
 *    expected body bytes.
 *  - The test-injected shutdown signal triggers the documented graceful
 *    shutdown (the underlying `runServer` calls `scheduler.stop()` then
 *    `serverHandle.abort()` — verified by the post-shutdown `fetch`
 *    failing because the listener is gone).
 *  - The resolved exit code is 0.
 *
 * The test injects a `FakeWorkspaceProvisioner` (so the real git
 * provisioner is never touched) and a `roleWires` registry whose
 * engineer wire returns `null` (so no real subprocess is spawned).
 * The test runs `runInit` for the temp-dir bootstrap, which spawns
 * `git`. When `git` is not on `PATH` the test is skipped with a
 * clear label.
 *
 * The test does not require network access beyond `127.0.0.1`. The
 * temp-dir fixture is removed in a `try/finally`.
 *
 * @module
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import type { HealthEnvelope } from "@keni/shared";
import { FakeWorkspaceProvisioner } from "@keni/runtime-workspace/test-fakes";
import { runInit } from "../../../src/init/mod.ts";
import { runStart } from "../../../src/start/mod.ts";

interface SmokeFixture {
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
  if (GIT_AVAILABLE) {
    Deno.test(label, fn);
    return;
  }
  Deno.test.ignore(`${label} (skipped: git not on PATH)`, fn);
};

async function makeSmokeFixture(): Promise<SmokeFixture> {
  const projectDir = await Deno.makeTempDir({ prefix: "keni-start-e2e-proj-" });
  const homeDir = await Deno.makeTempDir({ prefix: "keni-start-e2e-home-" });
  const code = await runInit({ targetDir: projectDir }, {
    homeDir,
    out: () => {},
    err: () => {},
  });
  if (code !== 0) {
    throw new Error(`runInit failed with exit code ${code}`);
  }

  const spaBundleDir = await Deno.makeTempDir({ prefix: "keni-start-e2e-spa-" });
  await Deno.writeTextFile(
    join(spaBundleDir, "index.html"),
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  await Deno.mkdir(join(spaBundleDir, "assets"), { recursive: true });
  await Deno.writeTextFile(
    join(spaBundleDir, "assets", "main-stub.js"),
    "globalThis.__keni_smoke = true;",
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

async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs: number,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

itGit(
  "runStart end-to-end: boots, serves /health + /, then shuts down cleanly",
  async () => {
    const fx = await makeSmokeFixture();
    const out: string[] = [];
    const err: string[] = [];

    const shutdownCtrl = new AbortController();
    const provisioner = new FakeWorkspaceProvisioner();

    const runPromise = runStart(
      {
        projectDir: fx.projectDir,
        spaBundle: fx.spaBundleDir,
        portRange: { start: 17777, end: 17877 },
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
        roleWires: {
          engineer: () => Promise.resolve(null),
          po: () => Promise.resolve(null),
        },
      },
    );

    let exitCode: number | undefined;
    let url: string | undefined;
    try {
      const startupLine = await waitFor(
        () => out.find((m) => m.startsWith("Keni server running at ")),
        10_000,
      );
      assertMatch(startupLine, /Keni server running at http:\/\/127\.0\.0\.1:\d+/);
      url = startupLine.replace(/^Keni server running at /, "");

      const healthRes = await fetch(`${url}/health`);
      assertEquals(healthRes.status, 200);
      const healthBody = (await healthRes.json()) as HealthEnvelope;
      assertEquals(healthBody.data.status, "ok");
      assert(healthBody.data.uptime_ms >= 0);
      assert(healthBody.project_id.length > 0);
      assertEquals(healthBody.data.project_id, healthBody.project_id);

      const indexRes = await fetch(`${url}/`);
      assertEquals(indexRes.status, 200);
      const ctype = indexRes.headers.get("Content-Type") ?? "";
      assert(ctype.startsWith("text/html"), `expected text/html, got '${ctype}'`);
      const body = await indexRes.text();
      assert(body.includes('id="root"'), 'expected SPA shell to contain id="root"');

      const assetRes = await fetch(`${url}/assets/main-stub.js`);
      assertEquals(assetRes.status, 200);
      assertEquals(
        assetRes.headers.get("Cache-Control"),
        "public, max-age=31536000, immutable",
      );
      const assetBody = await assetRes.text();
      assert(assetBody.includes("__keni_smoke"));

      shutdownCtrl.abort();
      exitCode = await runPromise;

      // Post-shutdown: the listener is gone, so a follow-up fetch
      // either fails to connect or returns a non-200; either proves
      // `serverHandle.abort()` ran.
      let postShutdownReachable = false;
      try {
        const after = await fetch(`${url}/health`);
        await after.body?.cancel();
        postShutdownReachable = after.ok;
      } catch {
        postShutdownReachable = false;
      }
      assert(
        !postShutdownReachable,
        "expected /health to be unreachable after shutdown",
      );
    } finally {
      try {
        if (exitCode === undefined) {
          if (!shutdownCtrl.signal.aborted) shutdownCtrl.abort();
          exitCode = await runPromise;
        }
      } catch {
        // Suppressed — this finally guarantees resource release.
      }
      await fx.cleanup();
    }

    assertEquals(exitCode, 0, `expected exit 0; stderr=${err.join("\n")}`);
    // The injected role wires return `null`, so the engineer's
    // workspace provisioner is intentionally NOT called. The smoke
    // test's primary assertions are the bound URL, the `/health`
    // shape, and the documented graceful-shutdown sequence — those
    // were already verified above.
  },
);
