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
 */
import { getDb, putChunkVector, putMemoryVector } from "./db.js";
import { embed, embeddingsEnabled, toBuffer } from "./embeddings.js";
import { vectorStore } from "./vector-store.js";
import { notifyWrite } from "./events.js";

export interface BackfillResult {
  memories_embedded: number;
  chunks_embedded: number;
  /** Embedding veya vektör indeksi devre dışıysa true (no-op). */
  skipped: boolean;
}

/**
 * Vektör indeksinde eksik (ana tabloda var, *_vec'te yok) memory ve chunk'ları embed
 * eder. Limit uygulanır (≥1 ≤100). Eksik kayıt yoksa sessizce no-op döner.
 *
 * Eşzamanlılık: `reindex()` ile aynı anda çağrılırsa iki yazar da putMemoryVector/
 * putChunkVector (idempotent DELETE+INSERT) yapar — son yazan kazanır, hasar olmaz.
 */
export async function backfillMissingEmbeddings(limit = 100): Promise<BackfillResult> {
  const result: BackfillResult = { memories_embedded: 0, chunks_embedded: 0, skipped: false };
  if (!embeddingsEnabled() || !vectorStore.available() || limit < 1) {
    result.skipped = true;
    return result;
  }
  const db = getDb();
  const boundedLimit = Math.min(limit, 100);

  const chunks = db
    .prepare(
      `SELECT c.id, c.heading, c.text, d.project, d.enabled, d.is_current, d.kind
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.id NOT IN (SELECT rowid FROM chunks_vec)
       LIMIT ?`
    )
    .all(boundedLimit) as {
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

  const mems = db
    .prepare(
      "SELECT id, title, body, project FROM memories WHERE id NOT IN (SELECT rowid FROM memories_vec) LIMIT ?"
    )
    .all(boundedLimit) as { id: number; title: string; body: string; project: string | null }[];
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

  if (result.chunks_embedded > 0 || result.memories_embedded > 0) notifyWrite();
  return result;
}