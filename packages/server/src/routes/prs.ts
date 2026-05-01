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
import { z } from "zod";
import { RoleNotOwnerError, StatusGraphViolationError } from "../errors.ts";
import { emitFrame, type EventBus } from "../eventBus.ts";
import { isPRRoleOwner, isPRTransitionReachable } from "../statusGraph.ts";
import {
  PRCreateRequestSchema,
  PRIntentPatchRequestSchema,
  PRStatusSchema,
  PRTransitionRequestSchema,
} from "../wire/prs.ts";
import type { ServerVariables } from "../middleware/types.ts";

/** Roles authorised to create a PR (engineer-only authorial flow; user may override). */
const PR_CREATE_OWNERS: readonly Role[] = ["engineer", "user"];

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

  return app;
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
