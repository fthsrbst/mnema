import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { getDb, NOW_MS } from "./db.js";
import { embedOne, toBuffer } from "./embeddings.js";
import { notifyWrite } from "./events.js";
import { hybridSearch } from "./search.js";
import { recordDeletion } from "./sync.js";
import { assertProjectReference } from "./projects.js";
import { resolveMachineName } from "./machine.js";
import type { Memory, MemoryInput, RelatedRef, SavedMemory, ScoredMemory, SearchFilters, SimilarHit } from "./types.js";
import { memoryConsolidateSchema, memoryInputSchema, memoryPatchSchema } from "./schemas.js";
import {
  deleteMemoryRelation,
  deleteRelationsForMemoryUid,
  listMemoryRelations,
  replaceLegacyRelatedRelations,
  saveMemoryRelation,
} from "./relations.js";
import { vectorStore } from "./vector-store.js";

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
async function findSimilar(id: number, vec: Float32Array): Promise<SimilarHit[]> {
  // k+1: kendi vektörü de sonuçlarda çıkar (mesafe 0), aşağıda rowid ile ele alınır
  const rows = await vectorStore.search("memory", toBuffer(vec), 4);
  const hits = rows.filter((r) => r.id !== id && r.distance <= config.dupDistance).slice(0, 3);
  return hits.map((r) => ({ id: r.id, title: getMemory(r.id)?.title ?? "?", distance: r.distance }));
}

async function upsertVector(
  id: number,
  title: string,
  body: string,
  canonicalSummary?: string | null
): Promise<SimilarHit[] | undefined> {
  if (!vectorStore.available()) return undefined;
  try {
    const vec = await embedOne(
      [title, canonicalSummary, body].filter((value): value is string => Boolean(value)).join("\n"),
      "RETRIEVAL_DOCUMENT"
    );
    if (!vec) return undefined;
    const db = getDb();
    // Embed (ağ çağrısı) beklenirken kayıt silinmiş olabilir; rowid yeniden
    // kullanıldığından öksüz vektör başka bir kayda yapışabilir — yazmadan önce doğrula.
    if (!db.prepare("SELECT 1 FROM memories WHERE id = ?").get(id)) return undefined;
    // sqlite-vec rowid için katı INTEGER ister; number REAL bağlandığından BigInt şart
    const stored = db.prepare("SELECT project, is_current FROM memories WHERE id = ?").get(id) as
      | { project: string | null; is_current: number }
      | undefined;
    vectorStore.putMemory(id, stored?.project, stored?.is_current ?? 1, toBuffer(vec));
    return await findSimilar(id, vec);
  } catch (err) {
    console.error(`[hub] memory #${id} embed edilemedi (FTS'te aranabilir): ${(err as Error).message}`);
    return undefined;
  }
}

export async function saveMemory(input: MemoryInput): Promise<SavedMemory> {
  input = memoryInputSchema.parse(input);
  assertProjectReference(input.project, "memory");
  const db = getDb();
  const relatedUids = idsToUids(input.related_ids);
  const info = db
    .prepare(
      `INSERT INTO memories(
         uid, type, title, body, project, tags, source, language, canonical_summary,
         normalizer_generation, importance, related, origin_machine, created_at, updated_at
       ) VALUES (
         @uid, @type, @title, @body, @project, @tags, @source, @language, @canonical_summary,
         @normalizer_generation, @importance, @related, @origin_machine, ${NOW_MS}, ${NOW_MS}
       )`
    )
    .run({
      uid: randomUUID().replaceAll("-", ""),
      type: input.type ?? "fact",
      title: input.title,
      body: input.body,
      project: input.project ?? null,
      tags: JSON.stringify(input.tags ?? []),
      source: input.source ?? null,
      language: input.language ?? null,
      canonical_summary: input.canonical_summary ?? null,
      normalizer_generation: input.normalizer_generation ?? null,
      importance: clampImportance(input.importance),
      related: JSON.stringify(relatedUids),
      origin_machine: input.origin_machine ?? resolveMachineName(),
    });
  const id = Number(info.lastInsertRowid);
  replaceLegacyRelatedRelations(id, relatedUids);
  const similar = await upsertVector(id, input.title, input.body, input.canonical_summary);
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
  patch = memoryPatchSchema.parse(patch);
  const existing = getMemory(id);
  if (!existing) return null;
  if (patch.project !== undefined) assertProjectReference(patch.project, "memory");
  const merged = {
    type: patch.type ?? existing.type,
    title: patch.title ?? existing.title,
    body: patch.body ?? existing.body,
    project: patch.project === undefined ? existing.project : patch.project,
    tags: JSON.stringify(patch.tags ?? existing.tags),
    language: patch.language === undefined ? existing.language : patch.language,
    canonical_summary:
      patch.canonical_summary === undefined ? existing.canonical_summary : patch.canonical_summary,
    normalizer_generation:
      patch.normalizer_generation === undefined ? existing.normalizer_generation : patch.normalizer_generation,
    importance: patch.importance === undefined ? existing.importance : clampImportance(patch.importance),
    // related_ids verilirse TAM listeyi değiştirir (ekleme değil) — memory_update sözleşmesiyle tutarlı
    related: patch.related_ids === undefined ? JSON.stringify(existing.related) : JSON.stringify(idsToUids(patch.related_ids, id)),
    id,
  };
  getDb()
    .prepare(
      `UPDATE memories SET type=@type, title=@title, body=@body, project=@project,
       tags=@tags, language=@language, canonical_summary=@canonical_summary,
       normalizer_generation=@normalizer_generation, importance=@importance,
       related=@related, updated_at=${NOW_MS} WHERE id=@id`
    )
    .run(merged);
  if (patch.related_ids !== undefined) replaceLegacyRelatedRelations(id, JSON.parse(merged.related) as string[]);
  if (patch.title !== undefined || patch.body !== undefined || patch.canonical_summary !== undefined) {
    await upsertVector(id, merged.title, merged.body, merged.canonical_summary);
  } else if (patch.project !== undefined && vectorStore.available()) {
    const embedding = vectorStore.get("memory", id);
    if (embedding) vectorStore.putMemory(id, merged.project, existing.is_current, embedding);
  }
  notifyWrite();
  return getMemory(id);
}

export interface MemoryConsolidationResult {
  target: Memory;
  deleted_source_ids: number[];
  rewired_relations: number;
}

/**
 * Explicit duplicate consolidation. The caller must provide the merged body;
 * Mnema never lets an automatic summarizer destroy source information. Typed
 * edges and the deprecated related-UID projection are rewired before sources
 * are tombstoned.
 */
export async function consolidateMemories(input: {
  target_id: number;
  source_ids: number[];
  body: string;
  title?: string;
  tags?: string[];
  language?: string;
  canonical_summary?: string;
  normalizer_generation?: string;
  source?: string;
}): Promise<MemoryConsolidationResult> {
  input = memoryConsolidateSchema.parse(input);
  const target = getMemory(input.target_id);
  if (!target) throw new Error(`target memory #${input.target_id} not found`);
  const sourceIds = [...new Set(input.source_ids)];
  const sources = sourceIds.map((id) => getMemory(id));
  const missing = sourceIds.filter((_id, index) => !sources[index]);
  if (missing.length > 0) throw new Error(`source memories not found: ${missing.join(", ")}`);
  if (sources.some((memory) => memory!.project !== target.project)) {
    throw new Error("all consolidated memories must have the same project scope");
  }

  const allRelations = new Map<string, ReturnType<typeof listMemoryRelations>[number]>();
  for (const id of sourceIds) {
    for (const relation of listMemoryRelations({ memory_id: id, limit: 500 })) {
      allRelations.set(relation.id, relation);
    }
  }

  const updated = await updateMemory(target.id, {
    body: input.body,
    title: input.title,
    tags: input.tags,
    language: input.language,
    canonical_summary: input.canonical_summary,
    normalizer_generation: input.normalizer_generation,
  });
  if (!updated) throw new Error("target memory disappeared during consolidation");
  if (input.source) {
    getDb().prepare(`UPDATE memories SET source = ?, updated_at = ${NOW_MS} WHERE id = ?`).run(input.source, target.id);
  }

  const sourceSet = new Set(sourceIds);
  let rewired = 0;
  for (const relation of allRelations.values()) {
    const fromId = sourceSet.has(relation.from_id) ? target.id : relation.from_id;
    const toId = sourceSet.has(relation.to_id) ? target.id : relation.to_id;
    if (fromId !== toId) {
      saveMemoryRelation({
        from_id: fromId,
        to_id: toId,
        relation_type: relation.relation_type,
        confidence: relation.confidence,
        valid_from: relation.valid_from ?? undefined,
        valid_to: relation.valid_to ?? undefined,
        source: relation.source ?? undefined,
        metadata: relation.metadata,
      });
      rewired++;
    }
    deleteMemoryRelation(relation.id);
  }

  const removedUids = new Set(sources.map((memory) => memory!.uid));
  const targetUid = getDb().prepare("SELECT uid FROM memories WHERE id = ?").get(target.id) as { uid: string };
  const rows = getDb().prepare("SELECT id, uid, related FROM memories").all() as {
    id: number;
    uid: string;
    related: string;
  }[];
  const updateRelated = getDb().prepare(`UPDATE memories SET related = ?, updated_at = ${NOW_MS} WHERE id = ?`);
  getDb().transaction(() => {
    for (const row of rows) {
      let related: string[];
      try {
        const parsed = JSON.parse(row.related);
        related = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
      } catch {
        related = [];
      }
      const next = [...new Set(related.map((uid) => (removedUids.has(uid) ? targetUid.uid : uid)))]
        .filter((uid) => uid !== row.uid);
      if (JSON.stringify(next) !== JSON.stringify(related)) updateRelated.run(JSON.stringify(next), row.id);
    }
  })();

  const deleted: number[] = [];
  for (const id of sourceIds) if (deleteMemory(id)) deleted.push(id);
  notifyWrite();
  return { target: getMemory(target.id)!, deleted_source_ids: deleted, rewired_relations: rewired };
}

export function deleteMemory(id: number): boolean {
  const db = getDb();
  const row = db.prepare("SELECT uid FROM memories WHERE id = ?").get(id) as { uid: string } | undefined;
  if (row?.uid) deleteRelationsForMemoryUid(row.uid);
  vectorStore.delete("memory", id);
  const deleted = db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  if (deleted && row?.uid) recordDeletion("memories", row.uid);
  if (deleted) notifyWrite();
  return deleted;
}

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC, offsetsiz) → epoch ms. */
function parseSqliteUtc(ts: string): number {
  return Date.parse(ts.replace(" ", "T") + "Z");
}

/**
 * Record evidence that was actually delivered to an agent. Candidate searches do
 * not call this: access_count represents injected/returned context, not ranking work.
 *
 * GÜVENİLMEZLİK UYARISI: Bu fonksiyon hem recall() (recall.ts) hem contextGet()
 * (context.ts) tarafından çağrılır. Bir agent aynı mesaj için ikisini de tetiklerse
 * (örn. önce context_get sonra recall, ya da tersi) access_count aynı "tek" erişim
 * için iki kez artar — istek/mesaj kimliği taşınmadığı için idempotent yapılamıyor.
 * Bu yüzden access_count'u KARAR VERMEDE (arşivleme, skorlama, eşikleme) kullanma;
 * yalnız kabaca "hiç mi erişildi" (== 0) gibi ikili sinyaller güvenli — tam sayısı
 * değil. searchMemories()'teki skorlama (score * importance * decay) bilerek
 * access_count kullanmaz; last_accessed + importance kullanır. hygiene.ts/findStale
 * de aynı sebeple last_accessed kullanır, access_count değil.
 */
export function recordMemoryAccess(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  // updated_at'e DOKUNULMAZ: bu alanlar cihaz-yerel istatistiktir, sync'e girmez —
  // yoksa her recall bir sync fırtınası yaratır ve LWW bozulur.
  getDb()
    .prepare(`UPDATE memories SET last_accessed = datetime('now'), access_count = access_count + 1 WHERE id IN (${placeholders})`)
    .run(...ids);
}

export async function searchMemories(query: string, filters: SearchFilters = {}): Promise<ScoredMemory[]> {
  // Project/type/tag/is_current constraints are candidate-generation filters. The final
  // relational checks below are defense in depth, not post-fusion filtering.
  // ADR-006: include_superseded=false (varsayılan) ⇒ currentOnly=true ⇒ is_current=0
  // kayıtlar hem FTS hem vektör KNN'in İÇİNDE elenir, top-k'dan sonra değil.
  const ranked = await hybridSearch("memories_fts", "memories_vec", query, config.searchCandidates, {
    project: filters.project,
    memoryType: filters.type,
    memoryTag: filters.tag,
    currentOnly: !filters.include_superseded,
  });
  if (ranked.length === 0) return [];
  // N+1 yerine tek sorgu: sıralama RRF'ten gelir, satırlar id→row haritasından okunur.
  const placeholders = ranked.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
    .all(...ranked.map((r) => r.id)) as Record<string, unknown>[];
  const byId = new Map(rows.map((r) => [r.id as number, rowToMemory(r)]));
  const limit = filters.limit ?? 8;
  const now = Date.now();
  const halflifeMs = Math.max(config.decayHalflifeDays, 1) * 86_400_000;
  const candidates: ScoredMemory[] = [];
  for (const { id, score, channels, channel_ranks } of ranked) {
    const mem = byId.get(id);
    if (!mem) continue;
    if (filters.type && mem.type !== filters.type) continue;
    if (filters.project && mem.project !== filters.project) continue;
    if (filters.tag && !mem.tags.includes(filters.tag)) continue;
    if (!filters.include_superseded && mem.is_current === 0) continue;
    const ageMs = Math.max(0, now - parseSqliteUtc(mem.updated_at));
    // Tabanlı decay: taze kayıt öne geçer ama eski kayıt asla decayFloor'un altına
    // ezilmez — "1 yıl önce şu sorunu nasıl çözmüştüm" sorgusu hâlâ sonuç bulur.
    // ln(2) çarpanı şart: onsuz ageMs=halflifeMs anında çarpan 0.5 değil e^-1≈0.368 olur
    // (yani "yarı ömür" adı yalan çıkar, kayıtlar isimlendirildiğinden çok daha hızlı bayatlar).
    const decay = config.decayFloor + (1 - config.decayFloor) * Math.exp(-Math.LN2 * (ageMs / halflifeMs));
    const final = score * mem.importance * decay;
    candidates.push({ ...mem, score: final, channels, channel_ranks });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
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
