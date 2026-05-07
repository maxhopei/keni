/**
 * Tests for the scheduler's cadence + timeout shorthand parser and
 * the agent / role / default resolution chain.
 */

import { assertEquals } from "@std/assert";
import { captureSchedulerLogger, type SchedulerLogEntry } from "../../../src/scheduler/log.ts";
import {
  FALLBACK_CADENCE_MS,
  FALLBACK_TIMEOUT_MS,
  parseDurationShorthand,
  resolveCadenceMs,
  resolveTimeoutMs,
  ROLE_DEFAULT_CADENCE_MS,
  ROLE_DEFAULT_TIMEOUT_MS,
} from "../../../src/scheduler/schedule.ts";

Deno.test("parseDurationShorthand — milliseconds", () => {
  assertEquals(parseDurationShorthand("100ms"), 100);
  assertEquals(parseDurationShorthand("0ms"), 0);
});

Deno.test("parseDurationShorthand — seconds", () => {
  assertEquals(parseDurationShorthand("5s"), 5_000);
  assertEquals(parseDurationShorthand("60s"), 60_000);
});

Deno.test("parseDurationShorthand — minutes", () => {
  assertEquals(parseDurationShorthand("5m"), 300_000);
  assertEquals(parseDurationShorthand("30m"), 1_800_000);
});

Deno.test("parseDurationShorthand — hours", () => {
  assertEquals(parseDurationShorthand("1h"), 3_600_000);
  assertEquals(parseDurationShorthand("2h"), 7_200_000);
});

Deno.test("parseDurationShorthand — cron `*/N * * * *`", () => {
  assertEquals(parseDurationShorthand("*/2 * * * *"), 120_000);
  assertEquals(parseDurationShorthand("*/5 * * * *"), 300_000);
});

Deno.test("parseDurationShorthand — bare integer is interpreted as ms", () => {
  assertEquals(parseDurationShorthand(1500), 1_500);
  assertEquals(parseDurationShorthand("1500"), 1_500);
  assertEquals(parseDurationShorthand(0), 0);
});

Deno.test("parseDurationShorthand — unparseable inputs return null", () => {
  assertEquals(parseDurationShorthand("totally-bogus"), null);
  assertEquals(parseDurationShorthand("5x"), null); // unknown unit
  assertEquals(parseDurationShorthand("-5s"), null); // negative duration
  assertEquals(parseDurationShorthand("5.5s"), null); // fractional duration
  assertEquals(parseDurationShorthand("0 0 * * *"), null); // unsupported cron shape
  assertEquals(parseDurationShorthand(""), null);
  assertEquals(parseDurationShorthand("  "), null);
  assertEquals(parseDurationShorthand(-1), null);
  assertEquals(parseDurationShorthand(1.5), null);
  assertEquals(parseDurationShorthand(Number.NaN), null);
  assertEquals(parseDurationShorthand(Number.POSITIVE_INFINITY), null);
});

Deno.test("resolveCadenceMs — engineer default is 60s", () => {
  const buffer: SchedulerLogEntry[] = [];
  const result = resolveCadenceMs(
    { agentId: "alice", role: "engineer", map: undefined },
    captureSchedulerLogger(buffer),
  );
  assertEquals(result.ms, 60_000);
  assertEquals(result.source, "default");
  assertEquals(buffer.length, 0);
});

Deno.test("resolveCadenceMs — po default is 5s", () => {
  const buffer: SchedulerLogEntry[] = [];
  const result = resolveCadenceMs(
    { agentId: "po", role: "po", map: undefined },
    captureSchedulerLogger(buffer),
  );
  assertEquals(result.ms, 5_000);
});

Deno.test("resolveCadenceMs — per-agent override beats per-role override", () => {
  const buffer: SchedulerLogEntry[] = [];
  const result = resolveCadenceMs(
    {
      agentId: "alice",
      role: "engineer",
      map: { alice: "10s", engineer: "30s" },
    },
    captureSchedulerLogger(buffer),
  );
  assertEquals(result.ms, 10_000);
  assertEquals(result.source, "agent");
  assertEquals(result.raw, "10s");
});

Deno.test("resolveCadenceMs — per-role override beats per-role default", () => {
  const buffer: SchedulerLogEntry[] = [];
  const result = resolveCadenceMs(
    {
      agentId: "alice",
      role: "engineer",
      map: { engineer: "30s" },
    },
    captureSchedulerLogger(buffer),
  );
  assertEquals(result.ms, 30_000);
  assertEquals(result.source, "role");
});

Deno.test("resolveCadenceMs — unparseable falls back to role default and warns", () => {
  const buffer: SchedulerLogEntry[] = [];
  const result = resolveCadenceMs(
    { agentId: "alice", role: "engineer", map: { alice: "totally-bogus" } },
    captureSchedulerLogger(buffer),
  );
  assertEquals(result.ms, 60_000);
  assertEquals(result.source, "default");
  assertEquals(buffer.length, 1);
  assertEquals(buffer[0]!.level, "warn");
  assertEquals(buffer[0]!.event, "schedule.invalid");
  assertEquals(buffer[0]!.fields.key, "alice");
  assertEquals(buffer[0]!.fields.value, "totally-bogus");
  assertEquals(buffer[0]!.fields.fallback, 60_000);
});

Deno.test("resolveCadenceMs — unknown role uses fallback constant", () => {
  const buffer: SchedulerLogEntry[] = [];
  const result = resolveCadenceMs(
    {
      agentId: "x",
      // simulate an unrecognised role string by casting through unknown
      role: "stranger" as unknown as "engineer",
      map: undefined,
    },
    captureSchedulerLogger(buffer),
  );
  assertEquals(result.ms, FALLBACK_CADENCE_MS);
});

Deno.test("resolveTimeoutMs — engineer default is 30 minutes", () => {
  const buffer: SchedulerLogEntry[] = [];
  const result = resolveTimeoutMs(
    { agentId: "alice", role: "engineer", map: undefined },
    captureSchedulerLogger(buffer),
  );
  assertEquals(result.ms, ROLE_DEFAULT_TIMEOUT_MS.engineer);
  assertEquals(result.ms, 30 * 60 * 1_000);
});

Deno.test("resolveTimeoutMs — po default is 5 minutes", () => {
  const buffer: SchedulerLogEntry[] = [];
  const result = resolveTimeoutMs(
    { agentId: "po", role: "po", map: undefined },
    captureSchedulerLogger(buffer),
  );
  assertEquals(result.ms, ROLE_DEFAULT_TIMEOUT_MS.po);
  assertEquals(result.ms, 5 * 60 * 1_000);
});

Deno.test("resolveTimeoutMs — per-agent override beats per-role default", () => {
  const buffer: SchedulerLogEntry[] = [];
  const result = resolveTimeoutMs(
    { agentId: "alice", role: "engineer", map: { alice: "10m" } },
    captureSchedulerLogger(buffer),
  );
  assertEquals(result.ms, 600_000);
});

Deno.test("resolveTimeoutMs — unknown role falls back to FALLBACK_TIMEOUT_MS", () => {
  const buffer: SchedulerLogEntry[] = [];
  const result = resolveTimeoutMs(
    {
      agentId: "x",
      role: "stranger" as unknown as "engineer",
      map: undefined,
    },
    captureSchedulerLogger(buffer),
  );
  assertEquals(result.ms, FALLBACK_TIMEOUT_MS);
});

Deno.test("ROLE_DEFAULT_CADENCE_MS values match spec.md §6.1", () => {
  assertEquals(ROLE_DEFAULT_CADENCE_MS.engineer, 60_000);
  assertEquals(ROLE_DEFAULT_CADENCE_MS.qa, 60_000);
  assertEquals(ROLE_DEFAULT_CADENCE_MS.po, 5_000);
});
