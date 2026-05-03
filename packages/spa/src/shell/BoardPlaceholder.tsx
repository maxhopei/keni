export function BoardPlaceholder() {
  return (
    <div
      data-testid="board-placeholder"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "var(--keni-color-text-muted)",
        fontSize: 16,
      }}
    >
      Kanban board lands in step 11.
    </div>
  );
}
