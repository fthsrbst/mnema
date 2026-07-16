import { getDb, NOW_MS } from "./db.js";
import type { FeedbackChannel, FeedbackTargetKind, FeedbackVerdict, RecallFeedback } from "./types.js";
import { feedbackInputSchema } from "./schemas.js";

/**
 * Recall kalite geri bildirimi: agent'lar otomatik enjeksiyonun isabetini işaretler.
 * Cihaz-yerel tutulur (sync'e girmez) — her cihazın recall yolu kendi HUB_RECALL_*
 * eşikleriyle çalışır; kalibrasyon verisi de o cihaza aittir. Birikince
 * scripts/recall-check.ts ile birlikte eşik ayarının kanıt tabanı olur.
 */
export function addRecallFeedback(input: {
  query: string;
  verdict: FeedbackVerdict;
  target_kind?: FeedbackTargetKind;
  target_id?: number;
  project?: string;
  intent?: "current_status" | "decision" | "technical_history" | "documentation" | "preference" | "general";
  rank?: number;
  channels?: FeedbackChannel[];
  delivery_id?: string;
  memory_id?: number;
  note?: string;
  source?: string;
}): RecallFeedback {
  input = feedbackInputSchema.parse(input);
  const targetKind = input.target_kind ?? (input.memory_id ? "memory" : null);
  const targetId = input.target_id ?? input.memory_id ?? null;
  const db = getDb();
  const targetUid = (() => {
    if (targetKind === "memory" && targetId) {
      return (db.prepare("SELECT uid FROM memories WHERE id = ?").get(targetId) as { uid: string } | undefined)?.uid ?? null;
    }
    if (targetKind === "document" && targetId) {
      return (db.prepare("SELECT uid FROM documents WHERE id = ?").get(targetId) as { uid: string } | undefined)?.uid ?? null;
    }
    if (targetKind === "chunk" && targetId) {
      const row = db
        .prepare("SELECT d.uid AS document_uid, c.seq FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ?")
        .get(targetId) as { document_uid: string; seq: number } | undefined;
      return row ? `${row.document_uid}:chunk:${row.seq}` : null;
    }
    return targetKind === "context" ? input.delivery_id ?? null : null;
  })();
  if (targetKind && targetKind !== "context" && targetId && !targetUid) {
    throw new Error(`${targetKind} target #${targetId} not found; feedback must reference delivered current evidence`);
  }
  const info = db
    .prepare(
      `INSERT INTO recall_feedback(
         query, verdict, target_kind, target_id, target_uid, project, intent, rank, channels,
         delivery_id, memory_id, note, source, created_at
       ) VALUES (
         @query, @verdict, @target_kind, @target_id, @target_uid, @project, @intent, @rank,
         @channels, @delivery_id, @memory_id, @note, @source, ${NOW_MS}
       )`
    )
    .run({
      query: input.query,
      verdict: input.verdict,
      target_kind: targetKind,
      target_id: targetId,
      target_uid: targetUid,
      project: input.project ?? null,
      intent: input.intent ?? null,
      rank: input.rank ?? null,
      channels: JSON.stringify(input.channels ?? []),
      delivery_id: input.delivery_id ?? null,
      memory_id: targetKind === "memory" ? targetId : null,
      note: input.note ?? null,
      source: input.source ?? null,
    });
  return rowToFeedback(db
    .prepare("SELECT * FROM recall_feedback WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as Record<string, unknown>);
}

function rowToFeedback(row: Record<string, unknown>): RecallFeedback {
  let channels: FeedbackChannel[] = [];
  try {
    const parsed = JSON.parse(String(row.channels ?? "[]"));
    if (Array.isArray(parsed)) channels = parsed as FeedbackChannel[];
  } catch {
    // Corrupt local calibration data should not break the feedback API.
  }
  return { ...(row as unknown as RecallFeedback), channels };
}

export function listRecallFeedback(opts: { verdict?: FeedbackVerdict; limit?: number } = {}): RecallFeedback[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  if (opts.verdict) {
    const rows = getDb()
      .prepare("SELECT * FROM recall_feedback WHERE verdict = ? ORDER BY created_at DESC LIMIT ?")
      .all(opts.verdict, limit) as Record<string, unknown>[];
    return rows.map(rowToFeedback);
  }
  const rows = getDb()
    .prepare("SELECT * FROM recall_feedback ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToFeedback);
}

/** Verdict bazında sayılar — eşik ayarı öncesi hızlı bakış (ör. noisy oranı yüksekse recallMinRatio artır). */
export function feedbackSummary(): { verdict: string; count: number }[] {
  return getDb()
    .prepare("SELECT verdict, COUNT(*) AS count FROM recall_feedback GROUP BY verdict ORDER BY count DESC")
    .all() as { verdict: string; count: number }[];
}

export function feedbackQualityBreakdown(): { verdict: string; target_kind: string; count: number }[] {
  return getDb()
    .prepare(
      `SELECT verdict, COALESCE(target_kind, 'context') AS target_kind, COUNT(*) AS count
       FROM recall_feedback GROUP BY verdict, COALESCE(target_kind, 'context')
       ORDER BY count DESC, verdict, target_kind`
    )
    .all() as { verdict: string; target_kind: string; count: number }[];
}
