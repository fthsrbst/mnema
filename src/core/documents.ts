import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { getDb, hasVec, NOW_MS } from "./db.js";
import { chunkMarkdown } from "./chunker.js";
import { embed, toBuffer } from "./embeddings.js";
import { notifyWrite } from "./events.js";
import { hybridSearch } from "./search.js";
import { recordDeletion } from "./sync.js";
import { assertProjectReference } from "./projects.js";
import type { DocumentInput, ScoredChunk } from "./types.js";
import { documentInputSchema, documentMetaPatchSchema } from "./schemas.js";
import { vectorStore } from "./vector-store.js";

export interface AddDocumentResult {
  document_id: number;
  uid: string;
  chunk_count: number;
  embedded: boolean;
  updated: boolean;
  content_hash: string;
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function documentUid(uri: string | undefined): string {
  return uri
    ? createHash("sha256").update(`document\0${uri}`).digest("hex").slice(0, 32)
    : randomUUID().replaceAll("-", "");
}

interface StoredDocumentMeta {
  id: number;
  uid: string;
  source: string | null;
  project: string | null;
  kind: DocumentInput["kind"];
  version: string | null;
  is_current: number;
  supersedes_uid: string | null;
  valid_from: string | null;
  valid_to: string | null;
  archived_at: string | null;
  language: string | null;
  content_hash: string | null;
}

/** Rewrites vec0 metadata while preserving the existing embedding bytes. */
function refreshDocumentVectorMetadata(documentId: number): void {
  if (!vectorStore.available()) return;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.id, d.project, d.enabled, d.is_current, d.kind
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.document_id = ?`
    )
    .all(documentId) as { id: number; project: string | null; enabled: number; is_current: number; kind: string }[];
  db.transaction(() => {
    for (const row of rows) {
      const embedding = vectorStore.get("chunk", row.id);
      if (embedding) vectorStore.putChunk(row.id, row.project, row.enabled, row.is_current, row.kind, embedding);
    }
  })();
}

/**
 * Indexes a document. A canonical URI is a stable identity: replacement updates
 * the same document UID/id and cannot destroy the old document until the new text
 * has been validated and chunked successfully.
 */
export async function addDocument(input: DocumentInput): Promise<AddDocumentResult> {
  input = documentInputSchema.parse(input);
  const db = getDb();
  const title = input.title.trim();
  if (!title) throw new Error("document title must not be empty");
  if (!input.text.trim()) throw new Error("document text must not be empty");
  const chunks = chunkMarkdown(input.text);
  if (chunks.length === 0) throw new Error("document produced no indexable chunks");
  const hash = contentHash(input.text);

  // Öğrenme notları web'de project="learning" filtresiyle listelenir; project vermeyen
  // istemciler (ör. ChatGPT connector) uri "learning/" ile başlıyorsa oraya düşsün.
  const project =
    input.project ?? (input.uri?.startsWith("learning/") ? "learning" : null);
  assertProjectReference(project, "document");
  const existing = input.uri
    ? (db.prepare("SELECT * FROM documents WHERE uri = ?").get(input.uri) as StoredDocumentMeta | undefined)
    : undefined;
  const insertChunk = db.prepare(
    "INSERT INTO chunks(document_id, seq, heading, text) VALUES (?, ?, ?, ?)"
  );
  let docId = existing?.id ?? 0;
  let uid = existing?.uid ?? documentUid(input.uri);
  const chunkIds: number[] = [];
  const supersededIds: number[] = [];
  const write = db.transaction(() => {
    if (existing) {
      vectorStore.deleteDocumentChunks(existing.id);
      db.prepare("DELETE FROM chunks WHERE document_id = ?").run(existing.id);
      db.prepare(
        `UPDATE documents SET title=@title, source=@source, project=@project,
         kind=@kind, version=@version, is_current=@is_current,
         supersedes_uid=@supersedes_uid, valid_from=@valid_from, valid_to=@valid_to,
         archived_at=@archived_at, content_hash=@content_hash, language=@language,
         updated_at=${NOW_MS} WHERE id=@id`
      ).run({
        id: existing.id,
        title,
        source: input.source ?? existing.source,
        project: input.project === undefined && !input.uri?.startsWith("learning/") ? existing.project : project,
        kind: input.kind ?? existing.kind ?? "reference",
        version: input.version ?? existing.version,
        is_current: input.is_current === undefined ? existing.is_current : input.is_current ? 1 : 0,
        supersedes_uid: input.supersedes_uid ?? existing.supersedes_uid,
        valid_from: input.valid_from ?? existing.valid_from,
        valid_to: input.valid_to ?? existing.valid_to,
        archived_at: input.archived_at ?? existing.archived_at,
        content_hash: hash,
        language: input.language ?? existing.language,
      });
    } else {
      const info = db.prepare(
        `INSERT INTO documents(
           uid, title, source, uri, project, kind, version, is_current, supersedes_uid,
           valid_from, valid_to, archived_at, content_hash, language, created_at, updated_at
         ) VALUES (
           @uid, @title, @source, @uri, @project, @kind, @version, @is_current, @supersedes_uid,
           @valid_from, @valid_to, @archived_at, @content_hash, @language, ${NOW_MS}, ${NOW_MS}
         )`
      ).run({
        uid,
        title,
        source: input.source ?? null,
        uri: input.uri ?? null,
        project,
        kind: input.kind ?? "reference",
        version: input.version ?? null,
        is_current: input.is_current === false ? 0 : 1,
        supersedes_uid: input.supersedes_uid ?? null,
        valid_from: input.valid_from ?? null,
        valid_to: input.valid_to ?? null,
        archived_at: input.archived_at ?? null,
        content_hash: hash,
        language: input.language ?? null,
      });
      docId = Number(info.lastInsertRowid);
    }

    chunks.forEach((c, i) => {
      chunkIds.push(Number(insertChunk.run(docId, i, c.heading, c.text).lastInsertRowid));
    });

    if (input.supersedes_uid && input.supersedes_uid !== uid) {
      const superseded = db.prepare("SELECT id FROM documents WHERE uid = ?").get(input.supersedes_uid) as
        | { id: number }
        | undefined;
      if (superseded) {
        db.prepare(
          `UPDATE documents SET is_current=0, archived_at=COALESCE(archived_at, ${NOW_MS}),
           valid_to=COALESCE(valid_to, ${NOW_MS}), updated_at=${NOW_MS} WHERE id=?`
        ).run(superseded.id);
        supersededIds.push(superseded.id);
      }
    }
  });
  write();
  for (const id of supersededIds) refreshDocumentVectorMetadata(id);

  let embedded = false;
  if (vectorStore.ready() && chunks.length > 0) {
    try {
      const vecs = await embed(
        chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)),
        "RETRIEVAL_DOCUMENT"
      );
      const current = db.prepare("SELECT project, enabled, is_current, kind, content_hash FROM documents WHERE id = ?").get(docId) as
        | { project: string | null; enabled: number; is_current: number; kind: string; content_hash: string | null }
        | undefined;
      const currentChunkIds = db
        .prepare("SELECT id FROM chunks WHERE document_id = ? ORDER BY seq")
        .all(docId) as { id: number }[];
      const sameGeneration =
        current?.content_hash === hash &&
        currentChunkIds.length === chunkIds.length &&
        currentChunkIds.every((row, index) => row.id === chunkIds[index]);
      if (vecs && current && sameGeneration) {
        // Content hash + exact chunk-id generation check: another same-URI update
        // may have completed while the remote embedding request was in flight.
        const tx = db.transaction(() => {
          vecs.forEach((v, i) =>
            vectorStore.putChunk(chunkIds[i], current.project, current.enabled, current.is_current, current.kind, toBuffer(v))
          );
        });
        tx();
        embedded = true;
      }
    } catch (err) {
      console.error(`[hub] doküman #${docId} embed edilemedi (FTS'te aranabilir): ${(err as Error).message}`);
    }
  }

  notifyWrite();
  return { document_id: docId, uid, chunk_count: chunks.length, embedded, updated: Boolean(existing), content_hash: hash };
}

export function deleteDocument(id: number): boolean {
  const db = getDb();
  const row = db.prepare("SELECT uid FROM documents WHERE id = ?").get(id) as { uid: string } | undefined;
  vectorStore.deleteDocumentChunks(id);
  db.prepare("DELETE FROM chunks WHERE document_id = ?").run(id);
  const deleted = db.prepare("DELETE FROM documents WHERE id = ?").run(id).changes > 0;
  if (deleted && row?.uid) recordDeletion("documents", row.uid);
  if (deleted) notifyWrite();
  return deleted;
}

export async function searchChunks(
  query: string,
  opts: { project?: string; limit?: number; include_archived?: boolean; kind?: DocumentInput["kind"] } = {}
): Promise<ScoredChunk[]> {
  // Lifecycle/project/kind constraints are applied during candidate retrieval.
  const ranked = await hybridSearch("chunks_fts", "chunks_vec", query, config.searchCandidates, {
    project: opts.project,
    currentOnly: !opts.include_archived,
    documentKind: opts.kind,
  });
  if (ranked.length === 0) return [];
  // N+1 yerine tek sorgu: sıralama RRF'ten gelir, satırlar id→row haritasından okunur.
  const placeholders = ranked.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT c.id AS chunk_id, c.seq AS chunk_seq, c.document_id, c.heading, c.text,
              d.uid AS document_uid, d.content_hash, d.title AS document_title, d.uri, d.project,
              d.kind AS document_kind, d.version AS document_version, d.is_current
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.id IN (${placeholders}) AND d.enabled = 1${opts.include_archived ? "" : " AND d.is_current = 1"}${opts.kind ? " AND d.kind = ?" : ""}`
    )
    .all(...ranked.map((r) => r.id), ...(opts.kind ? [opts.kind] : [])) as Omit<ScoredChunk, "score">[];
  const byId = new Map(rows.map((r) => [r.chunk_id, r]));
  const limit = opts.limit ?? 6;
  const out: ScoredChunk[] = [];
  for (const { id, score, channels, channel_ranks } of ranked) {
    const row = byId.get(id);
    if (!row) continue;
    if (opts.project && row.project !== opts.project) continue;
    out.push({ ...row, score, channels, channel_ranks });
    if (out.length >= limit) break;
  }
  return out;
}

export interface DocumentListItem {
  id: number;
  uid: string;
  title: string;
  uri: string | null;
  project: string | null;
  enabled: number;
  kind: string;
  version: string | null;
  is_current: number;
  supersedes_uid: string | null;
  valid_from: string | null;
  valid_to: string | null;
  archived_at: string | null;
  content_hash: string | null;
  language: string | null;
  created_at: string;
  updated_at: string;
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
      `SELECT d.id, d.uid, d.title, d.uri, d.project, d.enabled, d.kind, d.version,
              d.is_current, d.supersedes_uid, d.valid_from, d.valid_to, d.archived_at,
              d.content_hash, d.language, d.created_at, d.updated_at,
              (SELECT COUNT(*) FROM chunks WHERE document_id = d.id) AS chunk_count,
              ${vecJoin} AS vec_count
       FROM documents d ${where} ORDER BY d.created_at DESC LIMIT ?`
    )
    .all(...params) as DocumentListItem[];
}

/** Doküman metasını günceller (enabled ve/veya project). Değişiklik LWW sync ile cihazlara yayılır. */
export function updateDocumentMeta(
  id: number,
  patch: {
    enabled?: boolean;
    project?: string | null;
    kind?: DocumentInput["kind"];
    version?: string | null;
    is_current?: boolean;
    supersedes_uid?: string | null;
    valid_from?: string | null;
    valid_to?: string | null;
    archived_at?: string | null;
    language?: string | null;
  }
): boolean {
  patch = documentMetaPatchSchema.parse(patch);
  if (patch.project !== undefined) assertProjectReference(patch.project, "document");
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
  if (patch.kind !== undefined) (sets.push("kind = ?"), params.push(patch.kind));
  if (patch.version !== undefined) (sets.push("version = ?"), params.push(patch.version));
  if (patch.is_current !== undefined) (sets.push("is_current = ?"), params.push(patch.is_current ? 1 : 0));
  if (patch.supersedes_uid !== undefined)
    (sets.push("supersedes_uid = ?"), params.push(patch.supersedes_uid));
  if (patch.valid_from !== undefined) (sets.push("valid_from = ?"), params.push(patch.valid_from));
  if (patch.valid_to !== undefined) (sets.push("valid_to = ?"), params.push(patch.valid_to));
  if (patch.archived_at !== undefined) (sets.push("archived_at = ?"), params.push(patch.archived_at));
  if (patch.language !== undefined) (sets.push("language = ?"), params.push(patch.language));
  if (sets.length === 0) return false;
  const changed =
    getDb()
      .prepare(`UPDATE documents SET ${sets.join(", ")}, updated_at = ${NOW_MS} WHERE id = ?`)
      .run(...params, id).changes > 0;
  if (changed) notifyWrite();
  if (changed && (patch.enabled !== undefined || patch.project !== undefined || patch.is_current !== undefined)) {
    refreshDocumentVectorMetadata(id);
  }
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
      `SELECT d.id, d.uid, d.title, d.source, d.uri, d.project, d.enabled, d.kind, d.version,
              d.is_current, d.supersedes_uid, d.valid_from, d.valid_to, d.archived_at,
              d.content_hash, d.language, d.created_at, d.updated_at,
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
