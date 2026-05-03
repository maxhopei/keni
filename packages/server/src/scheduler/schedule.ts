/**
 * Schedule and timeout shorthand parser + per-agent / per-role
 * resolution.
 *
 * Accepts three input shapes (no cron library):
 *
 *  - Duration shorthand: `"5ms"`, `"5s"`, `"60s"`, `"5m"`, `"1h"`.
 *    Matched by `/^(\d+)(ms|s|m|h)$/`.
 *  - Simple cron pattern `"*\/N * * * *"` → `N * 60_000` ms.
 *    (Anything else cron-shaped is rejected.)
 *  - A bare positive integer (interpreted as milliseconds — useful in
 *    tests).
 *
 * Resolution order is identical for cadence and timeout:
 *
 *   `map[agentId] ?? map[role] ?? defaults[role] ?? defaultFallback`
 *
 * Per-role defaults match `spec.md` §6.1 (engineer / qa: 60 s tick,
 * 30 min timeout; po: 5 s tick, 5 min timeout). An unparseable value
 * emits one `warn`-level `"schedule.invalid"` (or
 * `"timeout.invalid"`) entry naming the key, the offending value, and
 * the fallback that was used.
 *
 * @module
 */

import type { Role } from "@keni/shared";
import type { SchedulerLogger } from "./log.ts";

/** Per-role default cadence (ms). `spec.md` §6.1. */
export const ROLE_DEFAULT_CADENCE_MS: Readonly<Record<string, number>> = {
  engineer: 60_000,
  qa: 60_000,
  po: 5_000,
  writer: 60_000,
};

/** Catch-all fallback when neither role nor agent override applies. */
export const FALLBACK_CADENCE_MS = 60_000;

/** Per-role default session timeout (ms). `design.md` Decision 5. */
export const ROLE_DEFAULT_TIMEOUT_MS: Readonly<Record<string, number>> = {
  engineer: 30 * 60 * 1_000,
  qa: 30 * 60 * 1_000,
  po: 5 * 60 * 1_000,
  writer: 30 * 60 * 1_000,
};

/** Catch-all fallback when neither role nor agent override applies. */
export const FALLBACK_TIMEOUT_MS = 30 * 60 * 1_000;

const DURATION_PATTERN = /^(\d+)(ms|s|m|h)$/;
const CRON_EVERY_N_MINUTES = /^\*\/(\d+) \* \* \* \*$/;

/**
 * Parse one shorthand value. Returns the number of milliseconds, or
 * `null` when the value cannot be parsed.
 *
 * Accepts: bare positive integers (ms), duration shorthand
 * (`"5s"` etc.), cron `"*\/N * * * *"`. Rejects negative, NaN, and
 * malformed strings.
 */
export function parseDurationShorthand(value: string | number): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null;
    return value;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const cron = CRON_EVERY_N_MINUTES.exec(trimmed);
  if (cron !== null) {
    const n = Number.parseInt(cron[1]!, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n * 60_000;
  }

  const duration = DURATION_PATTERN.exec(trimmed);
  if (duration !== null) {
    const n = Number.parseInt(duration[1]!, 10);
    const unit = duration[2]!;
    if (!Number.isFinite(n) || n < 0) return null;
    switch (unit) {
      case "ms":
        return n;
      case "s":
        return n * 1_000;
      case "m":
        return n * 60_000;
      case "h":
        return n * 3_600_000;
    }
  }

  // Bare integer (e.g. "1500"): treat as ms.
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/** Inputs to {@link resolveCadenceMs} and {@link resolveTimeoutMs}. */
export interface ResolveInputs {
  readonly agentId: string;
  readonly role: Role;
  readonly map: Readonly<Record<string, string | number>> | undefined;
}

/** Result of one resolution attempt. */
export interface ResolveResult {
  readonly ms: number;
  /** Source of the resolved value: an agent-id key, a role key, or the per-role default. */
  readonly source: "agent" | "role" | "default";
  /** Original (raw) value that resolved, when one was supplied. */
  readonly raw?: string | number;
}

function resolveFrom(
  inputs: ResolveInputs,
  defaults: Readonly<Record<string, number>>,
  fallback: number,
  logger: SchedulerLogger,
  logEvent: "schedule.invalid" | "timeout.invalid",
): ResolveResult {
  const map = inputs.map;
  const tryKey = (key: string, source: "agent" | "role"): ResolveResult | null => {
    if (map === undefined) return null;
    const raw = map[key];
    if (raw === undefined) return null;
    const parsed = parseDurationShorthand(raw);
    if (parsed === null) {
      logger.log("warn", logEvent, {
        key,
        value: raw,
        fallback: defaults[inputs.role] ?? fallback,
      });
      return null;
    }
    return { ms: parsed, source, raw };
  };

  return (
    tryKey(inputs.agentId, "agent") ??
      tryKey(inputs.role, "role") ?? {
      ms: defaults[inputs.role] ?? fallback,
      source: "default",
    }
  );
}

/**
 * Resolve the cadence (tick interval, ms) for one agent. Falls back to
 * the per-role default and finally to {@link FALLBACK_CADENCE_MS}.
 * Unparseable values emit one `warn`-level `"schedule.invalid"` line.
 */
export function resolveCadenceMs(
  inputs: ResolveInputs,
  logger: SchedulerLogger,
): ResolveResult {
  return resolveFrom(
    inputs,
    ROLE_DEFAULT_CADENCE_MS,
    FALLBACK_CADENCE_MS,
    logger,
    "schedule.invalid",
  );
}

/**
 * Resolve the per-cycle wall-clock timeout (ms) for one agent. Falls
 * back to the per-role default and finally to
 * {@link FALLBACK_TIMEOUT_MS}.
 */
export function resolveTimeoutMs(
  inputs: ResolveInputs,
  logger: SchedulerLogger,
): ResolveResult {
  return resolveFrom(
    inputs,
    ROLE_DEFAULT_TIMEOUT_MS,
    FALLBACK_TIMEOUT_MS,
    logger,
    "timeout.invalid",
  );
}
