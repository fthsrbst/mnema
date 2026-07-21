/**
 * Tutarlılık kontrolü: sessiz ıraksamayı görünür kılar.
 *
 * "last_pull güncel" hiçbir zaman sync'in çalıştığının kanıtı değildi — 2026-07-21'de
 * 8 memory ve 14 session tam da bu yanılgı altında kaybolmuştu (ADR-005). Burada iki
 * bağımsız kontrol var:
 *
 * 1. SİLME İNVARYANTI: ADR "silmeler yalnız `deletions` tombstone'u üzerinden yayılır"
 *    diyor. Doğrudan `DELETE FROM memories ...` çalıştıran biri tombstone bırakmaz ve
 *    silme hiçbir peer'a ulaşmaz. Trigger bunu silme ANINDA yakalayamaz çünkü
 *    `recordDeletion` DELETE'ten SONRA çağrılıyor; bu yüzden trigger yalnız olayı
 *    kaydeder ve uzlaştırma burada, kısa bir bekleme süresinden sonra yapılır.
 *
 * 2. DIGEST KARŞILAŞTIRMASI: sync turu içindeki kontrol yalnız sync çalıştığında devreye
 *    girer. Primary erişilemezse ya da cihaz uzun süre kapalı kalırsa ıraksama fark
 *    edilmez. Bu yüzden günlük bağımsız bir kontrol var.
 *
 * Her ikisi de UYARI kanalıdır, kapı değildir: başarısız olurlarsa sessizce geçilir ve
 * hiçbir zaman çağıranı çökertmezler.
 */
import { getDb } from "./db.js";
import { emitHubEvent } from "./events-bus.js";
import { syncDigest, type SyncDigest } from "./sync.js";

/** Trigger'ın yazdığı ham gözlem olayı. */
const DELETE_OBSERVED = "sync.delete_observed";
/** Uzlaştırma sonucu üretilen uyarı. */
export const DELETE_WITHOUT_TOMBSTONE = "sync.delete_without_tombstone";
/** Digest uyuşmazlığı uyarısı. */
export const PEER_DIVERGENCE = "sync.peer_divergence";

/**
 * Normal silme yolunda tombstone DELETE'ten hemen sonra yazılır; gözlemi o kadarcık
 * beklemeden değerlendirirsek her meşru silme yanlış alarm üretir. Yanlış alarm veren
 * bir uyarı zamanla görmezden gelinir ve o zaman gerçek uyarıyı da gizler.
 */
const DEFAULT_GRACE_MS = 5 * 60 * 1000;

export interface DeleteReconcileResult {
  checked: number;
  missing_tombstone: number;
}

export function reconcileDeleteObservations(graceMs = DEFAULT_GRACE_MS): DeleteReconcileResult {
  const db = getDb();
  const cutoff = new Date(Date.now() - graceMs).toISOString().replace("T", " ").replace("Z", "");
  const rows = db
    .prepare(`SELECT id, payload FROM hub_events WHERE type = ? AND created_at <= ? ORDER BY id LIMIT 500`)
    .all(DELETE_OBSERVED, cutoff) as { id: number; payload: string }[];

  const result: DeleteReconcileResult = { checked: rows.length, missing_tombstone: 0 };
  if (rows.length === 0) return result;

  const tombstone = db.prepare("SELECT 1 FROM deletions WHERE tbl = ? AND uid = ?");
  const processed: number[] = [];
  for (const row of rows) {
    processed.push(row.id);
    let tbl: string | undefined;
    let rowKey: string | undefined;
    try {
      const parsed = JSON.parse(row.payload) as { tbl?: string; row_key?: string };
      tbl = parsed.tbl;
      rowKey = parsed.row_key;
    } catch {
      continue; // bozuk payload: gözlemi tüket, uyarı üretme
    }
    if (!tbl || !rowKey) continue;
    if (tombstone.get(tbl, rowKey)) continue;
    result.missing_tombstone++;
    emitHubEvent({
      type: DELETE_WITHOUT_TOMBSTONE,
      payload: {
        tbl,
        row_key: rowKey,
        note:
          "Tombstone'suz silme: bu kayıt diğer cihazlarda DURMAYA devam edecek. " +
          "Silme yalnızca deletions tablosu üzerinden yayılır (ADR-005).",
      },
    });
  }

  // İşlenen gözlemler tüketilir; hub_events sonsuza büyümesin.
  const placeholders = processed.map(() => "?").join(",");
  db.prepare(`DELETE FROM hub_events WHERE id IN (${placeholders})`).run(...processed);
  return result;
}

export interface ConsistencyCheckResult {
  ok: boolean;
  deletes: DeleteReconcileResult;
  /** Uyuşmayan tablolar; primary'ye ulaşılamadıysa undefined. */
  divergence?: string[];
  error?: string;
}

/**
 * Günlük tutarlılık turu. Primary yoksa veya erişilemezse yalnız yerel silme
 * uzlaştırması yapılır — asla throw etmez.
 */
export async function runConsistencyCheck(
  primaryUrls: string[],
  token: string
): Promise<ConsistencyCheckResult> {
  const deletes = reconcileDeleteObservations();
  if (primaryUrls.length === 0) return { ok: true, deletes };

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  for (const url of primaryUrls) {
    try {
      const res = await fetch(`${url}/api/sync/digest`, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const remote = (await res.json()) as SyncDigest;
      const local = syncDigest();
      const diffs: string[] = [];
      for (const [tbl, r] of Object.entries(remote.tables ?? {})) {
        const l = local.tables[tbl];
        if (!l) continue;
        if (l.count !== r.count || l.uid_hash !== r.uid_hash) {
          diffs.push(`${tbl}: yerel ${l.count} / uzak ${r.count}`);
        }
      }
      if (diffs.length > 0) {
        emitHubEvent({
          type: PEER_DIVERGENCE,
          payload: {
            peer: url,
            tables: diffs,
            note:
              "Cihazlar arası ıraksama: sayım veya uid kümesi uyuşmuyor. " +
              "Tam süpürme için sync_state.last_pull_seq sıfırlanabilir.",
          },
        });
      }
      return { ok: true, deletes, divergence: diffs.length > 0 ? diffs : undefined };
    } catch (err) {
      // Sonraki adresi dene; hepsi başarısızsa aşağıda sessizce dönülür.
      if (url === primaryUrls[primaryUrls.length - 1]) {
        return { ok: false, deletes, error: (err as Error).message };
      }
    }
  }
  return { ok: false, deletes, error: "primary erişilemedi" };
}

/** Bekleyen (henüz uzlaştırılmamış) silme gözlemi sayısı — teşhis için. */
export function pendingDeleteObservations(): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM hub_events WHERE type = ?`).get(DELETE_OBSERVED) as { n: number }
  ).n;
}
