import { createContext } from "react";

export type ToastFn = (opts: { body: string; type?: "info" | "error"; uniqueID?: string }) => void;

export const ToastContext = createContext<ToastFn | null>(null);
