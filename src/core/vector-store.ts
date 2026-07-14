import { config } from "./config.js";
import {
  GLOBAL_VECTOR_PROJECT,
  getDb,
  hasVec,
  putChunkVector,
  putMemoryVector,
  vectorIndexReady,
} from "./db.js";

export type VectorEntity = "memory" | "chunk";

export interface VectorSearchFilter {
  project?: string;
  includeGlobal?: boolean;
  enabled?: boolean;
  currentOnly?: boolean;
  documentKind?: string;
}

export interface VectorHit {
  id: number;
  distance: number;
}

export interface VectorStore {
  readonly backend: "sqlite-vec";
  available(): boolean;
  ready(): boolean;
  search(entity: VectorEntity, embedding: Buffer, limit: number, filter?: VectorSearchFilter): VectorHit[];
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
}

class SqliteVectorStore implements VectorStore {
  readonly backend = "sqlite-vec" as const;

  available(): boolean {
    return hasVec();
  }

  ready(): boolean {
    return vectorIndexReady();
  }

  search(
    entity: VectorEntity,
    embedding: Buffer,
    limit: number,
    filter: VectorSearchFilter = {}
  ): VectorHit[] {
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
}

if (config.vectorBackend !== "sqlite-vec") {
  throw new Error(`unsupported HUB_VECTOR_BACKEND=${config.vectorBackend}; this build supports sqlite-vec`);
}

/** Single vector-index boundary used by online read/write/delete paths. */
export const vectorStore: VectorStore = new SqliteVectorStore();
