/**
 * Read-only retention inventory.
 *
 * This script never mutates the Hub database. It produces explicit candidates
 * for human review before any archive/invalidate/delete operation.
 */
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../src/core/config.js";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=")];
  })
);

function positiveInt(name: string, fallback: number, max: number): number {
  const raw = args.get(name);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a positive integer`);
  const value = Number(raw);
  if (value < 1 || value > max) throw new Error(`--${name} must be between 1 and ${max}`);
  return value;
}

const databasePath = path.resolve(args.get("db") || config.dbPath);
const project = args.get("project") || undefined;
const staleDays = positiveInt("stale-days", 90, 3650);
const invalidatedDays = positiveInt("invalidated-days", 30, 3650);
const operationalDays = positiveInt("operational-days", 30, 3650);
const candidateLimit = positiveInt("limit", 200, 5000);
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

type Row = Record<string, unknown>;

function rows(sql: string, params: unknown[] = []): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function count(sql: string, params: unknown[] = []): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

function tableExists(name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  );
}

const scopeSql = project ? " AND project = ?" : "";
const scopeParams = project ? [project] : [];
const staleModifier = `-${staleDays} days`;
const invalidatedModifier = `-${invalidatedDays} days`;
const operationalModifier = `-${operationalDays} days`;

try {
  const integrity = db.pragma("integrity_check", { simple: true }) as string;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  const pageCount = db.pragma("page_count", { simple: true }) as number;
  const freelistCount = db.pragma("freelist_count", { simple: true }) as number;

  const staleCurrent = rows(
    `SELECT id, uid, project, type, title, importance, last_accessed, updated_at
     FROM memories
     WHERE is_current = 1
       AND importance <= 1.0
       AND updated_at < datetime('now', ?)
       AND (last_accessed IS NULL OR last_accessed < datetime('now', ?))
       ${scopeSql}
     ORDER BY importance ASC, updated_at ASC
     LIMIT ?`,
    [staleModifier, staleModifier, ...scopeParams, candidateLimit]
  );
  const invalidated = rows(
    `SELECT id, uid, project, type, title, valid_to, invalidated_reason, updated_at
     FROM memories
     WHERE is_current = 0
       AND COALESCE(valid_to, updated_at) < datetime('now', ?)
       ${scopeSql}
     ORDER BY COALESCE(valid_to, updated_at) ASC
     LIMIT ?`,
    [invalidatedModifier, ...scopeParams, candidateLimit]
  );
  const archived = rows(
    `SELECT id, uid, project, type, title, importance, updated_at
     FROM memories
     WHERE EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = 'archived')
       ${scopeSql}
     ORDER BY updated_at ASC
     LIMIT ?`,
    [...scopeParams, candidateLimit]
  );
  const exactDuplicateGroups = rows(
    `SELECT COALESCE(project, '(global)') AS project, lower(title) AS normalized_title,
            COUNT(*) AS count,
            json_group_array(json_object(
              'id', id, 'uid', uid, 'title', title, 'is_current', is_current,
              'importance', importance, 'updated_at', updated_at
            )) AS candidates
     FROM memories
     WHERE 1=1 ${scopeSql}
     GROUP BY COALESCE(project, '(global)'), lower(title)
     HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC, normalized_title
     LIMIT ?`,
    [...scopeParams, candidateLimit]
  ).map((row) => ({
    ...row,
    candidates: JSON.parse(String(row.candidates)),
  }));
  const obsoleteDocuments = rows(
    `SELECT id, uid, project, kind, title, uri, enabled, is_current, valid_to, updated_at
     FROM documents
     WHERE (enabled = 0 OR is_current = 0 OR (valid_to IS NOT NULL AND valid_to <= datetime('now')))
       ${scopeSql}
     ORDER BY updated_at ASC
     LIMIT ?`,
    [...scopeParams, candidateLimit]
  );
  const compactedSessions = rows(
    `SELECT id, uid, project, source, compacted_at, created_at,
            substr(summary, 1, 160) AS summary
     FROM session_logs
     WHERE compacted_at IS NOT NULL
       AND created_at < datetime('now', ?)
       ${scopeSql}
     ORDER BY created_at ASC
     LIMIT ?`,
    [operationalModifier, ...scopeParams, candidateLimit]
  );

  const operationalTables: Record<string, { eligible: number; total: number }> = {};
  const operationalQueries: Record<string, string> = {
    tasks:
      "status IN ('done','cancelled') AND COALESCE(finished_at,updated_at) < datetime('now', ?)",
    agent_messages: "created_at < datetime('now', ?)",
    agent_presence:
      "status != 'active' AND COALESCE(finished_at,updated_at) < datetime('now', ?)",
    agent_capabilities: "status = 'offline' AND updated_at < datetime('now', ?)",
    jobs: "status IN ('done','failed') AND updated_at < datetime('now', ?)",
    hub_events: "created_at < datetime('now', ?)",
  };
  for (const [table, predicate] of Object.entries(operationalQueries)) {
    if (!tableExists(table)) continue;
    operationalTables[table] = {
      eligible: count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`, [operationalModifier]),
      total: count(`SELECT COUNT(*) AS n FROM ${table}`),
    };
  }

  const report = {
    ok: integrity === "ok",
    dry_run: true,
    generated_at: new Date().toISOString(),
    database: {
      path: databasePath,
      integrity,
      bytes: pageSize * pageCount,
      reclaimable_bytes_after_delete: pageSize * freelistCount,
    },
    scope: {
      project: project ?? null,
      stale_days: staleDays,
      invalidated_days: invalidatedDays,
      operational_days: operationalDays,
      candidate_limit: candidateLimit,
    },
    totals: {
      memories: count(
        `SELECT COUNT(*) AS n FROM memories WHERE 1=1 ${scopeSql}`,
        scopeParams
      ),
      documents: count(
        `SELECT COUNT(*) AS n FROM documents WHERE 1=1 ${scopeSql}`,
        scopeParams
      ),
      sessions: count(
        `SELECT COUNT(*) AS n FROM session_logs WHERE 1=1 ${scopeSql}`,
        scopeParams
      ),
      tombstones: tableExists("deletions")
        ? count("SELECT COUNT(*) AS n FROM deletions")
        : 0,
      audit_events: tableExists("audit_events")
        ? count("SELECT COUNT(*) AS n FROM audit_events")
        : 0,
    },
    review_candidates: {
      stale_current_archive_first: staleCurrent,
      invalidated_observation_complete: invalidated,
      already_archived: archived,
      exact_duplicate_groups: exactDuplicateGroups,
      obsolete_documents: obsoleteDocuments,
      old_compacted_sessions: compactedSessions,
    },
    operational_retention: operationalTables,
    guardrails: [
      "This report performed no writes.",
      "Archive stale current memories before considering deletion.",
      "Choose one canonical record in every duplicate group; never delete both automatically.",
      "Delete syncable rows only through domain APIs so tombstones are created.",
      "Do not prune tombstones or the audit chain as routine cleanup.",
      "Take and verify an online SQLite backup before an approved purge.",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
