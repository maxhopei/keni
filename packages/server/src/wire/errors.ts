/**
 * zod schema for {@link ErrorResponse} — used by integration tests to assert
 * response shape, never by handlers (handlers build the envelope through
 * `mapErrorToResponse`, the single source of truth).
 *
 * @module
 */

import { z } from "zod";
import { ERROR_CODES, type ErrorResponse } from "@keni/shared";

const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ErrorResponseSchema: z.ZodType<ErrorResponse> = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  project_id: z.string().optional(),
});
