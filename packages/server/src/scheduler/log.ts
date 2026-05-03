/**
 * Lightweight structured logger for the scheduler.
 *
 * The orchestration server's `LogSink` is shaped around HTTP request
 * lines (`RequestLogLine`); the scheduler's events are control-plane
 * concerns (`runner.replaced`, `tick.coalesced`, `schedule.invalid`,
 * `timeout.shorter_than_idle`, `cycle.spawn_failed`,
 * `tick.skipped_paused`, `tick.precheck_skipped`,
 * `runner.missing`, `scheduler.activity_post_failed`,
 * `scheduler.started`, `scheduler.stopped`) that don't fit the request
 * shape. A separate, smaller surface keeps the request log clean and
 * lets tests capture scheduler events without parsing JSONL.
 *
 * Three levels: `debug` (high-volume per-tick noise), `info`
 * (lifecycle), `warn` (recoverable problems). The default
 * implementation writes JSON to `console.{warn,log}`; the test helper
 * pushes onto an array.
 *
 * @module
 */

/** Severity levels emitted by the scheduler's structured log surface. */
export type SchedulerLogLevel = "debug" | "info" | "warn";

/** One structured log line. */
export interface SchedulerLogEntry {
  readonly level: SchedulerLogLevel;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Scheduler-shaped structured logger. */
export interface SchedulerLogger {
  log(
    level: SchedulerLogLevel,
    event: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void;
}

/**
 * Default logger — writes JSON to `console.warn` for `warn` and to
 * `console.log` for `info` / `debug`. Production wires this in at
 * bootstrap; the same stream feeds existing JSONL aggregators.
 */
export function consoleSchedulerLogger(): SchedulerLogger {
  return {
    log(level, event, fields) {
      const line = JSON.stringify({ level, event, ...(fields ?? {}) });
      if (level === "warn") console.warn(line);
      else console.log(line);
    },
  };
}

/** Test helper — push every entry onto the supplied buffer. */
export function captureSchedulerLogger(
  buffer: SchedulerLogEntry[],
): SchedulerLogger {
  return {
    log(level, event, fields) {
      buffer.push({ level, event, fields: fields ?? {} });
    },
  };
}
