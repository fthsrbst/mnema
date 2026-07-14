import type { CSSProperties, ReactNode } from "react";

interface PanelProps {
  children?: ReactNode;
  variant?: "default" | "danger" | "accent";
  raised?: boolean;
  ticked?: boolean;
  padded?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Card yerine geçen temel yüzey — köşesiz, ince kenarlıklı panel. */
export function Panel({ children, variant = "default", raised = false, ticked = false, padded = true, className, style }: PanelProps) {
  const cls = [
    "panel",
    variant === "danger" && "panel--danger",
    variant === "accent" && "panel--accent",
    raised && "panel--raised",
    ticked && "panel--ticked",
    padded && "panel--pad",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} style={style}>
      {children}
    </div>
  );
}
