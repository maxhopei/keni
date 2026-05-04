/**
 * Filesystem path to the engineer MCP server's direct-invocation entry
 * point (`packages/server/src/mcp/main.ts`).
 *
 * Resolved against `import.meta.url` so the constant is correct
 * regardless of the caller's current working directory. The engineer's
 * `mcpServerConfig` (built by `buildEngineerMcpServerConfig` from
 * `@keni/role-runtimes`) takes this path verbatim and spawns
 * `deno run -A <MCP_ENTRY_PATH> --agent <id> --server-url <url>
 * --workspace <abs-path>` per cycle.
 *
 * **Dev-mode-only.** This constant assumes `@keni/server` is being
 * loaded from disk as TypeScript source (the prototype's runtime
 * model). A future binary-packaging change SHALL replace it with an
 * embedded-asset extractor — `import.meta.url` inside a single-binary
 * distribution resolves into the binary's virtual filesystem, not a
 * real path; the `Deno.Command` spawn would then fail with `ENOENT`.
 *
 * @module
 */

/**
 * Absolute filesystem path to `packages/server/src/mcp/main.ts`.
 * Resolved at module-evaluation time against the `@keni/server`
 * package's source layout via `import.meta.url`.
 */
export const MCP_ENTRY_PATH: string = new URL("./mcp/main.ts", import.meta.url).pathname;
