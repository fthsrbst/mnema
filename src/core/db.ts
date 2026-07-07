import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { config } from "./config.js";

const require = createRequire(import.meta.url);

let db: Database.Database | null = null;
let vecAvailable = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'fact',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  project TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title, body, content='memories', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
  INSERT INTO memories_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TABLE IF NOT EXISTS documents(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT,
  uri TEXT,
  project TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  heading TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, heading, content='chunks', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading) VALUES('delete', old.id, old.text, old.heading);
END;

CREATE TABLE IF NOT EXISTS projects(
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS machines(
  name TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  lmstudio_port INTEGER,
  comfyui_port INTEGER,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_logs(
  id INTEGER PRIMARY KEY,
  project TEXT,
  summary TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cihazlar arası eşitleme: silinen kayıtların izi (LWW için)
CREATE TABLE IF NOT EXISTS deletions(
  uid TEXT PRIMARY KEY,
  tbl TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_state(
  peer TEXT PRIMARY KEY,
  last_pull TEXT,
  last_push TEXT
);
`;

/** Var olan DB'lere eşitleme kolonlarını ekler (uid, updated_at) ve backfill yapar. */
function migrate(database: Database.Database): void {
  const addColumn = (tbl: string, col: string, ddl: string) => {
    const cols = database.prepare(`PRAGMA table_info(${tbl})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) database.exec(`ALTER TABLE ${tbl} ADD COLUMN ${ddl}`);
  };
  addColumn("memories", "uid", "uid TEXT");
  addColumn("documents", "uid", "uid TEXT");
  addColumn("documents", "updated_at", "updated_at TEXT");
  addColumn("documents", "enabled", "enabled INTEGER NOT NULL DEFAULT 1");
  addColumn("session_logs", "uid", "uid TEXT");
  // Recall kalitesi: önem çarpanı + erişim takibi (bkz. memories.ts, search.ts)
  addColumn("memories", "importance", "importance REAL NOT NULL DEFAULT 1.0");
  addColumn("memories", "last_accessed", "last_accessed TEXT");
  addColumn("memories", "access_count", "access_count INTEGER NOT NULL DEFAULT 0");
  database.exec(`
    UPDATE memories SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
    UPDATE documents SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
    UPDATE documents SET updated_at = created_at WHERE updated_at IS NULL;
    UPDATE session_logs SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_uid ON memories(uid);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_uid ON documents(uid);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_uid ON session_logs(uid);
  `);
  migrateSyncStatePeers(database);
}

/**
 * sync_state.peer eskiden URL bazlıydı (HUB_PRIMARY_URL değeri) — artık tek
 * mantıksal "primary" peer kullanılıyor ki adres değişince (çoklu URL/failover)
 * `since` sıfırlanmasın. Var olan URL bazlı satırları 'primary'ye taşır.
 */
function migrateSyncStatePeers(database: Database.Database): void {
  const hasPrimary = database.prepare("SELECT 1 FROM sync_state WHERE peer = 'primary'").get();
  if (hasPrimary) return;
  const urlRows = database
    .prepare("SELECT peer, last_pull, last_push FROM sync_state WHERE peer LIKE 'http%' ORDER BY last_pull DESC")
    .all() as { peer: string; last_pull: string | null; last_push: string | null }[];
  if (urlRows.length === 0) return;
  const chosen = urlRows[0];
  database
    .prepare(
      `INSERT INTO sync_state(peer, last_pull, last_push) VALUES ('primary', @last_pull, @last_push)
       ON CONFLICT(peer) DO UPDATE SET last_pull=excluded.last_pull, last_push=excluded.last_push`
    )
    .run({ last_pull: chosen.last_pull, last_push: chosen.last_push });
  database.prepare("DELETE FROM sync_state WHERE peer != 'primary'").run();
}

export function getDb(): Database.Database {
  if (db) return db;
  const dir = path.dirname(path.resolve(config.dbPath));
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    // require: sqlite-vec CJS dağıtılıyor
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(db);
    vecAvailable = true;
  } catch (err) {
    vecAvailable = false;
    console.error(`[hub] sqlite-vec yüklenemedi, vektör arama kapalı: ${(err as Error).message}`);
  }

  db.exec(SCHEMA);
  migrate(db);

  if (vecAvailable) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[${config.embeddingDim}]);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${config.embeddingDim}]);
    `);
  }
  return db;
}

export function hasVec(): boolean {
  getDb();
  return vecAvailable;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
