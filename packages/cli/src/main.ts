/**
 * `@keni/cli` entry point — argv dispatcher for the `keni` command.
 *
 * Subcommands:
 *
 * - `keni init [path]` — initialise a Keni project (this change).
 * - `keni --help` / `-h` / no subcommand — print help.
 *
 * Future subcommands (notably `keni start`, lands in step 13) plug in here.
 *
 * The dispatcher is deliberately thin: it wraps the subcommand call in one
 * top-level `try/catch` that translates typed errors into the documented
 * exit codes (see `init/errors.ts`):
 *
 * | Exit | Cause |
 * | ---- | ----- |
 * | 0    | success or idempotent no-op |
 * | 1    | filesystem / git / project-state failure |
 * | 2    | usage error (unknown subcommand, bad argv) |
 *
 * The dispatcher does **not** call `Deno.exit` from inside `runInit`;
 * `runInit` returns a number and we exit at the top level so tests can drive
 * the dispatcher in-process via {@link runDispatcher}.
 *
 * @module
 */

import {
  GitOperationError,
  InitTargetError,
  ProjectStateError,
  UsageError,
} from "./init/errors.ts";
import {
  formatGitFailure,
  formatHelp,
  formatMalformedProjectYaml,
  formatUnwritableTarget,
  formatUsageError,
} from "./init/messages.ts";
import { parseInitArgs, runInit } from "./init/mod.ts";

/** Re-export so consumers can still import the package name. */
export const packageName = "@keni/cli";

/** Stdout / stderr writers, abstracted so tests can capture them. */
export interface DispatcherIO {
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

/**
 * Run the dispatcher against the supplied argv. Returns the process exit
 * code; never calls `Deno.exit`. Tests pass capturing writers via `io`.
 */
export async function runDispatcher(
  argv: readonly string[],
  io?: DispatcherIO,
): Promise<number> {
  const out = io?.out ?? ((m) => console.log(m));
  const err = io?.err ?? ((m) => console.error(m));

  const [subcommand, ...rest] = argv;

  try {
    switch (subcommand) {
      case undefined:
      case "--help":
      case "-h":
        out(formatHelp());
        return 0;
      case "init": {
        const opts = parseInitArgs(rest);
        return await runInit(opts, { out, err });
      }
      default:
        err(formatUsageError(`unknown subcommand: ${subcommand}`));
        out(formatHelp());
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(formatUsageError(e.message));
      out(formatHelp());
      return 2;
    }
    if (e instanceof InitTargetError) {
      err(formatUnwritableTarget({
        targetDir: e.targetDir,
        reason: e.reason,
        ...(e.osError !== undefined ? { osError: e.osError } : {}),
      }));
      return 1;
    }
    if (e instanceof GitOperationError) {
      err(formatGitFailure({
        command: e.command,
        stderr: e.stderr,
        exitCode: e.exitCode,
      }));
      return 1;
    }
    if (e instanceof ProjectStateError) {
      err(formatMalformedProjectYaml({
        path: e.path ?? "(unknown path)",
        underlyingMessage: e.message,
      }));
      return 1;
    }
    err(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await runDispatcher(Deno.args);
  Deno.exit(code);
}
