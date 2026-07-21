/**
 * Embedding backfill: kayıt sırasında embedding başarısız olursa (Gemini hatası/ağ
 * kesintisi) vektör sonsuza dek eksik kalırdı — reindex elle tetiklenmezse
 * hiç tamamlanmazdı. Bu modül, eksik memory/chunk vektörlerini periyodik tamamlar:
 * sunucu başlangıcında bir kez + 6 saatlik bakım döngüsünde. Eksik yoksa no-op.
 *
 * `embed()` zaten ≤100'lük batch ile çalışır (embeddings.ts BATCH_SIZE=100). Tek turda
 * en fazla `limit` (varsayılan 100) kayıt gömülür. Hata (Gemini exception) kaldığında
 * upstream periyodik tur tekrar deneyecektir; worker aracılığıyla enqueue edildiyse
 * worker.ts'teki exponential backoff devreye girer.
 *
 * İKİ YOLLU TARAMA (ADR-005 change_log üzerine kurulu, bkz. docs/adr/005-*.md):
 *
 * 1. KUYRUK YOLU (queue): `change_log`'da `embed_backfill_seq` imlecinden sonra değişen
 *    `memories`/`documents` satırlarının uid'lerini bulur, o satırlara ait olup henüz
 *    *_vec tablosunda olmayan chunk/memory id'lerini seçer. Veri büyüdükçe her turda tam
 *    tablo taraması yapmaz — yalnız değişen satırlara bakar.
 * 2. TAM TARAMA YEDEĞİ (full_scan): change_log'dan tamamen bağımsız, doğrudan
 *    "*_vec'te yok" sorgusuyla eksik satırları bulur. İlk çalıştırmada (imleç boş) ve
 *    sonrasında günde bir kez otomatik devreye girer.
 *
 *    Tam tarama NEDEN kaldırılamaz: change_log her satırı en az bir kez görsün diye
 *    trigger'lar var, ama kuyruk yolu `limit` ile sınırlıdır — bir turda limitten fazla
 *    satır değiştiyse fazlası imleç ilerledikten sonra kuyruktan sessizce düşer (bir daha
 *    hiç değişmezse bir daha hiç görünmez). Bu projede change_log'dan ÖNCE tam da bu
 *    sınıftan bir sessiz kayıp yaşandı: 16 memory + 12 chunk embedding'siz kalmıştı ve
 *    elle reindex'e kadar fark edilmedi. Günlük tam tarama bu sınıfı kapatan emniyet ağı;
 *    kuyruk yolu ise günlük taramayı BEKLEMEDEN hızlı yakalama sağlar.
 */
import { getDb, putChunkVector, putMemoryVector, NOW_MS } from "./db.js";
import { embed, embeddingsEnabled, toBuffer } from "./embeddings.js";
import { vectorStore } from "./vector-store.js";
import { notifyWrite } from "./events.js";

export interface BackfillResult {
  memories_embedded: number;
  chunks_embedded: number;
  /** Embedding veya vektör indeksi devre dışıysa true (no-op olabilir; adaylar yine seçilmiş olabilir). */
  skipped: boolean;
  /** Bu turda hangi yol çalıştı: change_log kuyruğu mu, periyodik emniyet-ağı tam taraması mı. */
  mode: "queue" | "full_scan";
}

/** İlerleme imleci: son işlenmiş change_log seq'i (system_metadata.key). */
export const EMBED_BACKFILL_SEQ_KEY = "embed_backfill_seq";
/** Son tam taramanın ISO zaman damgası (system_metadata.key). */
export const EMBED_BACKFILL_FULL_SCAN_KEY = "embed_backfill_last_full_scan";
/** Periyodik tam tarama aralığı: "günde bir" emniyet ağı (bkz. modül başı yorumu). */
const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** SQLite değişken limiti 999; uid/id listeleri bunun altında parçalanarak sorgulanır (sync.ts KEY_CHUNK ile aynı desen). */
const IN_CLAUSE_CHUNK = 400;

type Db = ReturnType<typeof getDb>;

function getMeta(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM system_metadata WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO system_metadata(key, value, updated_at) VALUES (?, ?, ${NOW_MS})
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(key, value);
}

/** `keys` listesini IN_CLAUSE_CHUNK parçalar halinde `table`'da arayıp `vecTable`'da eksik olan id'leri döner. */
function idsMissingEmbedding(
  db: Db,
  table: "memories" | "chunks",
  vecTable: "memories_vec" | "chunks_vec",
  keyCol: string,
  keys: (string | number)[],
  limit: number
): number[] {
  const out: number[] = [];
  for (let i = 0; i < keys.length && out.length < limit; i += IN_CLAUSE_CHUNK) {
    const slice = keys.slice(i, i + IN_CLAUSE_CHUNK);
    const holes = slice.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id FROM ${table} WHERE ${keyCol} IN (${holes}) AND id NOT IN (SELECT rowid FROM ${vecTable}) LIMIT ?`
      )
      .all(...slice, limit - out.length) as { id: number }[];
    out.push(...rows.map((r) => r.id));
  }
  return out;
}

function documentIdsForUids(db: Db, uids: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < uids.length; i += IN_CLAUSE_CHUNK) {
    const slice = uids.slice(i, i + IN_CLAUSE_CHUNK);
    const holes = slice.map(() => "?").join(",");
    out.push(
      ...(db.prepare(`SELECT id FROM documents WHERE uid IN (${holes})`).all(...slice) as { id: number }[]).map(
        (r) => r.id
      )
    );
  }
  return out;
}

export interface BackfillCandidates {
  mode: "queue" | "full_scan";
  chunkIds: number[];
  memoryIds: number[];
  /** Bu turun başında okunan change_log üst sınırı; tur hatasız biterse imleç buraya ilerletilir. */
  maxSeq: number;
}

/**
 * Bu turda embed edilecek aday chunk/memory id'lerini seçer. Yalnız OKUR — embed() çağırmaz,
 * imleci değiştirmez. `backfillMissingEmbeddings`'ten ayrı export edilmesinin nedeni: kuyruk/imleç
 * seçim mantığını gerçek Gemini çağrısı yapmadan (GEMINI_API_KEY boşken de) test edebilmek
 * (bkz. scripts/smoke.ts).
 */
export function planBackfillCandidates(limit = 100, opts?: { forceFullScan?: boolean }): BackfillCandidates {
  const db = getDb();
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  // maxSeq ÖNCE okunur: bu tur sürerken gelen yeni yazımlar bu turun kapsamı DIŞINDA kalır ve
  // imleç yalnız buraya kadar ilerletilir (collectChangesBySeq ile aynı desen, bkz. sync.ts) —
  // yoksa "işlemeden imleci ilerletme" garantisi bozulur.
  const maxSeq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM change_log").get() as { m: number }).m;
  const cursorRaw = getMeta(db, EMBED_BACKFILL_SEQ_KEY);
  const lastFullScanRaw = getMeta(db, EMBED_BACKFILL_FULL_SCAN_KEY);
  const lastFullScanAt = lastFullScanRaw ? Date.parse(lastFullScanRaw) : 0;
  // İlk çalıştırmada imleç boştur (cursorRaw === null) → tam tarama (mevcut/eski davranış).
  // Sonrasında günde bir kez otomatik tam tarama tetiklenir (emniyet ağı, modül başı yorumu).
  const fullScanDue =
    opts?.forceFullScan === true || cursorRaw === null || Date.now() - lastFullScanAt >= FULL_SCAN_INTERVAL_MS;

  if (fullScanDue) {
    const chunkIds = (
      db
        .prepare(`SELECT id FROM chunks WHERE id NOT IN (SELECT rowid FROM chunks_vec) LIMIT ?`)
        .all(boundedLimit) as { id: number }[]
    ).map((r) => r.id);
    const memoryIds = (
      db
        .prepare(`SELECT id FROM memories WHERE id NOT IN (SELECT rowid FROM memories_vec) LIMIT ?`)
        .all(boundedLimit) as { id: number }[]
    ).map((r) => r.id);
    return { mode: "full_scan", chunkIds, memoryIds, maxSeq };
  }

  const sinceSeq = Number(cursorRaw);
  /*
   * KRİTİK — budama (pruneChangeLog) etkileşimi:
   * pruneChangeLog() bir (tbl, row_key) çifti için change_log'da yalnız EN BÜYÜK seq'i tutar,
   * ara satırları siler. Bu, aşağıdaki "seq > sinceSeq" aralık sorgusu için SORUN DEĞİL:
   * seq monoton artar, dolayısıyla bir satırın change_log'da HAYATTA KALAN tek girdisi her
   * zaman o satırın gördüğü EN SON değişikliktir. Eğer satır sinceSeq'ten SONRA bir kez daha
   * değiştiyse, hayatta kalan (en büyük) seq de zorunlu olarak sinceSeq'ten büyüktür — ara
   * adımlar silinmiş olsa bile "bu satır bu aralıkta değişti mi" sorusunun cevabı bozulmaz;
   * yalnız "kaç kez değişti" bilgisi kaybolur ki bu zaten önemsizdir (embed edilen şey satırın
   * GÜNCEL içeriğidir, geçmiş sürümleri değil). Test 3 (scripts/smoke.ts) bunu doğrular.
   */
  const memoryUids = (
    db
      .prepare(`SELECT DISTINCT row_key FROM change_log WHERE tbl = 'memories' AND seq > ? AND seq <= ?`)
      .all(sinceSeq, maxSeq) as { row_key: string }[]
  ).map((r) => r.row_key);
  const documentUids = (
    db
      .prepare(`SELECT DISTINCT row_key FROM change_log WHERE tbl = 'documents' AND seq > ? AND seq <= ?`)
      .all(sinceSeq, maxSeq) as { row_key: string }[]
  ).map((r) => r.row_key);

  const memoryIds =
    memoryUids.length > 0 ? idsMissingEmbedding(db, "memories", "memories_vec", "uid", memoryUids, boundedLimit) : [];

  let chunkIds: number[] = [];
  if (documentUids.length > 0) {
    const docIds = documentIdsForUids(db, documentUids);
    if (docIds.length > 0) {
      chunkIds = idsMissingEmbedding(db, "chunks", "chunks_vec", "document_id", docIds, boundedLimit);
    }
  }

  return { mode: "queue", chunkIds, memoryIds, maxSeq };
}

/**
 * Vektör indeksinde eksik (ana tabloda var, *_vec'te yok) memory ve chunk'ları embed
 * eder. Aday seçimi `planBackfillCandidates`'tan gelir (kuyruk veya tam tarama, yukarı bak).
 *
 * Eşzamanlılık: `reindex()` ile aynı anda çağrılırsa iki yazar da putMemoryVector/
 * putChunkVector (idempotent DELETE+INSERT) yapar — son yazan kazanır, hasar olmaz.
 */
export async function backfillMissingEmbeddings(
  limit = 100,
  opts?: { forceFullScan?: boolean }
): Promise<BackfillResult> {
  const result: BackfillResult = { memories_embedded: 0, chunks_embedded: 0, skipped: false, mode: "queue" };
  if (!vectorStore.available() || limit < 1) {
    result.skipped = true;
    return result;
  }
  const db = getDb();
  const plan = planBackfillCandidates(limit, opts);
  result.mode = plan.mode;
  // embeddingsEnabled() false ise embed() aşağıda sessizce null döner (FTS-only mod, asla
  // çökmez) — aday seçimi ve imleç ilerletme YİNE de çalışır: "baktık ama şu an embed
  // edemedik" durumu budur. Embedding sonradan açıldığında günlük tam tarama emniyet ağı
  // bu turda atlanan satırları zaten yakalayacaktır.
  result.skipped = !embeddingsEnabled();

  if (plan.chunkIds.length > 0) {
    const chunks = db
      .prepare(
        `SELECT c.id, c.heading, c.text, d.project, d.enabled, d.is_current, d.kind
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE c.id IN (${plan.chunkIds.map(() => "?").join(",")})`
      )
      .all(...plan.chunkIds) as {
      id: number;
      heading: string | null;
      text: string;
      project: string | null;
      enabled: number;
      is_current: number;
      kind: string;
    }[];
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
  }

  if (plan.memoryIds.length > 0) {
    const mems = db
      .prepare(
        `SELECT id, title, body, project FROM memories WHERE id IN (${plan.memoryIds.map(() => "?").join(",")})`
      )
      .all(...plan.memoryIds) as { id: number; title: string; body: string; project: string | null }[];
    if (mems.length > 0) {
      const vecs = await embed(mems.map((m) => `${m.title}\n${m.body}`), "RETRIEVAL_DOCUMENT");
      if (vecs) {
        db.transaction(() => {
          vecs.forEach((v, i) => {
            const expected = mems[i];
            const current = db.prepare("SELECT title, body, project, is_current FROM memories WHERE id = ?").get(expected.id) as
              | { title: string; body: string; project: string | null; is_current: number }
              | undefined;
            if (!current || current.title !== expected.title || current.body !== expected.body) return;
            putMemoryVector(expected.id, current.project, current.is_current, toBuffer(v));
            result.memories_embedded++;
          });
        })();
      }
    }
  }

  if (result.chunks_embedded > 0 || result.memories_embedded > 0) notifyWrite();

  // İmleç yalnız bu tur HATASIZ tamamlandıysa buraya ulaşır ve ilerletilir. embed() Gemini
  // hatasında (3 denemeden sonra) throw eder; bu durumda fonksiyon burada patlar, imleç ESKİ
  // değerinde kalır ve bir sonraki tur aynı aralığı tekrar dener (çağıran taraf .catch ile
  // logluyor, bkz. src/server/index.ts).
  //
  // Embedding KAPALIYKEN imleç ilerletilmez. İmlecin anlami "buraya kadar embed edildi"dir;
  // anahtar yokken ilerletilirse o araliktaki kayitlar "islenmis" sayilir ve anahtar sonradan
  // eklendiginde kuyruk yolu onlari bir daha hic gormez — yalnizca gunluk tam tarama kurtarir.
  // Bu projede 16 memory + 12 chunk tam olarak bu sinifta sessizce embedding'siz kalmisti.
  if (embeddingsEnabled()) {
    setMeta(db, EMBED_BACKFILL_SEQ_KEY, String(plan.maxSeq));
    if (plan.mode === "full_scan") setMeta(db, EMBED_BACKFILL_FULL_SCAN_KEY, new Date().toISOString());
  }

  return result;
}
