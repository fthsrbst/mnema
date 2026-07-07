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
}

export interface SearchFilters {
  type?: MemoryType;
  project?: string;
  tag?: string;
  limit?: number;
}

export interface ScoredMemory extends Memory {
  score: number;
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
