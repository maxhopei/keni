import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <div
      data-testid="not-found"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        gap: "var(--keni-space-3)",
        background: "var(--keni-color-bg)",
        color: "var(--keni-color-text)",
      }}
    >
      <h1 style={{ margin: 0, fontSize: 32 }}>404</h1>
      <p style={{ margin: 0, color: "var(--keni-color-text-muted)" }}>
        We could not find that page.
      </p>
      <Link to="/">Back to dashboard</Link>
    </div>
  );
}
