import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApiClient } from "../transport/ApiClientContext.tsx";
import { useEventsClient } from "../transport/EventsClientContext.tsx";
import type { EventsClientLifecycle } from "../transport/eventsClient.ts";

// Component CSS lives in `src/index.css` (centralised at the entry).

const LIFECYCLE_LABELS: Record<EventsClientLifecycle, string> = {
  connecting: "Connecting",
  connected: "Live",
  disconnected: "Disconnected",
};

export function TopNav() {
  const apiClient = useApiClient();
  const eventsClient = useEventsClient();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<EventsClientLifecycle>(eventsClient.state);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getProjectId()
      .then((id) => {
        if (!cancelled) setProjectId(id);
      })
      .catch(() => {
        // Project id remains `null` (rendered as "—") on failure; the
        // roster panel surfaces the underlying error.
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  useEffect(() => {
    return eventsClient.onLifecycle((next) => setLifecycle(next));
  }, [eventsClient]);

  return (
    <nav className="keni-top-nav" aria-label="Application navigation">
      <div className="keni-top-nav__brand">Keni</div>
      <div className="keni-top-nav__center">
        <span className="keni-top-nav__project-label">project</span>
        <code className="keni-top-nav__project-id" data-testid="topnav-project-id">
          {projectId ?? "—"}
        </code>
      </div>
      <ul className="keni-top-nav__links">
        <li>
          <Link to="/">Board</Link>
        </li>
        <li>
          <Link to="/activity">Activity</Link>
        </li>
      </ul>
      <div
        className="keni-top-nav__connection"
        data-state={lifecycle}
        data-testid="topnav-connection"
      >
        <span className="keni-top-nav__dot" aria-hidden="true" />
        <span className="keni-top-nav__connection-label">{LIFECYCLE_LABELS[lifecycle]}</span>
      </div>
    </nav>
  );
}
