/**
 * ADR-007: procedural memory from agent trajectories.
 *
 * This module owns the ADMISSION GATE for distilled lessons — the deterministic,
 * security-critical half. Distillation (feeding a trajectory to a local model to
 * produce candidates) lives in phase 2; here a candidate arrives already shaped
 * and is judged:
 *
 *   1. no evidence reference        -> refused (never stored)
 *   2. prompt-injection signature   -> rejected
 *   3. sensitive topic (creds/etc.) -> held for a human, never auto-promoted
 *   4. corroborated by a SECOND      -> promoted to a howto memory
 *      independent episode
 *   otherwise                        -> left pending
 *
 * A candidate is never itself injected into an agent's context; only a promoted
 * howto memory is, and promotion requires corroboration. See ADR-007.
 */
import { randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import { emitHubEvent } from "./events-bus.js";
import { saveMemory, invalidateMemory } from "./memories.js";

export type LessonKind = "strategy" | "recovery" | "optimization";
export type CandidateStatus = "pending" | "promoted" | "rejected" | "held";

export interface CandidateInput {
  kind: LessonKind;
  /** What was happening — the retrieval key a future agent matches against. */
  situation: string;
  /** The actionable guidance. */
  guidance: string;
  project?: string | null;
  /** Groups candidates from one task/presence episode; enables bulk revocation. */
  episode_key: string;
  /** References to the rows this was derived from. Empty -> refused. */
  evidence_refs: string[];
}

export interface LessonCandidate {
  id: number;
  uid: string;
  kind: LessonKind;
  situation: string;
  guidance: string;
  project: string | null;
  episode_key: string;
  evidence_refs: string[];
  status: CandidateStatus;
  promoted_memory_uid: string | null;
  created_at: string;
}

export interface AdmitResult {
  status: CandidateStatus;
  candidate_uid: string;
  /** Set only when status transitioned to 'promoted'. */
  promoted_memory_uid?: string;
  reason?: string;
}

/** How a promoted candidate stamps its origin memory, so an episode is revocable. */
function episodeSource(episodeKey: string): string {
  return `trajectory-distiller:${episodeKey}`;
}

/**
 * Prompt-injection signature. Intentionally reuses the SAME notion the retrieval
 * path uses (context.ts instructionLike): a legitimate lesson is advice, so this
 * is not a general "imperative" filter — it fires only on injection markers like
 * "ignore previous instructions" or fake role tags. Kept in sync deliberately;
 * if context.ts's regex changes, this should track it.
 */
const INJECTION_RE =
  /(?:ignore|disregard|override)\s+(?:all\s+)?(?:(?:previous|prior)(?:\s+(?:system|developer|assistant|tool))?|system|developer|assistant|tool)\s+instructions?|<\/?(?:system|assistant|developer|tool)\b|\b(?:system|developer)\s*prompt\s*:/iu;

function hasInjectionSignature(text: string): boolean {
  return INJECTION_RE.test(text);
}

/**
 * Sensitive matches that must never be auto-promoted regardless of corroboration:
 * credentials, and privileged/destructive COMMANDS. This is the one class where an
 * automated mistake is least reversible (ADR-007).
 *
 * Deliberately narrow: it matches credential nouns and actual command tokens, not
 * TOPICS. A lesson that merely mentions "deploy" or "firewall" is normal knowledge
 * (many exist in this repo's memory); flagging the topic would send most ops
 * lessons to the human queue and defeat the automation. The risk is auto-promoting
 * a lesson that runs `sudo …`/`rm -rf …`, and those tokens are matched directly.
 */
const SENSITIVE_RE =
  /\b(?:pass(?:word|phrase)|secret|token|api[_\s-]?key|credential|private\s+key|ssh\s+key|authorized_keys|bearer)\b|\.env\b|\b(?:sudo|systemctl|chmod|chown|iptables|ufw|rm\s+-rf|drop\s+table|truncate\s+table|mkfs|dd\s+if=)\b/iu;

function isSensitive(text: string): boolean {
  return SENSITIVE_RE.test(text);
}

/** Tokenize to a lowercase word set, keeping tokens of at least `minLen` chars. */
function tokenSet(text: string, minLen = 3): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= minLen)
  );
}

/**
 * Deterministic situation similarity for the corroboration gate — no model, so
 * admission is stable and testable.
 *
 * Two situations corroborate when, for the SAME kind, they either share enough
 * salient content tokens (>= 4 chars, so distinctive nouns like "tailscale",
 * "deploy") or overlap strongly by ratio. Pure Jaccard alone is too brittle for
 * an inflected language: two honest paraphrases of one event ("… zaman aşımına
 * uğradı" vs "… timeout verdi") share the salient nouns but differ in every
 * inflected verb, deflating the ratio below any safe threshold. Counting shared
 * salient tokens is robust to that; the Jaccard clause still catches short
 * situations where few tokens clear the salience bar.
 *
 * Phase 2 may replace this with the FTS/bm25 near-duplicate path used by
 * findDuplicates, which downweights common tokens by IDF; this deterministic
 * matcher is the phase-1 stand-in.
 */
export function situationSimilar(
  a: string,
  b: string,
  opts: { minSharedSalient?: number; jaccard?: number } = {}
): boolean {
  const minSharedSalient = opts.minSharedSalient ?? 3;
  const jaccardThreshold = opts.jaccard ?? 0.5;

  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return false;

  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  const jaccard = union > 0 ? inter / union : 0;

  const salientA = tokenSet(a, 4);
  const salientB = tokenSet(b, 4);
  let sharedSalient = 0;
  for (const t of salientA) if (salientB.has(t)) sharedSalient++;

  return sharedSalient >= minSharedSalient || jaccard >= jaccardThreshold;
}

function rowToCandidate(row: Record<string, unknown>): LessonCandidate {
  return {
    id: row.id as number,
    uid: row.uid as string,
    kind: row.kind as LessonKind,
    situation: row.situation as string,
    guidance: row.guidance as string,
    project: (row.project as string) ?? null,
    episode_key: row.episode_key as string,
    evidence_refs: JSON.parse((row.evidence_refs as string) ?? "[]"),
    status: row.status as CandidateStatus,
    promoted_memory_uid: (row.promoted_memory_uid as string) ?? null,
    created_at: row.created_at as string,
  };
}

function insertCandidate(input: CandidateInput, status: CandidateStatus): { id: number; uid: string } {
  const uid = randomUUID().replaceAll("-", "");
  getDb()
    .prepare(
      `INSERT INTO lesson_candidates(uid, kind, situation, guidance, project, episode_key, evidence_refs, status, created_at)
       VALUES (@uid, @kind, @situation, @guidance, @project, @episode_key, @evidence_refs, @status, ${NOW_MS})`
    )
    .run({
      uid,
      kind: input.kind,
      situation: input.situation,
      guidance: input.guidance,
      project: input.project ?? null,
      episode_key: input.episode_key,
      evidence_refs: JSON.stringify(input.evidence_refs ?? []),
      status,
    });
  const id = getDb().prepare("SELECT id FROM lesson_candidates WHERE uid = ?").get(uid) as { id: number };
  return { id: id.id, uid };
}

/**
 * The admission gate. See module header for the decision order. Async because
 * promotion writes a memory (saveMemory embeds).
 */
export async function admitCandidate(input: CandidateInput): Promise<AdmitResult> {
  // 1. Evidence is mandatory. A candidate with no observable basis is refused
  //    outright and never stored — it cannot be audited or revoked meaningfully.
  if (!input.evidence_refs || input.evidence_refs.length === 0) {
    return { status: "rejected", candidate_uid: "", reason: "no_evidence" };
  }

  const combined = `${input.situation}\n${input.guidance}`;

  // 2. Injection signature -> store as rejected (kept for audit, never promoted).
  if (hasInjectionSignature(combined)) {
    const { uid } = insertCandidate(input, "rejected");
    emitHubEvent({ type: "feedback_recorded", payload: { candidate_uid: uid, reason: "injection_signature", project: input.project ?? null } });
    return { status: "rejected", candidate_uid: uid, reason: "injection_signature" };
  }

  // 3. Sensitive topic -> held for a human. Never auto-promotes even if a second
  //    episode corroborates; this is the least-reversible class.
  if (isSensitive(combined)) {
    const { uid } = insertCandidate(input, "held");
    emitHubEvent({ type: "feedback_recorded", payload: { candidate_uid: uid, reason: "sensitive_held", project: input.project ?? null } });
    return { status: "held", candidate_uid: uid, reason: "sensitive_held" };
  }

  // 4. Corroboration: a PENDING candidate of the same kind, from a DIFFERENT
  //    episode, whose situation is near-duplicate. Two candidates from the same
  //    episode never corroborate each other.
  const priorPending = getDb()
    .prepare(
      `SELECT * FROM lesson_candidates
       WHERE status = 'pending' AND kind = ? AND episode_key != ?`
    )
    .all(input.kind, input.episode_key) as Record<string, unknown>[];

  const match = priorPending
    .map(rowToCandidate)
    .find((c) => situationSimilar(c.situation, input.situation));

  if (match) {
    // Promote: write the howto memory, mark both candidates promoted.
    const memory = await saveMemory({
      type: "howto",
      title: `${input.kind}: ${input.situation.slice(0, 80)}`,
      body: `Durum: ${input.situation}\n\nRehber: ${input.guidance}`,
      project: input.project ?? undefined,
      tags: ["auto-lesson", "procedural", `kind-${input.kind}`, `episode-${input.episode_key.slice(0, 12)}`],
      source: episodeSource(input.episode_key),
      importance: input.kind === "recovery" ? 1.5 : 1.0,
    });
    const { uid } = insertCandidate(input, "promoted");
    getDb()
      .prepare("UPDATE lesson_candidates SET status = 'promoted', promoted_memory_uid = ? WHERE uid IN (?, ?)")
      .run(memory.uid, uid, match.uid);
    notifyWrite();
    emitHubEvent({ type: "feedback_recorded", payload: { candidate_uid: uid, reason: "promoted", memory_uid: memory.uid, project: input.project ?? null } });
    return { status: "promoted", candidate_uid: uid, promoted_memory_uid: memory.uid, reason: "corroborated" };
  }

  // Otherwise: first sighting, stays pending.
  const { uid } = insertCandidate(input, "pending");
  return { status: "pending", candidate_uid: uid, reason: "awaiting_corroboration" };
}

export function listLessonCandidates(opts: { status?: CandidateStatus; project?: string; limit?: number } = {}): LessonCandidate[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts.project) {
    conditions.push("project = ?");
    params.push(opts.project);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM lesson_candidates ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, Math.min(opts.limit ?? 50, 200)) as Record<string, unknown>[];
  return rows.map(rowToCandidate);
}

export function getLessonCandidate(uid: string): LessonCandidate | null {
  const row = getDb().prepare("SELECT * FROM lesson_candidates WHERE uid = ?").get(uid) as Record<string, unknown> | undefined;
  return row ? rowToCandidate(row) : null;
}

/**
 * Revoke everything derived from one episode: delete its candidates and
 * invalidate the howto memories they promoted. Invalidation (ADR-006) is
 * reversible and keeps the row, so a mistaken revocation is recoverable.
 */
export async function revokeEpisode(episodeKey: string, reason = "episode revoked"): Promise<{ candidates_deleted: number; memories_invalidated: number }> {
  const db = getDb();
  // Invalidate promoted memories stamped with this episode's source.
  const memories = db
    .prepare("SELECT id FROM memories WHERE source = ? AND is_current = 1")
    .all(episodeSource(episodeKey)) as { id: number }[];
  let invalidated = 0;
  for (const m of memories) {
    const res = await invalidateMemory({
      id: m.id,
      reason,
      evidence: `revokeEpisode(${episodeKey})`,
    });
    if (res) invalidated++;
  }
  const del = db.prepare("DELETE FROM lesson_candidates WHERE episode_key = ?").run(episodeKey);
  notifyWrite();
  return { candidates_deleted: del.changes, memories_invalidated: invalidated };
}
