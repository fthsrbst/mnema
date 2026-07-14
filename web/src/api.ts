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

/**
 * /outputs gibi auth arkasındaki statik dosyalar için URL üretir: <img>/<video>
 * etiketleri Authorization header gönderemediğinden token query param ile taşınır
 * (sunucu ?token= kabul eder).
 */
export function assetUrl(url: string): string {
  const token = getToken();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
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

export interface ProjectModule {
  name: string;
  path: string;
  purpose: string;
  key_files?: string[];
  depends_on?: string[];
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
  notes?: string;
  updated_at?: string;
  // --- kod haritası alanları (opsiyonel — backend'de henüz doldurulmamış olabilir) ---
  architecture?: string;
  modules?: ProjectModule[];
  entry_points?: Record<string, string>;
  commands?: Record<string, string>;
  conventions?: string[];
  data_model?: string;
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
  lmstudio_port: number | null;
  ollama_port: number | null;
  comfyui_port: number | null;
  notes: string | null;
  lmstudio: { online: boolean; models: string[] };
  ollama: { online: boolean; models: string[] };
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

export interface TimelineItem {
  kind: "memory" | "session" | "document";
  id: number;
  title: string;
  subtype: string | null;
  project: string | null;
  date: string;
}

export interface GrowthStats {
  days: number;
  daily: { day: string; memories: number; sessions: number; documents: number }[];
  totals: { memories: number; sessions: number; documents: number; chunks: number };
}

export interface HealthStatus {
  ok: boolean;
  vec: boolean;
  embeddings: boolean;
  version: string;
}

// --- usage istatistikleri ---

export interface UsageItem {
  id: number;
  title: string;
  type: string;
  project: string | null;
  access_count: number;
  last_accessed: string;
  importance: number;
}

export interface UsageStats {
  top: UsageItem[];
  stale: UsageItem[];
  stale_count: number;
  total: number;
}

// --- graph (ilişki grafiği) ---

export type GraphNodeKind = "project" | "memory" | "document" | "session" | "tag";

export type GraphRel = "related" | "belongs" | "tagged" | "logged";

export interface GraphNode {
  /** "<kind>:<key>" — memory/document/session için sayısal id, project/tag için ad. */
  id: string;
  kind: GraphNodeKind;
  label: string;
  sublabel?: string;
  project?: string | null;
  /** Toplam komşu sayısı — genişletme rozeti bundan. */
  degree: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: GraphRel;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Sayfalama: bu genişletmede dönmeyen kalan komşu sayısı. */
  more: number;
}

/** "kind:key" düğüm kimliğini parçalar (key içinde ":" olabilir — ilk ayraç esas alınır). */
export function parseGraphId(id: string): { kind: GraphNodeKind; key: string } {
  const i = id.indexOf(":");
  return { kind: id.slice(0, i) as GraphNodeKind, key: id.slice(i + 1) };
}

export function fetchGraphSeed(tags = 24): Promise<GraphPayload> {
  return api("GET", `/api/graph/seed?tags=${tags}`);
}

export function fetchGraphNeighbors(kind: GraphNodeKind, key: string, offset = 0, limit = 30): Promise<GraphPayload> {
  return api(
    "GET",
    `/api/graph/neighbors?kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}&offset=${offset}&limit=${limit}`
  );
}

export function fetchGraphNode(kind: GraphNodeKind, key: string): Promise<GraphNode> {
  return api("GET", `/api/graph/node?kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}`);
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
