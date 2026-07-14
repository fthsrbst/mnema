import type { CSSProperties, ReactNode } from "react";

type Align = "start" | "center" | "end" | "between" | "stretch";

interface StackProps {
  children?: ReactNode;
  gap?: number;
  vAlign?: Align;
  hAlign?: Align;
  wrap?: "wrap" | "nowrap";
  className?: string;
  style?: CSSProperties;
  paddingInline?: number;
  paddingBlock?: number;
  onClick?: () => void;
}

const alignMap: Record<Align, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  stretch: "stretch",
};

function px(n: number | undefined): string | undefined {
  return n === undefined ? undefined : `${n * 4}px`;
}

export function VStack({ children, gap = 0, vAlign, hAlign, wrap, className, style, paddingInline, paddingBlock, onClick }: StackProps) {
  return (
    <div
      className={className}
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: px(gap),
        alignItems: hAlign ? alignMap[hAlign] : undefined,
        justifyContent: vAlign ? alignMap[vAlign] : undefined,
        flexWrap: wrap,
        paddingInline: px(paddingInline),
        paddingBlock: px(paddingBlock),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function HStack({ children, gap = 0, vAlign, hAlign, wrap, className, style, paddingInline, paddingBlock, onClick }: StackProps) {
  return (
    <div
      className={className}
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "row",
        gap: px(gap),
        alignItems: vAlign ? alignMap[vAlign] : undefined,
        justifyContent: hAlign ? alignMap[hAlign] : undefined,
        flexWrap: wrap,
        paddingInline: px(paddingInline),
        paddingBlock: px(paddingBlock),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Grid({
  children,
  minWidth = 260,
  gap = 4,
  className,
  style,
}: {
  children?: ReactNode;
  minWidth?: number;
  gap?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={className}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}px, 1fr))`,
        gap: px(gap),
        ...style,
      }}
    >
      {children}
    </div>
  );
}
