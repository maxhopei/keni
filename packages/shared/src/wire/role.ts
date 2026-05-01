/**
 * Role identity types for the orchestration server's HTTP surface.
 *
 * The server reads the calling role from `X-Keni-Role` and (optionally) the
 * calling agent id from `X-Keni-Agent`. The header is trusted in the
 * prototype; auth is post-MVP and slots in front of the role-identity
 * middleware without changing this contract.
 *
 * See `openspec/specs/orchestration-server/spec.md` requirement
 * "Every request carries a role identity via `X-Keni-Role` and optional
 * `X-Keni-Agent` headers".
 *
 * @module
 */

/**
 * The five Keni roles. The prototype only meaningfully exercises `user` and
 * `engineer`; `qa`, `po`, `writer` are reserved for MVP and post-MVP role
 * runtimes (`spec.md` §3 / §8 / §9).
 */
export type Role = "user" | "engineer" | "qa" | "po" | "writer";

/** Tuple form of {@link Role} — handy for runtime enums (`zod`, JSON-schema, etc.). */
export const ROLES: readonly Role[] = [
  "user",
  "engineer",
  "qa",
  "po",
  "writer",
] as const;

/** Type-guard for {@link Role}. */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Agent id — the value the role runtime stamps in `X-Keni-Agent`. Today this
 * is just a string; the brand exists to surface intent in signatures
 * (e.g., `(agent: AgentId)` rather than `(agent: string)`).
 */
export type AgentId = string & { readonly __brand: "AgentId" };
