import { config } from "./config.js";
import { getDb } from "./db.js";
import { embedOne, embeddingsEnabled, toBuffer } from "./embeddings.js";
import { vectorStore } from "./vector-store.js";

const RRF_K = 60;

/** Serbest metni güvenli FTS5 sorgusuna çevirir: "tok1" OR "tok2" ... */
export function toFtsQuery(query: string): string {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1)
    .slice(0, 12);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
}

export type SearchChannel = "fts" | "vec";

export interface RankedId {
  id: number;
  score: number;
  /** Hangi arama kanalları buldu. Recall'un anlamsal kanıt kapısı bunu kullanır. */
  channels: SearchChannel[];
  /** One-based rank in each source channel; retained for audit and feedback. */
  channel_ranks: Partial<Record<SearchChannel, number>>;
}

export interface SearchScope {
  project?: string;
  memoryType?: string;
  memoryTag?: string;
  /** Include project-less global rows together with the requested project. */
  includeGlobal?: boolean;
  /** Memory and document searches default to current rows only (is_current=1); pass false to include superseded/archived ones (ADR-006). */
  currentOnly?: boolean;
  documentKind?: string;
}

/** FTS + vektör sonuçlarını Reciprocal Rank Fusion ile birleştirir. */
export function rrfFuse(lists: { channel: SearchChannel; ids: number[] }[]): RankedId[] {
  const scores = new Map<
    number,
    { score: number; channels: SearchChannel[]; channel_ranks: Partial<Record<SearchChannel, number>> }
  >();
  for (const { channel, ids } of lists) {
    ids.forEach((id, rank) => {
      const cur = scores.get(id) ?? { score: 0, channels: [], channel_ranks: {} };
      cur.score += 1 / (RRF_K + rank + 1);
      if (!cur.channels.includes(channel)) cur.channels.push(channel);
      cur.channel_ranks[channel] = rank + 1;
      scores.set(id, cur);
    });
  }
  return [...scores.entries()]
    .map(([id, v]) => ({ id, score: v.score, channels: v.channels, channel_ranks: v.channel_ranks }))
    .sort((a, b) => b.score - a.score);
}

export function ftsSearch(
  ftsTable: string,
  query: string,
  limit = config.searchCandidates,
  scope: SearchScope = {}
): number[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  try {
    let sql = `SELECT ${ftsTable}.rowid FROM ${ftsTable}`;
    const conditions = [`${ftsTable} MATCH ?`];
    const params: unknown[] = [fts];
    if (ftsTable === "memories_fts") {
      // ADR-006: is_current filtresi de dahil olmak üzere her koşul aynı JOIN'i paylaşır,
      // bu yüzden proje/tür/etiket verilmese bile join her zaman eklenir.
      sql += " JOIN memories m ON m.id = memories_fts.rowid";
      if (scope.project) {
        conditions.push(scope.includeGlobal ? "(m.project = ? OR m.project IS NULL)" : "m.project = ?");
        params.push(scope.project);
      }
      if (scope.memoryType) {
        conditions.push("m.type = ?");
        params.push(scope.memoryType);
      }
      if (scope.memoryTag) {
        conditions.push("EXISTS (SELECT 1 FROM json_each(m.tags) WHERE json_each.value = ?)");
        params.push(scope.memoryTag);
      }
      if (scope.currentOnly !== false) conditions.push("m.is_current = 1");
    } else if (ftsTable === "chunks_fts") {
      sql += " JOIN chunks c ON c.id = chunks_fts.rowid JOIN documents d ON d.id = c.document_id";
      conditions.push("d.enabled = 1");
      if (scope.currentOnly !== false) conditions.push("d.is_current = 1");
      if (scope.currentOnly !== false) {
        conditions.push("(d.valid_from IS NULL OR julianday(d.valid_from) <= julianday('now'))");
        conditions.push("(d.valid_to IS NULL OR julianday(d.valid_to) > julianday('now'))");
      }
      if (scope.documentKind) {
        conditions.push("d.kind = ?");
        params.push(scope.documentKind);
      }
      if (scope.project) {
        conditions.push(scope.includeGlobal ? "(d.project = ? OR d.project IS NULL)" : "d.project = ?");
        params.push(scope.project);
      }
    }
    sql += ` WHERE ${conditions.join(" AND ")} ORDER BY ${ftsTable}.rank LIMIT ?`;
    params.push(limit);
    const rows = getDb().prepare(sql).all(...params) as { rowid: number }[];
    return rows.map((r) => r.rowid);
  } catch {
    return []; // bozuk sorgu FTS'i düşürmesin
  }
}

export async function vecSearch(
  vecTable: string,
  query: string,
  limit = config.searchCandidates,
  scope: SearchScope = {}
): Promise<number[]> {
  if (!vectorStore.ready() || !embeddingsEnabled()) return [];
  const vec = await embedOne(query, "RETRIEVAL_QUERY");
  if (!vec) return [];
  const memoryFiltered = vecTable === "memories_vec" && Boolean(scope.memoryType || scope.memoryTag);
  const temporalDocumentFilter = vecTable === "chunks_vec" && scope.currentOnly !== false;
  const requiresMemoryPostFilter = memoryFiltered && vectorStore.backend === "sqlite-vec";
  const requiresTemporalPostFilter = temporalDocumentFilter && vectorStore.backend === "sqlite-vec";
  // sqlite-vec cannot express a multi-valued JSON tag constraint. Oversample
  // within the already-applied project partition, then filter before fusion.
  // At the configured 5k ceiling this covers the current/local profile fully;
  // external adapters must implement the same constraint natively.
  const vectorLimit = requiresMemoryPostFilter || requiresTemporalPostFilter
    ? Math.min(5000, Math.max(limit * 4, 80))
    : limit;
  let rows = await vectorStore.search(vecTable === "chunks_vec" ? "chunk" : "memory", toBuffer(vec), vectorLimit, {
    project: scope.project,
    includeGlobal: scope.includeGlobal,
    currentOnly: scope.currentOnly,
    documentKind: scope.documentKind,
    memoryType: scope.memoryType,
    memoryTag: scope.memoryTag,
  });
  if (requiresMemoryPostFilter && rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    const conditions = [`id IN (${placeholders})`];
    const params: unknown[] = rows.map((row) => row.id);
    if (scope.memoryType) (conditions.push("type = ?"), params.push(scope.memoryType));
    if (scope.memoryTag) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE json_each.value = ?)");
      params.push(scope.memoryTag);
    }
    const allowed = new Set(
      (getDb().prepare(`SELECT id FROM memories WHERE ${conditions.join(" AND ")}`).all(...params) as { id: number }[])
        .map((row) => row.id)
    );
    rows = rows.filter((row) => allowed.has(row.id)).slice(0, limit);
  }
  if (requiresTemporalPostFilter && rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    const allowed = new Set(
      (getDb()
        .prepare(
          `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE c.id IN (${placeholders})
             AND (d.valid_from IS NULL OR julianday(d.valid_from) <= julianday('now'))
             AND (d.valid_to IS NULL OR julianday(d.valid_to) > julianday('now'))`
        )
        .all(...rows.map((row) => row.id)) as { id: number }[]).map((row) => row.id)
    );
    rows = rows.filter((row) => allowed.has(row.id)).slice(0, limit);
  }
  // KNN her zaman "en yakın" k sonucu döner; alakasızları mesafe eşiğiyle ele
  return rows.filter((r) => r.distance <= config.vecMaxDistance).map((r) => r.id);
}

/** Hibrit arama: FTS + vektör → RRF. Vektör yoksa FTS-only. */
export async function hybridSearch(
  ftsTable: string,
  vecTable: string,
  query: string,
  candidates = config.searchCandidates,
  scope: SearchScope = {}
): Promise<RankedId[]> {
  const [ftsIds, vecIds] = await Promise.all([
    Promise.resolve(ftsSearch(ftsTable, query, candidates, scope)),
    vecSearch(vecTable, query, candidates, scope).catch((err) => {
      console.error(`[hub] vektör arama hatası (FTS ile devam): ${(err as Error).message}`);
      return [] as number[];
    }),
  ]);
  return rrfFuse([
    { channel: "fts", ids: ftsIds },
    { channel: "vec", ids: vecIds },
  ]);
}
