import { createHash } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";

export interface AuditEvent {
  id: number;
  request_id: string;
  actor: string;
  action: string;
  resource: string | null;
  project: string | null;
  status: number;
  metadata: Record<string, unknown>;
  previous_hash: string | null;
  event_hash: string;
  created_at: string;
}

function canonicalEvent(parts: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(parts).sort().map((key) => [key, parts[key] ?? null]));
}

function rowToAudit(row: Record<string, unknown>): AuditEvent {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.metadata ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch {
    // Integrity verification reports malformed rows without taking reads down.
  }
  return { ...(row as unknown as AuditEvent), metadata };
}

export function recordAuditEvent(input: {
  request_id: string;
  actor: string;
  action: string;
  resource?: string | null;
  project?: string | null;
  status: number;
  metadata?: Record<string, unknown>;
}): AuditEvent {
  const db = getDb();
  return db.transaction(() => {
    const previous = db.prepare("SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1").get() as
      | { event_hash: string }
      | undefined;
    const metadata = JSON.stringify(input.metadata ?? {});
    const normalized = {
      request_id: input.request_id,
      actor: input.actor,
      action: input.action,
      resource: input.resource ?? null,
      project: input.project ?? null,
      status: input.status,
      metadata,
    };
    const eventHash = createHash("sha256")
      .update(previous?.event_hash ?? "audit-genesis-v1")
      .update("\0")
      .update(canonicalEvent(normalized))
      .digest("hex");
    const info = db.prepare(
      `INSERT INTO audit_events(
         request_id, actor, action, resource, project, status, metadata,
         previous_hash, event_hash, created_at
       ) VALUES (
         @request_id, @actor, @action, @resource, @project, @status, @metadata,
         @previous_hash, @event_hash, ${NOW_MS}
       )`
    ).run({
      ...normalized,
      previous_hash: previous?.event_hash ?? null,
      event_hash: eventHash,
    });
    const id = Number(info.lastInsertRowid);
    return rowToAudit(db.prepare("SELECT * FROM audit_events WHERE id = ?").get(id) as Record<string, unknown>);
  })();
}

export function listAuditEvents(opts: {
  actor?: string;
  action?: string;
  project?: string;
  before?: string;
  limit?: number;
} = {}): AuditEvent[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.actor) (conditions.push("actor = ?"), params.push(opts.actor));
  if (opts.action) (conditions.push("action = ?"), params.push(opts.action));
  if (opts.project) (conditions.push("project = ?"), params.push(opts.project));
  if (opts.before) (conditions.push("created_at < ?"), params.push(opts.before));
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 1000));
  return (getDb().prepare(`SELECT * FROM audit_events${where} ORDER BY id DESC LIMIT ?`).all(...params) as Record<string, unknown>[])
    .map(rowToAudit);
}

export function verifyAuditChain(): { ok: boolean; checked: number; broken_at: number | null } {
  const rows = getDb().prepare("SELECT * FROM audit_events ORDER BY id").all() as Record<string, unknown>[];
  let previous: string | null = null;
  for (const row of rows) {
    const input = {
      request_id: row.request_id,
      actor: row.actor,
      action: row.action,
      resource: row.resource,
      project: row.project,
      status: row.status,
      metadata: String(row.metadata ?? "{}"),
    };
    const expected: string = createHash("sha256")
      .update(previous ?? "audit-genesis-v1")
      .update("\0")
      .update(canonicalEvent(input))
      .digest("hex");
    if (row.previous_hash !== previous || row.event_hash !== expected) {
      return { ok: false, checked: rows.indexOf(row), broken_at: Number(row.id) };
    }
    previous = String(row.event_hash);
  }
  return { ok: true, checked: rows.length, broken_at: null };
}
