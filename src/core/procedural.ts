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
import { getTask } from "./tasks.js";
import { taskFeedbackList } from "./learning.js";
import { localLlm, machinesStatus } from "./compute.js";

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

function insertCandidate(
  input: CandidateInput,
  status: CandidateStatus,
  promotedMemoryUid: string | null = null
): { id: number; uid: string } {
  const uid = randomUUID().replaceAll("-", "");
  const info = getDb()
    .prepare(
      `INSERT INTO lesson_candidates(uid, kind, situation, guidance, project, episode_key, evidence_refs, status, promoted_memory_uid, created_at)
       VALUES (@uid, @kind, @situation, @guidance, @project, @episode_key, @evidence_refs, @status, @promoted_memory_uid, ${NOW_MS})`
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
      promoted_memory_uid: promotedMemoryUid,
    });
  return { id: Number(info.lastInsertRowid), uid };
}

/** True only if the memory exists and is still current (not invalidated/revoked). */
function memoryIsCurrent(uid: string): boolean {
  const row = getDb().prepare("SELECT is_current FROM memories WHERE uid = ?").get(uid) as { is_current: number } | undefined;
  return row?.is_current === 1;
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

  // 4. Corroboration. Look at same-kind candidates from a DIFFERENT episode,
  //    whether still pending or already promoted. Two candidates from the same
  //    episode never corroborate each other.
  const prior = getDb()
    .prepare(
      `SELECT * FROM lesson_candidates
       WHERE kind = ? AND episode_key != ? AND status IN ('pending','promoted')`
    )
    .all(input.kind, input.episode_key) as Record<string, unknown>[];

  const matches = prior.map(rowToCandidate).filter((c) => situationSimilar(c.situation, input.situation));

  // 4a. If the pattern was ALREADY promoted and its memory is still current, do
  //     NOT mint a duplicate memory — attach this candidate to the existing one.
  //     Repeated recurrence must not flood the base with copies of one lesson.
  //     The is_current guard prevents resurrecting a human-invalidated lesson.
  const promotedMatch = matches.find((c) => c.status === "promoted" && c.promoted_memory_uid && memoryIsCurrent(c.promoted_memory_uid));
  if (promotedMatch) {
    const { uid } = insertCandidate(input, "promoted", promotedMatch.promoted_memory_uid);
    emitHubEvent({ type: "feedback_recorded", payload: { candidate_uid: uid, reason: "re_corroborated", memory_uid: promotedMatch.promoted_memory_uid, project: input.project ?? null } });
    return { status: "promoted", candidate_uid: uid, promoted_memory_uid: promotedMatch.promoted_memory_uid!, reason: "re_corroborated" };
  }

  // 4b. First corroboration: a pending match exists -> mint the howto memory and
  //     promote both candidates.
  const pendingMatch = matches.find((c) => c.status === "pending");
  if (pendingMatch) {
    const memory = await saveMemory({
      type: "howto",
      title: `${input.kind}: ${input.situation.slice(0, 80)}`,
      body: `Durum: ${input.situation}\n\nRehber: ${input.guidance}`,
      project: input.project ?? undefined,
      tags: ["auto-lesson", "procedural", `kind-${input.kind}`, `episode-${input.episode_key.slice(0, 12)}`],
      source: episodeSource(input.episode_key),
      importance: input.kind === "recovery" ? 1.5 : 1.0,
    });
    const { uid } = insertCandidate(input, "promoted", memory.uid);
    getDb()
      .prepare("UPDATE lesson_candidates SET status = 'promoted', promoted_memory_uid = ? WHERE uid = ?")
      .run(memory.uid, pendingMatch.uid);
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

// ===========================================================================
// Phase 2: episode assembly + distillation (wires the local model)
// ===========================================================================

/** One lesson the distiller proposes, before admission. */
export interface CandidateDraft {
  kind: LessonKind;
  situation: string;
  guidance: string;
}

export interface AssembledEpisode {
  episode_key: string;
  project: string | null;
  /** The coarse trajectory text handed to the distiller. */
  text: string;
  /** Rows this episode was built from — become the candidate's evidence. */
  evidence_refs: string[];
}

export interface DistillResult {
  episode_key: string;
  /** Why nothing was produced, when applicable. */
  skipped?: "no_local_llm" | "no_episode" | "empty_output";
  distilled: number;
  admitted: AdmitResult[];
}

const VALID_KINDS: readonly LessonKind[] = ["strategy", "recovery", "optimization"];

/**
 * Parse the distiller's raw output into validated drafts. PURE and defensive —
 * this is the trust boundary for model output, so it is unit-tested directly.
 *
 * Rules: the payload must be a JSON array (fences tolerated); each item must have
 * a valid kind and non-empty situation/guidance strings within length bounds.
 * Anything else is dropped. Free-form prose yields []. Never throws.
 */
export function parseDistillerOutput(raw: string): CandidateDraft[] {
  if (!raw || typeof raw !== "string") return [];
  // Tolerate markdown fences and surrounding prose: extract the first [...] block.
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const drafts: CandidateDraft[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const kind = (item as { kind?: unknown }).kind;
    const situation = (item as { situation?: unknown }).situation;
    const guidance = (item as { guidance?: unknown }).guidance;
    if (!VALID_KINDS.includes(kind as LessonKind)) continue;
    if (typeof situation !== "string" || typeof guidance !== "string") continue;
    const s = situation.trim();
    const g = guidance.trim();
    if (s.length < 3 || s.length > 280) continue;
    if (g.length < 3 || g.length > 400) continue;
    drafts.push({ kind: kind as LessonKind, situation: s, guidance: g });
    if (drafts.length >= 5) break; // cap: an episode yields a handful of lessons at most
  }
  return drafts;
}

/** True if any registered machine currently exposes a local LLM (mirror of compaction). */
async function localLlmAvailable(): Promise<boolean> {
  try {
    const status = await machinesStatus();
    return status.some((m) => m.lmstudio?.online || m.ollama?.online);
  } catch {
    return false;
  }
}

/**
 * Assemble a coarse trajectory for one task episode from rows Mnema already
 * stores. Reads task metadata + task_feedback ONLY — never raw shell output,
 * environment, or command lines (those are not in these rows, per ADR-007). The
 * episode is keyed by task uid; evidence_refs point at the exact rows used.
 * Returns null when there is nothing to learn from.
 */
export function assembleEpisode(taskUid: string): AssembledEpisode | null {
  const task = getTask(taskUid);
  const feedback = taskFeedbackList(taskUid);
  if (!task && feedback.length === 0) return null;

  const evidence_refs: string[] = [];
  const parts: string[] = [];

  if (task) {
    evidence_refs.push(`task:${task.uid}`);
    parts.push(`# Görev: ${task.title}`);
    if (task.description) parts.push(task.description);
    parts.push(`Durum: ${task.status}`);
  }

  for (const fb of feedback) {
    evidence_refs.push(`task_feedback:${fb.uid}`);
    const seg: string[] = [`## Sonuç: ${fb.outcome}`];
    if (fb.what_worked) seg.push(`İşe yarayan: ${fb.what_worked}`);
    if (fb.what_failed) seg.push(`Başarısız: ${fb.what_failed}`);
    if (fb.lessons) seg.push(`Dersler: ${fb.lessons}`);
    if (fb.duration_min != null) seg.push(`Süre: ${fb.duration_min} dk`);
    parts.push(seg.join("\n"));
  }

  if (evidence_refs.length === 0) return null;
  return {
    episode_key: taskUid,
    project: task?.project ?? feedback[0]?.project ?? null,
    text: parts.join("\n\n"),
    evidence_refs,
  };
}

const DISTILLER_SYSTEM_PROMPT = [
  "You extract reusable engineering lessons from one development episode.",
  "Output ONLY a JSON array (no prose, no code fences) of at most 3 objects.",
  'Each object: {"kind","situation","guidance"}.',
  'kind is one of: "strategy" (from a clean success), "recovery" (from a failure that was then fixed), "optimization" (from a slow or roundabout success).',
  "situation: <=140 chars, what was happening — the retrieval key a future agent matches against.",
  "guidance: <=200 chars, the actionable advice, phrased as description not as a command.",
  "If the episode carries no reusable lesson, output []. Never invent detail that is not in the input.",
].join("\n");

/**
 * Distill one episode into candidates via the local model, then run each through
 * the admission gate. Mirrors compaction's discipline: if no local LLM is
 * reachable it returns cleanly with skipped='no_local_llm' — never throws, never
 * blocks the caller. Model output is untrusted: it is parsed defensively and
 * every draft still passes admitCandidate (injection/sensitive/corroboration).
 */
export async function distillEpisode(taskUid: string): Promise<DistillResult> {
  const episode = assembleEpisode(taskUid);
  if (!episode) return { episode_key: taskUid, skipped: "no_episode", distilled: 0, admitted: [] };

  if (!(await localLlmAvailable())) {
    return { episode_key: episode.episode_key, skipped: "no_local_llm", distilled: 0, admitted: [] };
  }

  let raw: string;
  try {
    const result = await localLlm({
      messages: [
        { role: "system", content: DISTILLER_SYSTEM_PROMPT },
        { role: "user", content: episode.text },
      ],
      max_tokens: 600,
      temperature: 0,
    });
    raw = result.content ?? "";
  } catch {
    // Model unreachable mid-call: treat as unavailable, do not crash the worker.
    return { episode_key: episode.episode_key, skipped: "no_local_llm", distilled: 0, admitted: [] };
  }

  const drafts = parseDistillerOutput(raw);
  if (drafts.length === 0) {
    return { episode_key: episode.episode_key, skipped: "empty_output", distilled: 0, admitted: [] };
  }

  const admitted: AdmitResult[] = [];
  for (const draft of drafts) {
    admitted.push(
      await admitCandidate({
        kind: draft.kind,
        situation: draft.situation,
        guidance: draft.guidance,
        project: episode.project,
        episode_key: episode.episode_key,
        evidence_refs: episode.evidence_refs,
      })
    );
  }
  emitHubEvent({
    type: "feedback_recorded",
    payload: { reason: "episode_distilled", episode_key: episode.episode_key, distilled: drafts.length, project: episode.project },
  });
  return { episode_key: episode.episode_key, distilled: drafts.length, admitted };
}
