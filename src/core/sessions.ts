import { randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import { recordDeletion } from "./sync.js";
import type { SessionLog } from "./types.js";

export function addSessionLog(summary: string, project?: string, source?: string): SessionLog {
  const info = getDb()
    .prepare(`INSERT INTO session_logs(uid, project, summary, source, created_at) VALUES (?, ?, ?, ?, ${NOW_MS})`)
    .run(randomUUID().replaceAll("-", ""), project ?? null, summary, source ?? null);
  const log = getDb()
    .prepare("SELECT * FROM session_logs WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as SessionLog;
  notifyWrite();
  return log;
}

export function deleteSessionLog(id: number): boolean {
  const db = getDb();
  const row = db.prepare("SELECT uid FROM session_logs WHERE id = ?").get(id) as { uid: string } | undefined;
  const deleted = db.prepare("DELETE FROM session_logs WHERE id = ?").run(id).changes > 0;
  if (deleted && row?.uid) recordDeletion("session_logs", row.uid);
  if (deleted) notifyWrite();
  return deleted;
}

export function recentSessionLogs(opts: { project?: string; limit?: number } = {}): SessionLog[] {
  if (opts.project) {
    return getDb()
      .prepare("SELECT * FROM session_logs WHERE project = ? ORDER BY created_at DESC LIMIT ?")
      .all(opts.project, opts.limit ?? 10) as SessionLog[];
  }
  return getDb()
    .prepare("SELECT * FROM session_logs ORDER BY created_at DESC LIMIT ?")
    .all(opts.limit ?? 10) as SessionLog[];
}
