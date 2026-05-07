/**
 * `@keni/runtime-po` package entry point. Stub PO role implementation.
 *
 * The package exists to prove the polymorphic role plug-in model
 * registers and ticks a second role end-to-end. The bundled
 * `wire(input)` returns an `AgentRunner` whose `precheck` always
 * resolves `{ kind: "skip", reason: "po_not_implemented" }` — no MCP
 * server is spawned, no workspace is provisioned, no coding-agent CLI
 * runs.
 *
 * @module
 */

export const packageName = "@keni/runtime-po";

export { PO_PROMPT_BODY, PO_PROMPT_NAME } from "./prompts/po.ts";
export { wire } from "./wire.ts";
