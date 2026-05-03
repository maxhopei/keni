import { Outlet } from "react-router-dom";
import { prototypeFlags } from "../prototypeFlags.ts";
import { TopNav } from "./TopNav.tsx";
import { AgentRosterPanel } from "../features/agentRoster/AgentRosterPanel.tsx";

// Component CSS lives in `src/index.css` (centralised so Deno-side tests
// don't try to load `.css` files; Vite bundles them via the entry import).

export interface AppShellProps {
  /**
   * Test seam: override `prototypeFlags.chatPanelEnabled`. In production
   * code the flag is always read from the prototype-flags module.
   */
  readonly chatPanelEnabledOverride?: boolean;
}

export function AppShell(props: AppShellProps) {
  const chatPanelEnabled = props.chatPanelEnabledOverride ?? prototypeFlags.chatPanelEnabled;

  return (
    <div className="keni-app-shell" data-chat-visible={chatPanelEnabled.toString()}>
      <header className="keni-app-shell__nav">
        <TopNav />
      </header>
      <aside className="keni-app-shell__roster" aria-label="Agent roster">
        <AgentRosterPanel />
      </aside>
      <main className="keni-app-shell__main">
        <Outlet />
      </main>
      {chatPanelEnabled
        ? (
          <aside className="keni-app-shell__chat" aria-label="Chat panel">
            {/* Chat panel lands in step 23. */}
          </aside>
        )
        : null}
    </div>
  );
}
