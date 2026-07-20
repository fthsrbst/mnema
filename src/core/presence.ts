/**
 * Advisory agent-presence koordinasyonu: bir agent bir projede çalışmaya
 * başlarken "aktifim, şu branch'te, şu işi yapıyorum" der (agentCheckin),
 * bitince kapatır (agentCheckout). Bu bir mutual-exclusion KİLİDİ DEĞİLDİR —
 * agent'lar crash edebilir, sert kilit deadlock üretir. Bayatlık heartbeat_at +
 * HUB_PRESENCE_TTL_MIN ile ele alınır (agentActive() stale işaretler, engellemez).
 */
import { randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { config } from "./config.js";
import { resolveMachineName } from "./machine.js";
import { notifyWrite } from "./events.js";
import { recordDeletion } from "./sync.js";
import { assertProjectReference } from "./projects.js";
import { agentCheckinSchema, agentCheckoutSchema } from "./schemas.js";
import type { AgentPresence, AgentPresenceView } from "./types.js";

const PRESENCE_PRUNE_DAYS = 7;

function row(uid: string): AgentPresence | null {
  return (getDb().prepare("SELECT * FROM agent_presence WHERE uid = ?").get(uid) as AgentPresence | undefined) ?? null;
}

/** uid verilmezse yeni kayıt açar (uid döner); uid verilirse heartbeat/task/branch günceller. */
export function agentCheckin(input: unknown): AgentPresence {
  const parsed = agentCheckinSchema.parse(input);
  assertProjectReference(parsed.project, "agent_presence");
  const db = getDb();
  const machine = parsed.machine?.trim() || resolveMachineName();
  const agent = parsed.agent?.trim() || "claude-code";

  if (parsed.uid) {
    const existing = row(parsed.uid);
    if (existing) {
      db.prepare(
        `UPDATE agent_presence SET machine=@machine, agent=@agent, project=@project, branch=@branch,
         task=@task, status='active', heartbeat_at=${NOW_MS}, updated_at=${NOW_MS} WHERE uid=@uid`
      ).run({ uid: parsed.uid, machine, agent, project: parsed.project, branch: parsed.branch ?? null, task: parsed.task });
      notifyWrite();
      return row(parsed.uid)!;
    }
    // uid verilmiş ama kayıt bulunamadı (silinmiş/başka cihazda henüz sync olmamış) — aynı uid ile yeni aç.
  }
  const uid = parsed.uid ?? randomUUID().replaceAll("-", "");
  db.prepare(
    `INSERT INTO agent_presence(uid, machine, agent, project, branch, task, status, started_at, heartbeat_at, created_at, updated_at)
     VALUES (@uid, @machine, @agent, @project, @branch, @task, 'active', ${NOW_MS}, ${NOW_MS}, ${NOW_MS}, ${NOW_MS})`
  ).run({ uid, machine, agent, project: parsed.project, branch: parsed.branch ?? null, task: parsed.task });
  notifyWrite();
  return row(uid)!;
}

export function agentCheckout(input: unknown): AgentPresence | null {
  const parsed = agentCheckoutSchema.parse(input);
  const status = parsed.status ?? "done";
  const info = getDb()
    .prepare(`UPDATE agent_presence SET status=@status, finished_at=${NOW_MS}, updated_at=${NOW_MS} WHERE uid=@uid`)
    .run({ status, uid: parsed.uid });
  if (info.changes === 0) return null;
  notifyWrite();
  return row(parsed.uid);
}

/** heartbeat_at'ten geçen dakika (UTC "YYYY-MM-DD HH:MM:SS.mmm" formatı varsayılır). */
function minutesSince(ts: string): number {
  const ms = Date.now() - Date.parse(ts.replace(" ", "T") + "Z");
  return Math.max(0, Math.round(ms / 60_000));
}

export function agentActive(project?: string): AgentPresenceView[] {
  const db = getDb();
  const rows = (
    project
      ? db.prepare("SELECT * FROM agent_presence WHERE status = 'active' AND project = ? ORDER BY heartbeat_at DESC").all(project)
      : db.prepare("SELECT * FROM agent_presence WHERE status = 'active' ORDER BY heartbeat_at DESC").all()
  ) as AgentPresence[];
  const ttlMs = config.presenceTtlMin * 60_000;
  return rows.map((r) => ({ ...r, stale: Date.now() - Date.parse(r.heartbeat_at.replace(" ", "T") + "Z") > ttlMs }));
}

/** Bridge çıktısı için kısa Türkçe satırlar — stale olanlar ayrı, "muhtemelen düşmüş" notuyla. */
export function formatPresenceLines(presence: AgentPresenceView[]): string[] {
  const lines: string[] = [];
  for (const p of presence.filter((item) => !item.stale)) {
    lines.push(
      `⚠ Bu projede aktif agent var: ${p.machine} @ ${p.branch ?? "?"} — "${p.task}" (son nabız ${minutesSince(p.heartbeat_at)} dk önce)`
    );
  }
  for (const p of presence.filter((item) => item.stale)) {
    lines.push(
      `(muhtemelen düşmüş, kilit değil) ${p.machine} @ ${p.branch ?? "?"} — "${p.task}" (son nabız ${minutesSince(p.heartbeat_at)} dk önce)`
    );
  }
  return lines;
}

/** Son N saatte kapanmış (done/abandoned) kayıtlar — "son bitenler" listesi için. */
export function agentRecent(hoursInput?: number): AgentPresenceView[] {
  const hours = Number.isFinite(hoursInput) && (hoursInput as number) > 0 ? Math.min(Math.round(hoursInput as number), 24 * 30) : 24;
  const db = getDb();
  const cutoff = (
    db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f', 'now', '-${hours} hours') AS c`).get() as { c: string }
  ).c;
  const rows = db
    .prepare(
      "SELECT * FROM agent_presence WHERE status != 'active' AND COALESCE(finished_at, updated_at) >= ? ORDER BY COALESCE(finished_at, updated_at) DESC"
    )
    .all(cutoff) as AgentPresence[];
  const ttlMs = config.presenceTtlMin * 60_000;
  return rows.map((r) => ({ ...r, stale: Date.now() - Date.parse(r.heartbeat_at.replace(" ", "T") + "Z") > ttlMs }));
}

/**
 * done/abandoned + 7 günden eski kayıtları tombstone'la siler. Sync döngüsünden
 * önce çağrılır (server/index.ts) — ayrı bir bakım/purge noktası yok, ucuz olduğu
 * için bu yeterli.
 */
export function pruneStalePresence(): number {
  const db = getDb();
  const cutoff = (
    db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f', 'now', '-${PRESENCE_PRUNE_DAYS} days') AS c`).get() as { c: string }
  ).c;
  const rows = db
    .prepare("SELECT uid FROM agent_presence WHERE status != 'active' AND COALESCE(finished_at, updated_at) <= ?")
    .all(cutoff) as { uid: string }[];
  for (const r of rows) {
    db.prepare("DELETE FROM agent_presence WHERE uid = ?").run(r.uid);
    recordDeletion("agent_presence", r.uid);
  }
  if (rows.length > 0) notifyWrite();
  return rows.length;
}
