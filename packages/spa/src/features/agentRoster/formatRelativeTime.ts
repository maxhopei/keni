/**
 * Format an ISO 8601 timestamp as a relative-time string for the agent
 * roster cards.
 *
 * Bands (per the `spa-agent-roster` capability spec):
 *
 *   `< 5 s`     → `"now"`
 *   `< 60 s`    → `"Ns ago"`
 *   `< 3600 s`  → `"Nm ago"`
 *   `< 86400 s` → `"Nh ago"`
 *   otherwise   → `"Nd ago"`
 *
 * A future-dated `iso` returns `"now"` so a small clock skew between the
 * server and the browser does not surface as a confusing `-3s ago`.
 */
export function formatRelativeTime(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  const deltaSeconds = Math.floor((now.getTime() - then) / 1000);
  if (deltaSeconds < 5) return "now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86400)}d ago`;
}
