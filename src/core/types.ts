export type MemoryType = "fact" | "preference" | "decision" | "howto" | "context";

export interface Memory {
  id: number;
  uid: string;
  type: MemoryType;
  title: string;
  body: string;
  project: string | null;
  tags: string[];
  source: string | null;
  language: string | null;
  canonical_summary: string | null;
  normalizer_generation: string | null;
  importance: number;
  last_accessed: string | null;
  access_count: number;
  /** Bağlantılı hafızaların uid'leri (id değil — id'ler cihaz-yerel, uid sync'te sabit). */
  related: string[];
  /** Kaydın ilk yazıldığı cihaz (resolveMachineName() ile damgalanır). Yerel oluşturma sırasında damgalanır;
   *  sync'ten pull edilen satırda karşı tarafın verdiği değer korunur. */
  origin_machine: string | null;
  /** ADR-006: hafıza yaşam döngüsü — documents'taki desenin birebir aynısı. */
  /** Bu kaydın geçerlilik başlangıcı. Migration'da mevcut kayıtlar için created_at ile doldurulur; yeni kayıtlarda boş bırakılabilir. */
  valid_from: string | null;
  /** Geçerlilik bitişi (supersede/invalidate anında damgalanır). */
  valid_to: string | null;
  /** 1 = varsayılan okuma/arama sonuçlarına dahil; 0 = supersede/invalidate edilmiş, yalnız include_superseded ile görünür. */
  is_current: number;
  /** Bu kaydı geçersiz kılan/yerine geçen kaydın uid'i (varsa). */
  supersedes_uid: string | null;
  /** is_current=0 yapılma gerekçesi (memory_invalidate — faz 2). */
  invalidated_reason: string | null;
  /** ADR-006 faz 2: bu kaydın en son doğrulandığı zaman (volatil iddialar için). */
  verified_at: string | null;
  /** ADR-006 faz 2: bu tarihten sonra doğrulanmamışsa formatRecall görünür bir uyarı ekler (kaydı GİZLEMEZ). */
  review_after: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryInput {
  type?: MemoryType;
  title: string;
  body: string;
  project?: string;
  tags?: string[];
  source?: string;
  /** Original BCP-47 language. Original title/body remain authoritative. */
  language?: string;
  /** Optional concise English retrieval/context alias; never replaces body. */
  canonical_summary?: string | null;
  /** Model/ruleset version that produced canonical_summary. */
  normalizer_generation?: string | null;
  /** Önem çarpanı; 0.5–2.0 aralığına kelepçelenir. 2=kritik karar, 1=normal, 0.5=önemsiz detay. */
  importance?: number;
  /** Bağlantılı hafıza id'leri (yerel) — uid'e çevrilerek saklanır; bilinmeyen id sessizce atlanır. */
  related_ids?: number[];
  /** Hangi cihazdan yazıldığı. Verilmezse resolveMachineName() ile damgalanır. Sync'ten pull edilen
   *  kayıtlarda bu alan yutulmaz (karşı tarafın değeri korunur). */
  origin_machine?: string | null;
  /** ADR-006 faz 2: son doğrulama zamanı (opsiyonel; ISO 8601 veya "YYYY-MM-DD HH:MM:SS"). */
  verified_at?: string | null;
  /** ADR-006 faz 2: bu tarihten sonra doğrulanmamışsa formatRecall uyarı ekler. */
  review_after?: string | null;
}

/** Bağlantılı hafızanın yerel çözümü (uid → bu cihazdaki id + başlık). */
export interface RelatedRef {
  id: number;
  title: string;
}

export type FeedbackVerdict = "noisy" | "missing" | "helpful";
export type FeedbackTargetKind = "memory" | "chunk" | "document" | "context";
export type FeedbackChannel = "fts" | "vec" | "authority" | "graph";

/** Agent'lardan gelen recall kalite geri bildirimi — eşik kalibrasyonu verisi (cihaz-yerel). */
export interface RecallFeedback {
  id: number;
  query: string;
  verdict: FeedbackVerdict;
  target_kind: FeedbackTargetKind | null;
  target_id: number | null;
  /** Stable cross-device identity resolved by the server from target_kind/id. */
  target_uid: string | null;
  project: string | null;
  intent: Exclude<import("./context.js").ContextIntent, "auto"> | null;
  rank: number | null;
  channels: FeedbackChannel[];
  delivery_id: string | null;
  /** Deprecated compatibility alias. */
  memory_id: number | null;
  note: string | null;
  source: string | null;
  created_at: string;
}

export interface SearchFilters {
  type?: MemoryType;
  project?: string;
  tag?: string;
  limit?: number;
  /** ADR-006: varsayılan false — supersede/invalidate edilmiş (is_current=0) kayıtlar dahil edilmez. */
  include_superseded?: boolean;
}

export interface ScoredMemory extends Memory {
  score: number;
  /** Hangi arama kanalları buldu ("fts"/"vec"). Recall'un anlamsal kanıt kapısı kullanır. */
  channels?: ("fts" | "vec")[];
  channel_ranks?: Partial<Record<"fts" | "vec", number>>;
}

/** Kayıt anında bulunan olası benzer/tekrar (dedup) hafıza. */
export interface SimilarHit {
  id: number;
  title: string;
  distance: number;
}

/** saveMemory() dönüşü: benzer kayıt bulunduysa `similar` alanı eklenir. */
export interface SavedMemory extends Memory {
  similar?: SimilarHit[];
  /**
   * ADR-006: benzer kayit bulundugunda YAZAN AGENT'a ne yapacagini soyler.
   * Sistem kendisi karar VERMEZ — yanlis bir gecersiz kilma, bayat kayittan kotudur.
   * Bu yuzden karar cagirana birakilir ve yalnizca secenek hatirlatilir.
   */
  similar_hint?: string;
}

export interface DocumentInput {
  title: string;
  text: string;
  source?: string;
  uri?: string;
  project?: string;
  /** Stable lifecycle class used by intent routing and retention policy. */
  kind?: "reference" | "status" | "decision" | "runbook" | "research" | "learning" | "source";
  version?: string;
  /** Current documents participate in default retrieval. Defaults to true. */
  is_current?: boolean;
  /** Stable UID of an older document explicitly replaced by this document. */
  supersedes_uid?: string;
  valid_from?: string;
  valid_to?: string;
  archived_at?: string;
  /** Original BCP-47 language when known. Original text is always preserved. */
  language?: string;
}

export type MemoryRelationType =
  | "related"
  | "supports"
  | "contradicts"
  | "supersedes"
  | "caused_by"
  | "derived_from"
  | "applies_to";

export interface MemoryRelation {
  id: string;
  from_id: number;
  from_uid: string;
  from_title: string;
  to_id: number;
  to_uid: string;
  to_title: string;
  relation_type: MemoryRelationType;
  confidence: number;
  valid_from: string | null;
  valid_to: string | null;
  source: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ScoredChunk {
  chunk_id: number;
  chunk_seq: number;
  document_id: number;
  document_uid: string;
  content_hash: string | null;
  document_title: string;
  uri: string | null;
  project: string | null;
  document_kind?: string;
  document_version?: string | null;
  is_current?: number;
  heading: string | null;
  text: string;
  score: number;
  /** Hangi arama kanalları buldu ("fts"/"vec"). Recall'un anlamsal kanıt kapısı kullanır. */
  channels?: ("fts" | "vec")[];
  channel_ranks?: Partial<Record<"fts" | "vec", number>>;
}

/** Kod haritasının bir modülü — bir dizin/dosya kümesi ve sorumluluğu. */
export interface ProjectModule {
  /** Kısa modül adı, ör. "core/search" */
  name: string;
  /** Repo köküne göre yol, ör. "src/core/search.ts" veya "src/core/" */
  path: string;
  /** Tek cümle: bu modül ne yapar, sınırı ne. */
  purpose: string;
  /** Değişiklik yaparken ilk bakılacak dosyalar. */
  key_files?: string[];
  /** Bağımlı olduğu modül adları (modules[].name). */
  depends_on?: string[];
}

export interface ProjectMap {
  name: string;
  status?: "active" | "paused" | "done" | "idea";
  summary?: string;
  stack?: string[];
  repo?: string;
  paths?: Record<string, string>;
  current_focus?: string;
  decisions?: string[];
  next_steps?: string[];
  links?: string[];
  notes?: string;
  /** Kod haritası: mimarinin 3-5 cümlelik özeti (katmanlar, veri akışı, sınırlar). */
  architecture?: string;
  /** Kod haritası: modül dökümü — agent'ın "nereye bakacağım" sorusunun cevabı. */
  modules?: ProjectModule[];
  /** Giriş noktaları: rol → dosya, ör. { server: "src/server/index.ts" }. */
  entry_points?: Record<string, string>;
  /** Sık komutlar: ad → komut, ör. { dev: "npm run dev", test: "npm test" }. */
  commands?: Record<string, string>;
  /** Koddan okunamayan yazılı kurallar/konvansiyonlar (kısa maddeler). */
  conventions?: string[];
  /** Veri modelinin kısa özeti: ana tablolar/varlıklar ve ilişkileri. */
  data_model?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface SessionLog {
  id: number;
  project: string | null;
  summary: string;
  source: string | null;
  /** Hangi cihazdan yazıldığı (resolveMachineName() ile damgalanır). */
  origin_machine: string | null;
  created_at: string;
  updated_at: string;
}

export type AssetKind = "skill" | "prompt";

/** DB-authority skill/prompt kaydı (bkz. src/core/assets.ts). */
export interface AssetRecord {
  id: number;
  uid: string;
  kind: AssetKind;
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export type AgentPresenceStatus = "active" | "done" | "abandoned";

/** Advisory agent-presence kaydı — mutual-exclusion kilidi DEĞİL, koordinasyon sinyali. */
export interface AgentPresence {
  id: number;
  uid: string;
  machine: string;
  agent: string;
  project: string;
  branch: string | null;
  task: string;
  status: AgentPresenceStatus;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

/** agent_active() dönüşü: bayatlık TTL'e göre işaretlenmiş kayıt. */
export interface AgentPresenceView extends AgentPresence {
  stale: boolean;
}

// ============================================================================
// Agent Coordination Types
// ============================================================================

export type TaskStatus = "pending" | "claimed" | "in_progress" | "blocked" | "done" | "cancelled";

/**
 * Quality-gate verification proof attached at task completion time.
 * Stored as JSON in the `tasks.verification` column. `kind:"none"` is an
 * explicit conscious-choice signal (no warning emitted); a null column means
 * "no verification recorded" — `task_complete` surfaces a soft `uyari` in
 * that case (advisory, consistent with presence philosophy; never a hard lock).
 */
export type TaskVerificationKind = "tests" | "build" | "manual" | "none";

export interface TaskVerification {
  kind: TaskVerificationKind;
  command?: string;
  exit_code?: number;
  summary?: string;
}

/** Task queue item: agent-to-agent work delegation and tracking. */
export interface Task {
  id: number;
  uid: string;
  project: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  created_by: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  depends_on: string[];
  tags: string[];
  result: string | null;
  error: string | null;
  verification: TaskVerification | null;
  due_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskInput {
  project?: string;
  title: string;
  description?: string;
  priority?: number;
  created_by?: string;
  depends_on?: string[];
  tags?: string[];
  due_at?: string;
}

export interface TaskPatch {
  status?: TaskStatus;
  priority?: number;
  description?: string;
  result?: string;
  error?: string;
  tags?: string[];
  verification?: TaskVerification | null;
}

/**
 * `task_complete` yanıtı: görevin task satırına ek olarak bir `uyari` alanı
 * eklenir. `uyari` yalnızca verification kanıtı verilmemişse (kolon null
 * kaldıysa ve `kind:"none"` açıkça seçilmemişse) dolar — sert kilit değil,
 * agent'ı bilgilendirme amaçlı advisory alan.
 */
export type TaskCompleteResult = Task & { uyari?: string };

export interface TaskFilter {
  project?: string;
  status?: TaskStatus;
  claimed_by?: string;
  created_by?: string;
  tag?: string;
  limit?: number;
}

export type AgentCapabilityStatus = "available" | "busy" | "offline";

/** Agent capability registry entry. */
export interface AgentCapability {
  id: number;
  uid: string;
  agent: string;
  machine: string | null;
  capabilities: string[];
  models: string[];
  max_concurrent: number;
  status: AgentCapabilityStatus;
  last_seen_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AgentCapabilityInput {
  agent: string;
  machine?: string;
  capabilities?: string[];
  models?: string[];
  max_concurrent?: number;
  status?: AgentCapabilityStatus;
  metadata?: Record<string, unknown>;
}

export type MessageKind = "info" | "request" | "response" | "handoff" | "alert";

/** Agent-to-agent message. */
export interface AgentMessage {
  id: number;
  uid: string;
  from_agent: string;
  to_agent: string | null;
  project: string | null;
  task_uid: string | null;
  kind: MessageKind;
  subject: string;
  body: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface AgentMessageInput {
  from_agent: string;
  to_agent?: string;
  project?: string;
  task_uid?: string;
  kind?: MessageKind;
  subject: string;
  body: string;
  payload?: Record<string, unknown>;
}

/** Structured handoff package between agents. */
export interface HandoffPackage {
  project: string;
  from_agent: string;
  to_agent: string;
  generated_at: string;
  project_map: ProjectMap | null;
  recent_sessions: SessionLog[];
  active_tasks: Task[];
  pending_tasks: Task[];
  active_agents: AgentPresenceView[];
  relevant_memories: ScoredMemory[];
  blockers: string[];
  notes: string;
}

// ============================================================================
// Context Intelligence Types
// ============================================================================

export type TaskOutcome = "success" | "partial" | "failure";

/** Task-level feedback: captures outcomes and lessons from completed tasks. */
export interface TaskFeedback {
  id: number;
  uid: string;
  task_uid: string | null;
  project: string | null;
  agent: string | null;
  outcome: TaskOutcome;
  what_worked: string | null;
  what_failed: string | null;
  lessons: string | null;
  duration_min: number | null;
  created_at: string;
}

export interface TaskFeedbackInput {
  task_uid?: string;
  project?: string;
  agent?: string;
  outcome: TaskOutcome;
  what_worked?: string;
  what_failed?: string;
  lessons?: string;
  duration_min?: number;
}

/** Memory hygiene report. */
export interface HygieneReport {
  duplicates: { memory_id: number; title: string; similar_to: number; distance: number }[];
  stale: { memory_id: number; title: string; last_accessed: string | null; importance: number }[];
  contradictions: { from_id: number; from_title: string; to_id: number; to_title: string }[];
  orphan_relations: number;
  total_memories: number;
  generated_at: string;
}

/** Cross-project knowledge suggestion. */
export interface KnowledgeTransferSuggestion {
  memory_uid: string;
  title: string;
  source_project: string;
  target_project: string;
  relevance_score: number;
  reason: string;
}

// ============================================================================
// Extensibility Types
// ============================================================================

/** Webhook registration for outbound HTTP callbacks. */
export interface Webhook {
  id: number;
  uid: string;
  url: string;
  events: string[];
  secret: string | null;
  active: boolean;
  last_triggered_at: string | null;
  last_status: number | null;
  fail_count: number;
  created_at: string;
}

export interface WebhookInput {
  url: string;
  events?: string[];
  secret?: string;
}

export type JobKind = "embed" | "compact" | "hygiene" | "webhook" | "webhook_test" | "sync" | "reindex" | "distill" | "custom";
export type JobStatus = "queued" | "running" | "done" | "failed";

/** SQLite-backed job queue item. */
export interface Job {
  id: number;
  uid: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  last_error: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

/** Hub event types for the event bus. */
export type HubEventType =
  | "memory_saved"
  | "memory_updated"
  | "memory_deleted"
  | "task_created"
  | "task_updated"
  | "task_completed"
  | "task_cancelled"
  | "task_claimed"
  | "session_logged"
  | "agent_checkin"
  | "agent_checkout"
  | "agent_registered"
  | "document_added"
  | "document_updated"
  | "project_updated"
  | "message_sent"
  | "webhook_triggered"
  | "job_completed"
  | "job_failed"
  | "feedback_recorded";

export interface HubEvent {
  id?: number;
  type: HubEventType;
  payload: Record<string, unknown>;
  created_at?: string;
}

/** Prometheus-compatible metrics snapshot. */
export interface MetricsSnapshot {
  uptime_sec: number;
  requests_total: number;
  errors_5xx: number;
  errors_4xx: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  latency_p99_ms: number;
  embedding_calls: number;
  memory_count: number;
  document_count: number;
  task_count: number;
  active_tasks: number;
  agent_count: number;
  jobs: { queued: number; running: number; done: number; failed: number };
  coordination: CoordinationMetrics;
}

/**
 * Agent koordinasyon-yükü sinyalleri (son 7 gün penceresi).
 * Tüm değerler tek SQL turunda, ucuz bir sorguyla üretilir; getMetricsSnapshot
 * sıcak yolda çağrılır — 5 ms altı kalmalı.
 *
 * Tanımlar:
 * - tasks_completed_7d: Son 7 günde done olan görev sayısı.
 * - avg_task_cycle_time_min: claim→finish ortalaması (dakika); claimed_at null olanlar hariç.
 * - handoff_ratio: handoff mesaj sayısı / tamamlanan görev sayısı (yüksek = iş devirde boğuluyor).
 * - reclaim_count_7d: aynı göreve ikinci ve sonraki claim'lerin toplam sayısı
 *   (agent düşmüş / iş dönüp durmuş sinyali). hub_events'teki task_claimed
 *   olaylarından: (toplam claim olayı) − (unique claim edilen task sayısı).
 * - verification_coverage: doğrulama kanıtı (kind != "none") verilen tamamlanan görev oranı.
 */
export interface CoordinationMetrics {
  tasks_completed_7d: number;
  avg_task_cycle_time_min: number;
  handoff_ratio: number;
  reclaim_count_7d: number;
  verification_coverage: number;
}
