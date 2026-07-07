// Hub REST istemcisi — aynı origin'den servis edilir; token localStorage'da tutulur.

export function getToken(): string {
  return localStorage.getItem("hub_token") ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem("hub_token", token);
}

export function clearToken(): void {
  localStorage.removeItem("hub_token");
}

/** 401 yanıtı alındığında App.tsx bu callback'i kurar; kullanıcıyı token ekranına yönlendirir. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

export async function api<T = unknown>(method: string, route: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    onUnauthorized?.();
    throw new Error("Yetkisiz — token gerekli veya geçersiz.");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface Memory {
  id: number;
  type: string;
  title: string;
  body: string;
  project: string | null;
  tags: string[];
  source: string | null;
  updated_at: string;
  score?: number;
}

export interface ProjectMap {
  name: string;
  status?: string;
  summary?: string;
  stack?: string[];
  repo?: string;
  current_focus?: string;
  decisions?: string[];
  next_steps?: string[];
  updated_at?: string;
}

export interface SessionLog {
  id: number;
  project: string | null;
  summary: string;
  source: string | null;
  created_at: string;
}

export interface MachineStatus {
  name: string;
  host: string;
  lmstudio: { online: boolean; models: string[] };
  comfyui: { online: boolean };
}

export interface Skill {
  name: string;
  description: string;
  content: string;
}

export interface OutputFile {
  name: string;
  url: string;
  size: number;
  mtime: number;
}

// --- RAG / admin ---

export interface RagStats {
  db_path: string;
  db_size_bytes: number;
  vec_available: boolean;
  embeddings_enabled: boolean;
  embedding_model: string;
  embedding_dim: number;
  vec_max_distance: number;
  documents: { total: number; enabled: number; disabled: number };
  chunks: { total: number; embedded: number };
  memories: { total: number; embedded: number };
  sync: { primary_url: string; peers: { peer: string; last_pull: string | null; last_push: string | null }[] };
}

export interface ReindexResult {
  ok: boolean;
  chunks_embedded: number;
  memories_embedded: number;
  error?: string;
}

export interface RagDocument {
  id: number;
  title: string;
  uri: string | null;
  project: string | null;
  enabled: boolean;
  created_at: string;
  chunk_count: number;
  vec_count: number;
}

export interface RagChunk {
  id: number;
  seq: number;
  heading: string | null;
  text: string;
}

export interface RagDocumentDetail extends RagDocument {
  source: string | null;
  chunks: RagChunk[];
}

export interface RagSearchResult {
  chunk_id: number;
  document_id: number;
  heading: string | null;
  text: string;
  document_title: string;
  uri: string | null;
  project: string | null;
  score?: number;
}

export interface HealthStatus {
  ok: boolean;
  vec: boolean;
  embeddings: boolean;
  version: string;
}

// --- prompts ---

export interface PromptInfo {
  name: string;
  description: string;
}

export interface PromptList {
  master: PromptInfo | null;
  roles: PromptInfo[];
}

export interface PromptContent {
  name: string;
  content: string;
}
