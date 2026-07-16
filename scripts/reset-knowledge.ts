/**
 * Destructively resets the syncable knowledge corpus while preserving operational
 * configuration (machines, prompts, skills) and the audit trail. Every syncable
 * deletion goes through the domain API so offline peers receive tombstones.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ProjectMap } from "../src/core/types.js";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=")];
  })
);
const backupPath = args.get("backup");
const canonicalMapPath = args.get("canonical-map");
const confirmed = args.get("confirm") === "RESET_KNOWLEDGE";

if (!backupPath || !canonicalMapPath) {
  throw new Error(
    "usage: npm run reset:knowledge -- --backup=<verified.db> --canonical-map=<project.json> --confirm=RESET_KNOWLEDGE"
  );
}

const resolvedBackup = path.resolve(backupPath);
const resolvedMap = path.resolve(canonicalMapPath);
if (!fs.existsSync(resolvedBackup)) throw new Error(`backup not found: ${resolvedBackup}`);
if (!fs.existsSync(resolvedMap)) throw new Error(`canonical project map not found: ${resolvedMap}`);

const backup = new Database(resolvedBackup, { readonly: true, fileMustExist: true });
try {
  const integrity = (backup.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  if (integrity !== "ok") throw new Error(`backup integrity_check failed: ${integrity}`);
} finally {
  backup.close();
}

const canonicalMap = JSON.parse(fs.readFileSync(resolvedMap, "utf8")) as Record<string, unknown>;
const {
  closeDb,
  config,
  deleteDocument,
  deleteMemory,
  deleteProject,
  deleteSessionLog,
  getDb,
  upsertProject,
} = await import("../src/core/index.js");

if (path.resolve(config.dbPath) === resolvedBackup) throw new Error("backup path must differ from HUB_DB_PATH");
const db = getDb();
const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const before = {
  memories: count("memories"),
  documents: count("documents"),
  sessions: count("session_logs"),
  projects: count("projects"),
  relations: count("memory_relations"),
  feedback: count("recall_feedback"),
};

if (!confirmed) {
  closeDb();
  console.log(JSON.stringify({ ok: false, dry_run: true, db: path.resolve(config.dbPath), backup: resolvedBackup, before }, null, 2));
  throw new Error("destructive reset refused: pass --confirm=RESET_KNOWLEDGE after reviewing the dry run");
}

try {
  const memoryIds = (db.prepare("SELECT id FROM memories ORDER BY id").all() as { id: number }[]).map((row) => row.id);
  const documentIds = (db.prepare("SELECT id FROM documents ORDER BY id").all() as { id: number }[]).map((row) => row.id);
  const sessionIds = (db.prepare("SELECT id FROM session_logs ORDER BY id").all() as { id: number }[]).map((row) => row.id);
  const projectNames = (db.prepare("SELECT name FROM projects ORDER BY name").all() as { name: string }[]).map((row) => row.name);

  for (const id of memoryIds) deleteMemory(id);
  for (const id of documentIds) deleteDocument(id);
  for (const id of sessionIds) deleteSessionLog(id);
  for (const name of projectNames) deleteProject(name);
  db.prepare("DELETE FROM recall_feedback").run();
  const canonical = upsertProject(canonicalMap as ProjectMap);

  const after = {
    memories: count("memories"),
    documents: count("documents"),
    sessions: count("session_logs"),
    projects: count("projects"),
    relations: count("memory_relations"),
    feedback: count("recall_feedback"),
    tombstones: count("deletions"),
    audit_events_retained: count("audit_events"),
    machines_retained: count("machines"),
    prompts_and_skills_retained: true,
  };
  console.log(JSON.stringify({ ok: true, db: path.resolve(config.dbPath), backup: resolvedBackup, before, after, canonical_project: canonical.name }, null, 2));
} finally {
  closeDb();
}
