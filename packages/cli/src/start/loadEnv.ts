/**
 * Minimal `.env` loader for `keni start`.
 *
 * Parses `<projectDir>/.env` (when present) per a single-line regex:
 *
 * ```
 * /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
 * ```
 *
 * Strips surrounding double quotes from the value. Ignores blank lines
 * and lines whose first non-whitespace character is `#`. Multiline
 * values, variable interpolation (`${VAR}`), and command substitution
 * are NOT supported (the spec calls this out: do not invent semantics).
 *
 * Malformed lines are warn-logged via the supplied `LogSink` (when
 * present) and skipped. The function returns the parsed map; the caller
 * (`runStart`) overlays it onto the process env via {@link applyEnvOverlay}.
 *
 * @module
 */

import { join } from "@std/path";

/** Sink for warn-level messages from the parser. */
export interface EnvLoaderLogSink {
  warn(message: string): void;
}

/** Inputs for {@link loadEnvFile}. */
export interface LoadEnvFileInput {
  readonly projectDir: string;
  readonly logSink?: EnvLoaderLogSink;
}

/**
 * Read and parse `<projectDir>/.env`. Returns `{}` when the file is
 * absent (no warn). Malformed lines warn-log + skip. The total parser
 * surface is intentionally tiny: the spec promises "minimal" semantics.
 */
export async function loadEnvFile(
  input: LoadEnvFileInput,
): Promise<Record<string, string>> {
  const path = join(input.projectDir, ".env");
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return {};
    throw e;
  }

  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  const lineRe = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const m = lineRe.exec(trimmed);
    if (m === null) {
      input.logSink?.warn(`Skipping malformed .env line ${i + 1}: ${raw}`);
      continue;
    }
    const key = m[1]!;
    const value = stripDoubleQuotes(m[2]!);
    result[key] = value;
  }
  return result;
}

/**
 * Process-env interface for {@link applyEnvOverlay}. Default is the
 * `Deno.env` namespace; tests pass an in-memory `Map`-backed stub.
 */
export interface EnvLike {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/**
 * Apply parsed `.env` values to the process env, calling-shell-wins:
 * a key already present in the env is left alone. The function is
 * synchronous because the underlying `Deno.env` API is synchronous.
 */
export function applyEnvOverlay(
  parsed: Record<string, string>,
  env?: EnvLike,
): void {
  const target = env ?? defaultEnv();
  for (const [key, value] of Object.entries(parsed)) {
    if (target.get(key) === undefined) target.set(key, value);
  }
}

/** Build an `EnvLike` adapter over `Deno.env`. */
export function defaultEnv(): EnvLike {
  return {
    get: (k) => Deno.env.get(k),
    set: (k, v) => Deno.env.set(k, v),
  };
}

/** Build an in-memory `EnvLike` for tests. */
export function inMemoryEnv(seed: Record<string, string> = {}): EnvLike {
  const map = new Map(Object.entries(seed));
  return {
    get: (k) => map.get(k),
    set: (k, v) => {
      map.set(k, v);
    },
  };
}

function stripDoubleQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}
