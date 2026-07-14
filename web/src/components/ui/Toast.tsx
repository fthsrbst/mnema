import { useCallback, useRef, useState, type ReactNode } from "react";
import { ToastContext, type ToastFn } from "./ToastContext";

interface ToastItem {
  id: number;
  body: string;
  type: "info" | "error";
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const uniqueRef = useRef<Map<string, number>>(new Map());

  const push = useCallback<ToastFn>(({ body, type = "info", uniqueID }) => {
    const id = ++idRef.current;
    if (uniqueID) {
      const prev = uniqueRef.current.get(uniqueID);
      if (prev) setItems((cur) => cur.filter((t) => t.id !== prev));
      uniqueRef.current.set(uniqueID, id);
    }
    setItems((cur) => [...cur, { id, body, type }]);
    setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-stack">
        {items.map((t) => (
          <div key={t.id} className="toast u-flicker-in" data-type={t.type}>
            <span>{t.type === "error" ? "!" : ">"}</span>
            <span>{t.body}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
