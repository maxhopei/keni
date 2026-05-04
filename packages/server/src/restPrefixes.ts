/**
 * `REST_PREFIXES` — closed allowlist of HTTP path prefixes owned by the
 * orchestration server's REST and WebSocket route groups.
 *
 * Consumed by the static SPA route group (per the `orchestration-server`
 * capability spec) to decide whether an unmatched GET path falls through
 * to `index.html` (so `react-router-dom`'s `BrowserRouter` can re-mount
 * a deep link). Adding a new REST prefix is a code change to this
 * constant by design — that prevents a future contributor from
 * accidentally swallowing a new endpoint into the SPA fallthrough.
 *
 * The order of entries is the order of registration in `createServer`;
 * the value's identity (`as const`) keeps it usable as a discriminated
 * union element by future TypeScript code.
 *
 * @module
 */

export const REST_PREFIXES = [
  "/agents",
  "/tickets",
  "/prs",
  "/activity",
  "/health",
  "/events",
] as const;

/**
 * Element type of {@link REST_PREFIXES} — useful for type-narrowing in
 * future code that wants to type-check a path against the allowlist.
 */
export type RestPrefix = typeof REST_PREFIXES[number];

/**
 * Return `true` when `pathname` starts with any prefix in
 * {@link REST_PREFIXES}. Used by the SPA fallthrough handler to decide
 * whether to serve `index.html`.
 *
 * The check is pathname-only (no query string, no fragment); callers
 * pass the URL's `pathname` field. A path that exactly equals a prefix
 * is considered a match (e.g., `/agents` matches `"/agents"`); a path
 * that has a longer prefix continuation also matches (e.g.,
 * `/agents/alice/pause` matches `"/agents"`).
 */
export function isRestPrefixed(pathname: string): boolean {
  for (const prefix of REST_PREFIXES) {
    if (pathname === prefix) return true;
    if (pathname.startsWith(prefix + "/")) return true;
  }
  return false;
}
