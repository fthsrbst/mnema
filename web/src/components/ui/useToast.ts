import { useContext } from "react";
import { ToastContext, type ToastFn } from "./ToastContext";

export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
