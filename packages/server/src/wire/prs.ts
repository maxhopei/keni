/**
 * zod schemas for PR request bodies.
 *
 * Mirrors `tickets.ts` in shape and conventions; PR statuses are the
 * five-stage engineer-only lifecycle from `spec.md` §4.1.
 *
 * @module
 */

import { z } from "zod";
import type { PRCreateRequest, PRIntentPatchRequest, PRTransitionRequest } from "@keni/shared";

/** Every legal `PRStatus` literal — keep in lock-step with `PRStatus`. */
export const PR_STATUSES = [
  "open",
  "in_review",
  "has_comments",
  "approved",
  "merged",
] as const;

/** zod enum for PR statuses. */
export const PRStatusSchema = z.enum(PR_STATUSES);

export const PRCreateRequestSchema: z.ZodType<PRCreateRequest> = z.object({
  title: z.string().min(1).max(200),
  body: z.string().optional(),
  ticket: z.string().min(1),
  branch: z.string().min(1),
  author: z.string().min(1),
}).strict();

export const PRIntentPatchRequestSchema: z.ZodType<PRIntentPatchRequest> = z.object({
  intent: z.string(),
}).strict();

export const PRTransitionRequestSchema: z.ZodType<PRTransitionRequest> = z.object({
  from: PRStatusSchema,
  to: PRStatusSchema,
}).strict();
