import { createHash } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import { memoryRelationInputSchema, memoryRelationPatchSchema } from "./schemas.js";
import { recordDeletion } from "./sync.js";
import type { MemoryRelation, MemoryRelationType } from "./types.js";

interface RelationRow {
  uid: string;
  from_uid: string;
  to_uid: string;
  relation_type: MemoryRelationType;
  confidence: number;
  valid_from: string | null;
  valid_to: string | null;
  source: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  from_id: number;
  from_title: string;
  to_id: number;
  to_title: string;
}

const SELECT_RELATION = `
  SELECT r.*, fm.id AS from_id, fm.title AS from_title,
         tm.id AS to_id, tm.title AS to_title
    FROM memory_relations r
    JOIN memories fm ON fm.uid = r.from_uid
    JOIN memories tm ON tm.uid = r.to_uid`;

function rowToRelation(row: RelationRow): MemoryRelation {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metadata);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch {
    // Integrity checks report malformed metadata; reads remain available.
  }
  return {
    id: row.uid,
    from_id: row.from_id,
    from_uid: row.from_uid,
    from_title: row.from_title,
    to_id: row.to_id,
    to_uid: row.to_uid,
    to_title: row.to_title,
    relation_type: row.relation_type,
    confidence: row.confidence,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    source: row.source,
    metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function relationUid(
  fromUid: string,
  toUid: string,
  relationType: MemoryRelationType,
  validFrom: string | undefined
): string {
  return createHash("sha256")
    .update(["memory-relation-v1", fromUid, relationType, toUid, validFrom ?? ""].join("\0"))
    .digest("hex")
    .slice(0, 32);
}

export function saveMemoryRelation(input: {
  from_id: number;
  to_id: number;
  relation_type: MemoryRelationType;
  confidence?: number;
  valid_from?: string;
  valid_to?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}): MemoryRelation {
  input = memoryRelationInputSchema.parse(input);
  const db = getDb();
  const resolve = db.prepare("SELECT uid, project FROM memories WHERE id = ?");
  const from = resolve.get(input.from_id) as { uid: string; project: string | null } | undefined;
  const to = resolve.get(input.to_id) as { uid: string; project: string | null } | undefined;
  if (!from) throw new Error(`memory #${input.from_id} not found`);
  if (!to) throw new Error(`memory #${input.to_id} not found`);
  if (from.project !== to.project) {
    throw new Error("cross-project memory relations are not allowed; use matching project scope or explicit global memories");
  }
  const uid = relationUid(from.uid, to.uid, input.relation_type, input.valid_from);
  db.prepare(
    `INSERT INTO memory_relations(
       uid, from_uid, to_uid, relation_type, confidence, valid_from, valid_to,
       source, metadata, created_at, updated_at
     ) VALUES (
       @uid, @from_uid, @to_uid, @relation_type, @confidence, @valid_from, @valid_to,
       @source, @metadata, ${NOW_MS}, ${NOW_MS}
     ) ON CONFLICT(uid) DO UPDATE SET
       confidence=excluded.confidence, valid_to=excluded.valid_to,
       source=excluded.source, metadata=excluded.metadata, updated_at=${NOW_MS}`
  ).run({
    uid,
    from_uid: from.uid,
    to_uid: to.uid,
    relation_type: input.relation_type,
    confidence: input.confidence ?? 1,
    valid_from: input.valid_from ?? null,
    valid_to: input.valid_to ?? null,
    source: input.source ?? null,
    metadata: JSON.stringify(input.metadata ?? {}),
  });
  notifyWrite();
  return getMemoryRelation(uid)!;
}

export function getMemoryRelation(uid: string): MemoryRelation | null {
  const row = getDb().prepare(`${SELECT_RELATION} WHERE r.uid = ?`).get(uid) as RelationRow | undefined;
  return row ? rowToRelation(row) : null;
}

export function listMemoryRelations(opts: {
  memory_id?: number;
  relation_type?: MemoryRelationType;
  active_at?: string;
  limit?: number;
} = {}): MemoryRelation[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.memory_id) {
    conditions.push("(fm.id = ? OR tm.id = ?)");
    params.push(opts.memory_id, opts.memory_id);
  }
  if (opts.relation_type) {
    conditions.push("r.relation_type = ?");
    params.push(opts.relation_type);
  }
  if (opts.active_at) {
    conditions.push("(r.valid_from IS NULL OR r.valid_from <= ?)", "(r.valid_to IS NULL OR r.valid_to > ?)");
    params.push(opts.active_at, opts.active_at);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  return (getDb()
    .prepare(`${SELECT_RELATION}${where} ORDER BY r.updated_at DESC LIMIT ?`)
    .all(...params) as RelationRow[]).map(rowToRelation);
}

/**
 * Toplu ilişki sorgusu: birden çok memory için TEK sorguda tüm ilişkileri döner
 * (N+1 önleme — çağıran taraf hangi ilişkinin hangi memory'ye ait olduğunu
 * from_uid/to_uid üzerinden kendisi ayıklar). from_uid/to_uid indeksli olduğundan
 * IN listesi doğrudan indeksi kullanır.
 */
export function listMemoryRelationsForUids(
  uids: string[],
  opts: { active_at?: string; limit?: number } = {}
): MemoryRelation[] {
  if (uids.length === 0) return [];
  const unique = [...new Set(uids)];
  const placeholders = unique.map(() => "?").join(",");
  const conditions: string[] = [`(r.from_uid IN (${placeholders}) OR r.to_uid IN (${placeholders}))`];
  const params: unknown[] = [...unique, ...unique];
  if (opts.active_at) {
    conditions.push("(r.valid_from IS NULL OR r.valid_from <= ?)", "(r.valid_to IS NULL OR r.valid_to > ?)");
    params.push(opts.active_at, opts.active_at);
  }
  const where = ` WHERE ${conditions.join(" AND ")}`;
  params.push(Math.min(Math.max(opts.limit ?? 500, 1), 2000));
  return (getDb()
    .prepare(`${SELECT_RELATION}${where} ORDER BY r.updated_at DESC LIMIT ?`)
    .all(...params) as RelationRow[]).map(rowToRelation);
}

export function updateMemoryRelation(
  uid: string,
  patch: {
    confidence?: number;
    valid_from?: string | null;
    valid_to?: string | null;
    source?: string | null;
    metadata?: Record<string, unknown>;
  }
): MemoryRelation | null {
  patch = memoryRelationPatchSchema.parse(patch);
  const existing = getMemoryRelation(uid);
  if (!existing) return null;
  const validFrom = patch.valid_from === undefined ? existing.valid_from : patch.valid_from;
  const validTo = patch.valid_to === undefined ? existing.valid_to : patch.valid_to;
  if (validFrom && validTo && Date.parse(validTo) < Date.parse(validFrom)) {
    throw new Error("valid_to must not precede valid_from");
  }
  getDb().prepare(
    `UPDATE memory_relations SET confidence=@confidence, valid_from=@valid_from,
       valid_to=@valid_to, source=@source, metadata=@metadata, updated_at=${NOW_MS}
     WHERE uid=@uid`
  ).run({
    uid,
    confidence: patch.confidence ?? existing.confidence,
    valid_from: validFrom,
    valid_to: validTo,
    source: patch.source === undefined ? existing.source : patch.source,
    metadata: JSON.stringify(patch.metadata ?? existing.metadata),
  });
  notifyWrite();
  return getMemoryRelation(uid);
}

export function deleteMemoryRelation(uid: string): boolean {
  const deleted = getDb().prepare("DELETE FROM memory_relations WHERE uid = ?").run(uid).changes > 0;
  if (deleted) {
    recordDeletion("memory_relations", uid);
    notifyWrite();
  }
  return deleted;
}

/** Used by memory deletion so incident edges cannot become dangling. */
export function deleteRelationsForMemoryUid(memoryUid: string): number {
  const db = getDb();
  const rows = db
    .prepare("SELECT uid FROM memory_relations WHERE from_uid = ? OR to_uid = ?")
    .all(memoryUid, memoryUid) as { uid: string }[];
  for (const row of rows) deleteMemoryRelation(row.uid);
  return rows.length;
}

/** Maintain the deprecated memories.related JSON field as a projection into the
 * typed graph. Only projection-owned edges are replaced; explicit typed edges
 * with the same endpoints remain untouched. */
export function replaceLegacyRelatedRelations(memoryId: number, targetUids: string[]): void {
  const db = getDb();
  const from = db.prepare("SELECT uid FROM memories WHERE id = ?").get(memoryId) as { uid: string } | undefined;
  if (!from) return;
  const desired = new Set(targetUids.filter((uid) => uid !== from.uid));
  const existing = db
    .prepare(
      `SELECT uid, to_uid FROM memory_relations
       WHERE from_uid = ? AND relation_type = 'related'
         AND source IN ('legacy-related-backfill', 'legacy-related-projection')`
    )
    .all(from.uid) as { uid: string; to_uid: string }[];
  for (const row of existing) {
    if (!desired.has(row.to_uid)) deleteMemoryRelation(row.uid);
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_relations(
       uid, from_uid, to_uid, relation_type, confidence, source, metadata, created_at, updated_at
     ) VALUES (?, ?, ?, 'related', 1.0, 'legacy-related-projection', '{}', ${NOW_MS}, ${NOW_MS})`
  );
  for (const toUid of desired) {
    const exists = db.prepare("SELECT 1 FROM memories WHERE uid = ?").get(toUid);
    if (!exists) continue;
    const uid = createHash("sha256")
      .update(`legacy-related\0${from.uid}\0${toUid}`)
      .digest("hex")
      .slice(0, 32);
    insert.run(uid, from.uid, toUid);
  }
}
