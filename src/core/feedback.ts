import { getDb, NOW_MS } from "./db.js";
import type { FeedbackVerdict, RecallFeedback } from "./types.js";

/**
 * Recall kalite geri bildirimi: agent'lar otomatik enjeksiyonun isabetini işaretler.
 * Cihaz-yerel tutulur (sync'e girmez) — her cihazın recall yolu kendi HUB_RECALL_*
 * eşikleriyle çalışır; kalibrasyon verisi de o cihaza aittir. Birikince
 * scripts/recall-check.ts ile birlikte eşik ayarının kanıt tabanı olur.
 */
export function addRecallFeedback(input: {
  query: string;
  verdict: FeedbackVerdict;
  memory_id?: number;
  note?: string;
  source?: string;
}): RecallFeedback {
  const info = getDb()
    .prepare(
      `INSERT INTO recall_feedback(query, verdict, memory_id, note, source, created_at)
       VALUES (@query, @verdict, @memory_id, @note, @source, ${NOW_MS})`
    )
    .run({
      query: input.query,
      verdict: input.verdict,
      memory_id: input.memory_id ?? null,
      note: input.note ?? null,
      source: input.source ?? null,
    });
  return getDb()
    .prepare("SELECT * FROM recall_feedback WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as RecallFeedback;
}

export function listRecallFeedback(opts: { verdict?: FeedbackVerdict; limit?: number } = {}): RecallFeedback[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  if (opts.verdict) {
    return getDb()
      .prepare("SELECT * FROM recall_feedback WHERE verdict = ? ORDER BY created_at DESC LIMIT ?")
      .all(opts.verdict, limit) as RecallFeedback[];
  }
  return getDb()
    .prepare("SELECT * FROM recall_feedback ORDER BY created_at DESC LIMIT ?")
    .all(limit) as RecallFeedback[];
}

/** Verdict bazında sayılar — eşik ayarı öncesi hızlı bakış (ör. noisy oranı yüksekse recallMinRatio artır). */
export function feedbackSummary(): { verdict: string; count: number }[] {
  return getDb()
    .prepare("SELECT verdict, COUNT(*) AS count FROM recall_feedback GROUP BY verdict ORDER BY count DESC")
    .all() as { verdict: string; count: number }[];
}
