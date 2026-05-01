/**
 * In-memory `ConfigStore` adapter.
 *
 * @module
 */

import { StoreNotFoundError } from "../errors.ts";
import type { ConfigStore, GlobalConfig, ProjectConfig, ResolvedConfig } from "./interface.ts";

/**
 * In-memory `ConfigStore`. Constructor accepts optional initial values; use
 * `seedGlobalConfig` to set the global config from tests.
 *
 * Behavioural equivalence with `FileConfigStore` enforced by
 * `./contract_test.ts`.
 */
export class InMemoryConfigStore implements ConfigStore {
  #project: ProjectConfig | null;
  #globalConfig: GlobalConfig;

  constructor(initial?: {
    project?: ProjectConfig;
    global?: GlobalConfig;
  }) {
    this.#project = initial?.project ?? null;
    this.#globalConfig = initial?.global ?? {};
  }

  /** Test helper — seed or replace the in-memory global config. */
  seedGlobalConfig(globalConfig: GlobalConfig): void {
    this.#globalConfig = { ...globalConfig };
  }

  readProjectConfig(): Promise<ProjectConfig> {
    if (this.#project === null) {
      return Promise.reject(new StoreNotFoundError("project.yaml"));
    }
    return Promise.resolve(deepClone(this.#project));
  }

  readGlobalConfig(): Promise<GlobalConfig> {
    return Promise.resolve(deepClone(this.#globalConfig));
  }

  async resolve(): Promise<ResolvedConfig> {
    const project = await this.readProjectConfig();
    const globalConfig = await this.readGlobalConfig();
    return { ...globalConfig, ...project };
  }

  writeProjectConfig(config: ProjectConfig): Promise<void> {
    this.#project = deepClone(config);
    return Promise.resolve();
  }
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}
