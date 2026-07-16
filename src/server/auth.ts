import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config, getDocument, getMemory, getMemoryRelation, getSessionLog } from "../core/index.js";

export const hubScopeSchema = z.enum([
  "context:read",
  "knowledge:read",
  "knowledge:write",
  "project:read",
  "project:write",
  "session:read",
  "session:write",
  "compute:execute",
  "sync:read",
  "sync:write",
  "admin:read",
  "admin:write",
]);
export type HubScope = z.infer<typeof hubScopeSchema>;

const tokenPolicySchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    token: z.string().min(24).max(1024),
    scopes: z.array(hubScopeSchema).min(1),
    projects: z.array(z.string().min(1).max(100)).min(1).default(["*"]),
  })
  .strict();

interface TokenPolicy extends z.infer<typeof tokenPolicySchema> {}

export interface Principal {
  id: string;
  scopes: HubScope[];
  projects: string[];
  auth_mode: "scoped_token" | "legacy_admin" | "local_dev";
}

function loadPolicies(): TokenPolicy[] {
  const raw = process.env.HUB_AUTH_TOKENS?.trim();
  if (!raw) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("HUB_AUTH_TOKENS must be a JSON array");
  }
  const policies = z.array(tokenPolicySchema).max(1000).parse(json);
  const ids = new Set<string>();
  for (const policy of policies) {
    if (ids.has(policy.id)) throw new Error(`duplicate HUB_AUTH_TOKENS id: ${policy.id}`);
    ids.add(policy.id);
  }
  return policies;
}

const tokenPolicies = loadPolicies();

export function authenticationEnabled(): boolean {
  return tokenPolicies.length > 0 || (config.allowLegacyAdmin && config.token.length > 0);
}

function constantTimeTokenEqual(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authenticate(candidate: string | null): Principal | null {
  if (!authenticationEnabled()) {
    return { id: "local-dev", scopes: ["admin:write"], projects: ["*"], auth_mode: "local_dev" };
  }
  if (!candidate) return null;
  for (const policy of tokenPolicies) {
    if (constantTimeTokenEqual(candidate, policy.token)) {
      return { id: policy.id, scopes: policy.scopes, projects: policy.projects, auth_mode: "scoped_token" };
    }
  }
  if (config.allowLegacyAdmin && config.token && constantTimeTokenEqual(candidate, config.token)) {
    return { id: "legacy-admin", scopes: ["admin:write"], projects: ["*"], auth_mode: "legacy_admin" };
  }
  return null;
}

export function hasScope(principal: Principal, required: HubScope): boolean {
  const scopes = new Set(principal.scopes);
  if (scopes.has("admin:write") || scopes.has(required)) return true;
  if (scopes.has("admin:read") && required.endsWith(":read")) return true;
  if (required === "knowledge:read" && scopes.has("knowledge:write")) return true;
  if (required === "project:read" && scopes.has("project:write")) return true;
  if (required === "session:read" && scopes.has("session:write")) return true;
  if (required === "sync:read" && scopes.has("sync:write")) return true;
  return false;
}

export function hasProjectAccess(principal: Principal, project: string | null | undefined): boolean {
  if (principal.projects.includes("*")) return true;
  if (!project) return principal.projects.includes("global");
  return principal.projects.includes(project);
}

const MCP_SCOPES: Record<string, HubScope> = {
  context_get: "context:read",
  recall: "context:read",
  prompt_list: "context:read",
  prompt_get: "context:read",
  memory_search: "knowledge:read",
  memory_save: "knowledge:write",
  memory_update: "knowledge:write",
  memory_delete: "knowledge:write",
  memory_consolidate: "knowledge:write",
  memory_relation_add: "knowledge:write",
  memory_relation_list: "knowledge:read",
  memory_relation_update: "knowledge:write",
  memory_relation_delete: "knowledge:write",
  recall_feedback: "knowledge:write",
  rag_search: "knowledge:read",
  rag_add: "knowledge:write",
  project_list: "project:read",
  project_get: "project:read",
  project_update: "project:write",
  project_add_decision: "project:write",
  project_delete: "project:write",
  project_migrate_references: "admin:write",
  project_detach_references: "admin:write",
  profile_get: "knowledge:read",
  profile_update: "knowledge:write",
  session_recent: "session:read",
  session_log: "session:write",
  machine_status: "compute:execute",
  machine_register: "admin:write",
  local_llm: "compute:execute",
  workflow_list: "compute:execute",
  media_generate: "compute:execute",
  skill_list: "admin:read",
  skill_save: "admin:write",
  integrity_check: "admin:read",
  audit_list: "admin:read",
  audit_verify: "admin:read",
  vector_projection_status: "admin:read",
  vector_projection_verify: "admin:read",
  vector_projection_rebuild: "admin:write",
  vector_projection_flush: "admin:write",
  graph_neighbors: "knowledge:read",
  graph_node: "knowledge:read",
};

interface McpCall {
  name: string;
  args: Record<string, unknown>;
}

function mcpCalls(body: unknown): McpCall[] {
  const messages = Array.isArray(body) ? body : [body];
  const calls: McpCall[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { method?: unknown; params?: unknown };
    if (record.method !== "tools/call" || !record.params || typeof record.params !== "object") continue;
    const params = record.params as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== "string") continue;
    calls.push({
      name: params.name,
      args: params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {},
    });
  }
  return calls;
}

function callProject(call: McpCall): string | null | undefined {
  if (typeof call.args.project === "string") return call.args.project;
  if (call.name.startsWith("project_") && typeof call.args.name === "string") return call.args.name;
  if (["memory_update", "memory_delete"].includes(call.name) && typeof call.args.id === "number") {
    return getMemory(call.args.id)?.project;
  }
  if (call.name === "memory_consolidate" && typeof call.args.target_id === "number") {
    return getMemory(call.args.target_id)?.project;
  }
  if (call.name === "memory_relation_add" && typeof call.args.from_id === "number") {
    return getMemory(call.args.from_id)?.project;
  }
  if (call.name === "memory_relation_list" && typeof call.args.memory_id === "number") {
    return getMemory(call.args.memory_id)?.project;
  }
  if (["memory_relation_update", "memory_relation_delete"].includes(call.name) && typeof call.args.id === "string") {
    const relation = getMemoryRelation(call.args.id);
    return relation ? getMemory(relation.from_id)?.project : undefined;
  }
  if (["graph_node", "graph_neighbors"].includes(call.name) && typeof call.args.kind === "string" && typeof call.args.key === "string") {
    if (call.args.kind === "project") return call.args.key;
    if (call.args.kind === "memory") return getMemory(Number(call.args.key))?.project;
    if (call.args.kind === "document") return getDocument(Number(call.args.key))?.project;
    if (call.args.kind === "session") return getSessionLog(Number(call.args.key))?.project;
    return undefined;
  }
  return undefined;
}

const PROJECT_SENSITIVE_TOOLS = new Set([
  "context_get",
  "recall",
  "memory_search",
  "memory_save",
  "memory_consolidate",
  "memory_relation_add",
  "memory_relation_list",
  "memory_relation_update",
  "memory_relation_delete",
  "graph_node",
  "graph_neighbors",
  "rag_search",
  "rag_add",
  "session_recent",
  "session_log",
]);

export function authorizeMcp(principal: Principal, body: unknown): { ok: true } | { ok: false; reason: string } {
  for (const call of mcpCalls(body)) {
    const required = MCP_SCOPES[call.name] ?? "admin:write";
    if (!hasScope(principal, required)) return { ok: false, reason: `missing scope ${required}` };
    const project = callProject(call);
    if (!principal.projects.includes("*") && PROJECT_SENSITIVE_TOOLS.has(call.name) && project === undefined) {
      return { ok: false, reason: `tool ${call.name} requires an explicit project for this principal` };
    }
    if (project !== undefined && !hasProjectAccess(principal, project)) {
      return { ok: false, reason: `project access denied` };
    }
  }
  return { ok: true };
}

export function restScope(method: string, path: string): HubScope {
  if (path.startsWith("/recall/feedback")) return method === "GET" ? "knowledge:read" : "knowledge:write";
  if (path === "/context" || path.startsWith("/recall") || path === "/bridge") return "context:read";
  if (path.startsWith("/memory")) return method === "GET" ? "knowledge:read" : "knowledge:write";
  if (path === "/timeline" || path.startsWith("/stats/")) return "knowledge:read";
  if (path.startsWith("/rag/reindex")) return "admin:write";
  if (path.startsWith("/rag")) return method === "GET" ? "knowledge:read" : "knowledge:write";
  if (path === "/profile") return method === "GET" ? "knowledge:read" : "knowledge:write";
  if (path === "/projects/migrate-references") return "admin:write";
  if (/^\/projects\/[^/]+\/detach-references$/.test(path)) return "admin:write";
  if (path.startsWith("/projects")) return method === "GET" ? "project:read" : "project:write";
  if (path.startsWith("/graph")) return "knowledge:read";
  if (path.startsWith("/sessions")) return method === "GET" ? "session:read" : "session:write";
  if (path.startsWith("/machines") || path === "/llm" || path.startsWith("/workflow") || path === "/image" || path === "/media")
    return method === "GET" || path === "/llm" || path === "/image" || path === "/media" ? "compute:execute" : "admin:write";
  if (path.startsWith("/sync")) return method === "GET" ? "sync:read" : "sync:write";
  if (path === "/outputs") return "knowledge:read";
  if (path === "/integrity") return "admin:read";
  if (path === "/vector-projection" || path === "/vector-projection/verify") return "admin:read";
  if (path.startsWith("/vector-projection/")) return "admin:write";
  if (path.startsWith("/audit")) return "admin:read";
  if (path.startsWith("/skills") || path.startsWith("/prompts")) return method === "GET" ? "admin:read" : "admin:write";
  return "admin:write";
}

export function requestProject(req: { body?: unknown; query?: unknown; path?: string }): string | null | undefined {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const query = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
  if (typeof body.project === "string") return body.project;
  if (typeof query.project === "string") return query.project;
  if (req.path === "/memory/consolidate" && typeof body.target_id === "number") {
    return getMemory(body.target_id)?.project;
  }
  const match = req.path?.match(/^\/projects\/([^/]+)/);
  if (match) return decodeURIComponent(match[1]);
  const memoryMatch = req.path?.match(/^\/memory\/(\d+)/);
  if (memoryMatch) return getMemory(Number(memoryMatch[1]))?.project;
  if (req.path === "/memory-relations" && typeof body.from_id === "number") {
    return getMemory(body.from_id)?.project;
  }
  if (req.path === "/memory-relations" && typeof query.memory_id === "string") {
    return getMemory(Number(query.memory_id))?.project;
  }
  const relationMatch = req.path?.match(/^\/memory-relations\/([a-f0-9]{32})/i);
  if (relationMatch) {
    const relation = getMemoryRelation(relationMatch[1]);
    return relation ? getMemory(relation.from_id)?.project : undefined;
  }
  const documentMatch = req.path?.match(/^\/rag\/documents\/(\d+)/);
  if (documentMatch) return getDocument(Number(documentMatch[1]))?.project;
  const sessionMatch = req.path?.match(/^\/sessions\/(\d+)/);
  if (sessionMatch) return getSessionLog(Number(sessionMatch[1]))?.project;
  if (req.path?.startsWith("/graph") && typeof query.kind === "string" && typeof query.key === "string") {
    if (query.kind === "project") return query.key;
    if (query.kind === "memory") return getMemory(Number(query.key))?.project;
    if (query.kind === "document") return getDocument(Number(query.key))?.project;
    if (query.kind === "session") return getSessionLog(Number(query.key))?.project;
  }
  return undefined;
}

interface Bucket {
  window: number;
  count: number;
}
const buckets = new Map<string, Bucket>();

export function consumeRateLimit(principalId: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
  if (!Number.isFinite(config.rateLimitPerMinute)) throw new Error("HUB_RATE_LIMIT_PER_MINUTE must be a finite number");
  const limit = Math.max(1, Math.trunc(config.rateLimitPerMinute));
  const window = Math.floor(now / 60_000);
  const key = `${principalId}:${window}`;
  const bucket = buckets.get(key) ?? { window, count: 0 };
  bucket.count++;
  buckets.set(key, bucket);
  if (buckets.size > 10_000) {
    for (const [candidate, value] of buckets) if (value.window < window - 1) buckets.delete(candidate);
  }
  return { allowed: bucket.count <= limit, retryAfterSec: 60 - Math.floor((now % 60_000) / 1000) };
}
