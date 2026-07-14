import { useState, type ReactNode } from "react";

export function Collapsible({ trigger, children, defaultOpen = false }: { trigger: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" className="collapsible-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="collapsible-caret" data-open={open}>▶</span>
        {trigger}
      </button>
      {open && <div style={{ paddingTop: 8 }}>{children}</div>}
    </div>
  );
}
