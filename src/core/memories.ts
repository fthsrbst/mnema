import { getDb, hasVec } from "./db.js";
import { embedOne, toBuffer } from "./embeddings.js";
import { hybridSearch } from "./search.js";
import type { Memory, MemoryInput, ScoredMemory, SearchFilters } from "./types.js";

function rowToMemory(row: Record<string, unknown>): Memory {
  return { ...(row as unknown as Memory), tags: JSON.parse((row.tags as string) ?? "[]") };
}

async function upsertVector(id: number, title: string, body: string): Promise<void> {
  if (!hasVec()) return;
  try {
    const vec = await embedOne(`${title}\n${body}`, "RETRIEVAL_DOCUMENT");
    if (!vec) return;
    const db = getDb();
    db.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(id);
    db.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)").run(id, toBuffer(vec));
  } catch (err) {
    console.error(`[hub] memory #${id} embed edilemedi (FTS'te aranabilir): ${(err as Error).message}`);
  }
}

export async function saveMemory(input: MemoryInput): Promise<Memory> {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO memories(type, title, body, project, tags, source)
       VALUES (@type, @title, @body, @project, @tags, @source)`
    )
    .run({
      type: input.type ?? "fact",
      title: input.title,
      body: input.body,
      project: input.project ?? null,
      tags: JSON.stringify(input.tags ?? []),
      source: input.source ?? null,
    });
  const id = Number(info.lastInsertRowid);
  await upsertVector(id, input.title, input.body);
  return getMemory(id)!;
}

export function getMemory(id: number): Memory | null {
  const row = getDb().prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToMemory(row) : null;
}

export async function updateMemory(id: number, patch: Partial<MemoryInput>): Promise<Memory | null> {
  const existing = getMemory(id);
  if (!existing) return null;
  const merged = {
    type: patch.type ?? existing.type,
    title: patch.title ?? existing.title,
    body: patch.body ?? existing.body,
    project: patch.project === undefined ? existing.project : patch.project,
    tags: JSON.stringify(patch.tags ?? existing.tags),
    id,
  };
  getDb()
    .prepare(
      `UPDATE memories SET type=@type, title=@title, body=@body, project=@project,
       tags=@tags, updated_at=datetime('now') WHERE id=@id`
    )
    .run(merged);
  if (patch.title !== undefined || patch.body !== undefined) {
    await upsertVector(id, merged.title, merged.body);
  }
  return getMemory(id);
}

export function deleteMemory(id: number): boolean {
  const db = getDb();
  if (hasVec()) db.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(id);
  return db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
}

export async function searchMemories(query: string, filters: SearchFilters = {}): Promise<ScoredMemory[]> {
  const ranked = await hybridSearch("memories_fts", "memories_vec", query);
  if (ranked.length === 0) return [];
  const limit = filters.limit ?? 8;
  const out: ScoredMemory[] = [];
  for (const { id, score } of ranked) {
    const mem = getMemory(id);
    if (!mem) continue;
    if (filters.type && mem.type !== filters.type) continue;
    if (filters.project && mem.project !== filters.project) continue;
    if (filters.tag && !mem.tags.includes(filters.tag)) continue;
    out.push({ ...mem, score });
    if (out.length >= limit) break;
  }
  return out;
}

export function listMemories(filters: SearchFilters = {}): Memory[] {
  const conds: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.type) (conds.push("type = @type"), (params.type = filters.type));
  if (filters.project) (conds.push("project = @project"), (params.project = filters.project));
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT @limit`)
    .all({ ...params, limit: filters.limit ?? 50 }) as Record<string, unknown>[];
  return rows.map(rowToMemory);
}
