import { getDb, hasVec } from "./db.js";
import { embedOne, embeddingsEnabled, toBuffer } from "./embeddings.js";

const RRF_K = 60;
const CANDIDATES = 20;

/** Serbest metni güvenli FTS5 sorgusuna çevirir: "tok1" OR "tok2" ... */
export function toFtsQuery(query: string): string {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1)
    .slice(0, 12);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
}

export interface RankedId {
  id: number;
  score: number;
}

/** FTS + vektör sonuçlarını Reciprocal Rank Fusion ile birleştirir. */
export function rrfFuse(lists: number[][]): RankedId[] {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export function ftsSearch(ftsTable: string, query: string, limit = CANDIDATES): number[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  try {
    const rows = getDb()
      .prepare(`SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ? ORDER BY rank LIMIT ?`)
      .all(fts, limit) as { rowid: number }[];
    return rows.map((r) => r.rowid);
  } catch {
    return []; // bozuk sorgu FTS'i düşürmesin
  }
}

export async function vecSearch(vecTable: string, query: string, limit = CANDIDATES): Promise<number[]> {
  if (!hasVec() || !embeddingsEnabled()) return [];
  const vec = await embedOne(query, "RETRIEVAL_QUERY");
  if (!vec) return [];
  const rows = getDb()
    .prepare(`SELECT rowid FROM ${vecTable} WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
    .all(toBuffer(vec), limit) as { rowid: number }[];
  return rows.map((r) => r.rowid);
}

/** Hibrit arama: FTS + vektör → RRF. Vektör yoksa FTS-only. */
export async function hybridSearch(ftsTable: string, vecTable: string, query: string): Promise<RankedId[]> {
  const [ftsIds, vecIds] = await Promise.all([
    Promise.resolve(ftsSearch(ftsTable, query)),
    vecSearch(vecTable, query).catch((err) => {
      console.error(`[hub] vektör arama hatası (FTS ile devam): ${(err as Error).message}`);
      return [] as number[];
    }),
  ]);
  return rrfFuse([ftsIds, vecIds].filter((l) => l.length > 0));
}
