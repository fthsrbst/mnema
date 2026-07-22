/**
 * Memory hygiene: automated detection and cleanup of duplicate, stale,
 * and contradictory memories. Maintains knowledge base quality over time.
 */
import { getDb, NOW_MS } from "./db.js";
import { config } from "./config.js";
import { notifyWrite } from "./events.js";
import { toFtsQuery } from "./search.js";
import { listMemoryRelations } from "./relations.js";
import type { HygieneReport } from "./types.js";

// Duplicate-pair gate: FTS/bm25 generates candidates, but on a domain-homogeneous
// corpus (many notes sharing "mcp"/"hub"/"sync") bm25 alone massively over-reports.
// We confirm each candidate pair with Jaccard overlap of the two titles' significant
// tokens — a real near-duplicate restates the same thing, it doesn't merely share
// vocabulary. Embedding-free so it still works in FTS-only mode.
const DUP_TITLE_JACCARD_MIN = 0.5;
const DUP_STOPWORDS = new Set([
  "ve", "ile", "icin", "bir", "bu", "da", "de", "mi", "mu", "ya", "veya",
  "the", "a", "an", "of", "to", "in", "on", "is", "are", "and", "or", "for",
]);

/** Türkçe aksanları katlar (context.foldTurkishAscii ile aynı ruh); bağımsız tutuldu. */
function foldTr(s: string): string {
  return s
    .replace(/[İIı]/g, "i").replace(/[çÇ]/g, "c").replace(/[ğĞ]/g, "g")
    .replace(/[öÖ]/g, "o").replace(/[şŞ]/g, "s").replace(/[üÜ]/g, "u")
    .toLowerCase();
}

/** Başlığı anlamlı token kümesine indirger: aksan-katlanmış, kısa/stopword token'lar atılır. */
function significantTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const tok of foldTr(title).split(/[^a-z0-9]+/)) {
    if (tok.length < 3 || DUP_STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/** İki token kümesinin Jaccard benzerliği (kesişim/birleşim); ikisinden biri boşsa 0. */
function titleJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Find potential duplicate memories. Synchronous and embedding-free (no
 * vectorStore dependency — must work in FTS-only mode too):
 * 1. Exact title match (case-insensitive) — cheap, distance 0.0.
 * 2. Lexical near-duplicate via the memories FTS5 index: for each of the newest
 *    200 memories, query memories_fts with the memory's own title terms and flag
 *    other memories with a strong bm25 rank. This is lexical similarity (shared
 *    distinctive terms), NOT semantic similarity — it catches near-identical
 *    wording but misses paraphrased duplicates (that would require vectorStore).
 */
export function findDuplicates(project?: string): HygieneReport["duplicates"] {
  const db = getDb();
  const duplicates: HygieneReport["duplicates"] = [];
  const seen = new Set<string>();

  const where = project ? "WHERE project = ?" : "";
  const params = project ? [project] : [];

  // Pass 1: exact title match (case-insensitive), computed in SQL instead of an
  // O(n²) JS loop. Group by lower(title) to find titles shared by 2+ memories,
  // then fetch the member ids per duplicated title (ordered by id) and emit
  // pairs: first id as memory_id, each later id as similar_to.
  const dupTitles = db
    .prepare(`SELECT lower(title) AS t FROM memories ${where} GROUP BY lower(title) HAVING COUNT(*) > 1`)
    .all(...params) as { t: string }[];
  for (const dt of dupTitles) {
    const memberWhere = project ? "WHERE project = ? AND lower(title) = ?" : "WHERE lower(title) = ?";
    const memberParams = project ? [project, dt.t] : [dt.t];
    const members = db
      .prepare(`SELECT id, title FROM memories ${memberWhere} ORDER BY id`)
      .all(...memberParams) as { id: number; title: string }[];
    const first = members[0];
    for (let k = 1; k < members.length; k++) {
      const b = members[k];
      const key = [first.id, b.id].join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      duplicates.push({ memory_id: first.id, title: first.title, similar_to: b.id, distance: 0.0 });
    }
  }

  // Pass 2: FTS generates near-duplicate candidates over the newest 200 memories,
  // then each pair is confirmed by title-token Jaccard overlap (see the helpers at
  // the top of this file). bm25 alone flagged ~145 pairs on a 63-memory corpus —
  // almost all false positives from shared technical vocabulary. The Jaccard gate
  // keeps only pairs whose titles actually restate the same thing.
  const titleById = new Map<number, string>(
    (db.prepare(`SELECT id, title FROM memories ${where}`).all(...params) as { id: number; title: string }[]).map(
      (m) => [m.id, m.title] as const
    )
  );
  const newest = db
    .prepare(`SELECT id, title FROM memories ${where} ORDER BY id DESC LIMIT 200`)
    .all(...params) as { id: number; title: string }[];
  for (const m of newest) {
    const fts = toFtsQuery(m.title);
    if (!fts) continue;
    const mTokens = significantTokens(m.title);
    if (mTokens.size === 0) continue;
    let rows: { rowid: number; rank: number }[];
    try {
      rows = db
        .prepare(
          `SELECT memories_fts.rowid AS rowid, bm25(memories_fts) AS rank
           FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 5`
        )
        .all(fts) as { rowid: number; rank: number }[];
    } catch {
      continue; // bozuk sorgu hygiene taramasını düşürmesin
    }
    for (const r of rows) {
      if (r.rowid === m.id) continue;
      const candTitle = titleById.get(r.rowid);
      if (candTitle === undefined) continue; // FTS proje filtresini bilmez — kapsam dışıysa ele
      const key = [Math.min(m.id, r.rowid), Math.max(m.id, r.rowid)].join("-");
      if (seen.has(key)) continue;
      // Precision gate: yalnızca AYNI şeyi tekrar eden başlıklar (yüksek Jaccard)
      // duplicate sayılır; sadece ortak teknik kelime paylaşanlar (yanlış-pozitif) elenir.
      const jaccard = titleJaccard(mTokens, significantTokens(candTitle));
      if (jaccard < DUP_TITLE_JACCARD_MIN) continue;
      seen.add(key);
      duplicates.push({ memory_id: m.id, title: m.title, similar_to: r.rowid, distance: Number((1 - jaccard).toFixed(2)) });
    }
  }

  return duplicates;
}

/** Find stale memories (not accessed recently with low importance). */
export function findStale(days = 90): HygieneReport["stale"] {
  const db = getDb();
  const cutoff = (
    db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f', 'now', '-${days} days') AS c`).get() as { c: string }
  ).c;
  const rows = db
    .prepare(
      `SELECT id AS memory_id, title, last_accessed, importance FROM memories
       WHERE importance <= 1.0
         AND (last_accessed IS NULL OR last_accessed < ?)
         AND updated_at < ?
       ORDER BY importance ASC, COALESCE(last_accessed, '1970-01-01') ASC
       LIMIT 50`
    )
    .all(cutoff, cutoff) as { memory_id: number; title: string; last_accessed: string | null; importance: number }[];
  return rows;
}

/** Find memories with active contradiction relations. */
export function findContradictions(project?: string): HygieneReport["contradictions"] {
  const db = getDb();
  const contradictions: HygieneReport["contradictions"] = [];

  // Get all contradiction relations
  const relations = db
    .prepare(
      `SELECT r.from_uid, r.to_uid, mf.id AS from_id, mf.title AS from_title, mt.id AS to_id, mt.title AS to_title
       FROM memory_relations r
       JOIN memories mf ON mf.uid = r.from_uid
       JOIN memories mt ON mt.uid = r.to_uid
       WHERE r.relation_type = 'contradicts'
         AND (r.valid_to IS NULL OR r.valid_to > ${NOW_MS})`
    )
    .all() as { from_id: number; from_title: string; to_id: number; to_title: string }[];

  for (const rel of relations) {
    if (project) {
      // Keep the relation if EITHER memory belongs to the target project (a single-row
      // query with "id = ? OR id = ?" can only return one arbitrary row and silently
      // drops relations where just one side matches).
      const memProjects = db
        .prepare("SELECT project FROM memories WHERE id IN (?, ?)")
        .all(rel.from_id, rel.to_id) as { project: string | null }[];
      if (!memProjects.some((m) => m.project === project)) continue;
    }
    contradictions.push(rel);
  }
  return contradictions;
}

/** Count orphan relations (relations pointing to deleted memories). */
export function countOrphanRelations(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM memory_relations r
       WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.uid = r.from_uid)
          OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.uid = r.to_uid)`
    )
    .get() as { n: number };
  return row.n;
}

/** Generate a full hygiene report. */
export function hygieneReport(project?: string): HygieneReport {
  const totalRow = getDb()
    .prepare(project ? "SELECT COUNT(*) AS n FROM memories WHERE project = ?" : "SELECT COUNT(*) AS n FROM memories")
    .get(...(project ? [project] : [])) as { n: number };

  return {
    duplicates: findDuplicates(project),
    stale: findStale(),
    contradictions: findContradictions(project),
    orphan_relations: countOrphanRelations(),
    total_memories: totalRow.n,
    generated_at: new Date().toISOString(),
  };
}

/** Archive stale memories by reducing importance and adding archive tag. */
export function archiveStale(memoryIds: number[]): number {
  const db = getDb();
  let count = 0;
  const update = db.prepare(
    `UPDATE memories SET
      importance = 0.5,
      tags = CASE
        WHEN tags LIKE '%"archived"%' THEN tags
        ELSE json_insert(tags, '$[#]', 'archived')
      END,
      updated_at = ${NOW_MS}
     WHERE id = ?`
  );
  db.transaction(() => {
    for (const id of memoryIds) {
      const info = update.run(id);
      count += info.changes;
    }
  })();
  if (count > 0) notifyWrite();
  return count;
}

/** Delete orphan relations. */
export function cleanupOrphanRelations(): number {
  const db = getDb();
  const info = db
    .prepare(
      `DELETE FROM memory_relations
       WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.uid = from_uid)
          OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.uid = to_uid)`
    )
    .run();
  if (info.changes > 0) notifyWrite();
  return info.changes;
}

/**
 * Run a full automated hygiene pass.
 * Returns a summary of actions taken.
 */
export function runHygiene(project?: string): {
  report: HygieneReport;
  archived: number;
  orphans_cleaned: number;
} {
  const report = hygieneReport(project);

  // Auto-archive memories that are very stale and low importance
  const toArchive = report.stale
    .filter((s) => s.importance < 0.7 && (!s.last_accessed || s.last_accessed < new Date(Date.now() - 180 * 86400000).toISOString()))
    .map((s) => s.memory_id);
  const archived = archiveStale(toArchive);

  // Clean up orphan relations
  const orphans_cleaned = cleanupOrphanRelations();

  return { report, archived, orphans_cleaned };
}

/** Get memory statistics for monitoring. */
export function memoryStats(project?: string): {
  total: number;
  by_type: { type: string; count: number }[];
  avg_importance: number;
  never_accessed: number;
} {
  const db = getDb();
  const where = project ? "WHERE project = ?" : "";
  const params = project ? [project] : [];

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM memories ${where}`).get(...params) as { n: number }).n;

  const byType = db
    .prepare(`SELECT type, COUNT(*) AS count FROM memories ${where} GROUP BY type ORDER BY count DESC`)
    .all(...params) as { type: string; count: number }[];

  const avgImportance = (
    db.prepare(`SELECT AVG(importance) AS avg FROM memories ${where}`).get(...params) as { avg: number | null }
  ).avg ?? 1.0;

  const neverAccessed = (
    db.prepare(`SELECT COUNT(*) AS n FROM memories ${where} ${where ? "AND" : "WHERE"} access_count = 0`).get(...params) as { n: number }
  ).n;

  return { total, by_type: byType, avg_importance: avgImportance, never_accessed: neverAccessed };
}
