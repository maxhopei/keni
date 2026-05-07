/**
 * Integration tests for `POST /prs/:id/merge`.
 *
 * Each test boots a `Hono` app wired with the same middleware stack the
 * production composition root uses (role-identity + error boundary),
 * mounts `prsRoutes(...)` with the merge dependencies populated, and
 * exercises the endpoint against:
 *
 *  - a real `FilePRStore` rooted at a temp project;
 *  - a real `git` binary in a temp project repo seeded with a `main`
 *    branch and a feature branch (`engineer/oauth-login`);
 *  - a real `InMemoryActivityLogStore` so the documented `pr_merged`
 *    entry can be inspected on success;
 *  - a `FakeWorkspaceProvisioner` (the merge handler does not touch the
 *    workspace; it only needs the project repo path);
 *  - a fresh in-process {@link createMutex Mutex} per test except the
 *    concurrency case, which exercises the documented serialisation
 *    guarantee.
 *
 * Coverage matches `tasks.md` 6.6:
 *  - clean fast-forward returns 200 + SHA + updates PR status + appends
 *    a `pr_merged` activity entry;
 *  - non-fast-forward returns 409 with the documented details and
 *    leaves PR status + project `main` HEAD unchanged;
 *  - non-engineer / non-user role rejected with 403 `role_not_owner`;
 *  - user override is allowed (200);
 *  - missing PR returns 404 `store_not_found`;
 *  - PR not in `approved` returns 409 `status_graph_violation`;
 *  - concurrent merges queue and execute serially (mutex enforces order).
 */

import { Hono } from "@hono/hono";
import { assert, assertEquals, assertExists } from "@std/assert";
import {
  type ErrorResponse,
  FilePRStore,
  InMemoryActivityLogStore,
  type MergePrEnvelope,
  PR_MERGED_ACTIVITY_EVENT,
  resolveProjectPaths,
} from "@keni/shared";
import type { WorkspaceProvisioner } from "@keni/role-runtimes";
import type { ActivityEntry } from "@keni/shared";

/**
 * Tiny workspace-provisioner stub for the merge tests: every call to
 * `workspacePathFor(_, _)` returns the same fixed path. The other
 * methods are no-ops; the merge handler only uses `workspacePathFor`,
 * but the interface requires the full surface.
 */
function fixedWorkspaceProvisioner(path: string): WorkspaceProvisioner {
  return {
    workspacePathFor(): string {
      return path;
    },
    ensureProvisioned(): Promise<void> {
      return Promise.resolve();
    },
    pullMain(): Promise<void> {
      return Promise.resolve();
    },
    discardProvisioned(): Promise<void> {
      return Promise.resolve();
    },
  };
}
import { createInMemoryEventBus } from "../../../src/eventBus.ts";
import { errorBoundary } from "../../../src/middleware/errorBoundary.ts";
import { roleIdentity } from "../../../src/middleware/roleIdentity.ts";
import type { ServerVariables } from "../../../src/middleware/types.ts";
import { createMutex } from "../../../src/concurrency/mutex.ts";
import { prsRoutes } from "../../../src/routes/prs.ts";

async function collectActivity(
  store: InMemoryActivityLogStore,
): Promise<ActivityEntry[]> {
  const out: ActivityEntry[] = [];
  for await (const entry of store.query({})) {
    out.push(entry);
  }
  return out;
}

const PROJECT_ID = "project-merge-test";
const SHA40 = /^[0-9a-f]{40}$/;

interface MergeTestContext {
  readonly app: Hono<{ Variables: ServerVariables }>;
  readonly prStore: FilePRStore;
  readonly activityLogStore: InMemoryActivityLogStore;
  readonly projectRepoPath: string;
  readonly remoteRepoPath: string;
  readonly workspacePath: string;
  readonly cleanup: () => Promise<void>;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  env: Record<string, string> = {},
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
      ...env,
    },
  });
  const output = await cmd.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`git ${args.join(" ")} failed (exit ${output.code}): ${stderr}`);
  }
  return output;
}

async function setupRepos(): Promise<{
  remote: string;
  project: string;
  workspace: string;
  cleanup: () => Promise<void>;
}> {
  const root = await Deno.makeTempDir({ prefix: "keni-merge-test-" });
  const remote = `${root}/remote.git`;
  const seed = `${root}/seed`;
  const project = `${root}/project`;
  const workspace = `${root}/workspace`;

  await Deno.mkdir(remote, { recursive: true });
  await runGit(remote, ["init", "--bare", "--initial-branch=main"]);

  await Deno.mkdir(seed, { recursive: true });
  await runGit(seed, ["init", "--initial-branch=main"]);
  await runGit(seed, ["config", "user.name", "tester"]);
  await runGit(seed, ["config", "user.email", "tester@keni.invalid"]);
  await Deno.writeTextFile(`${seed}/README.md`, "# project\n");
  await runGit(seed, ["add", "."]);
  await runGit(seed, ["commit", "-m", "initial"]);
  await runGit(seed, ["remote", "add", "origin", remote]);
  await runGit(seed, ["push", "origin", "main"]);

  await runGit(seed, ["checkout", "main"]);

  await runGit(root, ["clone", remote, "project"]);
  await runGit(project, ["config", "user.name", "tester"]);
  await runGit(project, ["config", "user.email", "tester@keni.invalid"]);

  // The "workspace" simulates the engineer's sparse-checkout clone of
  // `project` (the orchestration-side clone). Engineers push the PR
  // branch to this workspace; the merge handler then fetches that
  // branch from here back into `project` and fast-forwards `main`.
  await runGit(root, ["clone", project, "workspace"]);
  await runGit(workspace, ["config", "user.name", "alice"]);
  await runGit(workspace, ["config", "user.email", "alice@keni.invalid"]);
  await runGit(workspace, ["checkout", "-b", "engineer/oauth-login"]);
  await Deno.writeTextFile(`${workspace}/feature.txt`, "ok\n");
  await runGit(workspace, ["add", "."]);
  await runGit(workspace, ["commit", "-m", "add feature"]);
  await runGit(workspace, ["checkout", "main"]);

  return {
    remote,
    project,
    workspace,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

async function makeMergeApp(): Promise<MergeTestContext> {
  const root = await Deno.makeTempDir({ prefix: "keni-merge-pr-store-" });
  const paths = resolveProjectPaths(root);
  const prStore = new FilePRStore(paths);
  const activityLogStore = new InMemoryActivityLogStore();
  const bus = createInMemoryEventBus();

  const repos = await setupRepos();
  const provisioner = fixedWorkspaceProvisioner(repos.workspace);

  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(roleIdentity());
  app.onError(errorBoundary(PROJECT_ID));
  app.route(
    "/prs",
    prsRoutes(prStore, bus, PROJECT_ID, {
      activityLogStore,
      workspaceProvisioner: provisioner,
      projectRepoPath: repos.project,
      mergeMutex: createMutex(),
      projectId: PROJECT_ID,
    }),
  );

  return {
    app,
    prStore,
    activityLogStore,
    projectRepoPath: repos.project,
    remoteRepoPath: repos.remote,
    workspacePath: repos.workspace,
    cleanup: async () => {
      await repos.cleanup();
      await Deno.remove(root, { recursive: true });
    },
  };
}

function authedRequest(
  url: string,
  init: { method?: string; role?: string; agent?: string; body?: unknown } = {},
): Request {
  const headers = new Headers();
  headers.set("X-Keni-Role", init.role ?? "engineer");
  if (init.agent) headers.set("X-Keni-Agent", init.agent);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function seedApprovedPR(
  ctx: MergeTestContext,
  branch: string,
  ticket = "ticket-0001",
): Promise<string> {
  const created = await ctx.app.fetch(authedRequest("http://x/prs", {
    body: {
      title: "OAuth login",
      ticket,
      branch,
      author: "alice",
    },
  }));
  if (created.status !== 201) {
    throw new Error(`PR creation failed: ${created.status} ${await created.text()}`);
  }
  const env = (await created.json()) as { data: { id: string } };
  const id = env.data.id;
  const r1 = await ctx.app.fetch(authedRequest(`http://x/prs/${id}/transition`, {
    body: { from: "open", to: "in_review" },
  }));
  if (r1.status !== 200) {
    throw new Error(`open→in_review failed: ${r1.status} ${await r1.text()}`);
  }
  const r2 = await ctx.app.fetch(authedRequest(`http://x/prs/${id}/transition`, {
    body: { from: "in_review", to: "approved" },
  }));
  if (r2.status !== 200) {
    throw new Error(`in_review→approved failed: ${r2.status} ${await r2.text()}`);
  }
  return id;
}

Deno.test({
  name: "POST /prs/:id/merge clean fast-forward → 200 + SHA + status updated + pr_merged appended",
  ignore: Deno.build.os === "windows",
  async fn() {
    const ctx = await makeMergeApp();
    try {
      const id = await seedApprovedPR(ctx, "engineer/oauth-login");

      const res = await ctx.app.fetch(
        authedRequest(`http://x/prs/${id}/merge`, { agent: "alice" }),
      );
      assertEquals(res.status, 200);
      const body = (await res.json()) as MergePrEnvelope;
      assertEquals(body.project_id, PROJECT_ID);
      assert(SHA40.test(body.data.merge_commit_sha));

      const head = await runGit(ctx.projectRepoPath, ["rev-parse", "HEAD"]);
      const headSha = new TextDecoder().decode(head.stdout).trim();
      assertEquals(headSha, body.data.merge_commit_sha);

      const branchRef = await runGit(ctx.projectRepoPath, [
        "rev-parse",
        "refs/heads/main",
      ]);
      assertEquals(
        new TextDecoder().decode(branchRef.stdout).trim(),
        body.data.merge_commit_sha,
      );

      const stored = await ctx.prStore.read(id);
      assertEquals(stored.header.status, "merged");

      const entries = await collectActivity(ctx.activityLogStore);
      const merged = entries.find((e) => e.event === PR_MERGED_ACTIVITY_EVENT);
      assertExists(merged, "expected a pr_merged activity entry");
      assertEquals(merged.refs.pr_id, id);
      assertEquals(merged.refs.branch, "engineer/oauth-login");
      assertEquals(merged.refs.merge_commit_sha, body.data.merge_commit_sha);
      assertEquals(merged.role, "engineer");
      assertEquals(merged.agent, "alice");
    } finally {
      await ctx.cleanup();
    }
  },
});

Deno.test({
  name: "POST /prs/:id/merge non-fast-forward → 409 merge_conflict (PR + main unchanged)",
  ignore: Deno.build.os === "windows",
  async fn() {
    const ctx = await makeMergeApp();
    try {
      await runGit(ctx.projectRepoPath, ["checkout", "main"]);
      await Deno.writeTextFile(`${ctx.projectRepoPath}/divergent.txt`, "x\n");
      await runGit(ctx.projectRepoPath, ["add", "."]);
      await runGit(ctx.projectRepoPath, ["commit", "-m", "diverge"]);

      const headBefore = new TextDecoder().decode(
        (await runGit(ctx.projectRepoPath, ["rev-parse", "HEAD"])).stdout,
      ).trim();

      const id = await seedApprovedPR(ctx, "engineer/oauth-login");

      const res = await ctx.app.fetch(
        authedRequest(`http://x/prs/${id}/merge`, { agent: "alice" }),
      );
      assertEquals(res.status, 409);
      const body = (await res.json()) as ErrorResponse;
      assertEquals(body.error.code, "merge_conflict");
      const details = body.error.details as Record<string, unknown> | undefined;
      assertExists(details);
      assertEquals(details.branch, "engineer/oauth-login");
      assertEquals(details.base, "main");
      assert(typeof details.git_stderr === "string");

      const stored = await ctx.prStore.read(id);
      assertEquals(stored.header.status, "approved");

      const headAfter = new TextDecoder().decode(
        (await runGit(ctx.projectRepoPath, ["rev-parse", "HEAD"])).stdout,
      ).trim();
      assertEquals(headAfter, headBefore);
    } finally {
      await ctx.cleanup();
    }
  },
});

Deno.test({
  name: "POST /prs/:id/merge as a non-engineer / non-user role → 403 role_not_owner",
  ignore: Deno.build.os === "windows",
  async fn() {
    const ctx = await makeMergeApp();
    try {
      const id = await seedApprovedPR(ctx, "engineer/oauth-login");
      const res = await ctx.app.fetch(
        authedRequest(`http://x/prs/${id}/merge`, { role: "qa", agent: "qa-1" }),
      );
      assertEquals(res.status, 403);
      const body = (await res.json()) as ErrorResponse;
      assertEquals(body.error.code, "role_not_owner");
    } finally {
      await ctx.cleanup();
    }
  },
});

Deno.test({
  name: "POST /prs/:id/merge as user override → 200",
  ignore: Deno.build.os === "windows",
  async fn() {
    const ctx = await makeMergeApp();
    try {
      const id = await seedApprovedPR(ctx, "engineer/oauth-login");
      const res = await ctx.app.fetch(
        authedRequest(`http://x/prs/${id}/merge`, { role: "user", agent: "human" }),
      );
      assertEquals(res.status, 200);
      const body = (await res.json()) as MergePrEnvelope;
      assert(SHA40.test(body.data.merge_commit_sha));

      const merged = (await collectActivity(ctx.activityLogStore)).find(
        (e) => e.event === PR_MERGED_ACTIVITY_EVENT,
      );
      assertExists(merged);
      assertEquals(merged.role, "user");
      assertEquals(merged.agent, "human");
    } finally {
      await ctx.cleanup();
    }
  },
});

Deno.test({
  name: "POST /prs/:id/merge for a missing PR → 404 store_not_found",
  ignore: Deno.build.os === "windows",
  async fn() {
    const ctx = await makeMergeApp();
    try {
      const res = await ctx.app.fetch(
        authedRequest("http://x/prs/pr-9999/merge", { agent: "alice" }),
      );
      assertEquals(res.status, 404);
      const body = (await res.json()) as ErrorResponse;
      assertEquals(body.error.code, "store_not_found");
    } finally {
      await ctx.cleanup();
    }
  },
});

Deno.test({
  name: "POST /prs/:id/merge while PR not yet approved → 403 status_graph_violation",
  ignore: Deno.build.os === "windows",
  async fn() {
    const ctx = await makeMergeApp();
    try {
      const created = await ctx.app.fetch(authedRequest("http://x/prs", {
        body: {
          title: "OAuth login",
          ticket: "ticket-0001",
          branch: "engineer/oauth-login",
          author: "alice",
        },
      }));
      const env = (await created.json()) as { data: { id: string } };
      const id = env.data.id;

      const res = await ctx.app.fetch(
        authedRequest(`http://x/prs/${id}/merge`, { agent: "alice" }),
      );
      const body = (await res.json()) as ErrorResponse;
      assertEquals(res.status, 403, `unexpected body: ${JSON.stringify(body)}`);
      assertEquals(body.error.code, "status_graph_violation");
    } finally {
      await ctx.cleanup();
    }
  },
});

Deno.test({
  name: "POST /prs/:id/merge serialises concurrent merges via the mutex",
  ignore: Deno.build.os === "windows",
  async fn() {
    const ctx = await makeMergeApp();
    try {
      // Add a second PR-bound branch to the workspace (alongside the
      // already-seeded `engineer/oauth-login`) so we can race two
      // merges through the mutex.
      await runGit(ctx.workspacePath, ["checkout", "main"]);
      await runGit(ctx.workspacePath, ["checkout", "-b", "engineer/feature-b"]);
      await Deno.writeTextFile(`${ctx.workspacePath}/b.txt`, "b\n");
      await runGit(ctx.workspacePath, ["add", "."]);
      await runGit(ctx.workspacePath, ["commit", "-m", "feature b"]);
      await runGit(ctx.workspacePath, ["checkout", "main"]);

      const idA = await seedApprovedPR(ctx, "engineer/oauth-login");
      const idB = await seedApprovedPR(ctx, "engineer/feature-b");

      const [resA, resB] = await Promise.all([
        ctx.app.fetch(authedRequest(`http://x/prs/${idA}/merge`, { agent: "alice" })),
        ctx.app.fetch(authedRequest(`http://x/prs/${idB}/merge`, { agent: "alice" })),
      ]);

      const codes = [resA.status, resB.status].sort((a, b) => a - b);
      assertEquals(codes[0], 200);
      assert(codes[1] === 200 || codes[1] === 409);

      const storedA = await ctx.prStore.read(idA);
      const storedB = await ctx.prStore.read(idB);
      const mergedCount = [storedA, storedB].filter((p) => p.header.status === "merged").length;
      assert(mergedCount >= 1);

      const events = (await collectActivity(ctx.activityLogStore)).filter(
        (e) => e.event === PR_MERGED_ACTIVITY_EVENT,
      );
      assertEquals(events.length, mergedCount);
    } finally {
      await ctx.cleanup();
    }
  },
});
