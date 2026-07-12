import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { getDb, hasVec, NOW_MS } from "./db.js";
import { embedOne, toBuffer } from "./embeddings.js";
import { notifyWrite } from "./events.js";
import { hybridSearch } from "./search.js";
import { recordDeletion } from "./sync.js";
import type { Memory, MemoryInput, RelatedRef, SavedMemory, ScoredMemory, SearchFilters, SimilarHit } from "./types.js";

/** Önem çarpanını 0.5–2.0 aralığına kelepçeler. */
function clampImportance(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 1.0;
  return Math.min(2.0, Math.max(0.5, v));
}

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    ...(row as unknown as Memory),
    tags: JSON.parse((row.tags as string) ?? "[]"),
    related: JSON.parse((row.related as string) ?? "[]"),
  };
}

/**
 * Yerel id listesini uid listesine çevirir (bağlantı saklama için). Bilinmeyen id'ler
 * ve kendine bağlantı sessizce atlanır — agent'ın elindeki id bayat olabilir,
 * bu yüzden hata yerine daralt.
 */
function idsToUids(ids: number[] | undefined, selfId?: number): string[] {
  if (!ids || ids.length === 0) return [];
  const stmt = getDb().prepare("SELECT uid FROM memories WHERE id = ?");
  const uids: string[] = [];
  for (const id of new Set(ids)) {
    if (id === selfId) continue;
    const row = stmt.get(id) as { uid: string } | undefined;
    if (row?.uid) uids.push(row.uid);
  }
  return uids;
}

/** Bağlantılı uid'leri bu cihazdaki id + başlığa çözer (silinmiş/henüz sync olmamışlar atlanır). */
export function resolveRelated(mem: Pick<Memory, "related">): RelatedRef[] {
  if (!mem.related || mem.related.length === 0) return [];
  const stmt = getDb().prepare("SELECT id, title FROM memories WHERE uid = ?");
  const out: RelatedRef[] = [];
  for (const uid of mem.related) {
    const row = stmt.get(uid) as RelatedRef | undefined;
    if (row) out.push(row);
  }
  return out;
}

/**
 * Yeni eklenen vektöre en yakın k=3 komşuyu bulur (kendisi hariç, eşik altında olanlar).
 * Kayıt anında hafif dedup uyarısı için — sqlite-vec'teki KNN deseni search.ts#vecSearch ile aynı.
 */
function findSimilar(id: number, vec: Float32Array): SimilarHit[] {
  const db = getDb();
  // k+1: kendi vektörü de sonuçlarda çıkar (mesafe 0), aşağıda rowid ile ele alınır
  const rows = db
    .prepare(`SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
    .all(toBuffer(vec), 4) as { rowid: number; distance: number }[];
  const hits = rows.filter((r) => r.rowid !== id && r.distance <= config.dupDistance).slice(0, 3);
  return hits.map((r) => ({ id: r.rowid, title: getMemory(r.rowid)?.title ?? "?", distance: r.distance }));
}

async function upsertVector(id: number, title: string, body: string): Promise<SimilarHit[] | undefined> {
  if (!hasVec()) return undefined;
  try {
    const vec = await embedOne(`${title}\n${body}`, "RETRIEVAL_DOCUMENT");
    if (!vec) return undefined;
    const db = getDb();
    // Embed (ağ çağrısı) beklenirken kayıt silinmiş olabilir; rowid yeniden
    // kullanıldığından öksüz vektör başka bir kayda yapışabilir — yazmadan önce doğrula.
    if (!db.prepare("SELECT 1 FROM memories WHERE id = ?").get(id)) return undefined;
    // sqlite-vec rowid için katı INTEGER ister; number REAL bağlandığından BigInt şart
    db.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(BigInt(id));
    db.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)").run(BigInt(id), toBuffer(vec));
    return findSimilar(id, vec);
  } catch (err) {
    console.error(`[hub] memory #${id} embed edilemedi (FTS'te aranabilir): ${(err as Error).message}`);
    return undefined;
  }
}

export async function saveMemory(input: MemoryInput): Promise<SavedMemory> {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO memories(uid, type, title, body, project, tags, source, importance, related, created_at, updated_at)
       VALUES (@uid, @type, @title, @body, @project, @tags, @source, @importance, @related, ${NOW_MS}, ${NOW_MS})`
    )
    .run({
      uid: randomUUID().replaceAll("-", ""),
      type: input.type ?? "fact",
      title: input.title,
      body: input.body,
      project: input.project ?? null,
      tags: JSON.stringify(input.tags ?? []),
      source: input.source ?? null,
      importance: clampImportance(input.importance),
      related: JSON.stringify(idsToUids(input.related_ids)),
    });
  const id = Number(info.lastInsertRowid);
  const similar = await upsertVector(id, input.title, input.body);
  notifyWrite();
  const mem = getMemory(id)!;
  return similar && similar.length > 0 ? { ...mem, similar } : mem;
}

export function getMemory(id: number): Memory | null {
  const row = getDb().prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToMemory(row) : null;
}

export async function updateMemory(id: number, patch: Partial<MemoryInput>): Promise<Memory | null> {
  const existing = getMemory(id);
  if (!existing) return null;
  const merged = {
    type: patch.type ?? existing.type,
    title: patch.title ?? existing.title,
    body: patch.body ?? existing.body,
    project: patch.project === undefined ? existing.project : patch.project,
    tags: JSON.stringify(patch.tags ?? existing.tags),
    importance: patch.importance === undefined ? existing.importance : clampImportance(patch.importance),
    // related_ids verilirse TAM listeyi değiştirir (ekleme değil) — memory_update sözleşmesiyle tutarlı
    related: patch.related_ids === undefined ? JSON.stringify(existing.related) : JSON.stringify(idsToUids(patch.related_ids, id)),
    id,
  };
  getDb()
    .prepare(
      `UPDATE memories SET type=@type, title=@title, body=@body, project=@project,
       tags=@tags, importance=@importance, related=@related, updated_at=${NOW_MS} WHERE id=@id`
    )
    .run(merged);
  if (patch.title !== undefined || patch.body !== undefined) {
    await upsertVector(id, merged.title, merged.body);
  }
  notifyWrite();
  return getMemory(id);
}

export function deleteMemory(id: number): boolean {
  const db = getDb();
  const row = db.prepare("SELECT uid FROM memories WHERE id = ?").get(id) as { uid: string } | undefined;
  if (hasVec()) db.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(BigInt(id));
  const deleted = db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  if (deleted && row?.uid) recordDeletion("memories", row.uid);
  if (deleted) notifyWrite();
  return deleted;
}

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC, offsetsiz) → epoch ms. */
function parseSqliteUtc(ts: string): number {
  return Date.parse(ts.replace(" ", "T") + "Z");
}

function touchMemories(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  // updated_at'e DOKUNULMAZ: bu alanlar cihaz-yerel istatistiktir, sync'e girmez —
  // yoksa her recall bir sync fırtınası yaratır ve LWW bozulur.
  getDb()
    .prepare(`UPDATE memories SET last_accessed = datetime('now'), access_count = access_count + 1 WHERE id IN (${placeholders})`)
    .run(...ids);
}

export async function searchMemories(query: string, filters: SearchFilters = {}): Promise<ScoredMemory[]> {
  const ranked = await hybridSearch("memories_fts", "memories_vec", query);
  if (ranked.length === 0) return [];
  const limit = filters.limit ?? 8;
  const now = Date.now();
  const halflifeMs = Math.max(config.decayHalflifeDays, 1) * 86_400_000;
  const candidates: ScoredMemory[] = [];
  for (const { id, score, channels } of ranked) {
    const mem = getMemory(id);
    if (!mem) continue;
    if (filters.type && mem.type !== filters.type) continue;
    if (filters.project && mem.project !== filters.project) continue;
    if (filters.tag && !mem.tags.includes(filters.tag)) continue;
    const ageMs = Math.max(0, now - parseSqliteUtc(mem.updated_at));
    // Tabanlı decay: taze kayıt öne geçer ama eski kayıt asla decayFloor'un altına
    // ezilmez — "1 yıl önce şu sorunu nasıl çözmüştüm" sorgusu hâlâ sonuç bulur.
    // ln(2) çarpanı şart: onsuz ageMs=halflifeMs anında çarpan 0.5 değil e^-1≈0.368 olur
    // (yani "yarı ömür" adı yalan çıkar, kayıtlar isimlendirildiğinden çok daha hızlı bayatlar).
    const decay = config.decayFloor + (1 - config.decayFloor) * Math.exp(-Math.LN2 * (ageMs / halflifeMs));
    const final = score * mem.importance * decay;
    candidates.push({ ...mem, score: final, channels });
  }
  candidates.sort((a, b) => b.score - a.score);
  const out = candidates.slice(0, limit);
  touchMemories(out.map((m) => m.id));
  return out;
}

export function listMemories(filters: SearchFilters = {}): Memory[] {
  const conds: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.type) (conds.push("type = @type"), (params.type = filters.type));
  if (filters.project) (conds.push("project = @project"), (params.project = filters.project));
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT @limit`)
    .all({ ...params, limit: filters.limit ?? 50 }) as Record<string, unknown>[];
  return rows.map(rowToMemory);
}
