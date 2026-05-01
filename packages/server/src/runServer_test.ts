/**
 * Tests for `runServer`. Avoids waiting for a real SIGINT by injecting an
 * `AbortSignal` (the production code path is exercised by step 13's
 * end-to-end tests; here we cover argv shape, exit codes, and the happy
 * path without touching `Deno.addSignalListener`).
 */

import { assertEquals, assertMatch } from "@std/assert";
import { FileConfigStore, resolveGlobalPaths, resolveProjectPaths } from "@keni/shared";
import { parseRunServerArgs, runServer, UsageError } from "./runServer.ts";

async function makeKeniInitialised(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await Deno.makeTempDir({ prefix: "keni-server-runserver-" });
  const home = await Deno.makeTempDir({ prefix: "keni-server-runserver-home-" });
  const projectPaths = resolveProjectPaths(root);
  const globalPaths = resolveGlobalPaths(home);
  await Deno.mkdir(projectPaths.keni, { recursive: true });
  await Deno.mkdir(projectPaths.tickets, { recursive: true });
  await Deno.mkdir(projectPaths.prs, { recursive: true });
  await Deno.mkdir(projectPaths.activity, { recursive: true });
  const config = new FileConfigStore(projectPaths, globalPaths);
  await config.writeProjectConfig({
    project_id: "00000000-0000-4000-8000-000000000001",
    name: "test-project",
  });
  return {
    root,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(home, { recursive: true });
    },
  };
}

Deno.test("parseRunServerArgs accepts --project=<path> inline form", () => {
  const parsed = parseRunServerArgs(["--project=/tmp/x", "--port=8080"]);
  assertEquals(parsed.port, 8080);
  assertMatch(parsed.projectDir, /\/tmp\/x$/);
  assertEquals(parsed.host, "127.0.0.1");
});

Deno.test("parseRunServerArgs accepts --project <path> separated form", () => {
  const parsed = parseRunServerArgs(["--project", "/tmp/x", "--host", "0.0.0.0"]);
  assertMatch(parsed.projectDir, /\/tmp\/x$/);
  assertEquals(parsed.host, "0.0.0.0");
});

Deno.test("parseRunServerArgs throws UsageError on missing --project", () => {
  let thrown: unknown;
  try {
    parseRunServerArgs(["--port", "8080"]);
  } catch (e) {
    thrown = e;
  }
  assertEquals(thrown instanceof UsageError, true);
});

Deno.test("parseRunServerArgs throws UsageError on unknown flag", () => {
  let thrown: unknown;
  try {
    parseRunServerArgs(["--project", "/tmp/x", "--bogus"]);
  } catch (e) {
    thrown = e;
  }
  assertEquals(thrown instanceof UsageError, true);
});

Deno.test("parseRunServerArgs rejects --port < 0 or > 65535", () => {
  for (const bad of ["-1", "65536", "abc"]) {
    let thrown: unknown;
    try {
      parseRunServerArgs(["--project", "/tmp/x", "--port", bad]);
    } catch (e) {
      thrown = e;
    }
    assertEquals(thrown instanceof UsageError, true, `expected UsageError for --port ${bad}`);
  }
});

Deno.test("runServer with no args returns exit 2 (missing --project)", async () => {
  const errLines: string[] = [];
  const code = await runServer([], { out: () => {}, err: (m) => errLines.push(m) });
  assertEquals(code, 2);
  assertEquals(errLines.some((l) => l.includes("--project")), true);
});

Deno.test("runServer with --unknown returns exit 2", async () => {
  const errLines: string[] = [];
  const code = await runServer(["--unknown"], { out: () => {}, err: (m) => errLines.push(m) });
  assertEquals(code, 2);
});

Deno.test("runServer against an empty dir returns exit 1 with `keni init` hint", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-server-runserver-empty-" });
  try {
    const errLines: string[] = [];
    const code = await runServer(["--project", root], {
      out: () => {},
      err: (m) => errLines.push(m),
    });
    assertEquals(code, 1);
    assertEquals(errLines.some((l) => l.includes("keni init")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runServer prints the bound URL and exits 0 on injected shutdown", async () => {
  const env = await makeKeniInitialised();
  try {
    const outLines: string[] = [];
    const ctrl = new AbortController();
    const promise = runServer(
      ["--project", env.root, "--port", "0"],
      { out: (m) => outLines.push(m), err: () => {}, shutdownSignal: ctrl.signal },
    );
    await waitFor(() => outLines.some((l) => l.startsWith("Keni server running at ")));
    const banner = outLines.find((l) => l.startsWith("Keni server running at "))!;
    assertMatch(banner, /^Keni server running at http:\/\/127\.0\.0\.1:\d+$/);

    const url = banner.replace(/^Keni server running at /, "");
    const res = await fetch(`${url}/tickets`, { headers: { "X-Keni-Role": "user" } });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.project_id, "00000000-0000-4000-8000-000000000001");

    ctrl.abort();
    const exit = await promise;
    assertEquals(exit, 0);
  } finally {
    await env.cleanup();
  }
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
