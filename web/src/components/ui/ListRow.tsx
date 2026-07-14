import type { ReactNode } from "react";

export function ListRow({
  title,
  description,
  start,
  end,
  onClick,
  bordered = true,
}: {
  title: string;
  description?: string;
  start?: ReactNode;
  end?: ReactNode;
  onClick?: () => void;
  bordered?: boolean;
}) {
  return (
    <div
      className="list-row"
      onClick={onClick}
      style={{ borderTop: bordered ? "1px solid var(--border)" : undefined, cursor: onClick ? "pointer" : "default" }}
    >
      {start}
      <div className="list-row-main">
        <span className="list-row-title">{title}</span>
        {description && <span className="list-row-desc">{description}</span>}
      </div>
      {end}
    </div>
  );
}
