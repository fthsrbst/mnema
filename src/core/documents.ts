import { randomUUID } from "node:crypto";
import { getDb, hasVec } from "./db.js";
import { chunkMarkdown } from "./chunker.js";
import { embed, toBuffer } from "./embeddings.js";
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

  const info = db
    .prepare("INSERT INTO documents(uid, title, source, uri, project) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID().replaceAll("-", ""), input.title, input.source ?? null, input.uri ?? null, input.project ?? null);
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
      if (vecs) {
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
     FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ?`
  );
  const limit = opts.limit ?? 6;
  const out: ScoredChunk[] = [];
  for (const { id, score } of ranked) {
    const row = stmt.get(id) as Omit<ScoredChunk, "score"> | undefined;
    if (!row) continue;
    if (opts.project && row.project !== opts.project) continue;
    out.push({ ...row, score });
    if (out.length >= limit) break;
  }
  return out;
}

export function listDocuments(limit = 50): { id: number; title: string; uri: string | null; project: string | null; created_at: string }[] {
  return getDb()
    .prepare("SELECT id, title, uri, project, created_at FROM documents ORDER BY created_at DESC LIMIT ?")
    .all(limit) as { id: number; title: string; uri: string | null; project: string | null; created_at: string }[];
}
