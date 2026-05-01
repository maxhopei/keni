/**
 * File-backed `ConfigStore` adapter — reads / writes
 * `<root>/.keni/project.yaml` and `~/.keni/config.yaml` per `spec.md` §5.1
 * and §5.2.
 *
 * @module
 */

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { writeFileAtomic } from "../atomic.ts";
import { InvalidArtifactError, StoreNotFoundError } from "../errors.ts";
import type { GlobalPaths, ProjectPaths } from "../paths.ts";
import type { ConfigStore, GlobalConfig, ProjectConfig, ResolvedConfig } from "./interface.ts";

/**
 * File-backed `ConfigStore`. See `./interface.ts` for the contract;
 * behavioural equivalence with `InMemoryConfigStore` enforced by
 * `./contract_test.ts`.
 */
export class FileConfigStore implements ConfigStore {
  readonly #projectPath: string;
  readonly #globalPath: string;

  constructor(
    projectPaths: Pick<ProjectPaths, "projectConfig">,
    globalPaths: Pick<GlobalPaths, "globalConfig">,
  ) {
    this.#projectPath = projectPaths.projectConfig;
    this.#globalPath = globalPaths.globalConfig;
  }

  async readProjectConfig(): Promise<ProjectConfig> {
    let raw: string;
    try {
      raw = await Deno.readTextFile(this.#projectPath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        throw new StoreNotFoundError("project.yaml", this.#projectPath);
      }
      throw err;
    }
    return parseConfig<ProjectConfig>(raw, this.#projectPath);
  }

  async readGlobalConfig(): Promise<GlobalConfig> {
    let raw: string;
    try {
      raw = await Deno.readTextFile(this.#globalPath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return {};
      throw err;
    }
    return parseConfig<GlobalConfig>(raw, this.#globalPath);
  }

  async resolve(): Promise<ResolvedConfig> {
    const [project, globalConfig] = await Promise.all([
      this.readProjectConfig(),
      this.readGlobalConfig(),
    ]);
    return { ...globalConfig, ...project };
  }

  async writeProjectConfig(config: ProjectConfig): Promise<void> {
    const yaml = stringifyYaml(config as unknown as Record<string, unknown>);
    await writeFileAtomic(this.#projectPath, yaml);
  }

  async writeGlobalConfig(config: GlobalConfig): Promise<void> {
    const yaml = stringifyYaml(config as unknown as Record<string, unknown>);
    await writeFileAtomic(this.#globalPath, yaml);
  }
}

function parseConfig<T>(raw: string, path: string): T {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new InvalidArtifactError(
      "malformed_yaml",
      `Failed to parse YAML config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      path,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidArtifactError(
      "invalid_config_shape",
      `Config at ${path} must be a YAML mapping at the top level`,
      path,
    );
  }
  return parsed as T;
}
