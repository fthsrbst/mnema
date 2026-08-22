import { randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import { recordDeletion } from "./sync.js";
import { resolveMachineName } from "./machine.js";
import type { SessionLog } from "./types.js";
import { assertProjectReference } from "./projects.js";
import { sessionInputSchema } from "./schemas.js";

export function addSessionLog(
  summary: string,
  project?: string,
  source?: string,
  originMachineOverride?: string
): SessionLog {
  const parsed = sessionInputSchema.parse({
    summary,
    project,
    source,
    origin_machine: originMachineOverride,
  });
  assertProjectReference(parsed.project, "session");
  const origin_machine = parsed.origin_machine ?? resolveMachineName();
  const info = getDb()
    .prepare(
      `INSERT INTO session_logs(uid, project, summary, source, origin_machine, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ${NOW_MS}, ${NOW_MS})`
    )
    .run(
      randomUUID().replaceAll("-", ""),
      parsed.project ?? null,
      parsed.summary,
      parsed.source ?? null,
      origin_machine
    );
  const log = getDb()
    .prepare("SELECT * FROM session_logs WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as SessionLog;
  notifyWrite();
  return log;
}

export function deleteSessionLog(id: number): boolean {
  const db = getDb();
  const row = db.prepare("SELECT uid FROM session_logs WHERE id = ?").get(id) as { uid: string } | undefined;
  // Silme + tombstone TEK işlemde — crash penceresinde kayıt peer'lardan dirilirdi.
  const deleted = db.transaction(() => {
    const ok = db.prepare("DELETE FROM session_logs WHERE id = ?").run(id).changes > 0;
    if (ok && row?.uid) recordDeletion("session_logs", row.uid);
    return ok;
  })();
  if (deleted) notifyWrite();
  return deleted;
}

export function getSessionLog(id: number): SessionLog | null {
  return (getDb().prepare("SELECT * FROM session_logs WHERE id = ?").get(id) as SessionLog | undefined) ?? null;
}

export function recentSessionLogs(opts: { project?: string; limit?: number } = {}): SessionLog[] {
  // REST "?limit=abc" → NaN → SQLite LIMIT NULL tabloyu baştan sona okurdu; sıkıştır.
  const rawLimit = Number(opts.limit);
  const limit =
    opts.limit === undefined || !Number.isFinite(rawLimit) ? 10 : Math.min(Math.max(Math.trunc(rawLimit), 1), 200);
  if (opts.project) {
    return getDb()
      .prepare("SELECT * FROM session_logs WHERE project = ? ORDER BY created_at DESC LIMIT ?")
      .all(opts.project, limit) as SessionLog[];
  }
  return getDb()
    .prepare("SELECT * FROM session_logs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as SessionLog[];
}
