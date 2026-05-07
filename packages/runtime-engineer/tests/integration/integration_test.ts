/**
 * End-to-end integration test for the engineer runtime.
 *
 * Architecture (mirrors `packages/role-runtimes/src/common/integration_test.ts`):
 *
 * - The orchestration server runs **in-process** via `runServer` against a
 *   fresh temp project root (with `.keni/` initialised) and an alternate
 *   temp `homeDir` for the engineer's workspace tree, so the host's real
 *   `~/.keni/` is never touched.
 * - A real `git` binary backs both the seeded "project repo" (which acts
 *   as the merge target) and the `GitWorkspaceProvisioner` clone under
 *   `<tempHome>/.keni/workspaces/<projectId>/alice/`.
 * - The fixture fake-coding-agent fixture is *not* exercised here — the
 *   role-runtime cycle-level tests already cover that surface; this
 *   suite focuses on the wiring deltas this change introduces:
 *   workspace provisioning shape, `pr_merged` end-to-end, server-side
 *   activity-log stamping.
 *
 * Coverage matches `tasks.md` 9.1, 9.4, 9.5, 9.6:
 *  - workspace exists at the documented path with `.git/` present and
 *    `.keni/` absent;
 *  - sparse-checkout pattern file contains exactly the documented two
 *    lines (`/*\n!.keni/\n`);
 *  - per-workspace identity is `alice` / `alice@keni.invalid`;
 *  - host's real `~/.keni/` is unchanged;
 *  - `POST /prs/:id/merge` end-to-end advances `main` HEAD and appends
 *    a `pr_merged` activity entry.
 *
 * (9.2 and 9.3 — fake-coding-agent invoker driving `startCycle` directly
 * — are left to a follow-up; the unit tests cover the engineer runner /
 * provisioner / prompt independently, and the role-runtime cycle's
 * existing integration test covers `startCycle` against the same
 * fixture.)
 *
 * @module
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import {
  FileActivityLogStore,
  FileConfigStore,
  type MergePrEnvelope,
  PR_MERGED_ACTIVITY_EVENT,
  resolveGlobalPaths,
  resolveProjectPaths,
} from "@keni/shared";
import { runServer } from "../../../server/src/runServer.ts";
import { wire as engineerWire } from "../../src/wire.ts";

const PROJECT_ID = "00000000-0000-4000-8000-0000000000c1";

interface IntegrationContext {
  readonly serverUrl: string;
  readonly projectRoot: string;
  readonly tempHome: string;
  readonly hostHome: string;
  readonly remoteRepoPath: string;
  readonly workspacePath: string;
  readonly stop: () => Promise<void>;
}

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<Deno.CommandOutput> {
  const cmd = new Deno.Command("git", {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "tester",
      GIT_AUTHOR_EMAIL: "tester@keni.invalid",
      GIT_COMMITTER_NAME: "tester",
      GIT_COMMITTER_EMAIL: "tester@keni.invalid",
    },
  });
  const out = await cmd.output();
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr);
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${stderr}`);
  }
  return out;
}

async function setupProjectRepoAsBareRemote(): Promise<{
  remote: string;
  cleanup: () => Promise<void>;
}> {
  const root = await Deno.makeTempDir({ prefix: "keni-eng-it-remote-" });
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");

  await Deno.mkdir(remote, { recursive: true });
  await runGit(remote, ["init", "--bare", "--initial-branch=main"]);

  await Deno.mkdir(seed, { recursive: true });
  await runGit(seed, ["init", "--initial-branch=main"]);
  await runGit(seed, ["config", "user.name", "tester"]);
  await runGit(seed, ["config", "user.email", "tester@keni.invalid"]);
  await Deno.writeTextFile(join(seed, "README.md"), "# project\n");
  await runGit(seed, ["add", "."]);
  await runGit(seed, ["commit", "-m", "initial"]);
  await runGit(seed, ["remote", "add", "origin", remote]);
  await runGit(seed, ["push", "origin", "main"]);

  return { remote, cleanup: () => Deno.remove(root, { recursive: true }) };
}

async function setup(): Promise<IntegrationContext> {
  const projectRoot = await Deno.makeTempDir({ prefix: "keni-eng-it-project-" });
  const tempHome = await Deno.makeTempDir({ prefix: "keni-eng-it-home-" });
  const hostHome = await Deno.makeTempDir({ prefix: "keni-eng-it-host-" });

  const remote = await setupProjectRepoAsBareRemote();

  // Clone the bare remote into the projectRoot so `runServer`'s
  // `--project` arg is a working git checkout the merge handler can
  // operate against.
  await Deno.remove(projectRoot, { recursive: true });
  await runGit(
    join(projectRoot, ".."),
    ["clone", remote.remote, projectRoot.split("/").slice(-1)[0]!],
  );
  await runGit(projectRoot, ["config", "user.name", "tester"]);
  await runGit(projectRoot, ["config", "user.email", "tester@keni.invalid"]);

  const projectPaths = resolveProjectPaths(projectRoot);
  const globalPaths = resolveGlobalPaths(hostHome);
  await Deno.mkdir(projectPaths.keni, { recursive: true });
  await Deno.mkdir(projectPaths.tickets, { recursive: true });
  await Deno.mkdir(projectPaths.prs, { recursive: true });
  await Deno.mkdir(projectPaths.activity, { recursive: true });
  const config = new FileConfigStore(projectPaths, globalPaths);
  await config.writeProjectConfig({
    project_id: PROJECT_ID,
    name: "engineer-it-project",
    agents: [{ id: "alice", role: "engineer", cli: "claude" }],
  });

  const outLines: string[] = [];
  const ctrl = new AbortController();
  const promise = runServer(
    ["--project", projectRoot, "--port", "0"],
    {
      out: (m) => outLines.push(m),
      err: () => {},
      homeDir: tempHome,
      shutdownSignal: ctrl.signal,
      roleWires: { engineer: engineerWire },
    },
  );
  const start = performance.now();
  let banner: string | undefined;
  while (banner === undefined) {
    if (performance.now() - start > 8000) {
      throw new Error("Orchestration server did not bind within 8s");
    }
    banner = outLines.find((l) => l.startsWith("Keni server running at "));
    if (banner === undefined) await new Promise((r) => setTimeout(r, 25));
  }
  const serverUrl = banner.replace(/^Keni server running at /, "");

  const workspacePath = join(
    tempHome,
    ".keni",
    "workspaces",
    PROJECT_ID,
    "alice",
  );

  return {
    serverUrl,
    projectRoot,
    tempHome,
    hostHome,
    remoteRepoPath: remote.remote,
    workspacePath,
    stop: async () => {
      ctrl.abort();
      await promise;
      await remote.cleanup();
    },
  };
}

async function teardown(ctx: IntegrationContext): Promise<void> {
  await ctx.stop();
  await Deno.remove(ctx.projectRoot, { recursive: true });
  await Deno.remove(ctx.tempHome, { recursive: true });

  // Host home should be untouched by the test (the provisioner uses
  // `tempHome`, not `hostHome`).
  const hostKeni = join(ctx.hostHome, ".keni");
  let hostHadKeni = false;
  try {
    await Deno.lstat(hostKeni);
    hostHadKeni = true;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  await Deno.remove(ctx.hostHome, { recursive: true });
  assertEquals(
    hostHadKeni,
    false,
    `host home dir gained a .keni/ tree at ${hostKeni}; the test leaked into the host's home`,
  );
}

Deno.test({
  name:
    "engineer integration — boot provisions alice's workspace with the documented sparse shape and identity",
  ignore: Deno.build.os === "windows",
  async fn() {
    const ctx = await setup();
    try {
      const gitDirStat = await Deno.lstat(join(ctx.workspacePath, ".git"));
      assert(gitDirStat.isDirectory, ".git/ should exist after ensureProvisioned");

      let keniLeaked = false;
      try {
        await Deno.lstat(join(ctx.workspacePath, ".keni"));
        keniLeaked = true;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
      assertEquals(
        keniLeaked,
        false,
        "workspace must NOT contain .keni/ (sparse-checkout exclusion)",
      );

      const sparsePath = join(
        ctx.workspacePath,
        ".git",
        "info",
        "sparse-checkout",
      );
      const sparse = await Deno.readTextFile(sparsePath);
      assertEquals(sparse, "/*\n!.keni/\n");

      const nameOut = await runGit(ctx.workspacePath, [
        "config",
        "--local",
        "user.name",
      ]);
      const emailOut = await runGit(ctx.workspacePath, [
        "config",
        "--local",
        "user.email",
      ]);
      assertEquals(new TextDecoder().decode(nameOut.stdout).trim(), "alice");
      assertEquals(
        new TextDecoder().decode(emailOut.stdout).trim(),
        "alice@keni.invalid",
      );
    } finally {
      await teardown(ctx);
    }
  },
});

Deno.test({
  name:
    "engineer integration — POST /prs/:id/merge end-to-end advances main HEAD and appends pr_merged",
  ignore: Deno.build.os === "windows",
  async fn() {
    const ctx = await setup();
    try {
      // Engineer pushes a branch from inside their workspace.
      await runGit(ctx.workspacePath, ["checkout", "-b", "engineer/oauth-login"]);
      await Deno.writeTextFile(
        join(ctx.workspacePath, "feature.txt"),
        "implemented\n",
      );
      await runGit(ctx.workspacePath, ["add", "."]);
      await runGit(ctx.workspacePath, ["commit", "-m", "ticket-0001 feature"]);
      await runGit(ctx.workspacePath, ["push", "origin", "engineer/oauth-login"]);
      await runGit(ctx.workspacePath, ["checkout", "main"]);

      const prCreate = await fetch(`${ctx.serverUrl}/prs`, {
        method: "POST",
        headers: {
          "X-Keni-Role": "engineer",
          "X-Keni-Agent": "alice",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "OAuth login",
          ticket: "ticket-0001",
          branch: "engineer/oauth-login",
          author: "alice",
        }),
      });
      assertEquals(prCreate.status, 201);
      const created = (await prCreate.json()) as { data: { id: string } };
      const prId = created.data.id;

      for (const [from, to] of [["open", "in_review"], ["in_review", "approved"]]) {
        const t = await fetch(`${ctx.serverUrl}/prs/${prId}/transition`, {
          method: "POST",
          headers: {
            "X-Keni-Role": "engineer",
            "X-Keni-Agent": "alice",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ from, to }),
        });
        const body = await t.text();
        assertEquals(t.status, 200, `${from}→${to} failed: ${body}`);
      }

      const headBefore = new TextDecoder().decode(
        (await runGit(ctx.projectRoot, ["rev-parse", "HEAD"])).stdout,
      ).trim();

      const mergeRes = await fetch(`${ctx.serverUrl}/prs/${prId}/merge`, {
        method: "POST",
        headers: {
          "X-Keni-Role": "engineer",
          "X-Keni-Agent": "alice",
        },
      });
      const mergeBody = (await mergeRes.json()) as MergePrEnvelope;
      assertEquals(mergeRes.status, 200);
      const sha = mergeBody.data.merge_commit_sha;
      assert(/^[0-9a-f]{40}$/.test(sha));
      assert(sha !== headBefore, "merge must advance main HEAD");

      const headAfter = new TextDecoder().decode(
        (await runGit(ctx.projectRoot, ["rev-parse", "HEAD"])).stdout,
      ).trim();
      assertEquals(headAfter, sha);

      const projectPaths = resolveProjectPaths(ctx.projectRoot);
      const activityStore = new FileActivityLogStore(projectPaths);
      const entries: { event: string; refs: Readonly<Record<string, string>> }[] = [];
      for await (const entry of activityStore.query({})) {
        entries.push({ event: entry.event, refs: entry.refs });
      }
      const merged = entries.find((e) => e.event === PR_MERGED_ACTIVITY_EVENT);
      assertExists(merged, "expected a pr_merged activity entry");
      assertEquals(merged.refs.pr_id, prId);
      assertEquals(merged.refs.branch, "engineer/oauth-login");
      assertEquals(merged.refs.merge_commit_sha, sha);
    } finally {
      await teardown(ctx);
    }
  },
});

Deno.test({
  name:
    "engineer integration — non-fast-forward merge surfaces 409 merge_conflict with documented details",
  ignore: Deno.build.os === "windows",
  async fn() {
    const ctx = await setup();
    try {
      // Engineer authors a feature branch off the workspace's *current*
      // main (which mirrors projectRoot's main at this point).
      await runGit(ctx.workspacePath, ["checkout", "main"]);
      await runGit(ctx.workspacePath, [
        "checkout",
        "-b",
        "engineer/conflict",
      ]);
      await Deno.writeTextFile(join(ctx.workspacePath, "feature.txt"), "ok\n");
      await runGit(ctx.workspacePath, ["add", "."]);
      await runGit(ctx.workspacePath, ["commit", "-m", "feature on stale main"]);
      await runGit(ctx.workspacePath, ["push", "origin", "engineer/conflict"]);
      await runGit(ctx.workspacePath, ["checkout", "main"]);

      // Now diverge projectRoot's main *after* the engineer's branch was
      // already pushed. The branch's parent is no longer reachable from
      // the new main, so `git merge --ff-only` cannot fast-forward.
      await runGit(ctx.projectRoot, ["checkout", "main"]);
      await Deno.writeTextFile(join(ctx.projectRoot, "divergent.txt"), "x\n");
      await runGit(ctx.projectRoot, ["add", "."]);
      await runGit(ctx.projectRoot, ["commit", "-m", "diverge"]);

      const prCreate = await fetch(`${ctx.serverUrl}/prs`, {
        method: "POST",
        headers: {
          "X-Keni-Role": "engineer",
          "X-Keni-Agent": "alice",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "Conflict",
          ticket: "ticket-0002",
          branch: "engineer/conflict",
          author: "alice",
        }),
      });
      const created = (await prCreate.json()) as { data: { id: string } };
      const prId = created.data.id;

      for (const [from, to] of [["open", "in_review"], ["in_review", "approved"]]) {
        const t = await fetch(`${ctx.serverUrl}/prs/${prId}/transition`, {
          method: "POST",
          headers: {
            "X-Keni-Role": "engineer",
            "X-Keni-Agent": "alice",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ from, to }),
        });
        await t.body?.cancel();
      }

      const mergeRes = await fetch(`${ctx.serverUrl}/prs/${prId}/merge`, {
        method: "POST",
        headers: {
          "X-Keni-Role": "engineer",
          "X-Keni-Agent": "alice",
        },
      });
      const body = await mergeRes.json() as {
        error?: { code: string; details?: Record<string, unknown> };
      };
      assertEquals(
        mergeRes.status,
        409,
        `expected 409 merge_conflict, got ${mergeRes.status}: ${JSON.stringify(body)}`,
      );
      assertExists(body.error);
      assertEquals(body.error.code, "merge_conflict");
      assertExists(body.error.details);
      assertEquals(body.error.details.branch, "engineer/conflict");
      assertEquals(body.error.details.base, "main");
      assert(typeof body.error.details.git_stderr === "string");
    } finally {
      await teardown(ctx);
    }
  },
});
