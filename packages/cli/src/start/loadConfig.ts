/**
 * Layered configuration loader for `keni start`.
 *
 * Reads `~/.keni/config.yaml` (when present) and `<projectDir>/.keni/project.yaml`
 * (REQUIRED — throws {@link ProjectStateError} on absence) and shallow-merges
 * the documented `KeniStartConfig` keys with project-wins precedence.
 *
 * The CLI flag overlay (`applyFlagOverrides`) is a separate function so the
 * merge stays pure and the flag interpretation is testable without
 * touching the filesystem.
 *
 * @module
 */

import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { type ProjectConfig, resolveGlobalPaths, resolveProjectPaths } from "@keni/shared";
import { ProjectStateError } from "../init/errors.ts";
import type { ParsedStartArgs } from "./args.ts";

/** Resolved start-time configuration. */
export interface KeniStartConfig {
  /** Inclusive port range to walk on bind. Default: `{ start: 7777, end: 7787 }`. */
  readonly port_range: { readonly start: number; readonly end: number };
  /** Bind host. Default: `127.0.0.1`. */
  readonly host: string;
  /** Graceful-shutdown grace window in ms. Default: `2_000`. Hard-cap: `10_000`. */
  readonly shutdown_grace_ms: number;
  /** SPA-serving mode. */
  readonly spa: SpaSection;
}

/** SPA section of the merged config. */
export type SpaSection =
  | { readonly mode: "bundled"; readonly bundle?: string }
  | { readonly mode: "dev"; readonly dev_url: string };

/** Loader output. */
export interface LoadedKeniConfig {
  readonly projectConfig: ProjectConfig;
  readonly startConfig: KeniStartConfig;
}

/** Inputs for {@link loadKeniConfig}. */
export interface LoadKeniConfigInput {
  readonly projectDir: string;
  readonly homeDir: string;
}

const DEFAULT_PORT_RANGE = { start: 7777, end: 7787 } as const;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const DEFAULT_SPA: SpaSection = { mode: "bundled" };

/**
 * Load and merge global + project YAML files into a {@link KeniStartConfig}.
 * The project YAML is REQUIRED (throws `ProjectStateError`); the global
 * YAML is optional (treated as `{}` when absent).
 *
 * Top-level keys are REPLACED, not deep-merged: a project YAML that
 * specifies `port_range` overrides the global YAML's value verbatim
 * even if it sets only one of `start` / `end`.
 *
 * @throws {ProjectStateError} when `<projectDir>/.keni/project.yaml` is missing.
 */
export async function loadKeniConfig(input: LoadKeniConfigInput): Promise<LoadedKeniConfig> {
  const projectPaths = resolveProjectPaths(input.projectDir);
  const globalPaths = resolveGlobalPaths(input.homeDir);

  const projectYaml = await readYamlOrNull(projectPaths.projectConfig);
  if (projectYaml === null) {
    throw new ProjectStateError(
      "missing_project_yaml",
      `No .keni/project.yaml found at ${projectPaths.projectConfig}; run \`keni init\` first.`,
      projectPaths.projectConfig,
    );
  }
  // The runtime payload is validated structurally elsewhere (the
  // `ConfigStore` performs zod validation on the same file). This
  // loader's responsibility is the start-time config layering, not
  // the on-disk schema; a stricter validator runs inside `runServer`.
  const projectConfig = projectYaml as unknown as ProjectConfig;

  const globalYaml = await readYamlOrNull(globalPaths.globalConfig);

  const startConfig = mergeStartConfig(globalYaml ?? {}, projectYaml);
  return { projectConfig, startConfig };
}

/**
 * Apply the parsed CLI flags on top of the merged file-based config.
 * Pure — does no I/O.
 */
export function applyFlagOverrides(
  base: KeniStartConfig,
  flags: ParsedStartArgs,
): KeniStartConfig {
  let portRange = base.port_range;
  if (flags.portPin !== undefined) {
    portRange = { start: flags.portPin, end: flags.portPin };
  } else if (flags.portRange !== undefined) {
    portRange = { start: flags.portRange.start, end: flags.portRange.end };
  }

  const host = flags.host ?? base.host;

  let spa = base.spa;
  if (flags.spaDevUrl !== undefined) {
    spa = { mode: "dev", dev_url: flags.spaDevUrl };
  } else if (flags.spaBundle !== undefined) {
    spa = { mode: "bundled", bundle: flags.spaBundle };
  }

  const shutdownGraceMs = flags.shutdownGraceMs ?? base.shutdown_grace_ms;

  return {
    port_range: portRange,
    host,
    shutdown_grace_ms: shutdownGraceMs,
    spa,
  };
}

/**
 * Merge the documented top-level keys from two YAML objects with the
 * project YAML winning. Unknown top-level keys are silently ignored
 * (the file may carry future-additive keys this prototype does not yet
 * understand).
 */
function mergeStartConfig(
  global: Record<string, unknown>,
  project: Record<string, unknown>,
): KeniStartConfig {
  const portRange = pickPortRange(project) ?? pickPortRange(global) ?? DEFAULT_PORT_RANGE;
  const host = pickString(project, "host") ?? pickString(global, "host") ?? DEFAULT_HOST;
  const shutdownGraceMs = pickInt(project, "shutdown_grace_ms") ??
    pickInt(global, "shutdown_grace_ms") ??
    DEFAULT_SHUTDOWN_GRACE_MS;
  const spa = pickSpa(project) ?? pickSpa(global) ?? DEFAULT_SPA;
  return {
    port_range: portRange,
    host,
    shutdown_grace_ms: shutdownGraceMs,
    spa,
  };
}

function pickPortRange(
  obj: Record<string, unknown>,
): { start: number; end: number } | undefined {
  const v = obj["port_range"];
  if (v === undefined || v === null || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const start = typeof r["start"] === "number" ? r["start"] : undefined;
  const end = typeof r["end"] === "number" ? r["end"] : undefined;
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function pickInt(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function pickSpa(obj: Record<string, unknown>): SpaSection | undefined {
  const v = obj["spa"];
  if (v === undefined || v === null || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const mode = r["mode"];
  if (mode === "dev" && typeof r["dev_url"] === "string") {
    return { mode: "dev", dev_url: r["dev_url"] };
  }
  if (mode === "bundled") {
    const bundle = typeof r["bundle"] === "string" ? r["bundle"] : undefined;
    return bundle !== undefined ? { mode: "bundled", bundle } : { mode: "bundled" };
  }
  return undefined;
}

async function readYamlOrNull(path: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await Deno.readTextFile(path);
    const parsed = parseYaml(text);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ProjectStateError(
        "malformed_yaml",
        `Expected a mapping at the top level of ${path}; got ${typeof parsed}`,
        path,
      );
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    if (e instanceof ProjectStateError) throw e;
    throw new ProjectStateError(
      "malformed_yaml",
      `Could not parse ${path}: ${e instanceof Error ? e.message : String(e)}`,
      path,
    );
  }
}

// Local re-export so callers do not need to import from `@std/path`.
export { join };
