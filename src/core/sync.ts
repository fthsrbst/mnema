/**
 * Cihazlar arası eşitleme (local-first):
 * - Her cihaz kendi hub'ını çalıştırır; HUB_PRIMARY_URL tanımlıysa (genelde Pi)
 *   periyodik iki yönlü eşitleme yapar. Primary erişilemezse sessizce bekler —
 *   lokal sistem tam işlevsel kalır.
 * - Çakışma çözümü: LWW (updated_at en yeni olan kazanır). Zaman damgaları ms
 *   hassasiyetli; yine de eşitse içerik parmak izi (SHA-256) büyük olan kazanır —
 *   kural her iki cihazda aynı sonucu verdiği için kopyalar tek kazanana yakınsar.
 *   (Eski davranış: eşit damgada iki taraf da kendi kopyasını tutuyordu → kalıcı ıraksama.)
 * - Silmeler tombstone ile yayılır; silme-güncelleme eşitliğinde silme kazanır.
 * - Embedding vektörleri base64 taşınır — cihazlar yeniden embed etmez.
 */
import { createHash } from "node:crypto";
import { getDb, hasVec, NOW_MS } from "./db.js";

/** Eşit updated_at için deterministik tie-break anahtarı. Alan sırası sabit kalmalı. */
export function contentFingerprint(parts: (string | number | null | undefined)[]): string {
  return createHash("sha256")
    .update(parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("\x1f"))
    .digest("hex");
}

/**
 * LWW karşılaştırma: uzaktaki kayıt yereli ezmeli mi?
 * Damgalar farklıysa yeni olan; eşitse parmak izi büyük olan kazanır.
 * Parmak izleri de eşitse içerik zaten aynıdır → yazmaya gerek yok.
 */
function remoteWins(localUpdated: string, remoteUpdated: string, localFp: () => string, remoteFp: () => string): boolean {
  if (remoteUpdated !== localUpdated) return remoteUpdated > localUpdated;
  return remoteFp() > localFp();
}

export interface SyncMemory {
  uid: string;
  type: string;
  title: string;
  body: string;
  project: string | null;
  tags: string;
  source: string | null;
  created_at: string;
  updated_at: string;
  importance?: number; // eski peer göndermezse 1.0 varsayılır
  related?: string; // JSON uid listesi; eski peer göndermezse '[]'
  embedding?: string; // base64 float32
}

export interface SyncChunk {
  seq: number;
  heading: string | null;
  text: string;
  embedding?: string;
}

export interface SyncDocument {
  uid: string;
  title: string;
  source: string | null;
  uri: string | null;
  project: string | null;
  enabled?: number; // eski peer'lar göndermez → 1 varsay
  created_at: string;
  updated_at: string;
  chunks: SyncChunk[];
}

export interface SyncPayload {
  now: string;
  memories: SyncMemory[];
  documents: SyncDocument[];
  projects: { name: string; data: string; updated_at: string }[];
  sessions: { uid: string; project: string | null; summary: string; source: string | null; created_at: string }[];
  machines: { name: string; host: string; lmstudio_port: number | null; ollama_port?: number | null; comfyui_port: number | null; notes: string | null; updated_at: string }[];
  deletions: { uid: string; tbl: string; deleted_at: string }[];
}

function b64(buf: Buffer | null | undefined): string | undefined {
  return buf ? buf.toString("base64") : undefined;
}

function getVecBuffer(table: string, rowid: number): Buffer | null {
  if (!hasVec()) return null;
  const row = getDb().prepare(`SELECT embedding FROM ${table} WHERE rowid = ?`).get(BigInt(rowid)) as
    | { embedding: Buffer }
    | undefined;
  return row?.embedding ?? null;
}

/** `since`'ten (ISO, UTC "YYYY-MM-DD HH:MM:SS") beri değişen her şeyi topla. */
export function collectChanges(since: string): SyncPayload {
  const db = getDb();
  const now = (db.prepare(`SELECT ${NOW_MS} AS n`).get() as { n: string }).n;

  const memories = (db
    .prepare("SELECT * FROM memories WHERE updated_at >= ?")
    .all(since) as (SyncMemory & { id: number })[]).map((m) => ({
    uid: m.uid, type: m.type, title: m.title, body: m.body, project: m.project,
    tags: m.tags, source: m.source, created_at: m.created_at, updated_at: m.updated_at,
    importance: m.importance ?? 1.0,
    related: m.related ?? "[]",
    // last_accessed/access_count kasıtlı olarak taşınmaz — cihaz-yerel istatistik
    embedding: b64(getVecBuffer("memories_vec", m.id)),
  }));

  const docRows = db
    .prepare("SELECT * FROM documents WHERE updated_at >= ?")
    .all(since) as (Omit<SyncDocument, "chunks"> & { id: number })[];
  const chunkStmt = db.prepare("SELECT id, seq, heading, text FROM chunks WHERE document_id = ? ORDER BY seq");
  const documents = docRows.map((d) => ({
    uid: d.uid, title: d.title, source: d.source, uri: d.uri, project: d.project,
    enabled: d.enabled ?? 1, created_at: d.created_at, updated_at: d.updated_at,
    chunks: (chunkStmt.all(d.id) as { id: number; seq: number; heading: string | null; text: string }[]).map(
      (c) => ({ seq: c.seq, heading: c.heading, text: c.text, embedding: b64(getVecBuffer("chunks_vec", c.id)) })
    ),
  }));

  return {
    now,
    memories,
    documents,
    projects: db.prepare("SELECT name, data, updated_at FROM projects WHERE updated_at >= ?").all(since) as SyncPayload["projects"],
    sessions: db.prepare("SELECT uid, project, summary, source, created_at FROM session_logs WHERE created_at >= ?").all(since) as SyncPayload["sessions"],
    machines: db.prepare("SELECT name, host, lmstudio_port, ollama_port, comfyui_port, notes, updated_at FROM machines WHERE updated_at >= ?").all(since) as SyncPayload["machines"],
    deletions: db.prepare("SELECT uid, tbl, deleted_at FROM deletions WHERE deleted_at >= ?").all(since) as SyncPayload["deletions"],
  };
}

function insertVec(table: string, rowid: number, embeddingB64: string | undefined): void {
  if (!hasVec() || !embeddingB64) return;
  const db = getDb();
  db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(rowid));
  db.prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`).run(BigInt(rowid), Buffer.from(embeddingB64, "base64"));
}

export interface ApplyResult {
  memories: number;
  documents: number;
  projects: number;
  sessions: number;
  machines: number;
  deletions: number;
}

/** Uzaktan gelen değişiklikleri LWW ile uygula. */
export function applyChanges(payload: SyncPayload): ApplyResult {
  const db = getDb();
  const result: ApplyResult = { memories: 0, documents: 0, projects: 0, sessions: 0, machines: 0, deletions: 0 };

  for (const raw of payload.memories ?? []) {
    // eski peer importance/related göndermezse varsayılanla doldur
    const m = { ...raw, importance: raw.importance ?? 1.0, related: raw.related ?? "[]" };
    // Bu uid bizde daha yeni silinmişse alma
    const tomb = db.prepare("SELECT deleted_at FROM deletions WHERE uid = ?").get(m.uid) as { deleted_at: string } | undefined;
    if (tomb && tomb.deleted_at >= m.updated_at) continue;
    const local = db.prepare("SELECT * FROM memories WHERE uid = ?").get(m.uid) as
      | { id: number; updated_at: string; type: string; title: string; body: string; project: string | null; tags: string; source: string | null; importance: number; related: string | null }
      | undefined;
    if (local) {
      const memFp = (r: { type: string; title: string; body: string; project: string | null; tags: string; source: string | null; importance?: number; related?: string | null }) =>
        contentFingerprint([r.type, r.title, r.body, r.project, r.tags, r.source, r.importance ?? 1.0, r.related ?? "[]"]);
      if (!remoteWins(local.updated_at, m.updated_at, () => memFp(local), () => memFp(m))) continue;
      db.prepare(
        `UPDATE memories SET type=@type, title=@title, body=@body, project=@project, tags=@tags,
         source=@source, importance=@importance, related=@related, updated_at=@updated_at WHERE uid=@uid`
      ).run(m);
      insertVec("memories_vec", local.id, m.embedding);
    } else {
      const info = db.prepare(
        `INSERT INTO memories(uid, type, title, body, project, tags, source, importance, related, created_at, updated_at)
         VALUES (@uid, @type, @title, @body, @project, @tags, @source, @importance, @related, @created_at, @updated_at)`
      ).run(m);
      insertVec("memories_vec", Number(info.lastInsertRowid), m.embedding);
    }
    result.memories++;
  }

  for (const d of payload.documents ?? []) {
    const tomb = db.prepare("SELECT deleted_at FROM deletions WHERE uid = ?").get(d.uid) as { deleted_at: string } | undefined;
    if (tomb && tomb.deleted_at >= d.updated_at) continue;
    const local = db.prepare("SELECT id, updated_at, title, source, uri, project, enabled FROM documents WHERE uid = ?").get(d.uid) as
      | { id: number; updated_at: string; title: string; source: string | null; uri: string | null; project: string | null; enabled: number | null }
      | undefined;
    let docId: number;
    if (local) {
      // Chunk içerikleri parmak izine dahil — sadece eşit damgada hesaplanır (lazy)
      const localFp = () => {
        const localChunks = db
          .prepare("SELECT seq, heading, text FROM chunks WHERE document_id = ? ORDER BY seq")
          .all(local.id) as { seq: number; heading: string | null; text: string }[];
        return contentFingerprint([
          local.title, local.source, local.uri, local.project, local.enabled ?? 1,
          ...localChunks.flatMap((c) => [c.seq, c.heading, c.text]),
        ]);
      };
      const remoteFp = () =>
        contentFingerprint([
          d.title, d.source, d.uri, d.project, d.enabled ?? 1,
          ...(d.chunks ?? []).flatMap((c) => [c.seq, c.heading, c.text]),
        ]);
      if (!remoteWins(local.updated_at, d.updated_at, localFp, remoteFp)) continue;
      docId = local.id;
      if (hasVec()) db.prepare("DELETE FROM chunks_vec WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)").run(docId);
      db.prepare("DELETE FROM chunks WHERE document_id = ?").run(docId);
      db.prepare("UPDATE documents SET title=@title, source=@source, uri=@uri, project=@project, enabled=@enabled, updated_at=@updated_at WHERE id=@id")
        .run({ ...d, enabled: d.enabled ?? 1, id: docId });
    } else {
      docId = Number(
        db.prepare(
          `INSERT INTO documents(uid, title, source, uri, project, enabled, created_at, updated_at)
           VALUES (@uid, @title, @source, @uri, @project, @enabled, @created_at, @updated_at)`
        ).run({ ...d, enabled: d.enabled ?? 1 }).lastInsertRowid
      );
    }
    const insertChunk = db.prepare("INSERT INTO chunks(document_id, seq, heading, text) VALUES (?, ?, ?, ?)");
    for (const c of d.chunks ?? []) {
      const chunkId = Number(insertChunk.run(docId, c.seq, c.heading, c.text).lastInsertRowid);
      insertVec("chunks_vec", chunkId, c.embedding);
    }
    result.documents++;
  }

  for (const p of payload.projects ?? []) {
    const local = db.prepare("SELECT data, updated_at FROM projects WHERE name = ?").get(p.name) as
      | { data: string; updated_at: string }
      | undefined;
    if (local && !remoteWins(local.updated_at, p.updated_at, () => contentFingerprint([local.data]), () => contentFingerprint([p.data]))) continue;
    db.prepare(
      `INSERT INTO projects(name, data, updated_at) VALUES (@name, @data, @updated_at)
       ON CONFLICT(name) DO UPDATE SET data=@data, updated_at=@updated_at`
    ).run(p);
    result.projects++;
  }

  for (const s of payload.sessions ?? []) {
    const tomb = db.prepare("SELECT 1 FROM deletions WHERE uid = ?").get(s.uid);
    if (tomb) continue; // silinmiş oturum logu geri dirilmesin
    const exists = db.prepare("SELECT 1 FROM session_logs WHERE uid = ?").get(s.uid);
    if (exists) continue;
    db.prepare(
      "INSERT INTO session_logs(uid, project, summary, source, created_at) VALUES (@uid, @project, @summary, @source, @created_at)"
    ).run(s);
    result.sessions++;
  }

  for (const m of payload.machines ?? []) {
    const local = db.prepare("SELECT host, lmstudio_port, ollama_port, comfyui_port, notes, updated_at FROM machines WHERE name = ?").get(m.name) as
      | { host: string; lmstudio_port: number | null; ollama_port: number | null; comfyui_port: number | null; notes: string | null; updated_at: string }
      | undefined;
    const machineFp = (r: { host: string; lmstudio_port: number | null; ollama_port?: number | null; comfyui_port: number | null; notes: string | null }) =>
      contentFingerprint([r.host, r.lmstudio_port, r.ollama_port ?? null, r.comfyui_port, r.notes]);
    if (local && !remoteWins(local.updated_at, m.updated_at, () => machineFp(local), () => machineFp(m))) continue;
    db.prepare(
      `INSERT INTO machines(name, host, lmstudio_port, ollama_port, comfyui_port, notes, updated_at)
       VALUES (@name, @host, @lmstudio_port, @ollama_port, @comfyui_port, @notes, @updated_at)
       ON CONFLICT(name) DO UPDATE SET host=@host, lmstudio_port=@lmstudio_port,
         ollama_port=@ollama_port, comfyui_port=@comfyui_port, notes=@notes, updated_at=@updated_at`
      // eski peer ollama_port göndermeyebilir → null'a normalize et
    ).run({ ...m, ollama_port: m.ollama_port ?? null });
    result.machines++;
  }

  for (const del of payload.deletions ?? []) {
    // deleted_at donmasın: geç gelen silme daha yeni ise tombstone'u ilerlet (LWW)
    db.prepare(
      `INSERT INTO deletions(uid, tbl, deleted_at) VALUES (@uid, @tbl, @deleted_at)
       ON CONFLICT(uid) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)`
    ).run(del);
    if (del.tbl === "memories") {
      const row = db.prepare("SELECT id, updated_at FROM memories WHERE uid = ?").get(del.uid) as { id: number; updated_at: string } | undefined;
      if (row && row.updated_at <= del.deleted_at) {
        if (hasVec()) db.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(BigInt(row.id));
        db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
        result.deletions++;
      }
    } else if (del.tbl === "documents") {
      const row = db.prepare("SELECT id, updated_at FROM documents WHERE uid = ?").get(del.uid) as { id: number; updated_at: string } | undefined;
      if (row && row.updated_at <= del.deleted_at) {
        if (hasVec()) db.prepare("DELETE FROM chunks_vec WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)").run(row.id);
        db.prepare("DELETE FROM chunks WHERE document_id = ?").run(row.id);
        db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
        result.deletions++;
      }
    } else if (del.tbl === "session_logs") {
      const row = db.prepare("SELECT id FROM session_logs WHERE uid = ?").get(del.uid) as { id: number } | undefined;
      if (row) {
        db.prepare("DELETE FROM session_logs WHERE id = ?").run(row.id);
        result.deletions++;
      }
    } else if (del.tbl === "projects" || del.tbl === "machines") {
      // name tabanlı tablolar: uid alanında ad taşınır
      const tbl = del.tbl;
      const row = db.prepare(`SELECT updated_at FROM ${tbl} WHERE name = ?`).get(del.uid) as { updated_at: string } | undefined;
      if (row && row.updated_at <= del.deleted_at) {
        db.prepare(`DELETE FROM ${tbl} WHERE name = ?`).run(del.uid);
        result.deletions++;
      }
    }
  }

  return result;
}

export function recordDeletion(tbl: string, uid: string): void {
  getDb()
    .prepare(`INSERT INTO deletions(uid, tbl, deleted_at) VALUES (?, ?, ${NOW_MS}) ON CONFLICT(uid) DO UPDATE SET deleted_at = ${NOW_MS}`)
    .run(uid, tbl);
}

// --- primary ile periyodik eşitleme (istemci tarafı) ---

// Tek mantıksal peer: adres (Tailscale/LAN) değişse de since ilerlemeye devam eder.
const PRIMARY_PEER = "primary";

function getSyncState(): { last_pull: string; last_push: string } {
  const row = getDb().prepare("SELECT last_pull, last_push FROM sync_state WHERE peer = ?").get(PRIMARY_PEER) as
    | { last_pull: string | null; last_push: string | null }
    | undefined;
  return { last_pull: row?.last_pull ?? "1970-01-01 00:00:00", last_push: row?.last_push ?? "1970-01-01 00:00:00" };
}

function setSyncState(patch: Partial<{ last_pull: string; last_push: string }>): void {
  const cur = getSyncState();
  getDb()
    .prepare(
      `INSERT INTO sync_state(peer, last_pull, last_push) VALUES (@peer, @last_pull, @last_push)
       ON CONFLICT(peer) DO UPDATE SET last_pull=@last_pull, last_push=@last_push`
    )
    .run({ peer: PRIMARY_PEER, ...cur, ...patch });
}

export interface SyncRunResult {
  ok: boolean;
  url?: string;
  pulled?: ApplyResult;
  pushed?: ApplyResult;
  error?: string;
}

/** Tek adresle tek tur eşitleme: pull → apply, collect → push. */
async function syncOnce(primaryUrl: string, token: string): Promise<SyncRunResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const state = getSyncState();
  try {
    const pullRes = await fetch(`${primaryUrl}/api/sync/changes?since=${encodeURIComponent(state.last_pull)}`, {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    if (!pullRes.ok) throw new Error(`pull ${pullRes.status}`);
    const remote = (await pullRes.json()) as SyncPayload;
    const pulled = applyChanges(remote);
    setSyncState({ last_pull: remote.now });

    const local = collectChanges(state.last_push);
    let pushed: ApplyResult = { memories: 0, documents: 0, projects: 0, sessions: 0, machines: 0, deletions: 0 };
    const hasLocal = Object.entries(local).some(([k, v]) => k !== "now" && Array.isArray(v) && v.length > 0);
    if (hasLocal) {
      const pushRes = await fetch(`${primaryUrl}/api/sync/apply`, {
        method: "POST",
        headers,
        body: JSON.stringify(local),
        signal: AbortSignal.timeout(60000),
      });
      if (!pushRes.ok) throw new Error(`push ${pushRes.status}`);
      pushed = (await pushRes.json()) as ApplyResult;
    }
    setSyncState({ last_push: local.now });
    return { ok: true, url: primaryUrl, pulled, pushed };
  } catch (err) {
    return { ok: false, url: primaryUrl, error: (err as Error).message };
  }
}

// Son başarılı adresi hatırla — bir sonraki turda önce onu dene (Tailscale
// düşüp LAN'a geçtiyse tekrar tekrar Tailscale'i denemek gecikme yaratmasın).
let lastGoodPrimaryUrl: string | null = null;

/**
 * Primary adres listesiyle eşitleme: sırayla dener (son başarılı adres önce),
 * ilk erişilebilenle tamamlar. Hepsi erişilemezse sessizce hata döner — throw etmez.
 */
export async function syncWithPrimary(primaryUrls: string[], token: string): Promise<SyncRunResult> {
  if (primaryUrls.length === 0) return { ok: false, error: "HUB_PRIMARY_URL tanımlı değil" };
  const ordered =
    lastGoodPrimaryUrl && primaryUrls.includes(lastGoodPrimaryUrl)
      ? [lastGoodPrimaryUrl, ...primaryUrls.filter((u) => u !== lastGoodPrimaryUrl)]
      : primaryUrls;
  let lastError = "";
  for (const url of ordered) {
    const res = await syncOnce(url, token);
    if (res.ok) {
      lastGoodPrimaryUrl = url;
      return res;
    }
    lastError = res.error ?? "bilinmeyen hata";
  }
  return { ok: false, error: lastError };
}
