import { getDb } from "./db.js";
import type { ProjectMap } from "./types.js";

export function upsertProject(map: ProjectMap): ProjectMap {
  if (!map.name) throw new Error("Proje adı (name) zorunlu");
  const db = getDb();
  const existing = getProject(map.name);
  const merged: ProjectMap = { ...(existing ?? {}), ...map, name: map.name };
  delete merged.updated_at;
  db.prepare(
    `INSERT INTO projects(name, data, updated_at) VALUES (@name, @data, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET data=@data, updated_at=datetime('now')`
  ).run({ name: map.name, data: JSON.stringify(merged) });
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
  return getDb().prepare("DELETE FROM projects WHERE name = ?").run(name).changes > 0;
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
