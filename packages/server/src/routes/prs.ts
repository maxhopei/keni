/**
 * PR REST routes — engineer-owned mirror of `tickets.ts`.
 *
 * Same composition as the ticket routes: parse → role/graph guard → store →
 * wire-shape map → respond. Engineer is the only owning role for the entire
 * PR lifecycle (`spec.md` §3 + §4.1); the user can override every transition
 * via `USER_OVERRIDE_ALLOWED`. The deferred `manual_override` activity log
 * emission marker (`TODO(step-25)`) sits on the transition seam.
 *
 * @module
 */

import { Hono } from "@hono/hono";
import type {
  ActivityLogStore,
  MergePrEnvelope,
  MergePrResponse,
  PR,
  PRCreateInput,
  PREnvelope,
  PRFilter,
  PRListResponse,
  PRResponse,
  PRStatus,
  PRStore,
  PRSummary,
  PRSummaryResponse,
  Role,
} from "@keni/shared";
import { PR_MERGED_ACTIVITY_EVENT } from "@keni/shared";
import { z } from "zod";
import { MergeConflictError, RoleNotOwnerError, StatusGraphViolationError } from "../errors.ts";
import { emitFrame, type EventBus } from "../eventBus.ts";
import { isPRRoleOwner, isPRTransitionReachable } from "../statusGraph.ts";
import {
  PRCreateRequestSchema,
  PRIntentPatchRequestSchema,
  PRStatusSchema,
  PRTransitionRequestSchema,
} from "../wire/prs.ts";
import type { ServerVariables } from "../middleware/types.ts";
import type { Mutex } from "../concurrency/mutex.ts";
import type { WorkspaceProvisioner } from "@keni/role-runtimes";

/** Roles authorised to create a PR (engineer-only authorial flow; user may override). */
const PR_CREATE_OWNERS: readonly Role[] = ["engineer", "user"];

/** Roles authorised to invoke `POST /prs/:id/merge`. */
const PR_MERGE_OWNERS: readonly Role[] = ["engineer", "user"];

/**
 * Optional merge-endpoint dependencies. When provided, `prsRoutes`
 * mounts `POST /:id/merge`; when omitted, the route is not registered
 * (keeps tests that don't need merge from having to wire git tooling).
 */
export interface PRsMergeDeps {
  readonly activityLogStore: ActivityLogStore;
  readonly workspaceProvisioner: WorkspaceProvisioner;
  readonly projectRepoPath: string;
  readonly mergeMutex: Mutex;
  readonly projectId: string;
  /** Override `git` binary path (tests pass `"git"` or `/no/such/git`). */
  readonly gitBinary?: string;
}

const PRStatusListSchema = z.string().transform((raw, ctx) => {
  const tokens = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const parsed: PRStatus[] = [];
  for (const t of tokens) {
    const single = PRStatusSchema.safeParse(t);
    if (!single.success) {
      ctx.addIssue({ code: "custom", message: `unknown status '${t}'` });
      return z.NEVER;
    }
    parsed.push(single.data);
  }
  return parsed;
});

/** Build the `/prs` sub-app. */
export function prsRoutes(
  store: PRStore,
  bus: EventBus,
  projectId: string,
  mergeDeps?: PRsMergeDeps,
): Hono<{ Variables: ServerVariables }> {
  const app = new Hono<{ Variables: ServerVariables }>();

  app.get("/", async (c) => {
    const filter = parsePRFilter(new URL(c.req.url).searchParams);
    const summaries = await store.list(filter);
    const body: PRListResponse = {
      data: summaries.map(toPRSummaryResponse),
      project_id: projectId,
    };
    return c.json(body);
  });

  app.get("/:id", async (c) => {
    const pr = await store.read(c.req.param("id"));
    return c.json(toPREnvelope(pr, projectId));
  });

  app.post("/", async (c) => {
    assertRoleCanCreatePR(c.var.role);
    const input = PRCreateRequestSchema.parse(await c.req.json());
    const pr = await store.create(input as PRCreateInput);
    emitFrame(bus, projectId, "pr.created", {
      pr_id: pr.header.id,
      status: pr.header.status,
      ticket: pr.header.ticket,
    });
    return c.json(toPREnvelope(pr, projectId), 201);
  });

  app.patch("/:id/intent", async (c) => {
    const id = c.req.param("id");
    const { intent } = PRIntentPatchRequestSchema.parse(await c.req.json());
    const pr = await store.updateIntent(id, intent);
    emitFrame(bus, projectId, "pr.updated", {
      pr_id: pr.header.id,
      status: pr.header.status,
      kind: "intent",
    });
    return c.json(toPREnvelope(pr, projectId));
  });

  app.post("/:id/transition", async (c) => {
    const id = c.req.param("id");
    const { from, to } = PRTransitionRequestSchema.parse(await c.req.json());
    if (!isPRTransitionReachable(from, to)) {
      throw new StatusGraphViolationError(from, to);
    }
    if (!isPRRoleOwner(c.var.role, to)) {
      throw new RoleNotOwnerError(c.var.role, to);
    }
    const pr = await store.updateStatus(id, from, to);
    // TODO(step-25): when c.var.role === "user", append a `manual_override`
    // entry to the activity log here, capturing { pr: id, from, to }.
    emitFrame(bus, projectId, "pr.updated", {
      pr_id: pr.header.id,
      status: pr.header.status,
      kind: "transition",
    });
    return c.json(toPREnvelope(pr, projectId));
  });

  if (mergeDeps) {
    app.post("/:id/merge", async (c) => {
      assertRoleCanMergePR(c.var.role);
      const id = c.req.param("id");
      const pr = await store.read(id);
      if (pr.header.status !== "approved") {
        throw new StatusGraphViolationError(pr.header.status, "merged");
      }
      const branch = pr.header.branch;
      const author = pr.header.author;
      const workspacePath = mergeDeps.workspaceProvisioner.workspacePathFor(
        mergeDeps.projectId,
        author,
      );
      const sha = await runMergeFastForward(branch, workspacePath, mergeDeps);
      const merged = await store.updateStatus(id, "approved", "merged");
      await mergeDeps.activityLogStore.append({
        session_id: `merge-${id}`,
        agent: c.var.agent ?? "user",
        role: c.var.role,
        event: PR_MERGED_ACTIVITY_EVENT,
        summary: `Merged PR ${id} (branch ${branch}) as ${sha.slice(0, 8)}`,
        refs: {
          pr_id: id,
          branch,
          merge_commit_sha: sha,
        },
      });
      emitFrame(bus, projectId, "pr.updated", {
        pr_id: merged.header.id,
        status: merged.header.status,
        kind: "transition",
      });
      const body: MergePrEnvelope = {
        data: { merge_commit_sha: sha } satisfies MergePrResponse,
        project_id: projectId,
      };
      return c.json(body);
    });
  }

  return app;
}

/** Allow `engineer` (canonical) and `user` (override) to merge PRs. */
export function assertRoleCanMergePR(role: Role): void {
  if (!PR_MERGE_OWNERS.includes(role)) {
    throw new RoleNotOwnerError(role, "merge_pr");
  }
}

/**
 * Serialise `git fetch <workspacePath> <branch>:<branch>` then
 * `git checkout main && git merge --ff-only <branch>` against the project
 * repo behind the supplied mutex. The fetch source is the engineer's
 * sparse-checkout workspace clone — engineers push their branch to that
 * clone (which IS their `origin`), so the merge target reaches in to
 * pull the branch ref directly rather than going through any
 * upstream/forge surface.
 *
 * Returns the resulting merge-commit SHA on success; raises
 * {@link MergeConflictError} on fast-forward refusal.
 */
async function runMergeFastForward(
  branch: string,
  workspacePath: string,
  deps: PRsMergeDeps,
): Promise<string> {
  return await deps.mergeMutex.runExclusive(async () => {
    const git = deps.gitBinary ?? "git";
    const cwd = deps.projectRepoPath;

    // Pull the branch ref from the engineer's workspace clone into a
    // local ref of the same name in the project repo. `+` allows the
    // fetch to update an existing ref non-fast-forwardingly when the
    // engineer rebased; the subsequent `merge --ff-only` is what
    // enforces the fast-forward invariant against `main`.
    await runGitOrThrow(
      git,
      cwd,
      ["fetch", workspacePath, `+${branch}:${branch}`],
      branch,
    );
    await runGitOrThrow(git, cwd, ["checkout", "main"], branch);
    await runGitMergeOrConflict(git, cwd, branch);
    const sha = await runGitCaptureSha(git, cwd, branch);
    return sha;
  });
}

async function runGitOrThrow(
  git: string,
  cwd: string,
  args: readonly string[],
  branch: string,
): Promise<void> {
  const cmd = new Deno.Command(git, {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  let output: Deno.CommandOutput;
  try {
    output = await cmd.output();
  } catch (cause) {
    throw new Error(
      `git ${args.join(" ")} could not be invoked in ${cwd}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new MergeConflictError(branch, "main", stderr);
  }
}

async function runGitMergeOrConflict(
  git: string,
  cwd: string,
  branch: string,
): Promise<void> {
  const cmd = new Deno.Command(git, {
    args: ["merge", "--ff-only", branch],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new MergeConflictError(branch, "main", stderr);
  }
}

async function runGitCaptureSha(
  git: string,
  cwd: string,
  branch: string,
): Promise<string> {
  const cmd = new Deno.Command(git, {
    args: ["rev-parse", "HEAD"],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new MergeConflictError(branch, "main", stderr);
  }
  const sha = new TextDecoder().decode(output.stdout).trim();
  return sha;
}

/** Allow `engineer` (canonical author) and `user` (override) to create PRs. */
export function assertRoleCanCreatePR(role: Role): void {
  if (!PR_CREATE_OWNERS.includes(role)) {
    throw new RoleNotOwnerError(role, "create_pr");
  }
}

/**
 * Parse `URLSearchParams` from `GET /prs?…` into a `PRFilter`. All fields
 * are optional and ANDed in the store; unknown keys are ignored.
 *
 * - `status=open,in_review` becomes `{ status: ["open", "in_review"] }`.
 * - `ticket=ticket-0001` is honoured.
 * - `author=alice` is honoured.
 */
export function parsePRFilter(params: URLSearchParams): PRFilter | undefined {
  const filter: { status?: PRStatus | readonly PRStatus[]; ticket?: string; author?: string } = {};

  const status = params.get("status");
  if (status !== null) {
    const tokens = PRStatusListSchema.parse(status);
    if (tokens.length === 1) filter.status = tokens[0]!;
    else filter.status = tokens;
  }

  const ticket = params.get("ticket");
  if (ticket !== null) filter.ticket = ticket;

  const author = params.get("author");
  if (author !== null) filter.author = author;

  return Object.keys(filter).length === 0 ? undefined : filter;
}

function toPRSummaryResponse(summary: PRSummary): PRSummaryResponse {
  return {
    id: summary.id,
    title: summary.title,
    status: summary.status,
    ticket: summary.ticket,
    branch: summary.branch,
    author: summary.author,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
  };
}

function toPRResponse(pr: PR): PRResponse {
  return { ...toPRSummaryResponse(pr.header), body: pr.body };
}

function toPREnvelope(pr: PR, projectId: string): PREnvelope {
  return { data: toPRResponse(pr), project_id: projectId };
}
