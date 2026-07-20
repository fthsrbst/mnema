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

export interface ProfessionalProfileDocument {
  id: number;
  uid: string;
  title: string;
  uri: string;
  source: string | null;
  language: string | null;
  updated_at: string;
  markdown: string;
}

export interface ProfessionalProfileSource {
  id: number;
  uid: string;
  title: string;
  uri: string | null;
  language: string | null;
  updated_at: string;
}

export interface ProfessionalProfileBundle {
  canonical: ProfessionalProfileDocument | null;
  sources: ProfessionalProfileSource[];
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

// --- agent presence ("Agents" görünümü) ---

export type AgentPresenceStatus = "active" | "done" | "abandoned";

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
  /** heartbeat_at, HUB_PRESENCE_TTL_MIN'den eski ise true — koordinasyon kilidi değil, sadece uyarı. */
  stale: boolean;
}

export function fetchActiveAgents(project?: string): Promise<AgentPresence[]> {
  return api("GET", `/api/agents/active${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchRecentAgents(hours = 24): Promise<AgentPresence[]> {
  return api("GET", `/api/agents/recent?hours=${hours}`);
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
  kind?: string;
  updated_at?: string;
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

// --- Agent Intelligence Platform ---

export interface Task {
  id: number;
  uid: string;
  project: string | null;
  title: string;
  description: string | null;
  status: "pending" | "claimed" | "in_progress" | "blocked" | "done" | "cancelled";
  priority: number;
  created_by: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  depends_on: string[];
  tags: string[];
  result: string | null;
  error: string | null;
  due_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentCapability {
  id: number;
  uid: string;
  agent: string;
  machine: string | null;
  capabilities: string[];
  models: string[];
  max_concurrent: number;
  status: "available" | "busy" | "offline";
  last_seen_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AgentMessage {
  id: number;
  uid: string;
  from_agent: string;
  to_agent: string | null;
  project: string | null;
  task_uid: string | null;
  kind: "info" | "request" | "response" | "handoff" | "alert";
  subject: string;
  body: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface Webhook {
  id: number;
  uid: string;
  url: string;
  events: string[];
  active: boolean;
  last_triggered_at: string | null;
  last_status: number | null;
  fail_count: number;
  created_at: string;
}

export interface Job {
  id: number;
  uid: string;
  kind: string;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  last_error: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface HubEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface MetricsOverview {
  uptime_sec: number;
  requests_total: number;
  errors_5xx: number;
  errors_4xx: number;
  embedding_calls: number;
  memory_count: number;
  task_count: number;
  agent_count: number;
  jobs: { queued: number; running: number; done: number; failed: number };
}

export interface HygieneReport {
  duplicates: { count: number; items: { id: number; title: string }[] };
  stale: { count: number; items: { memory_id: number; title: string; days_idle: number }[] };
  contradictions: { count: number; items: { id: number; title: string }[] };
  suggestions: string[];
}

// --- API functions for Agent Intelligence ---

export function fetchTasks(project?: string, status?: string, claimedBy?: string): Promise<Task[]> {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (status) params.set("status", status);
  if (claimedBy) params.set("claimed_by", claimedBy);
  const qs = params.toString();
  return api("GET", `/api/tasks${qs ? `?${qs}` : ""}`);
}

export function createTask(input: { title: string; description?: string; project?: string; priority?: number; tags?: string[]; created_by?: string }): Promise<Task> {
  return api("POST", "/api/tasks", input);
}

export function claimTask(uid: string, agent: string): Promise<Task> {
  return api("POST", `/api/tasks/${uid}/claim`, { agent });
}

export function completeTask(uid: string, result?: string): Promise<Task> {
  return api("POST", `/api/tasks/${uid}/complete`, { result });
}

export function cancelTask(uid: string, error?: string): Promise<Task> {
  return api("POST", `/api/tasks/${uid}/cancel`, { error });
}

export function fetchRegisteredAgents(): Promise<AgentCapability[]> {
  return api("GET", "/api/agents");
}

export function registerAgent(input: {
  agent: string;
  machine?: string;
  capabilities?: string[];
  models?: string[];
  max_concurrent?: number;
  status?: "available" | "busy" | "offline";
  metadata?: Record<string, unknown>;
}): Promise<AgentCapability> {
  return api("POST", "/api/agents/register", input);
}

export function agentHeartbeat(uid: string, status?: "available" | "busy" | "offline"): Promise<AgentCapability> {
  return api("POST", `/api/agents/${uid}/heartbeat`, status ? { status } : {});
}

export function findCapableAgents(capability: string): Promise<AgentCapability[]> {
  return api("GET", `/api/agents/find?capability=${encodeURIComponent(capability)}`);
}

export function fetchAgentMessages(agent: string, includeRead = true): Promise<AgentMessage[]> {
  return api("GET", `/api/messages/inbox?agent=${encodeURIComponent(agent)}&include_read=${includeRead ? "1" : "0"}`);
}

export function fetchSentMessages(agent: string): Promise<AgentMessage[]> {
  return api("GET", `/api/messages/sent?agent=${encodeURIComponent(agent)}`);
}

export function fetchRecentMessages(limit = 50): Promise<AgentMessage[]> {
  return api("GET", `/api/messages/recent?limit=${limit}`);
}

export function sendAgentMessage(input: {
  from_agent: string;
  to_agent?: string;
  project?: string;
  kind?: "info" | "request" | "response" | "handoff" | "alert";
  subject: string;
  body: string;
}): Promise<AgentMessage> {
  return api("POST", "/api/messages", input);
}

export function markMessageRead(uid: string): Promise<AgentMessage> {
  return api("POST", `/api/messages/${uid}/read`);
}

export function fetchWebhooks(): Promise<Webhook[]> {
  return api("GET", "/api/webhooks");
}

export function registerWebhook(input: { url: string; events?: string[]; secret?: string }): Promise<Webhook> {
  return api("POST", "/api/webhooks", input);
}

export function removeWebhook(uid: string): Promise<{ deleted: boolean }> {
  return api("DELETE", `/api/webhooks/${uid}`);
}

export function fetchJobs(status?: string): Promise<Job[]> {
  const qs = status ? `?status=${status}` : "";
  return api("GET", `/api/jobs${qs}`);
}

export function fetchJobStats(): Promise<{ queued: number; running: number; done: number; failed: number }> {
  return api("GET", "/api/jobs/stats");
}

export function fetchMetricsOverview(): Promise<MetricsOverview> {
  return api("GET", "/api/stats/overview");
}

export function fetchEvents(limit = 50): Promise<HubEvent[]> {
  return api("GET", `/api/events?limit=${limit}`);
}

export function fetchHygieneReport(): Promise<HygieneReport> {
  return api("GET", "/api/hygiene");
}

export function runHygiene(): Promise<{ archived: number; consolidated: number }> {
  return api("POST", "/api/hygiene/run");
}
