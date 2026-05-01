/**
 * Ticket REST routes — thin Hono sub-app over `TicketStore`.
 *
 * Each handler:
 *   1. Parses the body (or query) via the matching wire schema.
 *   2. Applies the role / status-graph guard (where the endpoint demands it).
 *   3. Calls the store.
 *   4. Maps the storage record into the wire shape and responds.
 *
 * Errors propagate to `app.onError(errorBoundary(...))`; handlers never
 * `try/catch`. The role guard for `POST /` rejects PO/QA/Writer with
 * `RoleNotOwnerError("<role>", "create_ticket")`; the status-graph and
 * owning-role guards for `POST /:id/transition` use the helpers in
 * `../statusGraph.ts`.
 *
 * Per design.md Decision 15 / `spec.md` §4.2, user-driven transitions are
 * structurally allowed by the role guard (`USER_OVERRIDE_ALLOWED`) but the
 * `manual_override` activity log emission lands in step 25 — the seam is
 * marked with a `TODO(step-25)` comment so the next implementer can find it.
 *
 * @module
 */

import { Hono } from "@hono/hono";
import type {
  Role,
  Ticket,
  TicketCreateInput,
  TicketEnvelope,
  TicketFilter,
  TicketHeaderPatch,
  TicketListResponse,
  TicketResponse,
  TicketStatus,
  TicketStore,
  TicketSummary,
  TicketSummaryResponse,
} from "@keni/shared";
import { z } from "zod";
import { RoleNotOwnerError, StatusGraphViolationError } from "../errors.ts";
import { isTicketRoleOwner, isTicketTransitionReachable } from "../statusGraph.ts";
import {
  TicketCreateRequestSchema,
  TicketHeaderPatchRequestSchema,
  TicketStatusSchema,
  TicketTransitionRequestSchema,
} from "../wire/tickets.ts";
import type { ServerVariables } from "../middleware/types.ts";

/** Roles authorised to create a ticket in the prototype (`spec.md` §4.3). */
const TICKET_CREATE_OWNERS: readonly Role[] = ["user", "engineer"];

/** Build the `/tickets` sub-app. */
export function ticketsRoutes(store: TicketStore, projectId: string): Hono<{
  Variables: ServerVariables;
}> {
  const app = new Hono<{ Variables: ServerVariables }>();

  app.get("/", async (c) => {
    const filter = parseTicketFilter(new URL(c.req.url).searchParams);
    const summaries = await store.list(filter);
    const body: TicketListResponse = {
      data: summaries.map(toTicketSummaryResponse),
      project_id: projectId,
    };
    return c.json(body);
  });

  app.get("/:id", async (c) => {
    const ticket = await store.read(c.req.param("id"));
    return c.json(toTicketEnvelope(ticket, projectId));
  });

  app.post("/", async (c) => {
    assertRoleCanCreateTicket(c.var.role);
    const input = TicketCreateRequestSchema.parse(await c.req.json());
    const ticket = await store.create(input as TicketCreateInput);
    return c.json(toTicketEnvelope(ticket, projectId), 201);
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const patch = TicketHeaderPatchRequestSchema.parse(await c.req.json());
    const { body, ...headerFields } = patch;
    let ticket: Ticket | undefined;
    if (Object.keys(headerFields).length > 0) {
      ticket = await store.updateHeader(id, headerFields as TicketHeaderPatch);
    }
    if (body !== undefined) {
      ticket = await store.updateBody(id, body);
    }
    if (ticket === undefined) {
      ticket = await store.read(id);
    }
    return c.json(toTicketEnvelope(ticket, projectId));
  });

  app.post("/:id/transition", async (c) => {
    const id = c.req.param("id");
    const { from, to } = TicketTransitionRequestSchema.parse(await c.req.json());
    if (!isTicketTransitionReachable(from, to)) {
      throw new StatusGraphViolationError(from, to);
    }
    if (!isTicketRoleOwner(c.var.role, to)) {
      throw new RoleNotOwnerError(c.var.role, to);
    }
    const ticket = await store.transitionStatus(id, from, to);
    // TODO(step-25): when c.var.role === "user", append a `manual_override`
    // entry to the activity log here, capturing { ticket: id, from, to }.
    return c.json(toTicketEnvelope(ticket, projectId));
  });

  return app;
}

/** Allow `user` and `engineer` to create tickets (prototype, `spec.md` §4.3). */
export function assertRoleCanCreateTicket(role: Role): void {
  if (!TICKET_CREATE_OWNERS.includes(role)) {
    throw new RoleNotOwnerError(role, "create_ticket");
  }
}

const PriorityBoundSchema = z.string().transform((v, ctx) => {
  const n = Number(v);
  if (!Number.isInteger(n)) {
    ctx.addIssue({ code: "custom", message: "must be an integer" });
    return z.NEVER;
  }
  return n;
});

const NullableStringSchema = z.string().transform((v) => (v === "null" ? null : v));

const TicketStatusListSchema = z.string().transform((raw, ctx) => {
  const tokens = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const parsed: TicketStatus[] = [];
  for (const t of tokens) {
    const single = TicketStatusSchema.safeParse(t);
    if (!single.success) {
      ctx.addIssue({ code: "custom", message: `unknown status '${t}'` });
      return z.NEVER;
    }
    parsed.push(single.data);
  }
  return parsed;
});

/**
 * Parse `URLSearchParams` from `GET /tickets?…` into a `TicketFilter`. All
 * fields are optional and ANDed in the store; unknown keys are ignored.
 *
 * - `status=open,in_progress` becomes `{ status: ["open", "in_progress"] }`;
 *   any unknown value throws `ZodError → 400 validation_failed`.
 * - `assignee=alice` and `assignee=null` (the literal string `null`) are honoured.
 * - `priorityMin` / `priorityMax` are integers; non-integer values throw `ZodError`.
 * - `changeRequest=cr-…` and `changeRequest=null` mirror `assignee`.
 */
export function parseTicketFilter(params: URLSearchParams): TicketFilter | undefined {
  const filter: {
    status?: TicketStatus | readonly TicketStatus[];
    assignee?: string | null;
    priorityMin?: number;
    priorityMax?: number;
    changeRequest?: string | null;
  } = {};

  const status = params.get("status");
  if (status !== null) {
    const tokens = TicketStatusListSchema.parse(status);
    if (tokens.length === 1) filter.status = tokens[0]!;
    else filter.status = tokens;
  }

  const assignee = params.get("assignee");
  if (assignee !== null) filter.assignee = NullableStringSchema.parse(assignee);

  const priorityMin = params.get("priorityMin");
  if (priorityMin !== null) filter.priorityMin = PriorityBoundSchema.parse(priorityMin);

  const priorityMax = params.get("priorityMax");
  if (priorityMax !== null) filter.priorityMax = PriorityBoundSchema.parse(priorityMax);

  const cr = params.get("changeRequest");
  if (cr !== null) filter.changeRequest = NullableStringSchema.parse(cr);

  return Object.keys(filter).length === 0 ? undefined : filter;
}

function toTicketSummaryResponse(summary: TicketSummary): TicketSummaryResponse {
  return {
    id: summary.id,
    title: summary.title,
    status: summary.status,
    assignee: summary.assignee,
    priority: summary.priority,
    change_request: summary.change_request,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
  };
}

function toTicketResponse(ticket: Ticket): TicketResponse {
  return { ...toTicketSummaryResponse(ticket.header), body: ticket.body };
}

function toTicketEnvelope(ticket: Ticket, projectId: string): TicketEnvelope {
  return { data: toTicketResponse(ticket), project_id: projectId };
}
