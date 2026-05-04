/**
 * Renders the `refs` map on an `ActivityEntryResponse` as a row of
 * key/value pairs. The three documented keys (`ticket`, `pr`,
 * `change_request`) render per the `spa-activity-log` capability:
 *
 *   - `ticket` / `pr` — clickable `<Link>` to the detail route
 *   - `change_request` — plain text (step 24 wires the link)
 *   - any other key — plain text
 *
 * Pure component; no state, no side effects.
 */

import { Link } from "react-router-dom";

export interface ActivityRefsProps {
  readonly refs: Readonly<Record<string, string>>;
}

export function ActivityRefs({ refs }: ActivityRefsProps) {
  const entries = Object.entries(refs);
  if (entries.length === 0) return null;
  return (
    <span className="keni-activity-refs" data-testid="activity-refs">
      {entries.map(([key, value]) => (
        <span key={key} className="keni-activity-refs__item">
          {renderOne(key, value)}
        </span>
      ))}
    </span>
  );
}

function renderOne(key: string, value: string) {
  if (key === "ticket") {
    return (
      <Link
        to={`/tickets/${value}`}
        data-testid={`activity-ref-ticket-${value}`}
      >
        {`ticket: ${value}`}
      </Link>
    );
  }
  if (key === "pr") {
    return (
      <Link
        to={`/prs/${value}`}
        data-testid={`activity-ref-pr-${value}`}
      >
        {`pr: ${value}`}
      </Link>
    );
  }
  return <span data-testid={`activity-ref-${key}`}>{`${key}: ${value}`}</span>;
}

export default ActivityRefs;
