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
  created_at: string;
  updated_at: string;
}
