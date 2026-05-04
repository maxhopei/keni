/**
 * Argv parser for `keni start`.
 *
 * Accepts the following surface (full grammar is the `cli-start`
 * capability spec's "Argv parsing" requirement):
 *
 * ```
 * keni start [path]
 *            [--project <path>]
 *            [--port <n>] | [--port-range <a>-<b>]
 *            [--host <h>]
 *            [--spa-dev-url <url>] | [--spa-bundle <path>]
 *            [--shutdown-grace-ms <n>]
 * ```
 *
 * Positional `[path]` wins over `--project`; supplying both produces a
 * warn-level log line via the IO writer and the positional value is
 * used. Malformed `--port` / `--port-range` / `--shutdown-grace-ms`
 * values throw {@link UsageError} (which the dispatcher in `main.ts`
 * surfaces as exit code 2).
 *
 * @module
 */

import { resolve } from "@std/path";
import { UsageError } from "../init/errors.ts";

/** Closed shape of the parsed argv. Pure data — no I/O references. */
export interface ParsedStartArgs {
  /**
   * Resolved absolute path to the project directory. The dispatcher passes
   * `cwd` when neither `[path]` nor `--project` are supplied.
   */
  readonly projectDir: string;
  /** Optional explicit single-port pin (`--port n`). */
  readonly portPin?: number;
  /** Optional explicit port range (`--port-range a-b`). */
  readonly portRange?: { readonly start: number; readonly end: number };
  /** Optional bind host. Defaults to the merged-config value when unset. */
  readonly host?: string;
  /** Optional dev-mode SPA URL (`--spa-dev-url`). */
  readonly spaDevUrl?: string;
  /** Optional explicit bundle path (`--spa-bundle`). */
  readonly spaBundle?: string;
  /** Optional shutdown grace override (`--shutdown-grace-ms n`). */
  readonly shutdownGraceMs?: number;
  /**
   * Set to `true` when the user supplied BOTH a positional `[path]` and
   * `--project <path>`. The dispatcher emits a warn-level log line in
   * this case (`[path]` wins).
   */
  readonly positionalAndFlagBoth: boolean;
}

/**
 * Parse the rest-of-argv after `start`. Throws {@link UsageError} on shape
 * problems (unknown flag, malformed numeric value).
 */
export function parseStartArgs(rest: readonly string[]): ParsedStartArgs {
  let positional: string | undefined;
  let projectFlag: string | undefined;
  let portPin: number | undefined;
  let portRange: { start: number; end: number } | undefined;
  let host: string | undefined;
  let spaDevUrl: string | undefined;
  let spaBundle: string | undefined;
  let shutdownGraceMs: number | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      if (positional !== undefined) {
        throw new UsageError(
          `keni start takes at most one positional argument: the project directory (got '${arg}')`,
        );
      }
      positional = arg;
      continue;
    }
    const [key, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    const consume = (): string => {
      if (inline !== undefined) return inline;
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`Flag ${key} requires a value`);
      }
      i++;
      return next;
    };

    switch (key) {
      case "--project":
        projectFlag = consume();
        break;
      case "--port": {
        const raw = consume();
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 1 || n > 65535 || `${n}` !== raw.trim()) {
          throw new UsageError(
            `--port must be an integer between 1 and 65535 (got '${raw}')`,
          );
        }
        portPin = n;
        break;
      }
      case "--port-range": {
        const raw = consume();
        const m = /^(\d+)-(\d+)$/.exec(raw);
        if (m === null) {
          throw new UsageError(
            `--port-range must be of the form '<start>-<end>' (got '${raw}')`,
          );
        }
        const start = Number.parseInt(m[1]!, 10);
        const end = Number.parseInt(m[2]!, 10);
        if (start < 1 || end > 65535 || start > end) {
          throw new UsageError(
            `--port-range bounds must satisfy 1 ≤ start ≤ end ≤ 65535 (got '${raw}')`,
          );
        }
        portRange = { start, end };
        break;
      }
      case "--host":
        host = consume();
        break;
      case "--spa-dev-url":
        spaDevUrl = consume();
        break;
      case "--spa-bundle":
        spaBundle = consume();
        break;
      case "--shutdown-grace-ms": {
        const raw = consume();
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 0 || `${n}` !== raw.trim()) {
          throw new UsageError(
            `--shutdown-grace-ms must be a non-negative integer (got '${raw}')`,
          );
        }
        shutdownGraceMs = n;
        break;
      }
      default:
        throw new UsageError(`Unknown flag: ${key}`);
    }
  }

  if (portPin !== undefined && portRange !== undefined) {
    throw new UsageError(
      "--port and --port-range are mutually exclusive; supply at most one",
    );
  }
  if (spaDevUrl !== undefined && spaBundle !== undefined) {
    throw new UsageError(
      "--spa-dev-url and --spa-bundle are mutually exclusive; supply at most one",
    );
  }

  const projectChoice = positional ?? projectFlag ?? Deno.cwd();
  const projectDir = resolve(projectChoice);

  return {
    projectDir,
    ...(portPin !== undefined ? { portPin } : {}),
    ...(portRange !== undefined ? { portRange } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(spaDevUrl !== undefined ? { spaDevUrl } : {}),
    ...(spaBundle !== undefined ? { spaBundle } : {}),
    ...(shutdownGraceMs !== undefined ? { shutdownGraceMs } : {}),
    positionalAndFlagBoth: positional !== undefined && projectFlag !== undefined,
  };
}
