import { config } from "./config.js";
import {
  GLOBAL_VECTOR_PROJECT,
  embeddingGenerationState,
  getDb,
  hasVec,
  putChunkVector,
  putMemoryVector,
  vectorIndexReady,
  vectorProject,
} from "./db.js";

export type VectorEntity = "memory" | "chunk";

export interface VectorSearchFilter {
  project?: string;
  includeGlobal?: boolean;
  enabled?: boolean;
  currentOnly?: boolean;
  documentKind?: string;
  memoryType?: string;
  memoryTag?: string;
}

export interface VectorHit {
  id: number;
  /** L2 distance over L2-normalized vectors; lower is better. */
  distance: number;
}

export interface VectorStoreStatus {
  backend: "sqlite-vec" | "qdrant";
  available: boolean;
  ready: boolean;
  outbox_pending: number;
  outbox_failed: number;
  projection_generation: string | null;
  projection_ready: boolean;
}

export interface VectorProjectionParity {
  ok: boolean;
  backend: "sqlite-vec" | "qdrant";
  generation: string;
  projection_ready: boolean;
  outbox_pending: number;
  local: { memories: number; chunks: number };
  remote: { memories: number; chunks: number } | null;
  error: string | null;
}

export interface VectorStore {
  readonly backend: "sqlite-vec" | "qdrant";
  available(): boolean;
  ready(): boolean;
  search(entity: VectorEntity, embedding: Buffer, limit: number, filter?: VectorSearchFilter): Promise<VectorHit[]>;
  putMemory(id: number, project: string | null | undefined, embedding: Buffer): void;
  putChunk(
    id: number,
    project: string | null | undefined,
    enabled: boolean | number,
    isCurrent: boolean | number,
    kind: string,
    embedding: Buffer
  ): void;
  get(entity: VectorEntity, id: number): Buffer | null;
  delete(entity: VectorEntity, id: number): void;
  deleteDocumentChunks(documentId: number): void;
  countDocumentChunks(documentId: number): number;
  status(): VectorStoreStatus;
}

class SqliteVectorStore implements VectorStore {
  readonly backend = "sqlite-vec" as const;

  available(): boolean {
    return hasVec();
  }

  ready(): boolean {
    return vectorIndexReady();
  }

  async search(
    entity: VectorEntity,
    embedding: Buffer,
    limit: number,
    filter: VectorSearchFilter = {}
  ): Promise<VectorHit[]> {
    if (!this.available() || !this.ready()) return [];
    const table = entity === "memory" ? "memories_vec" : "chunks_vec";
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.project) {
      if (filter.includeGlobal) {
        conditions.push("project IN (?, ?)");
        params.push(filter.project, GLOBAL_VECTOR_PROJECT);
      } else {
        conditions.push("project = ?");
        params.push(filter.project);
      }
    }
    if (entity === "chunk") {
      conditions.push("enabled = ?");
      params.push(BigInt(filter.enabled === false ? 0 : 1));
      if (filter.currentOnly !== false) {
        conditions.push("is_current = ?");
        params.push(1n);
      }
      if (filter.documentKind) {
        conditions.push("kind = ?");
        params.push(filter.documentKind);
      }
    }
    conditions.push("embedding MATCH ?", "k = ?");
    params.push(embedding, limit);
    const rows = getDb()
      .prepare(`SELECT rowid, distance FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY distance`)
      .all(...params) as { rowid: number; distance: number }[];
    return rows.map((row) => ({ id: row.rowid, distance: row.distance }));
  }

  putMemory(id: number, project: string | null | undefined, embedding: Buffer): void {
    putMemoryVector(id, project, embedding);
  }

  putChunk(
    id: number,
    project: string | null | undefined,
    enabled: boolean | number,
    isCurrent: boolean | number,
    kind: string,
    embedding: Buffer
  ): void {
    putChunkVector(id, project, enabled, isCurrent, embedding, kind);
  }

  get(entity: VectorEntity, id: number): Buffer | null {
    if (!this.available()) return null;
    const table = entity === "memory" ? "memories_vec" : "chunks_vec";
    const row = getDb().prepare(`SELECT embedding FROM ${table} WHERE rowid = ?`).get(BigInt(id)) as
      | { embedding: Buffer }
      | undefined;
    return row?.embedding ?? null;
  }

  delete(entity: VectorEntity, id: number): void {
    if (!this.available()) return;
    const table = entity === "memory" ? "memories_vec" : "chunks_vec";
    getDb().prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(id));
  }

  deleteDocumentChunks(documentId: number): void {
    if (!this.available()) return;
    getDb().prepare("DELETE FROM chunks_vec WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)").run(documentId);
  }

  countDocumentChunks(documentId: number): number {
    if (!this.available()) return 0;
    return (getDb()
      .prepare("SELECT COUNT(*) AS n FROM chunks_vec v WHERE v.rowid IN (SELECT id FROM chunks WHERE document_id = ?)")
      .get(documentId) as { n: number }).n;
  }

  status(): VectorStoreStatus {
    return {
      backend: this.backend,
      available: this.available(),
      ready: this.ready(),
      outbox_pending: 0,
      outbox_failed: 0,
      projection_generation: null,
      projection_ready: true,
    };
  }
}

interface OutboxRow {
  entity: VectorEntity;
  row_id: number;
  operation: "upsert" | "delete";
  payload: string | null;
  embedding: Buffer | null;
  generation: string;
  revision: number;
  attempts: number;
}

interface QdrantPoint {
  id: number;
  score: number;
}

const localStore = new SqliteVectorStore();
const ensuredCollections = new Set<string>();

function activeGeneration(): string {
  const state = embeddingGenerationState();
  return state.active ?? state.configured;
}

function projectionMetadata(): { generation: string | null; ready: boolean } {
  const rows = getDb()
    .prepare("SELECT key, value FROM system_metadata WHERE key IN ('qdrant_projection_generation', 'qdrant_projection_ready')")
    .all() as { key: string; value: string }[];
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    generation: values.get("qdrant_projection_generation") ?? null,
    ready: values.get("qdrant_projection_ready") === "1",
  };
}

function setProjectionMetadata(generation: string, ready: boolean): void {
  const stmt = getDb().prepare(
    `INSERT INTO system_metadata(key, value, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  );
  getDb().transaction(() => {
    stmt.run("qdrant_projection_generation", generation);
    stmt.run("qdrant_projection_ready", ready ? "1" : "0");
  })();
}

function projectionReady(): boolean {
  const state = projectionMetadata();
  return state.ready && state.generation === activeGeneration();
}

function currentOutboxCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM vector_outbox WHERE generation = ?").get(activeGeneration()) as { n: number }).n;
}

function currentOutboxIds(entity: VectorEntity): Set<number> {
  const rows = getDb()
    .prepare("SELECT row_id FROM vector_outbox WHERE generation = ? AND entity = ?")
    .all(activeGeneration(), entity) as { row_id: number }[];
  return new Set(rows.map((row) => row.row_id));
}

function mergeVectorHits(
  remote: VectorHit[],
  local: VectorHit[],
  limit: number,
  localAuthorityIds: ReadonlySet<number> = new Set()
): VectorHit[] {
  const merged = new Map<number, number>();
  // A queued upsert/delete means the remote point is stale by definition.
  // Exclude it before fusion; the local index (or local absence after delete)
  // is authoritative until the matching outbox revision is delivered.
  for (const hit of remote) {
    if (!localAuthorityIds.has(hit.id)) merged.set(hit.id, hit.distance);
  }
  for (const hit of local) {
    const previous = merged.get(hit.id);
    if (localAuthorityIds.has(hit.id) || previous === undefined || hit.distance < previous) {
      merged.set(hit.id, hit.distance);
    }
  }
  return [...merged.entries()]
    .map(([id, distance]) => ({ id, distance }))
    .sort((a, b) => a.distance - b.distance || a.id - b.id)
    .slice(0, limit);
}

function collectionName(entity: VectorEntity): string {
  return `${config.qdrantCollectionPrefix}_${entity === "memory" ? "memories" : "chunks"}_${activeGeneration().slice(0, 12)}`;
}

function bufferToVector(buffer: Buffer): number[] {
  if (buffer.byteLength !== config.embeddingDim * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`external vector dimension mismatch: ${buffer.byteLength} bytes`);
  }
  return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, config.embeddingDim));
}

function safeTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 100) : [];
  } catch {
    return [];
  }
}

function redactQdrantKey(value: string): string {
  return config.qdrantApiKey ? value.replaceAll(config.qdrantApiKey, "[redacted]") : value;
}

function memoryPayload(id: number, project: string | null | undefined): Record<string, unknown> {
  const row = getDb().prepare("SELECT type, tags FROM memories WHERE id = ?").get(id) as
    | { type: string; tags: string }
    | undefined;
  return {
    project: vectorProject(project),
    type: row?.type ?? "fact",
    tags: safeTags(row?.tags ?? "[]"),
    generation: activeGeneration(),
  };
}

function chunkPayload(
  id: number,
  project: string | null | undefined,
  enabled: boolean | number,
  isCurrent: boolean | number,
  kind: string
): Record<string, unknown> {
  const row = getDb()
    .prepare(
      `SELECT d.valid_from, d.valid_to
       FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ?`
    )
    .get(id) as { valid_from: string | null; valid_to: string | null } | undefined;
  return {
    project: vectorProject(project),
    enabled: Boolean(enabled),
    current: Boolean(isCurrent),
    kind,
    // Numeric sentinels make the active validity window expressible as two
    // indexed Qdrant ranges without missing/null post-filter ambiguity.
    valid_from_ms: row?.valid_from === null || row?.valid_from === undefined
      ? Number.MIN_SAFE_INTEGER
      : Number.isFinite(Date.parse(row.valid_from)) ? Date.parse(row.valid_from) : Number.MAX_SAFE_INTEGER,
    valid_to_ms: row?.valid_to === null || row?.valid_to === undefined
      ? Number.MAX_SAFE_INTEGER
      : Number.isFinite(Date.parse(row.valid_to)) ? Date.parse(row.valid_to) : Number.MIN_SAFE_INTEGER,
    generation: activeGeneration(),
  };
}

function queueUpsert(entity: VectorEntity, id: number, payload: Record<string, unknown>, embedding: Buffer): void {
  getDb()
    .prepare(
      `INSERT INTO vector_outbox(entity, row_id, operation, payload, embedding, generation, attempts, next_attempt_at, last_error, updated_at)
       VALUES (?, ?, 'upsert', ?, ?, ?, 0, strftime('%Y-%m-%d %H:%M:%f','now'), NULL, strftime('%Y-%m-%d %H:%M:%f','now'))
       ON CONFLICT(entity, row_id) DO UPDATE SET
         operation='upsert', payload=excluded.payload, embedding=excluded.embedding,
         generation=excluded.generation, attempts=0, next_attempt_at=excluded.next_attempt_at,
         revision=vector_outbox.revision + 1, last_error=NULL, updated_at=excluded.updated_at`
    )
    .run(entity, id, JSON.stringify(payload), embedding, activeGeneration());
}

function queueDelete(entity: VectorEntity, id: number): void {
  getDb()
    .prepare(
      `INSERT INTO vector_outbox(entity, row_id, operation, payload, embedding, generation, attempts, next_attempt_at, last_error, updated_at)
       VALUES (?, ?, 'delete', NULL, NULL, ?, 0, strftime('%Y-%m-%d %H:%M:%f','now'), NULL, strftime('%Y-%m-%d %H:%M:%f','now'))
       ON CONFLICT(entity, row_id) DO UPDATE SET
         operation='delete', payload=NULL, embedding=NULL, generation=excluded.generation,
         revision=vector_outbox.revision + 1, attempts=0, next_attempt_at=excluded.next_attempt_at,
         last_error=NULL, updated_at=excluded.updated_at`
    )
    .run(entity, id, activeGeneration());
}

async function qdrantRequest(path: string, init: RequestInit = {}, allowNotFound = false): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.qdrantTimeoutMs);
  try {
    const response = await fetch(`${config.qdrantUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(config.qdrantApiKey ? { "api-key": config.qdrantApiKey } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const body = redactQdrantKey((await response.text()).slice(0, 300));
      throw new Error(`Qdrant HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureCollection(entity: VectorEntity): Promise<void> {
  const name = collectionName(entity);
  if (ensuredCollections.has(name)) return;
  const existing = (await qdrantRequest(`/collections/${name}`, {}, true)) as
    | { result?: { config?: { params?: { vectors?: { size?: number; distance?: string } } } } }
    | null;
  if (!existing) {
    await qdrantRequest(`/collections/${name}`, {
      method: "PUT",
      body: JSON.stringify({
        vectors: { size: config.embeddingDim, distance: "Cosine", on_disk: config.deploymentProfile !== "personal" },
        on_disk_payload: config.deploymentProfile !== "personal",
        metadata: { owner: "mnema", entity, embedding_generation: activeGeneration() },
      }),
    });
  } else {
    const vectors = existing.result?.config?.params?.vectors;
    if (vectors?.size !== undefined && vectors.size !== config.embeddingDim) {
      throw new Error(`Qdrant collection ${name} has dimension ${vectors.size}, expected ${config.embeddingDim}`);
    }
    if (vectors?.distance && vectors.distance.toLowerCase() !== "cosine") {
      throw new Error(`Qdrant collection ${name} must use Cosine distance`);
    }
  }

  const indexes: Array<[string, "keyword" | "bool" | "integer"]> = entity === "memory"
    ? [["project", "keyword"], ["type", "keyword"], ["tags", "keyword"], ["generation", "keyword"]]
    : [["project", "keyword"], ["enabled", "bool"], ["current", "bool"], ["kind", "keyword"], ["valid_from_ms", "integer"], ["valid_to_ms", "integer"], ["generation", "keyword"]];
  for (const [field_name, field_schema] of indexes) {
    await qdrantRequest(`/collections/${name}/index?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ field_name, field_schema }),
    });
  }
  ensuredCollections.add(name);
}

function qdrantFilter(entity: VectorEntity, filter: VectorSearchFilter): Record<string, unknown> {
  const must: Record<string, unknown>[] = [
    { key: "generation", match: { value: activeGeneration() } },
  ];
  if (filter.project) {
    must.push({
      key: "project",
      match: filter.includeGlobal
        ? { any: [filter.project, GLOBAL_VECTOR_PROJECT] }
        : { value: filter.project },
    });
  }
  if (entity === "memory") {
    if (filter.memoryType) must.push({ key: "type", match: { value: filter.memoryType } });
    if (filter.memoryTag) must.push({ key: "tags", match: { value: filter.memoryTag } });
  } else {
    must.push({ key: "enabled", match: { value: filter.enabled !== false } });
    if (filter.currentOnly !== false) must.push({ key: "current", match: { value: true } });
    if (filter.currentOnly !== false) {
      const now = Date.now();
      must.push({ key: "valid_from_ms", range: { lte: now } });
      must.push({ key: "valid_to_ms", range: { gt: now } });
    }
    if (filter.documentKind) must.push({ key: "kind", match: { value: filter.documentKind } });
  }
  return { must };
}

async function qdrantSearch(
  entity: VectorEntity,
  embedding: Buffer,
  limit: number,
  filter: VectorSearchFilter
): Promise<VectorHit[]> {
  await ensureCollection(entity);
  const response = (await qdrantRequest(`/collections/${collectionName(entity)}/points/query`, {
    method: "POST",
    body: JSON.stringify({
      query: bufferToVector(embedding),
      filter: qdrantFilter(entity, filter),
      limit,
      with_payload: false,
      with_vector: false,
    }),
  })) as { result?: { points?: QdrantPoint[] } | QdrantPoint[] };
  const points = Array.isArray(response.result) ? response.result : response.result?.points ?? [];
  return points
    .filter((point) => Number.isSafeInteger(point.id) && Number.isFinite(point.score))
    .map((point) => ({
      id: point.id,
      // Both stores use normalized embeddings. Convert cosine similarity back
      // to the same L2 distance used by sqlite-vec and existing thresholds.
      distance: Math.sqrt(Math.max(0, 2 - 2 * Math.max(-1, Math.min(1, point.score)))),
    }));
}

class QdrantProjectionVectorStore implements VectorStore {
  readonly backend = "qdrant" as const;

  available(): boolean {
    return localStore.available();
  }

  ready(): boolean {
    return localStore.ready();
  }

  async search(entity: VectorEntity, embedding: Buffer, limit: number, filter: VectorSearchFilter = {}): Promise<VectorHit[]> {
    if (!this.ready()) return [];
    if (!projectionReady()) return localStore.search(entity, embedding, limit, filter);
    try {
      const remote = await qdrantSearch(entity, embedding, limit, filter);
      // Preserve read-your-write semantics while the asynchronous projection is
      // catching up. Once the durable queue is empty, avoid the local ANN cost.
      const pendingIds = currentOutboxIds(entity);
      if (pendingIds.size > 0) {
        const local = await localStore.search(entity, embedding, limit, filter);
        return mergeVectorHits(remote, local, limit, pendingIds);
      }
      return remote;
    } catch (err) {
      console.error(`[hub] Qdrant unavailable; sqlite-vec fallback: ${(err as Error).message}`);
      return localStore.search(entity, embedding, limit, filter);
    }
  }

  putMemory(id: number, project: string | null | undefined, embedding: Buffer): void {
    getDb().transaction(() => {
      localStore.putMemory(id, project, embedding);
      queueUpsert("memory", id, memoryPayload(id, project), embedding);
    })();
  }

  putChunk(id: number, project: string | null | undefined, enabled: boolean | number, isCurrent: boolean | number, kind: string, embedding: Buffer): void {
    getDb().transaction(() => {
      localStore.putChunk(id, project, enabled, isCurrent, kind, embedding);
      queueUpsert("chunk", id, chunkPayload(id, project, enabled, isCurrent, kind), embedding);
    })();
  }

  get(entity: VectorEntity, id: number): Buffer | null {
    return localStore.get(entity, id);
  }

  delete(entity: VectorEntity, id: number): void {
    getDb().transaction(() => {
      localStore.delete(entity, id);
      queueDelete(entity, id);
    })();
  }

  deleteDocumentChunks(documentId: number): void {
    const ids = getDb().prepare("SELECT id FROM chunks WHERE document_id = ?").all(documentId) as { id: number }[];
    getDb().transaction(() => {
      localStore.deleteDocumentChunks(documentId);
      for (const { id } of ids) queueDelete("chunk", id);
    })();
  }

  countDocumentChunks(documentId: number): number {
    return localStore.countDocumentChunks(documentId);
  }

  status(): VectorStoreStatus {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS pending,
                COALESCE(SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END), 0) AS failed
         FROM vector_outbox`
      )
      .get() as { pending: number; failed: number };
    return {
      backend: this.backend,
      available: this.available(),
      ready: this.ready(),
      outbox_pending: row.pending,
      outbox_failed: row.failed,
      projection_generation: projectionMetadata().generation,
      projection_ready: projectionReady(),
    };
  }
}

function markOutboxFailure(rows: OutboxRow[], error: unknown): void {
  const message = redactQdrantKey(String(error instanceof Error ? error.message : error).slice(0, 500));
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE vector_outbox SET
       attempts = attempts + 1,
       next_attempt_at = ?,
       last_error = ?,
       updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
     WHERE entity = ? AND row_id = ? AND operation = ? AND generation = ? AND revision = ?`
  );
  db.transaction(() => {
    for (const row of rows) {
      const delaySeconds = Math.min(300, 2 ** Math.min(8, row.attempts + 1));
      const next = new Date(Date.now() + delaySeconds * 1000).toISOString().replace("T", " ").replace("Z", "");
      stmt.run(next, message, row.entity, row.row_id, row.operation, row.generation, row.revision);
    }
  })();
}

/** Flushes a bounded, idempotent batch from SQLite to Qdrant. */
export async function flushVectorOutbox(limit = config.qdrantBatchSize): Promise<{ processed: number; failed: number; discarded: number }> {
  if (config.vectorBackend !== "qdrant") return { processed: 0, failed: 0, discarded: 0 };
  // A generation transition makes queued embeddings semantically incompatible
  // with the active collection. They are safe to discard because authoritative
  // rows remain local and the required reindex/backfill queues fresh vectors.
  const discarded = getDb()
    .prepare("DELETE FROM vector_outbox WHERE generation <> ?")
    .run(activeGeneration()).changes;
  const rows = getDb()
    .prepare(
      `SELECT entity, row_id, operation, payload, embedding, generation, revision, attempts
       FROM vector_outbox
       WHERE next_attempt_at <= strftime('%Y-%m-%d %H:%M:%f','now')
       ORDER BY updated_at, entity, row_id LIMIT ?`
    )
    .all(limit) as OutboxRow[];
  if (rows.length === 0) {
    const metadata = projectionMetadata();
    if (metadata.generation === activeGeneration() && currentOutboxCount() === 0) {
      setProjectionMetadata(activeGeneration(), true);
    }
    return { processed: 0, failed: 0, discarded };
  }

  let processed = 0;
  let failed = 0;
  for (const entity of ["memory", "chunk"] as const) {
    for (const operation of ["upsert", "delete"] as const) {
      const group = rows.filter((row) => row.entity === entity && row.operation === operation);
      if (group.length === 0) continue;
      try {
        await ensureCollection(entity);
        if (operation === "upsert") {
          await qdrantRequest(`/collections/${collectionName(entity)}/points?wait=true`, {
            method: "PUT",
            body: JSON.stringify({
              points: group.map((row) => ({
                id: row.row_id,
                vector: bufferToVector(row.embedding!),
                payload: JSON.parse(row.payload ?? "{}") as Record<string, unknown>,
              })),
            }),
          });
        } else {
          await qdrantRequest(`/collections/${collectionName(entity)}/points/delete?wait=true`, {
            method: "POST",
            body: JSON.stringify({ points: group.map((row) => row.row_id) }),
          });
        }
        const stmt = getDb().prepare(
          "DELETE FROM vector_outbox WHERE entity = ? AND row_id = ? AND operation = ? AND generation = ? AND revision = ?"
        );
        getDb().transaction(() => {
          for (const row of group) stmt.run(row.entity, row.row_id, row.operation, row.generation, row.revision);
        })();
        processed += group.length;
      } catch (err) {
        markOutboxFailure(group, err);
        failed += group.length;
      }
    }
  }
  if (failed === 0 && currentOutboxCount() === 0 && projectionMetadata().generation === activeGeneration()) {
    setProjectionMetadata(activeGeneration(), true);
  }
  return { processed, failed, discarded };
}

/** Queues every authoritative local vector for an initial/recovery backfill. */
export function queueFullVectorProjection(): { memories: number; chunks: number } {
  if (config.vectorBackend !== "qdrant") throw new Error("full external projection requires HUB_VECTOR_BACKEND=qdrant");
  const db = getDb();
  setProjectionMetadata(activeGeneration(), false);
  const memories = db
    .prepare("SELECT m.id, m.project, v.embedding FROM memories m JOIN memories_vec v ON v.rowid = m.id")
    .all() as { id: number; project: string | null; embedding: Buffer }[];
  const chunks = db
    .prepare(
      `SELECT c.id, d.project, d.enabled, d.is_current, d.kind, v.embedding
       FROM chunks c JOIN documents d ON d.id = c.document_id JOIN chunks_vec v ON v.rowid = c.id`
    )
    .all() as { id: number; project: string | null; enabled: number; is_current: number; kind: string; embedding: Buffer }[];
  db.transaction(() => {
    for (const row of memories) queueUpsert("memory", row.id, memoryPayload(row.id, row.project), row.embedding);
    for (const row of chunks) {
      queueUpsert("chunk", row.id, chunkPayload(row.id, row.project, row.enabled, row.is_current, row.kind), row.embedding);
    }
  })();
  if (memories.length + chunks.length === 0) setProjectionMetadata(activeGeneration(), true);
  return { memories: memories.length, chunks: chunks.length };
}

/** Starts a first-time or new-generation backfill without duplicating an active queue. */
export function ensureVectorProjectionQueued(): { queued: boolean; memories: number; chunks: number } {
  if (config.vectorBackend !== "qdrant" || !localStore.ready() || projectionReady() || currentOutboxCount() > 0) {
    return { queued: false, memories: 0, chunks: 0 };
  }
  const queued = queueFullVectorProjection();
  return { queued: true, ...queued };
}

async function qdrantCount(entity: VectorEntity): Promise<number> {
  await ensureCollection(entity);
  const response = (await qdrantRequest(`/collections/${collectionName(entity)}/points/count`, {
    method: "POST",
    body: JSON.stringify({ exact: true }),
  })) as { result?: { count?: number } };
  const count = response.result?.count;
  if (!Number.isSafeInteger(count) || (count ?? -1) < 0) throw new Error(`Qdrant returned an invalid ${entity} count`);
  return count!;
}

/** Exact operational parity check used before and after an external-index cutover. */
export async function verifyVectorProjectionParity(): Promise<VectorProjectionParity> {
  const db = getDb();
  const local = {
    memories: (db.prepare("SELECT COUNT(*) AS n FROM memories_vec").get() as { n: number }).n,
    chunks: (db.prepare("SELECT COUNT(*) AS n FROM chunks_vec").get() as { n: number }).n,
  };
  const status = vectorStore.status();
  const base = {
    backend: config.vectorBackend,
    generation: activeGeneration(),
    projection_ready: status.projection_ready,
    outbox_pending: status.outbox_pending,
    local,
  } as const;
  if (config.vectorBackend !== "qdrant") {
    return { ...base, ok: true, remote: null, error: null };
  }
  try {
    const [memories, chunks] = await Promise.all([qdrantCount("memory"), qdrantCount("chunk")]);
    const remote = { memories, chunks };
    return {
      ...base,
      remote,
      ok: status.projection_ready && status.outbox_pending === 0 && memories === local.memories && chunks === local.chunks,
      error: null,
    };
  } catch (err) {
    return { ...base, ok: false, remote: null, error: redactQdrantKey((err as Error).message).slice(0, 500) };
  }
}

/** Single boundary used by online reads/writes. Qdrant is a durable projection, never the source of truth. */
export const vectorStore: VectorStore = config.vectorBackend === "qdrant"
  ? new QdrantProjectionVectorStore()
  : localStore;
