import { useEffect, type ReactNode } from "react";
import { Button } from "./Button";

interface DialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  width?: number;
  title: string;
  children: ReactNode;
}

export function Dialog({ isOpen, onOpenChange, width = 520, title, children }: DialogProps) {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onOpenChange]);

  if (!isOpen) return null;
  return (
    <div className="dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onOpenChange(false); }}>
      <div className="dialog" style={{ ["--dialog-w" as string]: `${width}px` }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-header">
          <h3>{title}</h3>
          <button type="button" className="icon-btn icon-btn--sm" aria-label="Kapat" onClick={() => onOpenChange(false)}>
            ✕
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

interface AlertDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel: string;
  cancelLabel: string;
  onAction: () => void;
  loading?: boolean;
}

export function AlertDialog({ isOpen, onOpenChange, title, description, actionLabel, cancelLabel, onAction, loading }: AlertDialogProps) {
  if (!isOpen) return null;
  return (
    <div className="dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onOpenChange(false); }}>
      <div className="dialog" style={{ ["--dialog-w" as string]: "420px" }} role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="dialog-header">
          <h3>{title}</h3>
        </div>
        <div className="dialog-body">
          <p style={{ fontSize: 12, color: "var(--fg-dim)" }}>{description}</p>
          <div style={{ display: "flex", gap: 8 }}>
            <Button label={loading ? "..." : actionLabel} variant="destructive" onClick={onAction} disabled={loading} />
            <Button label={cancelLabel} variant="secondary" onClick={() => onOpenChange(false)} disabled={loading} />
          </div>
        </div>
      </div>
    </div>
  );
}
