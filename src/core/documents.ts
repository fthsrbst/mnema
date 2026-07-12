import { randomUUID } from "node:crypto";
import { getDb, hasVec, NOW_MS } from "./db.js";
import { chunkMarkdown } from "./chunker.js";
import { embed, toBuffer } from "./embeddings.js";
import { notifyWrite } from "./events.js";
import { hybridSearch } from "./search.js";
import { recordDeletion } from "./sync.js";
import type { DocumentInput, ScoredChunk } from "./types.js";

export interface AddDocumentResult {
  document_id: number;
  chunk_count: number;
  embedded: boolean;
}

/** Dokümanı chunk'layıp indeksler. Aynı uri varsa eskisini siler (re-index). */
export async function addDocument(input: DocumentInput): Promise<AddDocumentResult> {
  const db = getDb();

  if (input.uri) {
    const old = db.prepare("SELECT id FROM documents WHERE uri = ?").get(input.uri) as
      | { id: number }
      | undefined;
    if (old) deleteDocument(old.id);
  }

  // Öğrenme notları web'de project="learning" filtresiyle listelenir; project vermeyen
  // istemciler (ör. ChatGPT connector) uri "learning/" ile başlıyorsa oraya düşsün.
  const project =
    input.project ?? (input.uri?.startsWith("learning/") ? "learning" : null);
  const info = db
    .prepare(`INSERT INTO documents(uid, title, source, uri, project, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ${NOW_MS}, ${NOW_MS})`)
    .run(randomUUID().replaceAll("-", ""), input.title, input.source ?? null, input.uri ?? null, project);
  const docId = Number(info.lastInsertRowid);

  const chunks = chunkMarkdown(input.text);
  const insertChunk = db.prepare(
    "INSERT INTO chunks(document_id, seq, heading, text) VALUES (?, ?, ?, ?)"
  );
  const chunkIds: number[] = [];
  const insertAll = db.transaction(() => {
    chunks.forEach((c, i) => {
      chunkIds.push(Number(insertChunk.run(docId, i, c.heading, c.text).lastInsertRowid));
    });
  });
  insertAll();

  let embedded = false;
  if (hasVec() && chunks.length > 0) {
    try {
      const vecs = await embed(
        chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)),
        "RETRIEVAL_DOCUMENT"
      );
      if (vecs && db.prepare("SELECT 1 FROM documents WHERE id = ?").get(docId)) {
        // Varlık kontrolü: embed (ağ çağrısı) beklenirken doküman silinmişse
        // chunk rowid'leri yeniden kullanılmış olabilir — öksüz vektör yazma.
        const insertVec = db.prepare("INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)");
        const tx = db.transaction(() => {
          // sqlite-vec rowid için BigInt şart (number REAL bağlanır, reddedilir)
          vecs.forEach((v, i) => insertVec.run(BigInt(chunkIds[i]), toBuffer(v)));
        });
        tx();
        embedded = true;
      }
    } catch (err) {
      console.error(`[hub] doküman #${docId} embed edilemedi (FTS'te aranabilir): ${(err as Error).message}`);
    }
  }

  notifyWrite();
  return { document_id: docId, chunk_count: chunks.length, embedded };
}

export function deleteDocument(id: number): boolean {
  const db = getDb();
  const row = db.prepare("SELECT uid FROM documents WHERE id = ?").get(id) as { uid: string } | undefined;
  if (hasVec()) {
    db.prepare(
      "DELETE FROM chunks_vec WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)"
    ).run(id);
  }
  db.prepare("DELETE FROM chunks WHERE document_id = ?").run(id);
  const deleted = db.prepare("DELETE FROM documents WHERE id = ?").run(id).changes > 0;
  if (deleted && row?.uid) recordDeletion("documents", row.uid);
  if (deleted) notifyWrite();
  return deleted;
}

export async function searchChunks(
  query: string,
  opts: { project?: string; limit?: number } = {}
): Promise<ScoredChunk[]> {
  const ranked = await hybridSearch("chunks_fts", "chunks_vec", query);
  if (ranked.length === 0) return [];
  const stmt = getDb().prepare(
    `SELECT c.id AS chunk_id, c.document_id, c.heading, c.text,
            d.title AS document_title, d.uri, d.project
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.id = ? AND d.enabled = 1`
  );
  const limit = opts.limit ?? 6;
  const out: ScoredChunk[] = [];
  for (const { id, score, channels } of ranked) {
    const row = stmt.get(id) as Omit<ScoredChunk, "score"> | undefined;
    if (!row) continue;
    if (opts.project && row.project !== opts.project) continue;
    out.push({ ...row, score, channels });
    if (out.length >= limit) break;
  }
  return out;
}

export interface DocumentListItem {
  id: number;
  title: string;
  uri: string | null;
  project: string | null;
  enabled: number;
  created_at: string;
  chunk_count: number;
  vec_count: number;
}

/** project verilirse sadece o projeye ait dokümanları döner (frontend "learning" görünümü için). */
export function listDocuments(project?: string, limit = 100): DocumentListItem[] {
  const db = getDb();
  const vecJoin = hasVec()
    ? "(SELECT COUNT(*) FROM chunks_vec v WHERE v.rowid IN (SELECT id FROM chunks WHERE document_id = d.id))"
    : "0";
  const where = project ? "WHERE d.project = ?" : "";
  const params = project ? [project, limit] : [limit];
  return db
    .prepare(
      `SELECT d.id, d.title, d.uri, d.project, d.enabled, d.created_at,
              (SELECT COUNT(*) FROM chunks WHERE document_id = d.id) AS chunk_count,
              ${vecJoin} AS vec_count
       FROM documents d ${where} ORDER BY d.created_at DESC LIMIT ?`
    )
    .all(...params) as DocumentListItem[];
}

/** Doküman metasını günceller (enabled ve/veya project). Değişiklik LWW sync ile cihazlara yayılır. */
export function updateDocumentMeta(
  id: number,
  patch: { enabled?: boolean; project?: string | null }
): boolean {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(patch.enabled ? 1 : 0);
  }
  if (patch.project !== undefined) {
    sets.push("project = ?");
    params.push(patch.project);
  }
  if (sets.length === 0) return false;
  const changed =
    getDb()
      .prepare(`UPDATE documents SET ${sets.join(", ")}, updated_at = ${NOW_MS} WHERE id = ?`)
      .run(...params, id).changes > 0;
  if (changed) notifyWrite();
  return changed;
}

export function getDocument(id: number):
  | (DocumentListItem & { source: string | null; chunks: { id: number; seq: number; heading: string | null; text: string }[] })
  | null {
  const db = getDb();
  const vecJoin = hasVec()
    ? "(SELECT COUNT(*) FROM chunks_vec v WHERE v.rowid IN (SELECT id FROM chunks WHERE document_id = d.id))"
    : "0";
  const doc = db
    .prepare(
      `SELECT d.id, d.title, d.source, d.uri, d.project, d.enabled, d.created_at,
              (SELECT COUNT(*) FROM chunks WHERE document_id = d.id) AS chunk_count,
              ${vecJoin} AS vec_count
       FROM documents d WHERE d.id = ?`
    )
    .get(id) as (DocumentListItem & { source: string | null }) | undefined;
  if (!doc) return null;
  const chunks = db
    .prepare("SELECT id, seq, heading, text FROM chunks WHERE document_id = ? ORDER BY seq")
    .all(id) as { id: number; seq: number; heading: string | null; text: string }[];
  return { ...doc, chunks };
}
