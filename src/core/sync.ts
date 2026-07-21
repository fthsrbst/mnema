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
import {
  configuredEmbeddingGeneration,
  getDb,
  NOW_MS,
} from "./db.js";
import { config } from "./config.js";
import { syncPayloadSchema } from "./schemas.js";
import { vectorStore } from "./vector-store.js";

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
  language?: string | null;
  canonical_summary?: string | null;
  normalizer_generation?: string | null;
  created_at: string;
  updated_at: string;
  importance?: number; // eski peer göndermezse 1.0 varsayılır
  related?: string; // JSON uid listesi; eski peer göndermezse '[]'
  origin_machine?: string | null; // cihaz etiketi; eski peer göndermezse yerel değer korunur
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
  kind?: string;
  version?: string | null;
  is_current?: number;
  supersedes_uid?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  archived_at?: string | null;
  content_hash?: string | null;
  language?: string | null;
  created_at: string;
  updated_at: string;
  chunks: SyncChunk[];
}

interface StoredSyncDocument extends Omit<SyncDocument, "chunks"> {
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
}

export interface SyncPayload {
  now: string;
  /** Generation hash for every transported vector. Missing only on legacy peers. */
  embedding_generation?: string;
  memories: SyncMemory[];
  documents: SyncDocument[];
  relations?: {
    uid: string;
    from_uid: string;
    to_uid: string;
    relation_type: string;
    confidence: number;
    valid_from: string | null;
    valid_to: string | null;
    source: string | null;
    metadata: string;
    created_at: string;
    updated_at: string;
  }[];
  projects: { name: string; data: string; updated_at: string }[];
  sessions: { uid: string; project: string | null; summary: string; source: string | null; origin_machine?: string | null; created_at: string; updated_at?: string }[];
  machines: { name: string; host: string; lmstudio_port: number | null; ollama_port?: number | null; comfyui_port: number | null; notes: string | null; updated_at: string }[];
  /** Eski peer'lar bu alanı hiç göndermez (bkz. applyChangesUnsafe: yokluğu boş dizi sayılır). */
  assets?: { uid: string; kind: "skill" | "prompt"; name: string; content: string; created_at: string; updated_at: string }[];
  agent_presence?: {
    uid: string;
    machine: string;
    agent: string;
    project: string;
    branch: string | null;
    task: string;
    status: "active" | "done" | "abandoned";
    started_at: string;
    heartbeat_at: string;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
  }[];
  // Agent Intelligence Platform tables
  tasks?: {
    uid: string;
    project: string | null;
    title: string;
    description: string | null;
    status: string;
    priority: number;
    created_by: string | null;
    claimed_by: string | null;
    claimed_at: string | null;
    depends_on: string;
    tags: string;
    result: string | null;
    error: string | null;
    due_at: string | null;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
  }[];
  agent_capabilities?: {
    uid: string;
    agent: string;
    machine: string | null;
    capabilities: string;
    models: string;
    max_concurrent: number;
    status: string;
    last_seen_at: string | null;
    metadata: string;
    created_at: string;
    updated_at: string;
  }[];
  agent_messages?: {
    uid: string;
    from_agent: string;
    to_agent: string | null;
    project: string | null;
    task_uid: string | null;
    kind: string;
    subject: string;
    body: string;
    payload: string;
    read_at: string | null;
    created_at: string;
  }[];
  deletions: { uid: string; tbl: string; deleted_at: string }[];
}

function b64(buf: Buffer | null | undefined): string | undefined {
  return buf ? buf.toString("base64") : undefined;
}

function getVecBuffer(table: string, rowid: number): Buffer | null {
  return vectorStore.get(table === "memories_vec" ? "memory" : "chunk", rowid);
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
    language: m.language ?? null,
    canonical_summary: m.canonical_summary ?? null,
    normalizer_generation: m.normalizer_generation ?? null,
    importance: m.importance ?? 1.0,
    related: m.related ?? "[]",
    origin_machine: m.origin_machine ?? null,
    // last_accessed/access_count kasıtlı olarak taşınmaz — cihaz-yerel istatistik
    embedding: b64(getVecBuffer("memories_vec", m.id)),
  }));

  const docRows = db
    .prepare("SELECT * FROM documents WHERE updated_at >= ?")
    .all(since) as (Omit<SyncDocument, "chunks"> & { id: number })[];
  const chunkStmt = db.prepare("SELECT id, seq, heading, text FROM chunks WHERE document_id = ? ORDER BY seq");
  const documents = docRows.map((d) => ({
    uid: d.uid, title: d.title, source: d.source, uri: d.uri, project: d.project,
    enabled: d.enabled ?? 1, kind: d.kind ?? "reference", version: d.version ?? null,
    is_current: d.is_current ?? 1, supersedes_uid: d.supersedes_uid ?? null,
    valid_from: d.valid_from ?? null, valid_to: d.valid_to ?? null,
    archived_at: d.archived_at ?? null, content_hash: d.content_hash ?? null,
    language: d.language ?? null, created_at: d.created_at, updated_at: d.updated_at,
    chunks: (chunkStmt.all(d.id) as { id: number; seq: number; heading: string | null; text: string }[]).map(
      (c) => ({ seq: c.seq, heading: c.heading, text: c.text, embedding: b64(getVecBuffer("chunks_vec", c.id)) })
    ),
  }));

  return {
    now,
    embedding_generation: configuredEmbeddingGeneration(),
    memories,
    documents,
    relations: db
      .prepare(
        `SELECT uid, from_uid, to_uid, relation_type, confidence, valid_from,
                valid_to, source, metadata, created_at, updated_at
         FROM memory_relations WHERE updated_at >= ?`
      )
      .all(since) as NonNullable<SyncPayload["relations"]>,
    projects: db.prepare("SELECT name, data, updated_at FROM projects WHERE updated_at >= ?").all(since) as SyncPayload["projects"],
    sessions: db
      .prepare("SELECT uid, project, summary, source, origin_machine, created_at, updated_at FROM session_logs WHERE updated_at >= ?")
      .all(since) as SyncPayload["sessions"],
    machines: db.prepare("SELECT name, host, lmstudio_port, ollama_port, comfyui_port, notes, updated_at FROM machines WHERE updated_at >= ?").all(since) as SyncPayload["machines"],
    assets: db
      .prepare("SELECT uid, kind, name, content, created_at, updated_at FROM assets WHERE updated_at >= ?")
      .all(since) as SyncPayload["assets"],
    agent_presence: db
      .prepare(
        `SELECT uid, machine, agent, project, branch, task, status, started_at, heartbeat_at, finished_at, created_at, updated_at
         FROM agent_presence WHERE updated_at >= ?`
      )
      .all(since) as SyncPayload["agent_presence"],
    // Agent Intelligence Platform tables
    tasks: db
      .prepare(
        `SELECT uid, project, title, description, status, priority, created_by, claimed_by, claimed_at,
                depends_on, tags, result, error, due_at, started_at, finished_at, created_at, updated_at
         FROM tasks WHERE updated_at >= ?`
      )
      .all(since) as SyncPayload["tasks"],
    agent_capabilities: db
      .prepare(
        `SELECT uid, agent, machine, capabilities, models, max_concurrent, status, last_seen_at, metadata, created_at, updated_at
         FROM agent_capabilities WHERE updated_at >= ?`
      )
      .all(since) as SyncPayload["agent_capabilities"],
    agent_messages: db
      .prepare(
        `SELECT uid, from_agent, to_agent, project, task_uid, kind, subject, body, payload, read_at, created_at
         FROM agent_messages WHERE created_at >= ?`
      )
      .all(since) as SyncPayload["agent_messages"],
    deletions: db.prepare("SELECT uid, tbl, deleted_at FROM deletions WHERE deleted_at >= ?").all(since) as SyncPayload["deletions"],
  };
}

function insertMemoryVec(rowid: number, project: string | null, embeddingB64: string | undefined): void {
  if (!vectorStore.available() || !embeddingB64) return;
  vectorStore.putMemory(rowid, project, Buffer.from(embeddingB64, "base64"));
}

function insertChunkVec(
  rowid: number,
  document: Pick<SyncDocument, "project" | "enabled" | "is_current" | "kind">,
  embeddingB64: string | undefined
): void {
  if (!vectorStore.available() || !embeddingB64) return;
  vectorStore.putChunk(
    rowid,
    document.project,
    document.enabled ?? 1,
    document.is_current ?? 1,
    document.kind ?? "reference",
    Buffer.from(embeddingB64, "base64")
  );
}

export interface ApplyResult {
  memories: number;
  documents: number;
  relations: number;
  projects: number;
  sessions: number;
  machines: number;
  assets: number;
  agent_presence: number;
  deletions: number;
  vectors_skipped?: number;
}

/** Uzaktan gelen değişiklikleri LWW ile uygula. */
function applyChangesUnsafe(payload: SyncPayload): ApplyResult {
  const db = getDb();
  const result: ApplyResult = {
    memories: 0, documents: 0, relations: 0, projects: 0, sessions: 0, machines: 0,
    assets: 0, agent_presence: 0, deletions: 0, vectors_skipped: 0,
  };
  const generationMatches = payload.embedding_generation
    ? payload.embedding_generation === configuredEmbeddingGeneration()
    : config.acceptLegacyVectors;
  // Never mix newly configured vectors into an index whose active generation
  // is still old. Source rows sync normally and the required reindex fills them.
  const acceptVectors = generationMatches && vectorStore.ready();

  for (const raw of payload.memories ?? []) {
    // eski peer importance/related/origin_machine göndermezse varsayılanla doldur
    const m = {
      ...raw,
      importance: raw.importance ?? 1.0,
      related: raw.related ?? "[]",
      language: raw.language ?? null,
      canonical_summary: raw.canonical_summary ?? null,
      normalizer_generation: raw.normalizer_generation ?? null,
      // origin_machine alanı eski peer'dan gelmeyebilir → INSERT'te null, UPDATE'te yerel korunur
      origin_machine: raw.origin_machine ?? null,
    };
    // Bu uid bizde daha yeni silinmişse alma
    const tomb = db.prepare("SELECT deleted_at FROM deletions WHERE tbl = 'memories' AND uid = ?").get(m.uid) as { deleted_at: string } | undefined;
    if (tomb && tomb.deleted_at >= m.updated_at) continue;
    const local = db.prepare("SELECT * FROM memories WHERE uid = ?").get(m.uid) as
      | { id: number; updated_at: string; type: string; title: string; body: string; project: string | null; tags: string; source: string | null; language: string | null; canonical_summary: string | null; normalizer_generation: string | null; importance: number; related: string | null }
      | undefined;
    if (local) {
      const memFp = (r: { type: string; title: string; body: string; project: string | null; tags: string; source: string | null; language?: string | null; canonical_summary?: string | null; normalizer_generation?: string | null; importance?: number; related?: string | null }) =>
        contentFingerprint([
          r.type, r.title, r.body, r.project, r.tags, r.source,
          r.language, r.canonical_summary, r.normalizer_generation,
          r.importance ?? 1.0, r.related ?? "[]",
        ]);
      if (!remoteWins(local.updated_at, m.updated_at, () => memFp(local), () => memFp(m))) continue;
      db.prepare(
        `UPDATE memories SET type=@type, title=@title, body=@body, project=@project, tags=@tags,
         source=@source, language=@language, canonical_summary=@canonical_summary,
         normalizer_generation=@normalizer_generation, importance=@importance,
         related=@related, origin_machine=COALESCE(@origin_machine, origin_machine),
         updated_at=@updated_at WHERE uid=@uid`
      ).run(m);
      if (acceptVectors) insertMemoryVec(local.id, m.project, m.embedding);
      else if (m.embedding) result.vectors_skipped!++;
    } else {
      const info = db.prepare(
        `INSERT INTO memories(
           uid, type, title, body, project, tags, source, language, canonical_summary,
           normalizer_generation, importance, related, origin_machine, created_at, updated_at
         ) VALUES (
           @uid, @type, @title, @body, @project, @tags, @source, @language, @canonical_summary,
           @normalizer_generation, @importance, @related, @origin_machine, @created_at, @updated_at
         )`
      ).run(m);
      if (acceptVectors) insertMemoryVec(Number(info.lastInsertRowid), m.project, m.embedding);
      else if (m.embedding) result.vectors_skipped!++;
    }
    result.memories++;
  }

  for (const raw of payload.documents ?? []) {
    const d = {
      ...raw,
      enabled: raw.enabled ?? 1,
      kind: raw.kind ?? "reference",
      version: raw.version ?? null,
      is_current: raw.is_current ?? 1,
      supersedes_uid: raw.supersedes_uid ?? null,
      valid_from: raw.valid_from ?? null,
      valid_to: raw.valid_to ?? null,
      archived_at: raw.archived_at ?? null,
      content_hash: raw.content_hash ?? null,
      language: raw.language ?? null,
    };
    const tomb = db.prepare("SELECT deleted_at FROM deletions WHERE tbl = 'documents' AND uid = ?").get(d.uid) as { deleted_at: string } | undefined;
    if (tomb && tomb.deleted_at >= d.updated_at) continue;
    const local = db
      .prepare("SELECT * FROM documents WHERE uid = ? OR (uri IS NOT NULL AND uri = ?) ORDER BY uid = ? DESC LIMIT 1")
      .get(d.uid, d.uri, d.uid) as
      | (StoredSyncDocument & { id: number })
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
          local.kind, local.version, local.is_current, local.supersedes_uid,
          local.valid_from, local.valid_to, local.archived_at, local.content_hash, local.language,
          ...localChunks.flatMap((c) => [c.seq, c.heading, c.text]),
        ]);
      };
      const remoteFp = () =>
        contentFingerprint([
          d.title, d.source, d.uri, d.project, d.enabled ?? 1,
          d.kind, d.version, d.is_current, d.supersedes_uid,
          d.valid_from, d.valid_to, d.archived_at, d.content_hash, d.language,
          ...(d.chunks ?? []).flatMap((c) => [c.seq, c.heading, c.text]),
        ]);
      if (!remoteWins(local.updated_at, d.updated_at, localFp, remoteFp)) continue;
      docId = local.id;
      vectorStore.deleteDocumentChunks(docId);
      db.prepare("DELETE FROM chunks WHERE document_id = ?").run(docId);
      db.prepare(
        `UPDATE documents SET title=@title, source=@source, uri=@uri, project=@project,
         enabled=@enabled, kind=@kind, version=@version, is_current=@is_current,
         supersedes_uid=@supersedes_uid, valid_from=@valid_from, valid_to=@valid_to,
         archived_at=@archived_at, content_hash=@content_hash, language=@language,
         updated_at=@updated_at WHERE id=@id`
      ).run({ ...d, id: docId });
    } else {
      docId = Number(
        db.prepare(
          `INSERT INTO documents(
             uid, title, source, uri, project, enabled, kind, version, is_current,
             supersedes_uid, valid_from, valid_to, archived_at, content_hash, language,
             created_at, updated_at
           ) VALUES (
             @uid, @title, @source, @uri, @project, @enabled, @kind, @version, @is_current,
             @supersedes_uid, @valid_from, @valid_to, @archived_at, @content_hash, @language,
             @created_at, @updated_at
           )`
        ).run(d).lastInsertRowid
      );
    }
    const insertChunk = db.prepare("INSERT INTO chunks(document_id, seq, heading, text) VALUES (?, ?, ?, ?)");
    for (const c of d.chunks ?? []) {
      const chunkId = Number(insertChunk.run(docId, c.seq, c.heading, c.text).lastInsertRowid);
      if (acceptVectors) insertChunkVec(chunkId, d, c.embedding);
      else if (c.embedding) result.vectors_skipped!++;
    }
    result.documents++;
  }

  for (const relation of payload.relations ?? []) {
    const tomb = db
      .prepare("SELECT deleted_at FROM deletions WHERE tbl = 'memory_relations' AND uid = ?")
      .get(relation.uid) as { deleted_at: string } | undefined;
    if (tomb && tomb.deleted_at >= relation.updated_at) continue;
    // Accept before endpoints if peer ordering is partial. Graph reads hide it
    // until both memories arrive; integrity_check exposes a persistent orphan.
    const local = db.prepare("SELECT * FROM memory_relations WHERE uid = ?").get(relation.uid) as
      | (typeof relation)
      | undefined;
    const relationFp = (row: typeof relation) =>
      contentFingerprint([
        row.from_uid, row.to_uid, row.relation_type, row.confidence,
        row.valid_from, row.valid_to, row.source, row.metadata, row.created_at,
      ]);
    if (
      local &&
      !remoteWins(local.updated_at, relation.updated_at, () => relationFp(local), () => relationFp(relation))
    ) continue;
    db.prepare(
      `INSERT INTO memory_relations(
         uid, from_uid, to_uid, relation_type, confidence, valid_from, valid_to,
         source, metadata, created_at, updated_at
       ) VALUES (
         @uid, @from_uid, @to_uid, @relation_type, @confidence, @valid_from, @valid_to,
         @source, @metadata, @created_at, @updated_at
       ) ON CONFLICT(uid) DO UPDATE SET
         from_uid=excluded.from_uid, to_uid=excluded.to_uid,
         relation_type=excluded.relation_type, confidence=excluded.confidence,
         valid_from=excluded.valid_from, valid_to=excluded.valid_to,
         source=excluded.source, metadata=excluded.metadata,
         created_at=excluded.created_at, updated_at=excluded.updated_at`
    ).run(relation);
    result.relations++;
  }

  for (const p of payload.projects ?? []) {
    const tomb = db.prepare("SELECT deleted_at FROM deletions WHERE tbl = 'projects' AND uid = ?").get(p.name) as
      | { deleted_at: string }
      | undefined;
    if (tomb && tomb.deleted_at >= p.updated_at) continue;
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
    const session = { ...s, updated_at: s.updated_at ?? s.created_at, origin_machine: s.origin_machine ?? null };
    const tomb = db.prepare("SELECT 1 FROM deletions WHERE tbl = 'session_logs' AND uid = ?").get(s.uid);
    if (tomb) continue; // silinmiş oturum logu geri dirilmesin
    const local = db.prepare("SELECT project, summary, source, created_at, updated_at FROM session_logs WHERE uid = ?").get(s.uid) as
      | { project: string | null; summary: string; source: string | null; created_at: string; updated_at: string }
      | undefined;
    if (local) {
      const fp = (row: { project: string | null; summary: string; source: string | null; created_at: string }) =>
        contentFingerprint([row.project, row.summary, row.source, row.created_at]);
      if (!remoteWins(local.updated_at, session.updated_at, () => fp(local), () => fp(session))) continue;
      db.prepare(
        `UPDATE session_logs SET project=@project, summary=@summary, source=@source,
         origin_machine=COALESCE(@origin_machine, origin_machine),
         created_at=@created_at, updated_at=@updated_at WHERE uid=@uid`
      ).run(session);
    } else {
      db.prepare(
        `INSERT INTO session_logs(uid, project, summary, source, origin_machine, created_at, updated_at)
         VALUES (@uid, @project, @summary, @source, @origin_machine, @created_at, @updated_at)`
      ).run(session);
    }
    result.sessions++;
  }

  for (const m of payload.machines ?? []) {
    const tomb = db.prepare("SELECT deleted_at FROM deletions WHERE tbl = 'machines' AND uid = ?").get(m.name) as
      | { deleted_at: string }
      | undefined;
    if (tomb && tomb.deleted_at >= m.updated_at) continue;
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

  // (kind,name) fallback eşleşmesi de tutulur: birden çok cihaz aynı repo skill/prompt
  // dosyalarını bağımsız seed ederse (deterministik seed uid'i olmayan eski veri, elle
  // düzenleme, vb.) UNIQUE(kind,name) çakışması yerine LWW ile aynı satıra yakınsar.
  for (const raw of payload.assets ?? []) {
    const tomb = db.prepare("SELECT deleted_at FROM deletions WHERE tbl = 'assets' AND uid = ?").get(raw.uid) as
      | { deleted_at: string }
      | undefined;
    if (tomb && tomb.deleted_at >= raw.updated_at) continue;
    const local = db
      .prepare("SELECT * FROM assets WHERE uid = ? OR (kind = ? AND name = ?) ORDER BY uid = ? DESC LIMIT 1")
      .get(raw.uid, raw.kind, raw.name, raw.uid) as { id: number; kind: string; name: string; content: string; updated_at: string } | undefined;
    const fp = (r: { kind: string; name: string; content: string }) => contentFingerprint([r.kind, r.name, r.content]);
    if (local) {
      if (!remoteWins(local.updated_at, raw.updated_at, () => fp(local), () => fp(raw))) continue;
      db.prepare("UPDATE assets SET content=@content, updated_at=@updated_at WHERE id=@id").run({
        content: raw.content, updated_at: raw.updated_at, id: local.id,
      });
    } else {
      db.prepare(
        `INSERT INTO assets(uid, kind, name, content, created_at, updated_at)
         VALUES (@uid, @kind, @name, @content, @created_at, @updated_at)`
      ).run(raw);
    }
    result.assets++;
  }

  for (const raw of payload.agent_presence ?? []) {
    const tomb = db.prepare("SELECT deleted_at FROM deletions WHERE tbl = 'agent_presence' AND uid = ?").get(raw.uid) as
      | { deleted_at: string }
      | undefined;
    if (tomb && tomb.deleted_at >= raw.updated_at) continue;
    const local = db.prepare("SELECT * FROM agent_presence WHERE uid = ?").get(raw.uid) as
      | { id: number; updated_at: string; machine: string; agent: string; project: string; branch: string | null; task: string; status: string; started_at: string; heartbeat_at: string; finished_at: string | null }
      | undefined;
    const fp = (r: { machine: string; agent: string; project: string; branch: string | null; task: string; status: string; heartbeat_at: string; finished_at: string | null }) =>
      contentFingerprint([r.machine, r.agent, r.project, r.branch, r.task, r.status, r.heartbeat_at, r.finished_at]);
    if (local) {
      if (!remoteWins(local.updated_at, raw.updated_at, () => fp(local), () => fp(raw))) continue;
      db.prepare(
        `UPDATE agent_presence SET machine=@machine, agent=@agent, project=@project, branch=@branch, task=@task,
         status=@status, started_at=@started_at, heartbeat_at=@heartbeat_at, finished_at=@finished_at, updated_at=@updated_at
         WHERE uid=@uid`
      ).run(raw);
    } else {
      db.prepare(
        `INSERT INTO agent_presence(uid, machine, agent, project, branch, task, status, started_at, heartbeat_at, finished_at, created_at, updated_at)
         VALUES (@uid, @machine, @agent, @project, @branch, @task, @status, @started_at, @heartbeat_at, @finished_at, @created_at, @updated_at)`
      ).run(raw);
    }
    result.agent_presence++;
  }

  // Agent Intelligence Platform: tasks
  for (const raw of payload.tasks ?? []) {
    const tomb = db.prepare("SELECT deleted_at FROM deletions WHERE tbl = 'tasks' AND uid = ?").get(raw.uid) as
      | { deleted_at: string }
      | undefined;
    if (tomb && tomb.deleted_at >= raw.updated_at) continue;
    const local = db.prepare("SELECT * FROM tasks WHERE uid = ?").get(raw.uid) as
      | { id: number; updated_at: string }
      | undefined;
    const fp = (r: { title: string; description: string | null; status: string; priority: number; claimed_by: string | null; result: string | null }) =>
      contentFingerprint([r.title, r.description, r.status, r.priority, r.claimed_by, r.result]);
    if (local) {
      if (!remoteWins(local.updated_at, raw.updated_at, () => fp(local as never), () => fp(raw))) continue;
      db.prepare(
        `UPDATE tasks SET project=@project, title=@title, description=@description, status=@status, priority=@priority,
         created_by=@created_by, claimed_by=@claimed_by, claimed_at=@claimed_at, depends_on=@depends_on, tags=@tags,
         result=@result, error=@error, due_at=@due_at, started_at=@started_at, finished_at=@finished_at, updated_at=@updated_at
         WHERE uid=@uid`
      ).run(raw);
    } else {
      db.prepare(
        `INSERT INTO tasks(uid, project, title, description, status, priority, created_by, claimed_by, claimed_at,
          depends_on, tags, result, error, due_at, started_at, finished_at, created_at, updated_at)
         VALUES (@uid, @project, @title, @description, @status, @priority, @created_by, @claimed_by, @claimed_at,
          @depends_on, @tags, @result, @error, @due_at, @started_at, @finished_at, @created_at, @updated_at)`
      ).run(raw);
    }
  }

  // Agent Intelligence Platform: agent_capabilities
  for (const raw of payload.agent_capabilities ?? []) {
    const local = db.prepare("SELECT * FROM agent_capabilities WHERE uid = ?").get(raw.uid) as
      | { id: number; updated_at: string }
      | undefined;
    const fp = (r: { agent: string; machine: string | null; capabilities: string; status: string }) =>
      contentFingerprint([r.agent, r.machine, r.capabilities, r.status]);
    if (local) {
      if (!remoteWins(local.updated_at, raw.updated_at, () => fp(local as never), () => fp(raw))) continue;
      db.prepare(
        `UPDATE agent_capabilities SET agent=@agent, machine=@machine, capabilities=@capabilities, models=@models,
         max_concurrent=@max_concurrent, status=@status, last_seen_at=@last_seen_at, metadata=@metadata, updated_at=@updated_at
         WHERE uid=@uid`
      ).run(raw);
    } else {
      db.prepare(
        `INSERT INTO agent_capabilities(uid, agent, machine, capabilities, models, max_concurrent, status, last_seen_at, metadata, created_at, updated_at)
         VALUES (@uid, @agent, @machine, @capabilities, @models, @max_concurrent, @status, @last_seen_at, @metadata, @created_at, @updated_at)`
      ).run(raw);
    }
  }

  // Agent Intelligence Platform: agent_messages (insert-only, no LWW needed)
  for (const raw of payload.agent_messages ?? []) {
    const exists = db.prepare("SELECT 1 FROM agent_messages WHERE uid = ?").get(raw.uid);
    if (exists) continue;
    db.prepare(
      `INSERT INTO agent_messages(uid, from_agent, to_agent, project, task_uid, kind, subject, body, payload, read_at, created_at)
       VALUES (@uid, @from_agent, @to_agent, @project, @task_uid, @kind, @subject, @body, @payload, @read_at, @created_at)`
    ).run(raw);
  }

  for (const del of payload.deletions ?? []) {
    // deleted_at donmasın: geç gelen silme daha yeni ise tombstone'u ilerlet (LWW)
    db.prepare(
      `INSERT INTO deletions(uid, tbl, deleted_at) VALUES (@uid, @tbl, @deleted_at)
       ON CONFLICT(tbl, uid) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)`
    ).run(del);
    if (del.tbl === "memories") {
      const row = db.prepare("SELECT id, updated_at FROM memories WHERE uid = ?").get(del.uid) as { id: number; updated_at: string } | undefined;
      if (row && row.updated_at <= del.deleted_at) {
        vectorStore.delete("memory", row.id);
        db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
        result.deletions++;
      }
    } else if (del.tbl === "documents") {
      const row = db.prepare("SELECT id, updated_at FROM documents WHERE uid = ?").get(del.uid) as { id: number; updated_at: string } | undefined;
      if (row && row.updated_at <= del.deleted_at) {
        vectorStore.deleteDocumentChunks(row.id);
        db.prepare("DELETE FROM chunks WHERE document_id = ?").run(row.id);
        db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
        result.deletions++;
      }
    } else if (del.tbl === "memory_relations") {
      const row = db.prepare("SELECT updated_at FROM memory_relations WHERE uid = ?").get(del.uid) as
        | { updated_at: string }
        | undefined;
      if (row && row.updated_at <= del.deleted_at) {
        db.prepare("DELETE FROM memory_relations WHERE uid = ?").run(del.uid);
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
    } else if (del.tbl === "assets") {
      const row = db.prepare("SELECT id, updated_at FROM assets WHERE uid = ?").get(del.uid) as { id: number; updated_at: string } | undefined;
      if (row && row.updated_at <= del.deleted_at) {
        db.prepare("DELETE FROM assets WHERE id = ?").run(row.id);
        result.deletions++;
      }
    } else if (del.tbl === "agent_presence") {
      const row = db.prepare("SELECT id, updated_at FROM agent_presence WHERE uid = ?").get(del.uid) as { id: number; updated_at: string } | undefined;
      if (row && row.updated_at <= del.deleted_at) {
        db.prepare("DELETE FROM agent_presence WHERE id = ?").run(row.id);
        result.deletions++;
      }
    }
  }

  return result;
}

/** Apply one sync payload atomically: a malformed row cannot leave a half-applied peer state. */
export function applyChanges(payload: SyncPayload): ApplyResult {
  payload = syncPayloadSchema.parse(payload) as SyncPayload;
  const db = getDb();
  return db.transaction(() => applyChangesUnsafe(payload))();
}

export function recordDeletion(tbl: string, uid: string): void {
  getDb()
    .prepare(
      `INSERT INTO deletions(uid, tbl, deleted_at) VALUES (?, ?, ${NOW_MS})
       ON CONFLICT(tbl, uid) DO UPDATE SET deleted_at = ${NOW_MS}`
    )
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
    let pushed: ApplyResult = { memories: 0, documents: 0, relations: 0, projects: 0, sessions: 0, machines: 0, assets: 0, agent_presence: 0, deletions: 0 };
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
