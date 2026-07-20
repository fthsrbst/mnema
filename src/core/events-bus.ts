/**
 * Typed event bus for hub-wide events. Replaces simple notifyWrite() for
 * structured event handling. Supports internal handlers, event log, and
 * webhook delivery integration.
 */
import { randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import type { HubEvent, HubEventType } from "./types.js";

type EventHandler = (event: HubEvent) => void;

const handlers = new Map<HubEventType | "*", EventHandler[]>();
const eventLog: HubEvent[] = [];
const MAX_LOG = 200;

/** Emit a typed hub event to all registered handlers. */
export function emitHubEvent(event: HubEvent): void {
  // Store in ring buffer
  eventLog.push(event);
  if (eventLog.length > MAX_LOG) eventLog.shift();

  // Persist to DB for cross-restart visibility
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO hub_events(uid, type, payload, created_at) VALUES (?, ?, ?, ${NOW_MS})`
    ).run(randomUUID().replaceAll("-", ""), event.type, JSON.stringify(event));
  } catch {
    // Non-critical: don't fail the write operation if event logging fails
  }

  // Dispatch to type-specific handlers
  const typeHandlers = handlers.get(event.type) ?? [];
  const wildcardHandlers = handlers.get("*") ?? [];
  for (const handler of [...typeHandlers, ...wildcardHandlers]) {
    try {
      handler(event);
    } catch (err) {
      console.error(`[hub:event-bus] handler error for ${event.type}: ${(err as Error).message}`);
    }
  }
}

/** Register a handler for a specific event type (or "*" for all). */
export function onHubEvent(type: HubEventType | "*", handler: EventHandler): () => void {
  const list = handlers.get(type) ?? [];
  list.push(handler);
  handlers.set(type, list);
  // Return unsubscribe function
  return () => {
    const arr = handlers.get(type);
    if (arr) {
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    }
  };
}

/** Get recent events from the in-memory log. */
export function getEventLog(limit = 50, type?: HubEventType): HubEvent[] {
  const filtered = type ? eventLog.filter((e) => e.type === type) : eventLog;
  return filtered.slice(-limit);
}

/** Get recent events from the database (survives restart). */
export function getEventLogDb(limit = 50, type?: HubEventType): (HubEvent & { uid: string; created_at: string })[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT uid, type, payload, created_at FROM hub_events ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, Math.min(limit, 200)) as { uid: string; type: string; payload: string; created_at: string }[];
  return rows.map((r) => ({
    ...(JSON.parse(r.payload) as HubEvent),
    uid: r.uid,
    created_at: r.created_at,
  }));
}

/** Prune old events from the database. */
export function pruneEvents(daysOld = 7): number {
  const db = getDb();
  const info = db
    .prepare(`DELETE FROM hub_events WHERE created_at < strftime('%Y-%m-%d %H:%M:%f', 'now', '-${daysOld} days')`)
    .run();
  return info.changes;
}
