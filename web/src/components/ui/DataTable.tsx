import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  width?: string;
  render: (row: T) => ReactNode;
}

/** Basit, bağımlılıksız veri tablosu — Astryx Table'ın yerine geçer. */
export function DataTable<T>({
  data,
  columns,
  rowKey,
  onRowClick,
  isRowActive,
}: {
  data: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  isRowActive?: (row: T) => boolean;
}) {
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? "data-table-row--clickable" : undefined}
              data-active={isRowActive ? isRowActive(row) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
