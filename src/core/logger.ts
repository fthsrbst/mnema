/**
 * Structured logger with levels. Minimal replacement for console.log
 * with timestamps, levels, and optional context.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = (process.env.HUB_LOG_LEVEL as LogLevel) || "info";
if (!LEVEL_PRIORITY[currentLevel]) currentLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function formatMessage(level: LogLevel, message: string, context?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const ctx = context ? ` ${JSON.stringify(context)}` : "";
  return `[${ts}] [${level.toUpperCase()}] ${message}${ctx}`;
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY.debug) {
      console.debug(formatMessage("debug", message, context));
    }
  },
  info(message: string, context?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY.info) {
      console.info(formatMessage("info", message, context));
    }
  },
  warn(message: string, context?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY.warn) {
      console.warn(formatMessage("warn", message, context));
    }
  },
  error(message: string, context?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY.error) {
      console.error(formatMessage("error", message, context));
    }
  },
};
