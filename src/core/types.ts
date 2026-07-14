export type MemoryType = "fact" | "preference" | "decision" | "howto" | "context";

export interface Memory {
  id: number;
  type: MemoryType;
  title: string;
  body: string;
  project: string | null;
  tags: string[];
  source: string | null;
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

/** Agent'lardan gelen recall kalite geri bildirimi — eşik kalibrasyonu verisi (cihaz-yerel). */
export interface RecallFeedback {
  id: number;
  query: string;
  verdict: FeedbackVerdict;
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
}

export interface ScoredChunk {
  chunk_id: number;
  document_id: number;
  document_title: string;
  uri: string | null;
  project: string | null;
  heading: string | null;
  text: string;
  score: number;
  /** Hangi arama kanalları buldu ("fts"/"vec"). Recall'un anlamsal kanıt kapısı kullanır. */
  channels?: ("fts" | "vec")[];
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
}
