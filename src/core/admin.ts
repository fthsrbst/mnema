/**
 * Vector DB / RAG yönetimi: istatistik ve yeniden indeksleme.
 * Web UI'daki yönetim paneli bu uçları kullanır.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { verifyAuditChain } from "./audit.js";
import {
  embeddingGenerationState,
  getDb,
  hasVec,
  markEmbeddingGenerationReady,
  putChunkVector,
  putMemoryVector,
  vecError,
} from "./db.js";
import { embed, embeddingsDisabledReason, embeddingsEnabled, toBuffer } from "./embeddings.js";

export interface RagStats {
  db_path: string;
  db_size_bytes: number;
  vec_available: boolean;
  embeddings_enabled: boolean;
  degraded_detail: { vec_error?: string; embeddings_reason?: string } | null;
  embedding_model: string;
  embedding_dim: number;
  embedding_generation: ReturnType<typeof embeddingGenerationState>;
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
    // Ham degradasyon nedenleri sadece bu auth'lu uçta — /health yalnızca sabit kod döner.
    degraded_detail:
      vecError() || embeddingsDisabledReason()
        ? { vec_error: vecError() ?? undefined, embeddings_reason: embeddingsDisabledReason() ?? undefined }
        : null,
    embedding_model: config.embeddingModel,
    embedding_dim: config.embeddingDim,
    embedding_generation: embeddingGenerationState(),
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

export interface UsageMemoryItem {
  id: number;
  title: string;
  type: string;
  project: string | null;
  access_count: number;
  last_accessed: string | null;
  importance: number;
}

export interface UsageStats {
  top: UsageMemoryItem[];
  stale: UsageMemoryItem[];
  stale_count: number;
  total: number;
}

/**
 * Hafıza kullanım istatistikleri: en çok erişilenler + bayatlamış kayıtlar.
 * Web admin paneli için — kontrat frontend'le sabit, değiştirme.
 * Bayat tanımı: 90+ gündür erişilmemiş VEYA hiç erişilmemiş ama 90+ gün önce
 * oluşturulmuş — taze kayıt daha şansını bulamadığı için "ölü" sayılmaz.
 * Sıralama importance-öncelikli: yüksek önemli bayat kayıt recall'u en çok
 * çarpıtandır (importance çarpanı skoru şişirir), önce o gözden geçirilmeli.
 */
export function usageStats(): UsageStats {
  const db = getDb();
  const fields = "id, title, type, project, access_count, last_accessed, importance";
  const staleCond = `((last_accessed IS NULL AND created_at < datetime('now', '-90 days'))
    OR last_accessed < datetime('now', '-90 days'))`;
  // access_count recall() ve contextGet() tarafından çift sayılabilir (bkz.
  // memories.ts recordMemoryAccess yorumu) — bu liste yalnız kaba bir "en çok
  // görülen" göstergesidir, tam sayı üzerine karar kurma.
  const top = db
    .prepare(`SELECT ${fields} FROM memories ORDER BY access_count DESC LIMIT 10`)
    .all() as UsageMemoryItem[];
  const stale = db
    .prepare(
      `SELECT ${fields} FROM memories WHERE ${staleCond}
       ORDER BY importance DESC, last_accessed IS NOT NULL, last_accessed ASC LIMIT 20`
    )
    .all() as UsageMemoryItem[];
  const stale_count = (db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${staleCond}`).get() as { n: number }).n;
  const total = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
  return { top, stale, stale_count, total };
}

export interface IntegrityIssue {
  severity: "error" | "warning" | "info";
  code: string;
  count: number;
  examples: string[];
  remediation: string;
}

export interface KnowledgeIntegrityReport {
  ok: boolean;
  checked_at: string;
  issues: IntegrityIssue[];
  counts: {
    memories: number;
    documents: number;
    chunks: number;
    projects: number;
    sessions: number;
    relations: number;
    audit_events: number;
    vector_outbox: number;
  };
}

/** Cross-table and retrieval-index integrity diagnostics for operations/migrations. */
export function knowledgeIntegrity(): KnowledgeIntegrityReport {
  const db = getDb();
  const issues: IntegrityIssue[] = [];
  const one = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;
  const add = (
    severity: IntegrityIssue["severity"],
    code: string,
    count: number,
    examples: string[],
    remediation: string
  ) => {
    if (count > 0) issues.push({ severity, code, count, examples, remediation });
  };

  const unknownProjects = db
    .prepare(
      `SELECT project, SUM(n) AS n FROM (
         SELECT project, COUNT(*) AS n FROM memories WHERE project IS NOT NULL GROUP BY project
         UNION ALL SELECT project, COUNT(*) FROM documents WHERE project IS NOT NULL GROUP BY project
         UNION ALL SELECT project, COUNT(*) FROM session_logs WHERE project IS NOT NULL GROUP BY project
       ) refs
       WHERE project NOT IN ('global', 'learning')
         AND project NOT IN (SELECT name FROM projects)
       GROUP BY project ORDER BY n DESC`
    )
    .all() as { project: string; n: number }[];
  add(
    "error",
    "unknown_project_references",
    unknownProjects.reduce((sum, row) => sum + row.n, 0),
    unknownProjects.slice(0, 10).map((row) => `${row.project} (${row.n})`),
    "Create/restore the canonical project map or migrate the records to the correct project name; then enable HUB_STRICT_PROJECTS."
  );
  const auditChain = verifyAuditChain();
  add(
    "error",
    "broken_audit_chain",
    auditChain.ok ? 0 : 1,
    auditChain.broken_at ? [`event #${auditChain.broken_at}`] : [],
    "Restore the audit database from a trusted backup and investigate tampering or unsafe maintenance."
  );

  if (config.vectorBackend === "qdrant") {
    const retrying = db
      .prepare(
        `SELECT entity, row_id, attempts, last_error FROM vector_outbox
         WHERE attempts > 0 ORDER BY attempts DESC, updated_at LIMIT 10`
      )
      .all() as { entity: string; row_id: number; attempts: number; last_error: string | null }[];
    add(
      "warning",
      "vector_projection_retrying",
      one("SELECT COUNT(*) AS n FROM vector_outbox WHERE attempts > 0"),
      retrying.map((row) => `${row.entity}#${row.row_id} attempts=${row.attempts}: ${(row.last_error ?? "unknown").slice(0, 120)}`),
      "Check Qdrant health, TLS, credentials and collection schema; then call vector_projection_flush. Rows remain durable."
    );
    const stale = db
      .prepare(
        `SELECT entity, row_id, attempts FROM vector_outbox
         WHERE julianday(updated_at) < julianday('now', '-15 minutes')
         ORDER BY updated_at LIMIT 10`
      )
      .all() as { entity: string; row_id: number; attempts: number }[];
    add(
      "error",
      "vector_projection_stalled",
      one("SELECT COUNT(*) AS n FROM vector_outbox WHERE julianday(updated_at) < julianday('now', '-15 minutes')"),
      stale.map((row) => `${row.entity}#${row.row_id} attempts=${row.attempts}`),
      "Restore Qdrant connectivity or switch HUB_VECTOR_BACKEND back to sqlite-vec; do not accept external-backend parity while the queue is stalled."
    );
  }

  const typedDangling = db
    .prepare(
      `SELECT r.uid, r.relation_type
       FROM memory_relations r
       LEFT JOIN memories fm ON fm.uid = r.from_uid
       LEFT JOIN memories tm ON tm.uid = r.to_uid
       WHERE fm.id IS NULL OR tm.id IS NULL LIMIT 10`
    )
    .all() as { uid: string; relation_type: string }[];
  const typedDanglingCount = one(
    `SELECT COUNT(*) AS n FROM memory_relations r
     LEFT JOIN memories fm ON fm.uid = r.from_uid
     LEFT JOIN memories tm ON tm.uid = r.to_uid
     WHERE fm.id IS NULL OR tm.id IS NULL`
  );
  add(
    "error",
    "dangling_typed_relations",
    typedDanglingCount,
    typedDangling.map((row) => `${row.uid}:${row.relation_type}`),
    "Restore/sync both endpoint memories or delete the orphan relation."
  );
  const relationRows = db.prepare("SELECT uid, metadata, valid_from, valid_to FROM memory_relations").all() as {
    uid: string;
    metadata: string;
    valid_from: string | null;
    valid_to: string | null;
  }[];
  const invalidRelationMetadata: string[] = [];
  const invalidRelationWindows: string[] = [];
  for (const row of relationRows) {
    try {
      const metadata = JSON.parse(row.metadata);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) invalidRelationMetadata.push(row.uid);
    } catch {
      invalidRelationMetadata.push(row.uid);
    }
    if (row.valid_from && row.valid_to && Date.parse(row.valid_to) < Date.parse(row.valid_from)) {
      invalidRelationWindows.push(row.uid);
    }
  }
  add(
    "error",
    "invalid_relation_metadata",
    invalidRelationMetadata.length,
    invalidRelationMetadata.slice(0, 10),
    "Replace metadata with a JSON object."
  );
  add(
    "error",
    "invalid_relation_validity",
    invalidRelationWindows.length,
    invalidRelationWindows.slice(0, 10),
    "Set valid_to equal to or later than valid_from."
  );

  const duplicateUris = db
    .prepare("SELECT uri, COUNT(*) AS n FROM documents WHERE uri IS NOT NULL GROUP BY uri HAVING COUNT(*) > 1")
    .all() as { uri: string; n: number }[];
  add(
    "error",
    "duplicate_document_uri",
    duplicateUris.length,
    duplicateUris.slice(0, 10).map((row) => `${row.uri} (${row.n})`),
    "Merge each URI into one canonical document before creating the unique URI index."
  );

  const emptyDocs = db
    .prepare("SELECT id, title FROM documents d WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)")
    .all() as { id: number; title: string }[];
  add(
    "error",
    "documents_without_chunks",
    emptyDocs.length,
    emptyDocs.slice(0, 10).map((row) => `#${row.id} ${row.title}`),
    "Re-index from the source document or archive/delete the empty record."
  );

  const missingHashes = db
    .prepare("SELECT id, title FROM documents WHERE content_hash IS NULL")
    .all() as { id: number; title: string }[];
  add(
    "warning",
    "documents_without_content_hash",
    missingHashes.length,
    missingHashes.slice(0, 10).map((row) => `#${row.id} ${row.title}`),
    "Re-index the canonical URI to make replacement generation checks available."
  );

  const lifecycleConflicts = db
    .prepare("SELECT id, title FROM documents WHERE is_current = 1 AND archived_at IS NOT NULL")
    .all() as { id: number; title: string }[];
  add(
    "error",
    "current_but_archived_documents",
    lifecycleConflicts.length,
    lifecycleConflicts.slice(0, 10).map((row) => `#${row.id} ${row.title}`),
    "Set is_current=0 or clear archived_at after confirming the canonical version."
  );
  const invalidDocumentValidity = db
    .prepare(
      `SELECT id, title FROM documents
       WHERE (valid_from IS NOT NULL AND julianday(valid_from) IS NULL)
          OR (valid_to IS NOT NULL AND julianday(valid_to) IS NULL)
          OR (valid_from IS NOT NULL AND valid_to IS NOT NULL AND julianday(valid_to) < julianday(valid_from))`
    )
    .all() as { id: number; title: string }[];
  add(
    "error",
    "invalid_document_validity",
    invalidDocumentValidity.length,
    invalidDocumentValidity.slice(0, 10).map((row) => `#${row.id} ${row.title}`),
    "Use parseable ISO timestamps and ensure valid_to is not earlier than valid_from."
  );

  const danglingSupersedes = db
    .prepare(
      `SELECT id, title, supersedes_uid FROM documents
       WHERE supersedes_uid IS NOT NULL AND supersedes_uid NOT IN (SELECT uid FROM documents)`
    )
    .all() as { id: number; title: string; supersedes_uid: string }[];
  add(
    "warning",
    "dangling_document_supersedes",
    danglingSupersedes.length,
    danglingSupersedes.slice(0, 10).map((row) => `#${row.id} ${row.title} -> ${row.supersedes_uid}`),
    "Restore the superseded document, or clear the relation while retaining provenance elsewhere."
  );

  if (hasVec()) {
    const missingMemoryVec = one("SELECT COUNT(*) AS n FROM memories WHERE id NOT IN (SELECT rowid FROM memories_vec)");
    const missingChunkVec = one("SELECT COUNT(*) AS n FROM chunks WHERE id NOT IN (SELECT rowid FROM chunks_vec)");
    const orphanMemoryVec = one("SELECT COUNT(*) AS n FROM memories_vec WHERE rowid NOT IN (SELECT id FROM memories)");
    const orphanChunkVec = one("SELECT COUNT(*) AS n FROM chunks_vec WHERE rowid NOT IN (SELECT id FROM chunks)");
    add("warning", "missing_memory_vectors", missingMemoryVec, [], "Run rag reindex after confirming the embedding generation.");
    add("warning", "missing_chunk_vectors", missingChunkVec, [], "Run rag reindex after confirming the embedding generation.");
    add("error", "orphan_memory_vectors", orphanMemoryVec, [], "Run non-force reindex cleanup and investigate concurrent delete/update paths.");
    add("error", "orphan_chunk_vectors", orphanChunkVec, [], "Run non-force reindex cleanup and investigate concurrent document replacement.");
  }

  const memoryRows = db.prepare("SELECT id, title, related, tags FROM memories").all() as {
    id: number;
    title: string;
    related: string;
    tags: string;
  }[];
  const knownUids = new Set((db.prepare("SELECT uid FROM memories").all() as { uid: string }[]).map((row) => row.uid));
  const invalidJson: string[] = [];
  const danglingRelations: string[] = [];
  for (const row of memoryRows) {
    try {
      const tags = JSON.parse(row.tags);
      const related = JSON.parse(row.related);
      if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string") || !Array.isArray(related)) {
        invalidJson.push(`#${row.id} ${row.title}`);
        continue;
      }
      const missing = related.filter((uid: unknown) => typeof uid !== "string" || !knownUids.has(uid));
      if (missing.length > 0) danglingRelations.push(`#${row.id} ${row.title} (${missing.length})`);
    } catch {
      invalidJson.push(`#${row.id} ${row.title}`);
    }
  }
  add("error", "invalid_memory_json", invalidJson.length, invalidJson.slice(0, 10), "Repair tags/related as JSON string arrays before serving search.");
  add(
    "warning",
    "dangling_memory_relations",
    danglingRelations.length,
    danglingRelations.slice(0, 10),
    "Remove missing related UIDs or restore the referenced memory."
  );

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    checked_at: new Date().toISOString(),
    issues,
    counts: {
      memories: one("SELECT COUNT(*) AS n FROM memories"),
      documents: one("SELECT COUNT(*) AS n FROM documents"),
      chunks: one("SELECT COUNT(*) AS n FROM chunks"),
      projects: one("SELECT COUNT(*) AS n FROM projects"),
      sessions: one("SELECT COUNT(*) AS n FROM session_logs"),
      relations: one("SELECT COUNT(*) AS n FROM memory_relations"),
      audit_events: one("SELECT COUNT(*) AS n FROM audit_events"),
      vector_outbox: one("SELECT COUNT(*) AS n FROM vector_outbox"),
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
  const generation = embeddingGenerationState();
  if (generation.reindex_required && !force) {
    return { ...result, ok: false, error: "embedding generation değişti — force reindex zorunlu" };
  }
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
    .prepare(
      `SELECT c.id, c.heading, c.text, d.project, d.enabled, d.is_current, d.kind
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.id NOT IN (SELECT rowid FROM chunks_vec)`
    )
    .all() as { id: number; heading: string | null; text: string; project: string | null; enabled: number; is_current: number; kind: string }[];
  if (chunks.length > 0) {
    const vecs = await embed(
      chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)),
      "RETRIEVAL_DOCUMENT"
    );
    if (vecs) {
      db.transaction(() => {
        vecs.forEach((v, i) => {
          const expected = chunks[i];
          const current = db
            .prepare(
              `SELECT c.heading, c.text, d.project, d.enabled, d.is_current, d.kind
               FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ?`
            )
            .get(expected.id) as Omit<typeof expected, "id"> | undefined;
          if (!current || current.heading !== expected.heading || current.text !== expected.text) return;
          putChunkVector(expected.id, current.project, current.enabled, current.is_current, toBuffer(v), current.kind);
          result.chunks_embedded++;
        });
      })();
    }
  }

  const mems = db
    .prepare("SELECT id, title, body, project FROM memories WHERE id NOT IN (SELECT rowid FROM memories_vec)")
    .all() as { id: number; title: string; body: string; project: string | null }[];
  if (mems.length > 0) {
    const vecs = await embed(mems.map((m) => `${m.title}\n${m.body}`), "RETRIEVAL_DOCUMENT");
    if (vecs) {
      db.transaction(() => {
        vecs.forEach((v, i) => {
          const expected = mems[i];
          const current = db.prepare("SELECT title, body, project FROM memories WHERE id = ?").get(expected.id) as
            | { title: string; body: string; project: string | null }
            | undefined;
          if (!current || current.title !== expected.title || current.body !== expected.body) return;
          putMemoryVector(expected.id, current.project, toBuffer(v));
          result.memories_embedded++;
        });
      })();
    }
  }

  markEmbeddingGenerationReady("reindexed");
  return result;
}
