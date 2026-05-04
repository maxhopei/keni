/**
 * `state.json` paused-agents reader and persister for `keni start`.
 *
 * `<projectDir>/.keni/state.json` is a small, additive JSON file that
 * `keni init` creates as `{}`. The `cli-start-and-end-to-end-wiring`
 * change adds the OPTIONAL `paused_agents: string[]` key so the user's
 * pause selection survives a server restart.
 *
 * Reader semantics (per the `cli-start` capability spec):
 *
 *  - File absent or `paused_agents` key absent → `[]` (no warn).
 *  - Malformed JSON or `paused_agents` not an array → `[]` (warn).
 *  - Entries not in the supplied roster → dropped with one warn line per id.
 *
 * Persister semantics:
 *
 *  - Read existing `state.json` (treat missing as `{}`).
 *  - Replace ONLY the `paused_agents` key (preserve every other top-level key).
 *  - Write atomically: write to `state.json.tmp.<pid>.<random>`, then `Deno.rename`.
 *  - Reject the returned promise on any filesystem error so the caller
 *    (the orchestration server's pause handler) can warn-log without
 *    failing the user request.
 *
 * @module
 */

import { join } from "@std/path";
import type { AgentConfig } from "@keni/shared";

/** Sink for warn-level messages from the reader. */
export interface PausedAgentsLogSink {
  warn(message: string): void;
}

/** Inputs for {@link readPausedAgents}. */
export interface ReadPausedAgentsInput {
  readonly projectDir: string;
  readonly roster: readonly AgentConfig[];
  readonly logSink?: PausedAgentsLogSink;
}

/**
 * Read the `paused_agents` key from `<projectDir>/.keni/state.json`.
 * Drops entries not in the supplied roster (warn-logs each drop).
 * Returns `[]` for absent / malformed values (warn-logs the malformed
 * case; the absent case is a no-op).
 */
export async function readPausedAgents(
  input: ReadPausedAgentsInput,
): Promise<readonly string[]> {
  const path = stateJsonPath(input.projectDir);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    input.logSink?.warn(
      `Could not parse ${path} as JSON; treating paused_agents as []. ` +
        (e instanceof Error ? e.message : String(e)),
    );
    return [];
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    input.logSink?.warn(
      `Expected an object at the top of ${path}; treating paused_agents as [].`,
    );
    return [];
  }
  const raw = (json as Record<string, unknown>)["paused_agents"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    input.logSink?.warn(
      `Expected ${path}#paused_agents to be an array; treating as [].`,
    );
    return [];
  }
  const known = new Set(input.roster.map((a) => a.id));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") {
      input.logSink?.warn(
        `Ignoring non-string entry in ${path}#paused_agents: ${JSON.stringify(entry)}`,
      );
      continue;
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (!known.has(entry)) {
      input.logSink?.warn(
        `Ignoring paused_agents entry '${entry}' (not in the project's agent roster)`,
      );
      continue;
    }
    result.push(entry);
  }
  return result;
}

/** Inputs for {@link persistPausedAgents}. */
export interface PersistPausedAgentsInput {
  readonly projectDir: string;
  readonly paused: readonly string[];
  readonly logSink?: PausedAgentsLogSink;
}

/**
 * Persist the supplied `paused` array as `state.json#paused_agents`.
 * Reads the existing file (treats missing as `{}`), replaces only the
 * `paused_agents` key (preserving every other top-level key), and
 * writes atomically via write-temp-then-rename.
 *
 * Rejects on any filesystem failure; the orchestration server catches
 * and warn-logs (per the modified `orchestration-server` requirement).
 */
export async function persistPausedAgents(input: PersistPausedAgentsInput): Promise<void> {
  const path = stateJsonPath(input.projectDir);
  let existing: Record<string, unknown> = {};
  try {
    const text = await Deno.readTextFile(path);
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    } else {
      input.logSink?.warn(
        `Existing ${path} is not a JSON object; replacing with a fresh document.`,
      );
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      input.logSink?.warn(
        `Could not parse existing ${path}; replacing with a fresh document. ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }
  const next = { ...existing, paused_agents: [...input.paused] };
  const serialised = JSON.stringify(next, null, 2) + "\n";
  await writeAtomic(path, serialised);
}

/** Build the absolute path to `<projectDir>/.keni/state.json`. */
export function stateJsonPath(projectDir: string): string {
  return join(projectDir, ".keni", "state.json");
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp.${Deno.pid}.${Math.random().toString(36).slice(2)}`;
  await Deno.writeTextFile(tmp, contents);
  try {
    await Deno.rename(tmp, path);
  } catch (e) {
    try {
      await Deno.remove(tmp);
    } catch {
      // best-effort cleanup of the tmp file
    }
    throw e;
  }
}
