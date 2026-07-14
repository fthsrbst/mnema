import type { CSSProperties, ReactNode } from "react";

export function Heading({
  level = 3,
  children,
  className,
  style,
}: {
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const Tag = `h${level}` as const;
  const sizes: Record<number, string> = {
    1: "28px",
    2: "22px",
    3: "18px",
    4: "14px",
    5: "12px",
    6: "11px",
  };
  return (
    <Tag className={className} style={{ fontSize: sizes[level], lineHeight: 1.3, ...style }}>
      {children}
    </Tag>
  );
}

export function Text({
  children,
  type = "default",
  color = "primary",
  className,
  style,
}: {
  children?: ReactNode;
  type?: "default" | "supporting";
  color?: "primary" | "secondary" | "disabled" | "inherit";
  className?: string;
  style?: CSSProperties;
}) {
  const colorVar =
    color === "secondary" ? "var(--fg-dim)" : color === "disabled" ? "var(--fg-faint)" : color === "inherit" ? "inherit" : "var(--fg)";
  return (
    <span
      className={className}
      style={{
        fontSize: type === "supporting" ? "11px" : "13px",
        color: colorVar,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
