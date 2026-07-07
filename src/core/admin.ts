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
      primary_url: config.primaryUrl,
      peers: db.prepare("SELECT peer, last_pull, last_push FROM sync_state").all() as RagStats["sync"]["peers"],
    },
  };
}

export interface ReindexResult {
  ok: boolean;
  chunks_embedded: number;
  memories_embedded: number;
  error?: string;
}

/**
 * Eksik embeddingleri tamamlar; force=true tüm vektörleri sıfırdan üretir
 * (EMBEDDING_DIM veya model değişince gerekir).
 */
export async function reindex(force = false): Promise<ReindexResult> {
  const result: ReindexResult = { ok: true, chunks_embedded: 0, memories_embedded: 0 };
  if (!hasVec()) return { ...result, ok: false, error: "sqlite-vec yok — vektör indeksi kullanılamıyor" };
  if (!embeddingsEnabled()) return { ...result, ok: false, error: "GEMINI_API_KEY tanımlı değil" };
  const db = getDb();

  if (force) {
    db.exec("DELETE FROM chunks_vec; DELETE FROM memories_vec;");
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
