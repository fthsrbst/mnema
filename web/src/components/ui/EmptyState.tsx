export function EmptyState({ title, description, art }: { title: string; description?: string; art?: string }) {
  return (
    <div className="empty-state">
      <pre>{art ?? DEFAULT_ART}</pre>
      <span className="empty-state-title">{title}</span>
      {description && <span style={{ fontSize: 12, color: "var(--fg-dim)", maxWidth: 420 }}>{description}</span>}
    </div>
  );
}

const DEFAULT_ART = String.raw`
+--------------------+
|  ░░░░░░░░░░░░░░░░  |
|  ░░░░░░░░░░░░░░░░  |
|  ░░  NO DATA  ░░░  |
|  ░░░░░░░░░░░░░░░░  |
+--------------------+
`;
