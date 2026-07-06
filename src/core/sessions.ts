import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import type { SessionLog } from "./types.js";

export function addSessionLog(summary: string, project?: string, source?: string): SessionLog {
  const info = getDb()
    .prepare("INSERT INTO session_logs(uid, project, summary, source) VALUES (?, ?, ?, ?)")
    .run(randomUUID().replaceAll("-", ""), project ?? null, summary, source ?? null);
  return getDb()
    .prepare("SELECT * FROM session_logs WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as SessionLog;
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
