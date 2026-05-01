/**
 * `requestLog` middleware — emits one structured JSONL line per request via
 * the injected `LogSink`. Captures method, path, status, duration, role,
 * agent, and (when set by `errorBoundary`) the documented `error_code`.
 *
 * Sink factories provided here:
 *
 * - {@link stdoutLogSink}: `console.log(JSON.stringify(line))`. Default for
 *   the development entry point.
 * - {@link captureLogSink}: pushes onto an in-memory array. Used by tests.
 * - {@link fileLogSink}: date-partitioned append-only `<dir>/server-YYYY-MM-DD.jsonl`.
 *
 * @module
 */

import { join } from "@std/path";
import type { MiddlewareHandler } from "@hono/hono";
import type { LogSink, RequestLogLine, ServerVariables } from "./types.ts";

export type { LogSink, RequestLogLine } from "./types.ts";

/**
 * Build the `requestLog` middleware. Always emits a line, even on error.
 * The line is composed *after* `next()` resolves so the response status and
 * the `error_code` set by `errorBoundary` are visible.
 */
export function requestLog(
  sink: LogSink,
  projectId: string,
): MiddlewareHandler<{ Variables: ServerVariables }> {
  return async (c, next) => {
    const startedAt = performance.now();
    const timestamp = new Date().toISOString();
    let thrown: unknown;
    try {
      await next();
    } catch (err) {
      thrown = err;
    }
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const line: RequestLogLine = {
      request_id: c.var.request_id ?? "",
      timestamp,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: durationMs,
      role: c.var.role ?? null,
      agent: c.var.agent ?? null,
      project_id: projectId,
      ...(c.var.error_code === undefined ? {} : { error_code: c.var.error_code }),
    };
    await sink.write(line);
    if (thrown !== undefined) throw thrown;
  };
}

/** Sink that writes one JSON line per request to stdout. */
export function stdoutLogSink(): LogSink {
  return {
    write(line) {
      console.log(JSON.stringify(line));
    },
  };
}

/** Sink that pushes lines onto an in-memory array. Used by tests. */
export function captureLogSink(buffer: RequestLogLine[]): LogSink {
  return {
    write(line) {
      buffer.push(line);
    },
  };
}

/**
 * Sink that appends each line to `<dir>/server-YYYY-MM-DD.jsonl`. The
 * directory is created on demand; the file is opened lazily and reused
 * within a UTC day, then rolled to a new file when the date changes.
 */
export function fileLogSink(dir: string): LogSink {
  let currentDate: string | undefined;
  let currentFile: Deno.FsFile | undefined;
  const encoder = new TextEncoder();

  async function ensureFile(date: string): Promise<Deno.FsFile> {
    if (currentDate === date && currentFile !== undefined) return currentFile;
    if (currentFile !== undefined) {
      try {
        currentFile.close();
      } catch {
        // already-closed handle: safe to ignore
      }
    }
    await Deno.mkdir(dir, { recursive: true });
    const path = join(dir, `server-${date}.jsonl`);
    currentFile = await Deno.open(path, { append: true, create: true });
    currentDate = date;
    return currentFile;
  }

  return {
    async write(line) {
      const date = line.timestamp.slice(0, 10);
      const file = await ensureFile(date);
      await file.write(encoder.encode(JSON.stringify(line) + "\n"));
    },
    close() {
      if (currentFile !== undefined) {
        try {
          currentFile.close();
        } catch {
          // already-closed handle: safe to ignore
        }
        currentFile = undefined;
        currentDate = undefined;
      }
    },
  };
}
