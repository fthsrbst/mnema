export function Tag({ children, variant = "default", solid = false }: { children: React.ReactNode; variant?: "default" | "accent" | "danger" | "warn"; solid?: boolean }) {
  const cls = ["tag", variant !== "default" && `tag--${variant}`, solid && "tag--solid"].filter(Boolean).join(" ");
  return <span className={cls}>{children}</span>;
}

export function StatusDot({ variant = "neutral", label, pulsing }: { variant?: "neutral" | "success" | "error" | "warning"; label: string; pulsing?: boolean }) {
  return (
    <span className={`status-dot${pulsing ? " status-dot--pulsing" : ""}`} data-variant={variant}>
      <span className="status-dot-mark" />
      {label}
    </span>
  );
}

export function LivePill({ children }: { children: React.ReactNode }) {
  return (
    <span className="live-pill">
      <span className="live-dot" />
      {children}
    </span>
  );
}
