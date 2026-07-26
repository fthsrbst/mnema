import { randomUUID, createHash } from "node:crypto";
import { config } from "./config.js";
import { getDb, NOW_MS } from "./db.js";
import { embedOne, toBuffer } from "./embeddings.js";
import { notifyWrite } from "./events.js";
import { hybridSearch } from "./search.js";
import { recordDeletion } from "./sync.js";
import { assertProjectReference } from "./projects.js";
import { resolveMachineName } from "./machine.js";
import type {
  MachineScope,
  MachineStateStatus,
  MachineStateView,
  Memory,
  MemoryInput,
  MemoryMachineMarkInput,
  MemoryMachineState,
  RelatedRef,
  SavedMemory,
  ScoredMemory,
  SearchFilters,
  SimilarHit,
} from "./types.js";
import {
  memoryConsolidateSchema,
  memoryInputSchema,
  memoryInvalidateSchema,
  memoryMachineMarkSchema,
  memoryPatchSchema,
  memoryRevalidateSchema,
} from "./schemas.js";
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
  const mem = {
    ...(row as unknown as Memory),
    tags: JSON.parse((row.tags as string) ?? "[]"),
    related: JSON.parse((row.related as string) ?? "[]"),
  };
  // machine_scope NULL ve "global" eş anlamlı; NULL olarak saklayıp okuma tarafında
  // uyarı üretmemek için burada normalize etmiyoruz — alan gerçek DB değerini taşır.
  return mem;
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
         normalizer_generation, importance, related, origin_machine, verified_at, review_after,
         machine_scope, created_at, updated_at
       ) VALUES (
         @uid, @type, @title, @body, @project, @tags, @source, @language, @canonical_summary,
         @normalizer_generation, @importance, @related, @origin_machine, @verified_at, @review_after,
         @machine_scope, ${NOW_MS}, ${NOW_MS}
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
      verified_at: input.verified_at ?? null,
      review_after: input.review_after ?? null,
      machine_scope: input.machine_scope ?? null,
    });
  const id = Number(info.lastInsertRowid);
  replaceLegacyRelatedRelations(id, relatedUids);
  const similar = await upsertVector(id, input.title, input.body, input.canonical_summary);
  notifyWrite();
  const mem = getMemory(id)!;
  // Cihaz-farkındalığı advisory uyarısı (spec §2): howto/context tipinde ve machine_scope
  // machine_dependent OLMAYAN bir kayıt yazıldığında, yazan agent'a "bu cihaza bağlı olabilir,
  // öyleyse machine_dependent ver" hatırlatması yapılır. Kayıt HER HALÜKÂRDA yazılır — kilit değil,
  // presence/task_complete felsefesiyle tutarlı. decision/preference/fact sessiz kalır.
  const advisory = machineScopeAdvisory(mem.type, mem.machine_scope);
  if (similar && similar.length > 0) {
    return {
      ...mem,
      similar,
      similar_hint:
        "Benzer kayıt(lar) var. Bu yeni kayıt onlardan birini GEÇERSİZ KILIYORSA " +
        "memory_invalidate(id, reason, evidence, replaced_by_id=" + String(mem.id) + ") çağır — " +
        "yoksa çelişkili iki kayıt yan yana durur ve okuyan agent hangisinin geçerli olduğunu bilemez. " +
        "Emin değilsen dokunma: kanıtsız geçersiz kılma bayat kayıttan daha kötüdür.",
      ...(advisory ? { uyari: advisory } : {}),
    };
  }
  return advisory ? { ...mem, uyari: advisory } : mem;
}

/**
 * Cihaz-farkındalığı advisory metni (kayıt tipine göre). `machine_dependent` kayıtlar
 * ve decision/preference/fact tipleri sessizdir; yalnız howto/context + global/NULL'da uyarı.
 * Spec §2: "Uyar, kilitleme." Kayıt her hâlükârda yazılır.
 */
function machineScopeAdvisory(type: Memory["type"], machineScope: MachineScope | null): string | undefined {
  if (machineScope === "machine_dependent") return undefined;
  if (type !== "howto" && type !== "context") return undefined;
  return (
    "Bu kayıt cihaza bağlı olabilir (" + type + "). Öyleyse " +
    "machine_scope:\"machine_dependent\" ver — yoksa başka cihazdaki agent bu çözümü orada da " +
    "uygulanmış sayabilir. Cihazlarda doğruladıkça memory_machine_mark ile işaretle."
  );
}

export function getMemory(id: number): Memory | null {
  const row = getDb().prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToMemory(row) : null;
}

/**
 * Toplu id→Memory çözümü (N+1 önleme). is_current'a göre FİLTRELEMEZ — getMemory ile
 * aynı davranış: çağıran taraf (örn. context.ts graf genişletmesi) bilinçli olarak
 * supersede/invalidate edilmiş bir komşuyu da çekebilmeli.
 */
export function getMemoriesByIds(ids: number[]): Memory[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
    .all(...unique) as Record<string, unknown>[];
  return rows.map(rowToMemory);
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
    // ADR-006 faz 2: null verilirse temizlenir (nullableTimestamp — memoryPatchSchema).
    verified_at: patch.verified_at === undefined ? existing.verified_at : patch.verified_at,
    review_after: patch.review_after === undefined ? existing.review_after : patch.review_after,
    // Cihaz-farkındalığı: undefined = dokunma; null = global'e temizle; "machine_dependent"/"global".
    machine_scope: patch.machine_scope === undefined ? existing.machine_scope : patch.machine_scope,
    id,
  };
  getDb()
    .prepare(
      `UPDATE memories SET type=@type, title=@title, body=@body, project=@project,
       tags=@tags, language=@language, canonical_summary=@canonical_summary,
       normalizer_generation=@normalizer_generation, importance=@importance,
       related=@related, verified_at=@verified_at, review_after=@review_after,
       machine_scope=@machine_scope, updated_at=${NOW_MS} WHERE id=@id`
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
  // Cihaz-farkındalığı: memory silinince state satırları da cascade temizlenir (spec §5).
  // deleteGuard trigger'ı satır başına tetiklenir ama tombstone AYNI anda yazılmaz; bu yüzden
  // burada her satır için recordDeletion('memory_machine_state', uid) çağrılır — silme-koruma
  // invariant'ı (ADR-005: tombstone'suz silme replike olmaz) böylece korunur.
  if (row?.uid) deleteMachineStatesForMemoryUid(row.uid);
  vectorStore.delete("memory", id);
  const deleted = db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  if (deleted && row?.uid) recordDeletion("memories", row.uid);
  if (deleted) notifyWrite();
  return deleted;
}

function resolveMemoryIdFromRef(ref: { id?: number; uid?: string }): number | null {
  if (ref.id !== undefined) return ref.id;
  if (ref.uid !== undefined) {
    const row = getDb().prepare("SELECT id FROM memories WHERE uid = ?").get(ref.uid) as { id: number } | undefined;
    return row?.id ?? null;
  }
  return null;
}

// ============================================================================
// Cihaz-farkındalığı (machine_machine_state defteri) — spec §4, §5, §3
// ============================================================================

/** Deterministik uid: sha256(memory_uid + ":" + machine) ilk 32 hex. Sync'te çakışmasız
 *  birleşmenin temeli — iki cihaz aynı (memory,machine) için aynı uid üretir. */
function machineStateUid(memoryUid: string, machine: string): string {
  return createHash("sha256")
    .update(`${memoryUid}:${machine}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Bir kaydın bir cihazdaki durumunu upsert eder (spec §4). İlk işaret, kaydın
 * `machine_scope`'u NULL/global ise `machine_dependent` yapar — cihaz bazında işaretlemek,
 * cihaza bağlılığının itirafıdır. `memory_uid` ZORUNLU (id cihaz-yereldir, deftere id yazmak
 * satırı diğer cihazlarda yanlış kayda bağlar). `verified_at` = sunucu saati.
 */
export function markMachineState(input: MemoryMachineMarkInput): MemoryMachineState {
  const parsed = memoryMachineMarkSchema.parse(input);
  const db = getDb();
  const memoryUid = parsed.memory_uid;
  const machine = (parsed.machine?.trim() || resolveMachineName()).trim();
  if (!machine) throw new Error("machine could not be resolved (HUB_MACHINE_NAME/hostname)");
  const uid = machineStateUid(memoryUid, machine);
  const now = (db.prepare(`SELECT ${NOW_MS} AS n`).get() as { n: string }).n;
  // Upsert (deterministik uid sayesinde ON CONFLICT(uid)). Mevcut satır varsa
  // status/note/verified_at/verified_by/updated_at güncellenir; memory_uid/machine sabit.
  db.prepare(
    `INSERT INTO memory_machine_state(
       uid, memory_uid, machine, status, note, verified_at, verified_by, updated_at
     ) VALUES (
       @uid, @memory_uid, @machine, @status, @note, @verified_at, @verified_by, @updated_at
     )
     ON CONFLICT(uid) DO UPDATE SET
       status=excluded.status, note=excluded.note,
       verified_at=excluded.verified_at, verified_by=excluded.verified_by,
       updated_at=excluded.updated_at`
  ).run({
    uid,
    memory_uid: memoryUid,
    machine,
    status: parsed.status,
    note: parsed.note ?? null,
    verified_at: now,
    verified_by: parsed.verified_by ?? null,
    updated_at: now,
  });
  // Yan etki (spec §4): kaydın machine_scope'u NULL/global ise machine_dependent yap.
  // Ayrı bir UPDATE — bir kaydı cihaz bazında işaretlemek cihaza bağlılığının itirafıdır;
  // ayrıca scope güncellemesi istemek gereksiz sürtünme yaratır.
  db.prepare(
    `UPDATE memories SET machine_scope = 'machine_dependent', updated_at = ${NOW_MS}
      WHERE uid = ? AND (machine_scope IS NULL OR machine_scope = 'global' OR machine_scope = '')`
  ).run(memoryUid);
  notifyWrite();
  return getMachineStateByUid(uid)!;
}

/** uid tekil sorgu. */
export function getMachineStateByUid(uid: string): MemoryMachineState | null {
  const row = getDb()
    .prepare("SELECT uid, memory_uid, machine, status, note, verified_at, verified_by, updated_at FROM memory_machine_state WHERE uid = ?")
    .get(uid) as MemoryMachineState | undefined;
  return row ?? null;
}

/** Bir hafıza kaydının tüm cihaz durumu satırlarını döner. */
export function listMachineStatesForMemory(memoryUid: string): MemoryMachineState[] {
  return getDb()
    .prepare("SELECT uid, memory_uid, machine, status, note, verified_at, verified_by, updated_at FROM memory_machine_state WHERE memory_uid = ? ORDER BY updated_at DESC")
    .all(memoryUid) as MemoryMachineState[];
}

/**
 * Memory silme yolunda state satırlarını cascade temizler + her biri için tombstone yazar
 * (spec §5). `recordDeletion('memory_machine_state', uid)` — sync'ten gelen silme olmasa bile
 * cihazlar arası tutarlılık için tombstone şart (ADR-005 invariant).
 */
export function deleteMachineStatesForMemoryUid(memoryUid: string): number {
  const db = getDb();
  const rows = db.prepare("SELECT uid FROM memory_machine_state WHERE memory_uid = ?").all(memoryUid) as { uid: string }[];
  for (const r of rows) recordDeletion("memory_machine_state", r.uid);
  if (rows.length === 0) return 0;
  const n = db.prepare("DELETE FROM memory_machine_state WHERE memory_uid = ?").run(memoryUid).changes;
  return n;
}

/**
 * Okuma yolu için cihaz durumu görünümünü hesaplar (spec §3). `thisMachine` parametresi
 * verilirse `current` = bu cihazın durumu (satır yoksa null = bilinmiyor), `others` = geri
 * kalan tüm cihazlar. Verilmezse (trace'i olmayan çağırıcı) `current` null, `others` = tümü.
 *
 * Bu fonksiyon raw satır okur — zenginleştirme çağıranın sorumluluğunda (machine_warning
 * için machineWarning() kullan). Sadece `machine_dependent` kayıtlar için çağrılmalı;
 * global/NULL kayıtlar için uyarı üretilmez (çağıran filtreler).
 */
export function buildMachineStateView(memoryUid: string, thisMachine: string | null): MachineStateView {
  const rows = listMachineStatesForMemory(memoryUid) as { machine: string; status: MachineStateStatus; verified_at: string | null }[];
  let current: MachineStateStatus | null = null;
  const others: { machine: string; status: MachineStateStatus; verified_at: string | null }[] = [];
  for (const r of rows) {
    if (thisMachine && r.machine === thisMachine) current = r.status;
    else others.push({ machine: r.machine, status: r.status, verified_at: r.verified_at });
  }
  return { current, others };
}

/**
 * Uyarı matrisine (spec §3) göre cihaz uyarı metni üretir. Her zaman kapatma yolunu söyler:
 * "Doğruladıktan sonra memory_machine_mark ile işaretle." `null` = uyarı yok.
 *
 * - current=applied veya not_applicable → uyarı yok
 * - current=not_applied → "bu cihazda UYGULANMADI olarak işaretli"
 * - current=null (bu cihazda satır yok), başkasında applied var → "yalnız {liste}'de doğrulandı; burada BİLİNMİYOR"
 * - current=null, hiç satır yok → "hiçbir cihazda doğrulanmamış"
 */
export function machineWarning(
  memoryTitle: string,
  view: MachineStateView,
  thisMachine: string | null
): string | undefined {
  if (view.current === "applied" || view.current === "not_applicable") return undefined;
  if (view.current === "not_applied") {
    return (
      `⚠ Cihaz durumu: bu çözüm bu cihazda (${thisMachine ?? "?"}) UYGULANMADI olarak işaretli ` +
      `("${memoryTitle}"). uygulanmış varsayma. Doğruladıktan sonra ` +
      `memory_machine_mark ile durumu güncelle.`
    );
  }
  // current === null: bu cihazda satır yok
  const applied = view.others.filter((o) => o.status === "applied");
  if (applied.length > 0) {
    const list = applied.map((a) => a.machine).join(", ");
    const when = applied.find((a) => a.verified_at)?.verified_at;
    const whenTxt = when ? ` (en son ${when.slice(0, 10)})` : "";
    return (
      `⚠ Cihaz durumu: bu çözüm yalnız ${list}'de doğrulandı${whenTxt}. Bu cihazda ` +
      `(${thisMachine ?? "?"}) durum BİLİNMİYOR — uygulanmış varsayma. Doğruladıktan sonra ` +
      `memory_machine_mark ile işaretle. ("${memoryTitle}")`
    );
  }
  // Hiç satır yok ya da hepsi not_applied
  return (
    `⚠ Cihaz durumu: hiçbir cihazda doğrulanmamış ("${memoryTitle}"). Bu cihazda ` +
    `(${thisMachine ?? "?"}) durum BİLİNMİYOR — uygulanmış varsayma. Doğruladıktan sonra ` +
    `memory_machine_mark ile işaretle.`
  );
}

/**
 * Toplu zenginleştirme: `machine_dependent` ve `is_current=1` kayıtlara `machine_state`
 * ve `machine_warning` yazar. global/NULL ve is_current=0 kayıtlar DOKUNULMAZ (spec §3 —
 * supersession uyarısı önceliklidir; geçersiz kaydın "hangi cihazda uygulandı" sorusu
 * anlamsızdır). N+1 önleme: tek sorgu ile tüm ilgili memory'lerin state satırlarını çeker.
 */
export function enrichMachineStates<T extends Memory & { machine_state?: MachineStateView; machine_warning?: string }>(
  items: T[],
  thisMachine: string | null
): T[] {
  const dependentUids = items
    .filter((it) => it.machine_scope === "machine_dependent" && it.is_current === 1)
    .map((it) => it.uid);
  if (dependentUids.length === 0) return items;
  const placeholders = dependentUids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT memory_uid, machine, status, verified_at
         FROM memory_machine_state
        WHERE memory_uid IN (${placeholders})
        ORDER BY updated_at DESC`
    )
    .all(...dependentUids) as { memory_uid: string; machine: string; status: MachineStateStatus; verified_at: string | null }[];
  const byMemory = new Map<string, { machine: string; status: MachineStateStatus; verified_at: string | null }[]>();
  for (const r of rows) {
    const arr = byMemory.get(r.memory_uid) ?? [];
    arr.push({ machine: r.machine, status: r.status, verified_at: r.verified_at });
    byMemory.set(r.memory_uid, arr);
  }
  return items.map((it) => {
    if (it.machine_scope !== "machine_dependent" || it.is_current !== 1) return it;
    const all = byMemory.get(it.uid) ?? [];
    let current: MachineStateStatus | null = null;
    const others: { machine: string; status: MachineStateStatus; verified_at: string | null }[] = [];
    for (const r of all) {
      if (thisMachine && r.machine === thisMachine) current = r.status;
      else others.push({ machine: r.machine, status: r.status, verified_at: r.verified_at });
    }
    const view: MachineStateView = { current, others };
    const warning = machineWarning(it.title, view, thisMachine);
    return { ...it, machine_state: view, ...(warning ? { machine_warning: warning } : {}) };
  });
}

export interface InvalidateMemoryInput {
  id?: number;
  uid?: string;
  /** Kısa gerekçe. */
  reason: string;
  /** Bu iddiayı yanlışlayan komut çıktısı/gözlem — ZORUNLU. */
  evidence: string;
  /** Bu kaydın yerine geçen yeni kaydın yerel id'si (opsiyonel). */
  replaced_by_id?: number;
}

/**
 * ADR-006 faz 2: hafızayı is_current=0 işaretler. SATIRI ASLA SİLMEZ — tersi memory_revalidate
 * ile mümkündür. evidence ZORUNLU (schema): "careless invalidation is the symmetric danger"
 * (ADR — bir agent doğru bir hafızayı yanlış bir testle bayat ilan etmek üzereydi). Vektör
 * tablosundaki is_current metadata'sı da güncellenir (vector-store.ts) — yoksa KNN filtresi
 * eski değeri görmeye devam eder. replaced_by_id verilirse: YENİ kaydın supersedes_uid'i
 * ESKİ kaydın uid'ine bağlanır (documents.ts'teki "yeni.supersedes_uid = eski.uid" yönüyle
 * aynı) ve memory_relations'a from=yeni, to=eski yönünde 'supersedes' kenarı eklenir.
 */
export async function invalidateMemory(input: InvalidateMemoryInput): Promise<Memory | null> {
  const parsed = memoryInvalidateSchema.parse(input);
  const id = resolveMemoryIdFromRef(parsed);
  if (id === null) return null;
  const existing = getMemory(id);
  if (!existing) return null;
  // Yerine gecen kaydin varligi HERHANGI bir mutasyondan ONCE dogrulanir: sonra
  // dogrulanirsa kayit gecersizlestirilmis ama supersedes bagi kurulmamis olarak
  // yarim durumda kalirdi.
  const replacement =
    parsed.replaced_by_id !== undefined ? getMemory(parsed.replaced_by_id) : null;
  if (parsed.replaced_by_id !== undefined && !replacement) {
    throw new Error(`replacement memory #${parsed.replaced_by_id} not found`);
  }
  if (replacement && replacement.project !== existing.project) {
    throw new Error(
      `replacement memory must belong to the same project (${existing.project ?? "global"} != ${replacement.project ?? "global"})`
    );
  }
  const db = getDb();
  const reasonText = `${parsed.reason} — kanıt: ${parsed.evidence}`;
  db.transaction(() => {
    db.prepare(
      `UPDATE memories SET is_current = 0, valid_to = ${NOW_MS}, invalidated_reason = ?, updated_at = ${NOW_MS} WHERE id = ?`
    ).run(reasonText, id);
    if (replacement) {
      db.prepare(`UPDATE memories SET supersedes_uid = ?, updated_at = ${NOW_MS} WHERE id = ?`).run(
        existing.uid,
        replacement.id
      );
      saveMemoryRelation({
        from_id: replacement.id,
        to_id: id,
        relation_type: "supersedes",
        source: "memory_invalidate",
      });
    }
  })();
  if (vectorStore.available()) {
    const embedding = vectorStore.get("memory", id);
    if (embedding) vectorStore.putMemory(id, existing.project, false, embedding);
  }
  notifyWrite();
  return getMemory(id);
}

export interface RevalidateMemoryInput {
  id?: number;
  uid?: string;
}

/**
 * ADR-006 faz 2: memory_invalidate'in panzehiri. Yanlışlıkla invalidate edilmiş DOĞRU bir
 * hafızayı geri getirir: is_current=1, valid_to/invalidated_reason temizlenir. supersedes_uid
 * ve memory_relations kenarı BİLEREK dokunulmaz — geçmiş ilişki kaydı kalır, yalnız geçerlilik
 * geri döner. Vektör metadata'sı da is_current=1'e güncellenir.
 */
export async function revalidateMemory(input: RevalidateMemoryInput): Promise<Memory | null> {
  const parsed = memoryRevalidateSchema.parse(input);
  const id = resolveMemoryIdFromRef(parsed);
  if (id === null) return null;
  const existing = getMemory(id);
  if (!existing) return null;
  const db = getDb();
  db.prepare(
    `UPDATE memories SET is_current = 1, valid_to = NULL, invalidated_reason = NULL, updated_at = ${NOW_MS} WHERE id = ?`
  ).run(id);
  if (vectorStore.available()) {
    const embedding = vectorStore.get("memory", id);
    if (embedding) vectorStore.putMemory(id, existing.project, true, embedding);
  }
  notifyWrite();
  return getMemory(id);
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
  const sliced = candidates.slice(0, limit);
  // Cihaz-farkındalığı zenginleştirmesi (spec §3): yalnız machine_dependent + is_current=1
  // kayıtlar için machine_state/machine_warning eklenir. global/superseded kayıtlar dokunulmaz.
  return enrichMachineStates(sliced, resolveMachineName());
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
