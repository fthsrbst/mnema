import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import { recordDeletion } from "./sync.js";
import type { ProjectMap } from "./types.js";
import { config } from "./config.js";
import { projectMapSchema } from "./schemas.js";
import { projectNameSchema } from "./schemas.js";
import { vectorStore } from "./vector-store.js";

const RESERVED_PROJECT_NAMES = new Set(["global", "learning"]);

export function isKnownProjectName(name: string): boolean {
  return RESERVED_PROJECT_NAMES.has(name) || getProject(name) !== null;
}

export function assertProjectReference(project: string | null | undefined, entity: string): void {
  if (!project || isKnownProjectName(project)) return;
  if (config.strictProjects) {
    throw new Error(`${entity} references unknown project '${project}'; create it with project_update first`);
  }
}

export function upsertProject(map: ProjectMap): ProjectMap {
  if (!map.name) throw new Error("Proje adı (name) zorunlu");
  const candidate = { ...map };
  delete candidate.updated_at;
  map = projectMapSchema.parse(candidate) as ProjectMap;
  const db = getDb();
  const existing = getProject(map.name);
  const merged: ProjectMap = { ...(existing ?? {}), ...map, name: map.name };
  delete merged.updated_at;
  db.prepare(
    `INSERT INTO projects(name, data, updated_at) VALUES (@name, @data, ${NOW_MS})
     ON CONFLICT(name) DO UPDATE SET data=@data, updated_at=${NOW_MS}`
  ).run({ name: map.name, data: JSON.stringify(merged) });
  notifyWrite();
  return getProject(map.name)!;
}

export function getProject(name: string): ProjectMap | null {
  const row = getDb().prepare("SELECT data, updated_at FROM projects WHERE name = ?").get(name) as
    | { data: string; updated_at: string }
    | undefined;
  if (!row) return null;
  return { ...(JSON.parse(row.data) as ProjectMap), updated_at: row.updated_at };
}

export function listProjects(): ProjectMap[] {
  const rows = getDb()
    .prepare("SELECT data, updated_at FROM projects ORDER BY updated_at DESC")
    .all() as { data: string; updated_at: string }[];
  return rows.map((r) => ({ ...(JSON.parse(r.data) as ProjectMap), updated_at: r.updated_at }));
}

export function deleteProject(name: string): boolean {
  const deleted = getDb().prepare("DELETE FROM projects WHERE name = ?").run(name).changes > 0;
  if (deleted) {
    recordDeletion("projects", name);
    notifyWrite();
  }
  return deleted;
}

/**
 * Çalışma dizininden proje adını çözer (hook'lar için). Eşleşme sırası:
 * 1. cwd'nin herhangi bir segmenti proje adına eşit (case-insensitive),
 * 2. proje repo/paths alanlarının son segmenti cwd'nin son segmentine eşit.
 * Bulamazsa null — recall global çalışır, köprü susar.
 */
export function resolveProjectFromPath(cwd: string): string | null {
  if (!cwd) return null;
  const segments = cwd.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
  if (segments.length === 0) return null;
  const base = segments[segments.length - 1];
  let fallback: string | null = null;
  for (const proj of listProjects()) {
    const name = proj.name.toLowerCase();
    if (segments.includes(name)) return proj.name;
    const candidates = [proj.repo, ...Object.values(proj.paths ?? {})].filter(
      (v): v is string => typeof v === "string" && v.length > 0
    );
    for (const c of candidates) {
      const tail = c.split(/[\\/]+/).filter(Boolean).pop()?.replace(/\.git$/, "").toLowerCase();
      if (tail && tail === base) fallback = fallback ?? proj.name;
    }
  }
  return fallback;
}

/** Karar/adım ekleme gibi kısmi güncellemeler için yardımcı. */
export function appendToProject(
  name: string,
  field: "decisions" | "next_steps",
  entry: string
): ProjectMap | null {
  const proj = getProject(name);
  if (!proj) return null;
  const list = Array.isArray(proj[field]) ? (proj[field] as string[]) : [];
  return upsertProject({ ...proj, [field]: [...list, entry] });
}

export interface ProjectReferenceMigrationResult {
  from: string;
  to: string;
  memories: number;
  documents: number;
  sessions: number;
}

/**
 * Atomically rewrites project references and vec partition metadata. This is an
 * administrative data migration, not a project-map rename/delete operation.
 */
export function migrateProjectReferences(fromRaw: string, toRaw: string): ProjectReferenceMigrationResult {
  const from = projectNameSchema.parse(fromRaw);
  const to = projectNameSchema.parse(toRaw);
  if (from === to) return { from, to, memories: 0, documents: 0, sessions: 0 };
  if (!isKnownProjectName(to)) throw new Error(`target project '${to}' has no canonical project map`);
  const db = getDb();
  const memoryVectors = vectorStore.available()
    ? (db.prepare("SELECT id FROM memories WHERE project = ?").all(from) as { id: number }[])
        .map((row) => ({ ...row, embedding: vectorStore.get("memory", row.id) }))
        .filter((row): row is { id: number; embedding: Buffer } => Boolean(row.embedding))
    : [];
  const chunkVectors = vectorStore.available()
    ? (db
        .prepare(
          `SELECT c.id, d.enabled, d.is_current, d.kind
           FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.project = ?`
        )
        .all(from) as { id: number; enabled: number; is_current: number; kind: string }[])
        .map((row) => ({ ...row, embedding: vectorStore.get("chunk", row.id) }))
        .filter((row): row is { id: number; enabled: number; is_current: number; kind: string; embedding: Buffer } => Boolean(row.embedding))
    : [];

  const result = db.transaction(() => {
    const memories = db
      .prepare(`UPDATE memories SET project = ?, updated_at = ${NOW_MS} WHERE project = ?`)
      .run(to, from).changes;
    const documents = db
      .prepare(`UPDATE documents SET project = ?, updated_at = ${NOW_MS} WHERE project = ?`)
      .run(to, from).changes;
    const sessions = db
      .prepare(`UPDATE session_logs SET project = ?, updated_at = ${NOW_MS} WHERE project = ?`)
      .run(to, from).changes;
    for (const row of memoryVectors) vectorStore.putMemory(row.id, to, row.embedding);
    for (const row of chunkVectors) vectorStore.putChunk(row.id, to, row.enabled, row.is_current, row.kind, row.embedding);
    return { from, to, memories, documents, sessions };
  })();
  if (result.memories + result.documents + result.sessions > 0) notifyWrite();
  return result;
}
