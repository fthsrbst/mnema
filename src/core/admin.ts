/**
 * Vector DB / RAG yönetimi: istatistik ve yeniden indeksleme.
 * Web UI'daki yönetim paneli bu uçları kullanır.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { getDb, hasVec } from "./db.js";
import { embed, embeddingsEnabled, toBuffer } from "./embeddings.js";

export interface RagStats {
  db_path: string;
  db_size_bytes: number;
  vec_available: boolean;
  embeddings_enabled: boolean;
  embedding_model: string;
  embedding_dim: number;
  vec_max_distance: number;
  documents: { total: number; enabled: number; disabled: number };
  chunks: { total: number; embedded: number };
  memories: { total: number; embedded: number };
  sync: { primary_url: string; peers: { peer: string; last_pull: string | null; last_push: string | null }[] };
}

export function ragStats(): RagStats {
  const db = getDb();
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const vec = hasVec();
  const dbFile = path.resolve(config.dbPath);
  return {
    db_path: dbFile,
    db_size_bytes: fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0,
    vec_available: vec,
    embeddings_enabled: embeddingsEnabled(),
    embedding_model: config.embeddingModel,
    embedding_dim: config.embeddingDim,
    vec_max_distance: config.vecMaxDistance,
    documents: {
      total: one("SELECT COUNT(*) AS n FROM documents"),
      enabled: one("SELECT COUNT(*) AS n FROM documents WHERE enabled = 1"),
      disabled: one("SELECT COUNT(*) AS n FROM documents WHERE enabled = 0"),
    },
    chunks: {
      total: one("SELECT COUNT(*) AS n FROM chunks"),
      embedded: vec ? one("SELECT COUNT(*) AS n FROM chunks_vec") : 0,
    },
    memories: {
      total: one("SELECT COUNT(*) AS n FROM memories"),
      embedded: vec ? one("SELECT COUNT(*) AS n FROM memories_vec") : 0,
    },
    sync: {
      primary_url: config.primaryUrls.join(","),
      peers: db.prepare("SELECT peer, last_pull, last_push FROM sync_state").all() as RagStats["sync"]["peers"],
    },
  };
}

export interface TimelineItem {
  kind: "memory" | "session" | "document";
  id: number;
  title: string;
  subtype: string | null; // memory type / session source / document source
  project: string | null;
  date: string;
}

/** Hafıza + oturum + dokümanları tek zaman ekseninde döner (en yeni önce, sayfalama: before). */
export function timeline(opts: { limit?: number; before?: string } = {}): TimelineItem[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  const before = opts.before ?? "9999-12-31";
  return getDb()
    .prepare(
      `SELECT * FROM (
         SELECT 'memory' AS kind, id, title, type AS subtype, project, updated_at AS date FROM memories
         UNION ALL
         SELECT 'session' AS kind, id, substr(summary, 1, 140) AS title, source AS subtype, project, created_at AS date FROM session_logs
         UNION ALL
         SELECT 'document' AS kind, id, title, source AS subtype, project, created_at AS date FROM documents
       ) WHERE date < ? ORDER BY date DESC LIMIT ?`
    )
    .all(before, limit) as TimelineItem[];
}

export interface GrowthStats {
  days: number;
  daily: { day: string; memories: number; sessions: number; documents: number }[];
  totals: { memories: number; sessions: number; documents: number; chunks: number };
}

/** Son N günün günlük kayıt sayıları — bilgi birikimi grafiği için. */
export function growthStats(days = 90): GrowthStats {
  const db = getDb();
  const since = `-${Math.min(Math.max(days, 7), 365)} days`;
  const rows = db
    .prepare(
      `SELECT day, SUM(m) AS memories, SUM(s) AS sessions, SUM(d) AS documents FROM (
         SELECT date(created_at) AS day, 1 AS m, 0 AS s, 0 AS d FROM memories WHERE created_at >= date('now', ?)
         UNION ALL
         SELECT date(created_at), 0, 1, 0 FROM session_logs WHERE created_at >= date('now', ?)
         UNION ALL
         SELECT date(created_at), 0, 0, 1 FROM documents WHERE created_at >= date('now', ?)
       ) GROUP BY day ORDER BY day`
    )
    .all(since, since, since) as GrowthStats["daily"];
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    days,
    daily: rows,
    totals: {
      memories: one("SELECT COUNT(*) AS n FROM memories"),
      sessions: one("SELECT COUNT(*) AS n FROM session_logs"),
      documents: one("SELECT COUNT(*) AS n FROM documents"),
      chunks: one("SELECT COUNT(*) AS n FROM chunks"),
    },
  };
}

export interface ReindexResult {
  ok: boolean;
  chunks_embedded: number;
  memories_embedded: number;
  error?: string;
}

let reindexing = false;

/**
 * Eksik embeddingleri tamamlar; force=true tüm vektörleri sıfırdan üretir
 * (EMBEDDING_DIM veya model değişince gerekir). Eşzamanlı çağrı reddedilir —
 * çift tıklama aynı chunk'ları iki kez embed edip API parası yakmasın.
 */
export async function reindex(force = false): Promise<ReindexResult> {
  const result: ReindexResult = { ok: true, chunks_embedded: 0, memories_embedded: 0 };
  if (reindexing) return { ...result, ok: false, error: "reindex zaten çalışıyor" };
  if (!hasVec()) return { ...result, ok: false, error: "sqlite-vec yok — vektör indeksi kullanılamıyor" };
  if (!embeddingsEnabled()) return { ...result, ok: false, error: "GEMINI_API_KEY tanımlı değil" };
  reindexing = true;
  try {
    return await doReindex(force, result);
  } finally {
    reindexing = false;
  }
}

async function doReindex(force: boolean, result: ReindexResult): Promise<ReindexResult> {
  const db = getDb();

  if (force) {
    db.exec("DELETE FROM chunks_vec; DELETE FROM memories_vec;");
  } else {
    // Öksüz vektörleri temizle: ana kaydı silinmiş (embed yarışı / eski bug) vec satırları
    // rowid yeniden kullanımında başka kayda yapışabilir — normal reindex'te de süpür.
    db.prepare("DELETE FROM chunks_vec WHERE rowid NOT IN (SELECT id FROM chunks)").run();
    db.prepare("DELETE FROM memories_vec WHERE rowid NOT IN (SELECT id FROM memories)").run();
  }

  const chunks = db
    .prepare("SELECT id, heading, text FROM chunks WHERE id NOT IN (SELECT rowid FROM chunks_vec)")
    .all() as { id: number; heading: string | null; text: string }[];
  if (chunks.length > 0) {
    const vecs = await embed(
      chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)),
      "RETRIEVAL_DOCUMENT"
    );
    if (vecs) {
      const ins = db.prepare("INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)");
      db.transaction(() => vecs.forEach((v, i) => ins.run(BigInt(chunks[i].id), toBuffer(v))))();
      result.chunks_embedded = vecs.length;
    }
  }

  const mems = db
    .prepare("SELECT id, title, body FROM memories WHERE id NOT IN (SELECT rowid FROM memories_vec)")
    .all() as { id: number; title: string; body: string }[];
  if (mems.length > 0) {
    const vecs = await embed(mems.map((m) => `${m.title}\n${m.body}`), "RETRIEVAL_DOCUMENT");
    if (vecs) {
      const ins = db.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)");
      db.transaction(() => vecs.forEach((v, i) => ins.run(BigInt(mems[i].id), toBuffer(v))))();
      result.memories_embedded = vecs.length;
    }
  }

  return result;
}
