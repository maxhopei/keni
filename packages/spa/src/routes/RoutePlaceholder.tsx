import { useParams } from "react-router-dom";

export interface RoutePlaceholderProps {
  readonly title: string;
  readonly stepRef: string;
}

export default function RoutePlaceholder(props: RoutePlaceholderProps) {
  const params = useParams();
  const paramEntries = Object.entries(params).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );

  return (
    <div
      data-testid="route-placeholder"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: "var(--keni-space-2)",
        textAlign: "center",
      }}
    >
      <h1 style={{ margin: 0, fontSize: 22 }}>{props.title}</h1>
      <p style={{ margin: 0, color: "var(--keni-color-text-muted)" }}>
        This view lands in {props.stepRef}.
      </p>
      {paramEntries.length > 0
        ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
            {paramEntries.map(([key, value]) => (
              <span
                key={key}
                style={{ fontFamily: "var(--keni-font-mono)", fontSize: 13 }}
                data-testid={`route-param-${key}`}
              >
                {key}: {value}
              </span>
            ))}
          </div>
        )
        : null}
    </div>
  );
}
