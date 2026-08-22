/**
 * Advisory agent-presence koordinasyonu: bir agent bir projede çalışmaya
 * başlarken "aktifim, şu branch'te, şu işi yapıyorum" der (agentCheckin),
 * bitince kapatır (agentCheckout). Bu bir mutual-exclusion KİLİDİ DEĞİLDİR —
 * agent'lar crash edebilir, sert kilit deadlock üretir. Bayatlık heartbeat_at +
 * HUB_PRESENCE_TTL_MIN ile ele alınır (agentActive() stale işaretler, engellemez).
 */
import { randomUUID } from "node:crypto";
import { getDb, hlcStamp } from "./db.js";
import { config } from "./config.js";
import { resolveMachineName } from "./machine.js";
import { notifyWrite } from "./events.js";
import { recordDeletion } from "./sync.js";
import { assertProjectReference } from "./projects.js";
import { touchAgentHeartbeat } from "./capabilities.js";
import { agentCheckinSchema, agentCheckoutSchema } from "./schemas.js";
import type { AgentPresence, AgentPresenceView } from "./types.js";

const PRESENCE_PRUNE_DAYS = 7;
/** Bayat 'active' kaydı kaç TTL sonra otomatik abandoned'a çevrilecek (crash = sessiz checkout). */
const PRESENCE_ABANDON_MULTIPLIER = 2;

function row(uid: string): AgentPresence | null {
  return (getDb().prepare("SELECT * FROM agent_presence WHERE uid = ?").get(uid) as AgentPresence | undefined) ?? null;
}

/**
 * uid verilmezse yeni kayıt açar (uid döner); verilirse heartbeat/task/branch günceller.
 * Kural: kapalı (done/abandoned) kayıt heartbeat ile DIRİLTİLMEZ ve tombstone'lu uid
 * reddedilir — gecikmiş bir heartbeat'in eski kaydı 'active'e geri çevirmesi bir
 * hataydı. Aynı (agent,machine,project) için canlı kayıt varsa yeni satır açmak yerine
 * o kayıt benimsenir (duplicate koruması, bkz. db.ts partial UNIQUE index).
 */
export function agentCheckin(input: unknown): AgentPresence {
  const parsed = agentCheckinSchema.parse(input);
  assertProjectReference(parsed.project, "agent_presence");
  const db = getDb();
  const machine = parsed.machine?.trim() || resolveMachineName();
  const agent = parsed.agent?.trim() || "claude-code";

  if (parsed.uid) {
    const tomb = db.prepare("SELECT 1 FROM deletions WHERE tbl = 'agent_presence' AND uid = ?").get(parsed.uid);
    if (tomb) throw new Error(`presence uid silinmiş (tombstone): ${parsed.uid} — uid olmadan yeni checkin aç`);
    const existing = row(parsed.uid);
    if (existing) {
      if (existing.status !== "active") {
        throw new Error(
          `presence kaydı zaten kapanmış (${existing.status}): ${parsed.uid} — heartbeat diriltemez, uid olmadan yeni checkin aç`
        );
      }
      const stamp = hlcStamp();
      db.prepare(
        `UPDATE agent_presence SET machine=@machine, agent=@agent, project=@project, branch=@branch,
         task=@task, status='active', heartbeat_at=@stamp, updated_at=@stamp WHERE uid=@uid`
      ).run({ uid: parsed.uid, machine, agent, project: parsed.project, branch: parsed.branch ?? null, task: parsed.task, stamp });
      touchAgentHeartbeat(agent, machine);
      notifyWrite();
      return row(parsed.uid)!;
    }
    // uid bulunamadı (silinmemiş, henüz sync olmamış olabilir) — adopt-or-insert'e düş.
  }

  // Duplicate koruma: aynı (agent,machine,project) için canlı kayıt varsa onu benimse;
  // ikinci bir canlı satır açmak hem bridge'i yanıltır hem UNIQUE index'i ihlal eder.
  const adopted = db
    .prepare(
      "SELECT uid FROM agent_presence WHERE status = 'active' AND agent = ? AND machine = ? AND project = ? LIMIT 1"
    )
    .get(agent, machine, parsed.project) as { uid: string } | undefined;
  if (adopted && adopted.uid !== parsed.uid) {
    const stamp = hlcStamp();
    db.prepare(
      `UPDATE agent_presence SET branch=@branch, task=@task, status='active',
       heartbeat_at=@stamp, updated_at=@stamp WHERE uid=@uid`
    ).run({ uid: adopted.uid, branch: parsed.branch ?? null, task: parsed.task, stamp });
    touchAgentHeartbeat(agent, machine);
    notifyWrite();
    return row(adopted.uid)!;
  }

  const uid = parsed.uid ?? randomUUID().replaceAll("-", "");
  const stamp = hlcStamp();
  db.prepare(
    `INSERT INTO agent_presence(uid, machine, agent, project, branch, task, status, started_at, heartbeat_at, created_at, updated_at)
     VALUES (@uid, @machine, @agent, @project, @branch, @task, 'active', @stamp, @stamp, @stamp, @stamp)`
  ).run({ uid, machine, agent, project: parsed.project, branch: parsed.branch ?? null, task: parsed.task, stamp });
  touchAgentHeartbeat(agent, machine);
  notifyWrite();
  return row(uid)!;
}

export function agentCheckout(input: unknown): AgentPresence | null {
  const parsed = agentCheckoutSchema.parse(input);
  const status = parsed.status ?? "done";
  const info = getDb()
    .prepare(`UPDATE agent_presence SET status=@status, finished_at=@stamp, updated_at=@stamp WHERE uid=@uid`)
    .run({ status, uid: parsed.uid, stamp: hlcStamp() });
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
  // stale yalnız CANLI kayıtlar için anlamlıdır: kapanmış oturumun heartbeat'i eskidi
  // diye "bayat" göstermek yanıltıcıydı (uzun ama temiz bitmiş oturumlar hep stale çıkıyordu).
  return rows.map((r) => ({ ...r, stale: false }));
}

/**
 * TTL'in ABANDON katını aşan canlı kayıtları 'abandoned' yapar — crash eden agent'ın
 * bıraktığı ölümsüz zombi satırlarını kapatır (eskiden yalnız 'stale' işaretiyle
 * sonsuza dek duruyorlardı, hiçbir şey onları kapatmıyordu).
 */
function closeStaleActive(maxAgeMinutes: number, project?: string): AgentPresence[] {
  const db = getDb();
  const age = Math.max(1, Math.round(maxAgeMinutes));
  const cutoff = (
    db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f','now','-${age} minutes') AS c`).get() as { c: string }
  ).c;
  const rows = (
    project
      ? db.prepare("SELECT * FROM agent_presence WHERE status = 'active' AND project = ? AND heartbeat_at <= ?").all(project, cutoff)
      : db.prepare("SELECT * FROM agent_presence WHERE status = 'active' AND heartbeat_at <= ?").all(cutoff)
  ) as AgentPresence[];
  if (rows.length === 0) return [];
  const stamp = hlcStamp();
  for (const r of rows) {
    db.prepare(
      "UPDATE agent_presence SET status = 'abandoned', finished_at = @stamp, updated_at = @stamp WHERE uid = @uid AND status = 'active'"
    ).run({ uid: r.uid, stamp });
  }
  notifyWrite();
  return rows.map((r) => ({ ...r, status: "abandoned", finished_at: stamp, updated_at: stamp }));
}

/** Otomatik bakım: heartbeat'i 2×TTL aşan canlı kayıtları kapatır (prune ile aynı döngüde). */
export function autoAbandonStalePresence(): number {
  return closeStaleActive(config.presenceTtlMin * PRESENCE_ABANDON_MULTIPLIER).length;
}

/**
 * Manuel eşitleme aracı: TTL dolmuş TÜM bayat aktif kayıtları hemen 'abandoned' yapar
 * (project verilirse o projeyle sınırlar). Yazım sync ile tüm cihazlara yayılır — ortak
 * ağda zombi kayıtları tek noktadan temizlemenin yolu.
 */
export function purgeStalePresence(project?: string): { closed: AgentPresence[] } {
  return { closed: closeStaleActive(config.presenceTtlMin, project) };
}

/**
 * Bakım: önce bayat canlıları abandoned yapar (crash temizliği), sonra done/abandoned +
 * 7 günden eski kayıtları tombstone'la siler. Sync döngüsünden önce çağrılır
 * (server/index.ts) — ayrı bir bakım/purge noktası yok, ucuz olduğu için bu yeterli.
 */
export function pruneStalePresence(): number {
  const abandoned = autoAbandonStalePresence();
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
  if (rows.length > 0 || abandoned > 0) notifyWrite();
  return abandoned + rows.length;
}
