import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { CHUNKER_VERSION } from "./chunker.js";

const require = createRequire(import.meta.url);

export const GLOBAL_VECTOR_PROJECT = "__global__";

export function vectorProject(project: string | null | undefined): string {
  return project?.trim() || GLOBAL_VECTOR_PROJECT;
}

let db: Database.Database | null = null;
let vecAvailable = false;
let vecErrorMsg: string | null = null;

/**
 * Milisaniye hassasiyetli UTC zaman damgası üreten SQL ifadesi.
 * LWW eşitlemede saniye hassasiyeti aynı saniyedeki iki yazmayı ayırt edemiyordu;
 * ms hassasiyet çakışma olasılığını düşürür. Eski "YYYY-MM-DD HH:MM:SS" değerleriyle
 * sözlüksel (lexicographic) karşılaştırma geriye uyumludur ("…:50.123" > "…:50").
 */
export const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f','now')";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'fact',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  project TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  language TEXT,
  canonical_summary TEXT,
  normalizer_generation TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title, body, canonical_summary, content='memories', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, body, canonical_summary) VALUES (new.id, new.title, new.body, new.canonical_summary);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, canonical_summary) VALUES('delete', old.id, old.title, old.body, old.canonical_summary);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, canonical_summary) VALUES('delete', old.id, old.title, old.body, old.canonical_summary);
  INSERT INTO memories_fts(rowid, title, body, canonical_summary) VALUES (new.id, new.title, new.body, new.canonical_summary);
END;

CREATE TABLE IF NOT EXISTS documents(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT,
  uri TEXT,
  project TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
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
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE TABLE IF NOT EXISTS machines(
  name TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  lmstudio_port INTEGER,
  ollama_port INTEGER,
  comfyui_port INTEGER,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE TABLE IF NOT EXISTS session_logs(
  id INTEGER PRIMARY KEY,
  project TEXT,
  summary TEXT NOT NULL,
  source TEXT,
  compacted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

-- Recall kalite geri bildirimi (agent'lardan): eşik kalibrasyonu verisi.
-- Cihaz-yerel tutulur (sync'e girmez) — her cihazın recall yolu kendi eşikleriyle ölçülür.
CREATE TABLE IF NOT EXISTS recall_feedback(
  id INTEGER PRIMARY KEY,
  query TEXT NOT NULL,
  verdict TEXT NOT NULL,
  memory_id INTEGER,
  target_kind TEXT,
  target_id INTEGER,
  target_uid TEXT,
  project TEXT,
  intent TEXT,
  rank INTEGER,
  channels TEXT NOT NULL DEFAULT '[]',
  delivery_id TEXT,
  note TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

-- Typed, temporal knowledge-graph edges. Memory IDs are device-local, so edges
-- reference stable memory UIDs and carry their own syncable UID.
CREATE TABLE IF NOT EXISTS memory_relations(
  uid TEXT PRIMARY KEY,
  from_uid TEXT NOT NULL,
  to_uid TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  valid_from TEXT,
  valid_to TEXT,
  source TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  CHECK(from_uid != to_uid),
  CHECK(confidence >= 0 AND confidence <= 1)
);

-- Node-local tamper-evident audit chain. Request bodies, tokens, document text,
-- and prompts are deliberately excluded by the writer.
CREATE TABLE IF NOT EXISTS audit_events(
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT,
  project TEXT,
  status INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

-- Cihazlar arası eşitleme: silinen kayıtların izi (LWW için)
CREATE TABLE IF NOT EXISTS deletions(
  uid TEXT NOT NULL,
  tbl TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  PRIMARY KEY(tbl, uid)
);

CREATE TABLE IF NOT EXISTS sync_state(
  peer TEXT PRIMARY KEY,
  last_pull TEXT,
  last_push TEXT
);

-- Skill/prompt içeriği: DB authority (bkz. src/core/assets.ts). Repo'daki skills/*/SKILL.md
-- ve prompts/**/*.md dosyaları yalnızca ilk kurulum seed'idir; sonraki yazımlar buraya
-- düşer ve sync ile diğer cihazlara otomatik yayılır (git commit/push gerekmez).
CREATE TABLE IF NOT EXISTS assets(
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('skill', 'prompt')),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  UNIQUE(kind, name)
);
CREATE INDEX IF NOT EXISTS idx_assets_updated ON assets(updated_at);

-- Advisory agent-presence koordinasyonu: mutual-exclusion kilidi DEĞİL, "kim ne üzerinde
-- çalışıyor" sinyali. Bayatlık heartbeat_at + HUB_PRESENCE_TTL_MIN ile ele alınır (bkz. presence.ts).
CREATE TABLE IF NOT EXISTS agent_presence(
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  machine TEXT NOT NULL,
  agent TEXT NOT NULL,
  project TEXT NOT NULL,
  branch TEXT,
  task TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'done', 'abandoned')) DEFAULT 'active',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_presence_project_status ON agent_presence(project, status, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_agent_presence_updated ON agent_presence(updated_at);

CREATE TABLE IF NOT EXISTS system_metadata(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

-- Durable projection queue for external vector indexes. The local sqlite-vec
-- mutation commits in the same transaction as this entry; remote delivery is
-- revision-guarded, idempotent, and retried out of band.
CREATE TABLE IF NOT EXISTS vector_outbox(
  entity TEXT NOT NULL CHECK(entity IN ('memory', 'chunk')),
  row_id INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
  payload TEXT,
  embedding BLOB,
  generation TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  PRIMARY KEY(entity, row_id)
);
CREATE INDEX IF NOT EXISTS idx_vector_outbox_due ON vector_outbox(next_attempt_at, updated_at);

-- Task queue: agent-to-agent work delegation and tracking.
-- Tasks can have dependencies (depends_on JSON array of task uids) and are
-- claimed atomically by agents. Status flow: pending -> claimed -> in_progress -> done/cancelled.
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  project TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','in_progress','blocked','done','cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  error TEXT,
  verification TEXT,
  due_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed ON tasks(claimed_by, status);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);

-- Agent capability registry: tracks what each agent can do and its current status.
-- Agents register their capabilities (code_review, testing, deploy, etc.) and
-- can be found by capability for task routing.
CREATE TABLE IF NOT EXISTS agent_capabilities(
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL,
  machine TEXT,
  capabilities TEXT NOT NULL DEFAULT '[]',
  models TEXT NOT NULL DEFAULT '[]',
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','busy','offline')),
  last_seen_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  UNIQUE(agent, machine)
);
CREATE INDEX IF NOT EXISTS idx_agent_capabilities_status ON agent_capabilities(status, last_seen_at);

-- Agent messages: structured communication between agents.
-- Supports info, request, response, handoff, and alert message types.
-- Messages can be linked to tasks for context.
CREATE TABLE IF NOT EXISTS agent_messages(
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  project TEXT,
  task_uid TEXT,
  kind TEXT NOT NULL DEFAULT 'info' CHECK(kind IN ('info','request','response','handoff','alert')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_to ON agent_messages(to_agent, read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_project ON agent_messages(project, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_task ON agent_messages(task_uid);

-- Per-agent read state for broadcast messages (to_agent IS NULL). Direct messages
-- use agent_messages.read_at directly (global — only one recipient anyway); broadcasts
-- must not let one agent's read mark it read for everyone else.
CREATE TABLE IF NOT EXISTS agent_message_reads(
  message_uid TEXT NOT NULL,
  agent TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY(message_uid, agent)
);

-- Task-level feedback: captures outcomes and lessons from completed tasks.
-- Distinct from recall_feedback (which measures retrieval quality).
CREATE TABLE IF NOT EXISTS task_feedback(
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  task_uid TEXT,
  project TEXT,
  agent TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','partial','failure')),
  what_worked TEXT,
  what_failed TEXT,
  lessons TEXT,
  duration_min INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX IF NOT EXISTS idx_task_feedback_project ON task_feedback(project, created_at);
CREATE INDEX IF NOT EXISTS idx_task_feedback_task ON task_feedback(task_uid);

-- Webhook registrations: outbound HTTP callbacks on hub events.
-- Auto-disabled after repeated failures.
CREATE TABLE IF NOT EXISTS webhooks(
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["*"]',
  secret TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_triggered_at TEXT,
  last_status INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

-- Job queue: SQLite-backed async worker for embed, compact, hygiene, webhook, sync, reindex.
-- Single-threaded processing with exponential backoff on failure.
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  last_error TEXT,
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, next_run_at);

-- Hub event log: recent events for debugging and dashboard.
-- Ring buffer style — old events are pruned periodically.
CREATE TABLE IF NOT EXISTS hub_events(
  id INTEGER PRIMARY KEY,
  uid TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX IF NOT EXISTS idx_hub_events_type ON hub_events(type, created_at);

-- Sync delivery watermark: central monotonic change log fed by triggers (ADR-005).
-- AUTOINCREMENT zorunlu — düz INTEGER PRIMARY KEY silinen en yüksek rowid'yi geri kullanır,
-- prune sonrası seq monotonluğu bozulur ve geç watermark'lı peer kaçırdığı satırı tekrar kaçırır.
CREATE TABLE IF NOT EXISTS change_log(
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl        TEXT NOT NULL,
  row_key    TEXT NOT NULL,
  -- 1 = bu satiri applyChanges yazdi, yani degisiklik primary'den geldi. Push tarafinda
  -- haric tutulur; yoksa uzaktan gelen her kayit bir sonraki turda kaynagina geri gider
  -- (echo) ve change_log her turda siser. Pull tarafinda haric TUTULMAZ: primary'nin
  -- PC'den aldigi kaydi Mac'e iletebilmesi gerekir.
  from_sync  INTEGER NOT NULL DEFAULT 0,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX IF NOT EXISTS idx_change_log_key ON change_log(tbl, row_key);
`;

/**
 * Bir tablo için change_log trigger'ları kurar. ADR-005: toplu/tekrarlı yazım patikalarını
 * bypass edememesi için trigger tabanlı teslimat. `{ update: false }` insert-only
 * tablolar için AFTER UPDATE trigger'ını kurmaz (örn. agent_messages — apply yolunda
 * `if (exists) continue` ile es geçilir, read_at cihaz-yereldir).
 */
function installChangeTrigger(
  database: Database.Database,
  tbl: string,
  rowKeyExpr: string,
  opts: { update?: boolean } = {}
): void {
  const update = opts.update ?? true;
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS ${tbl}_chg_ai AFTER INSERT ON ${tbl} BEGIN
      INSERT INTO change_log(tbl, row_key) VALUES ('${tbl}', ${rowKeyExpr});
    END;
  `);
  if (update) {
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS ${tbl}_chg_au AFTER UPDATE ON ${tbl} BEGIN
        INSERT INTO change_log(tbl, row_key) VALUES ('${tbl}', ${rowKeyExpr});
      END;
    `);
  }
}

/**
 * Senkronize edilen tüm tablolar için change_log trigger'larını kurar. migrate()'in EN SON
 * adımıdır — önce çalışacak veri migration'ları (özellikle migrateDeletionPrimaryKey içindeki
 * `INSERT OR REPLACE INTO deletions`) trigger'lardan önce gelmeli; yoksa her tarihsel
 * tombstone change_log'a düşer ve tüm peer'lara yeniden yayınlanır (ADR-005).
 */
/**
 * Senkronize edilen tabloların change_log tanımı — TEK KAYNAK.
 *
 * `rowKey` ile `triggerRowKey` AYNI değeri üretmek zorundadır: trigger yeni yazımları,
 * `rowKey` ise seed'i ve seq-modu sorgularını besler. Ayrışırlarsa seq modu satırı
 * bulamaz ve kayıt sessizce teslim edilmez — bu yüzden ikisi yan yana durur.
 * Değerler derleme-zamanı sabitidir; SQL'e gömülmeleri güvenlidir (kullanıcı girdisi değil).
 */
export const SYNC_TABLES: {
  tbl: string;
  /** change_log.row_key'i üreten ifade (tablonun kendi bağlamında). */
  rowKey: string;
  /** Aynı ifadenin trigger gövdesindeki (new.*) hali. */
  triggerRowKey: string;
  /** false ise AFTER UPDATE trigger'ı kurulmaz (insert-only tablolar). */
  update?: boolean;
  /**
   * true ise AFTER DELETE gözlem trigger'ı kurulur (ADR-005 silme invariantı).
   * `deletions` tablosunun kendisine kurulmaz. Bu tablolarda `rowKey` DÜZ BİR KOLON
   * olmak zorundadır — trigger gövdesinde `old.<rowKey>` olarak kullanılır.
   */
  deleteGuard?: boolean;
}[] = [
  { tbl: "memories", rowKey: "uid", triggerRowKey: "new.uid", deleteGuard: true },
  { tbl: "documents", rowKey: "uid", triggerRowKey: "new.uid", deleteGuard: true },
  { tbl: "memory_relations", rowKey: "uid", triggerRowKey: "new.uid", deleteGuard: true },
  { tbl: "projects", rowKey: "name", triggerRowKey: "new.name", deleteGuard: true },
  { tbl: "session_logs", rowKey: "uid", triggerRowKey: "new.uid", deleteGuard: true },
  { tbl: "machines", rowKey: "name", triggerRowKey: "new.name", deleteGuard: true },
  { tbl: "assets", rowKey: "uid", triggerRowKey: "new.uid", deleteGuard: true },
  { tbl: "agent_presence", rowKey: "uid", triggerRowKey: "new.uid", deleteGuard: true },
  { tbl: "tasks", rowKey: "uid", triggerRowKey: "new.uid", deleteGuard: true },
  { tbl: "agent_capabilities", rowKey: "uid", triggerRowKey: "new.uid", deleteGuard: true },
  // agent_messages insert-only (ADR-005): read_at cihaz-yereldir, update trigger yok.
  { tbl: "agent_messages", rowKey: "uid", triggerRowKey: "new.uid", deleteGuard: true, update: false },
  // deletions PK birleşik (tbl, uid) — row_key tek başına uid olursa iki tablodaki
  // aynı uid çakışır, bu yüzden "tbl:uid" bileşik anahtar kullanılır.
  {
    tbl: "deletions",
    rowKey: "tbl || ':' || uid",
    triggerRowKey: "new.tbl || ':' || new.uid",
  },
];

/**
 * Silme GÖZLEM trigger'ı (ADR-005 silme invariantı).
 *
 * ADR "silmeler yalnız `deletions` tombstone'u üzerinden yayılır" diyor ama hiçbir şey
 * bunu zorlamıyordu: doğrudan `DELETE FROM memories ...` çalıştıran biri tombstone
 * bırakmaz, silme hiçbir peer'a ulaşmaz ve sessiz ıraksama olur.
 *
 * Trigger burada tombstone'u KONTROL EDEMEZ: `recordDeletion` DELETE'ten SONRA çağrılıyor
 * (bkz. memories.ts deleteMemory), yani "tombstone yok" koşulu her normal silmede de
 * doğru olurdu ve uyarı sürekli yanlış alarm verirdi. Bu yüzden trigger yalnızca OLAYI
 * kaydeder; tombstone ile uzlaştırma sonradan reconcileDeleteObservations() ile yapılır.
 */
function installDeleteGuardTrigger(database: Database.Database, tbl: string, rowKey: string): void {
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS ${tbl}_del_observe AFTER DELETE ON ${tbl} BEGIN
      INSERT INTO hub_events(type, payload) VALUES (
        'sync.delete_observed',
        json_object('tbl', '${tbl}', 'row_key', old.${rowKey})
      );
    END;
  `);
}

function installChangeTriggers(database: Database.Database): void {
  for (const t of SYNC_TABLES) {
    installChangeTrigger(database, t.tbl, t.triggerRowKey, { update: t.update });
    if (t.deleteGuard) installDeleteGuardTrigger(database, t.tbl, t.rowKey);
  }
}

/**
 * Var olan satırlar için change_log'u BİR KEZ doldurur.
 *
 * Trigger'lar yalnız yeni yazımlarda tetiklenir; yükseltme anında tablolarda duran
 * kayıtların hiç change_log izi olmaz ve `since_seq=0` boş döner. Seed bunu kapatır ve
 * yan etkisi kasıtlıdır: bir kereye mahsus tam yeniden yayın, cihazlar arasında birikmiş
 * ıraksamayı LWW altında (idempotent) kapatır — ADR-005'teki "ilk turda tam süpürme"nin
 * sunucu tarafındaki karşılığı. Idempotency deseni migrateLegacyRelations ile aynıdır.
 */
function seedChangeLog(database: Database.Database): void {
  const marker = database.prepare("SELECT value FROM system_metadata WHERE key = 'change_log_seeded'").get() as
    | { value: string }
    | undefined;
  if (marker?.value === "1") return;
  database.transaction(() => {
    for (const t of SYNC_TABLES) {
      database.prepare(`INSERT INTO change_log(tbl, row_key) SELECT '${t.tbl}', ${t.rowKey} FROM ${t.tbl}`).run();
    }
    database
      .prepare(
        `INSERT INTO system_metadata(key, value, updated_at) VALUES ('change_log_seeded', '1', ${NOW_MS})
         ON CONFLICT(key) DO UPDATE SET value='1', updated_at=${NOW_MS}`
      )
      .run();
  })();
}

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
  addColumn("vector_outbox", "revision", "revision INTEGER NOT NULL DEFAULT 1");
  // Document lifecycle. Existing documents remain current reference material;
  // operators can archive/supersede stale versions explicitly after migration.
  addColumn("documents", "kind", "kind TEXT NOT NULL DEFAULT 'reference'");
  addColumn("documents", "version", "version TEXT");
  addColumn("documents", "is_current", "is_current INTEGER NOT NULL DEFAULT 1");
  addColumn("documents", "supersedes_uid", "supersedes_uid TEXT");
  addColumn("documents", "valid_from", "valid_from TEXT");
  addColumn("documents", "valid_to", "valid_to TEXT");
  addColumn("documents", "archived_at", "archived_at TEXT");
  addColumn("documents", "content_hash", "content_hash TEXT");
  addColumn("documents", "language", "language TEXT");
  backfillDocumentHashes(database);
  addColumn("session_logs", "uid", "uid TEXT");
  addColumn("session_logs", "updated_at", "updated_at TEXT");
  addColumn("session_logs", "compacted_at", "compacted_at TEXT");
  // hub_events.uid: emitHubEvent() ve getEventLogDb() bu kolonu varsayar; şema ilk sürümde
  // eksikti (INSERT sessizce yutuluyor, SELECT ise "no such column" ile patlıyordu).
  addColumn("hub_events", "uid", "uid TEXT");
  // Yerel LLM backend'leri: LM Studio'ya ek olarak Ollama (OpenAI-uyumlu /v1)
  addColumn("machines", "ollama_port", "ollama_port INTEGER");
  // Recall kalitesi: önem çarpanı + erişim takibi (bkz. memories.ts, search.ts)
  addColumn("memories", "importance", "importance REAL NOT NULL DEFAULT 1.0");
  addColumn("memories", "last_accessed", "last_accessed TEXT");
  addColumn("memories", "access_count", "access_count INTEGER NOT NULL DEFAULT 0");
  // Bağlantılı hafızalar: uid listesi (JSON). uid tutulur çünkü id'ler cihaz-yerel
  // autoincrement'tir — sync sonrası aynı kayıt farklı cihazda farklı id alabilir.
  addColumn("memories", "related", "related TEXT NOT NULL DEFAULT '[]'");
  addColumn("memories", "language", "language TEXT");
  addColumn("memories", "canonical_summary", "canonical_summary TEXT");
  addColumn("memories", "normalizer_generation", "normalizer_generation TEXT");
  // Machine attribution: hangi cihazdan yazıldığı (presence/capabilities'ta resolveMachineName()
  // ile aynı kaynak). Sync'ten gelen satırlarda mevcut değer korunur, yeni yerel kayıtlarda
  // resolveMachineName() ile otomatik damgalanır.
  addColumn("memories", "origin_machine", "origin_machine TEXT");
  addColumn("session_logs", "origin_machine", "origin_machine TEXT");
  // ADR-006: hafıza yaşam döngüsü — documents'ta zaten var olan deseni (kind/version hariç)
  // memories'e taşır. is_current NOT NULL DEFAULT 1: var olan hiçbir kayıt geriye dönük
  // bayat işaretlenmez (ADR bunu açıkça yasaklıyor). valid_from mevcut kayıtlar için
  // aşağıda created_at ile doldurulur; valid_to/supersedes_uid/invalidated_reason boş kalır.
  addColumn("memories", "valid_from", "valid_from TEXT");
  addColumn("memories", "valid_to", "valid_to TEXT");
  addColumn("memories", "is_current", "is_current INTEGER NOT NULL DEFAULT 1");
  addColumn("memories", "supersedes_uid", "supersedes_uid TEXT");
  addColumn("memories", "invalidated_reason", "invalidated_reason TEXT");
  // ADR-006 faz 2: doğrulama yaşı. Volatil iddialar (ortam durumu, bir servisin ayakta olması
  // gibi) review_after ile bir kontrol ufku alabilir. review_after geçmişte kalırsa
  // formatRecall (recall.ts) GÖRÜNÜR bir uyarı ekler — kaydı GİZLEMEZ: sistem bir şeyin
  // yanlış olduğunu bilemez ama kimsenin kontrol etmediğini bilir, bunu söyleyebilir.
  addColumn("memories", "verified_at", "verified_at TEXT");
  addColumn("memories", "review_after", "review_after TEXT");
  // Retrieval feedback was memory-only in the first release. Keep memory_id for
  // compatibility, but use target_kind/target_id for memory, chunk, document,
  // or whole-context feedback and retain the delivered ranking evidence.
  addColumn("recall_feedback", "target_kind", "target_kind TEXT");
  addColumn("recall_feedback", "target_id", "target_id INTEGER");
  addColumn("recall_feedback", "target_uid", "target_uid TEXT");
  addColumn("recall_feedback", "project", "project TEXT");
  addColumn("recall_feedback", "intent", "intent TEXT");
  addColumn("recall_feedback", "rank", "rank INTEGER");
  addColumn("recall_feedback", "channels", "channels TEXT NOT NULL DEFAULT '[]'");
  addColumn("recall_feedback", "delivery_id", "delivery_id TEXT");
  // Task quality gate: agent complete çağırırken verification kanıtı
  // (JSON {kind,command,exit_code?,summary}; kind: tests|build|manual|none)
  // gönderebilir. Kolon null = kanıt verilmedi (advisory uyarı); "none" =
  // bilinçli tercih (uyarı YOK). Sert kilit DEĞİL — presence felsefesiyle
  // tutarlı (bkz. completeTask, docs/agent-platform.md).
  addColumn("tasks", "verification", "verification TEXT");
  database.exec(`
    UPDATE recall_feedback
       SET target_kind = 'memory', target_id = memory_id
     WHERE memory_id IS NOT NULL AND target_kind IS NULL;
    CREATE INDEX IF NOT EXISTS idx_recall_feedback_target
      ON recall_feedback(target_kind, target_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_recall_feedback_project_intent
      ON recall_feedback(project, intent, created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_uid, relation_type, updated_at);
    CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_uid, relation_type, updated_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_actor_action ON audit_events(actor, action, created_at);
  `);
  migrateLegacyRelations(database);
  migrateMemoryFts(database);
  // ADR-006 backfill: yalnızca valid_from doldurulur (henüz hiç dolmamış eski satırlar için).
  // is_current'a DOKUNULMAZ — kolon zaten NOT NULL DEFAULT 1 ile eklendi, hiçbir kayıt
  // bu migration'la bayat işaretlenmez.
  database.prepare("UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL").run();
  database.exec(`
    UPDATE memories SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
    UPDATE documents SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
    UPDATE documents SET updated_at = created_at WHERE updated_at IS NULL;
    UPDATE session_logs SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
    UPDATE session_logs SET updated_at = created_at WHERE updated_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_uid ON memories(uid);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_uid ON documents(uid);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_uid ON session_logs(uid);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_uri_unique ON documents(uri) WHERE uri IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_documents_project_current ON documents(project, enabled, is_current);
  `);
  // ADR-005: teslimat watermark'i seq tabanli. Kolonlar nullable — NULL "henuz seq
  // modunda degil" demektir ve zaman-modu fallback'i bu sayede bozulmadan durur.
  addColumn("change_log", "from_sync", "from_sync INTEGER NOT NULL DEFAULT 0");
  addColumn("sync_state", "last_pull_seq", "last_pull_seq INTEGER");
  addColumn("sync_state", "last_push_seq", "last_push_seq INTEGER");
  migrateSyncStatePeers(database);
  migrateDeletionPrimaryKey(database);
  // En son: change_log trigger'ları. Önceki veri migration'ları (özellikle
  // migrateDeletionPrimaryKey tarihsel tombstone'ları yeniden yazar) trigger'lardan
  // önce çalışmalı; yoksa her tarihsel tombstone change_log'a düşer ve tüm peer'lara
  // rebroadcast olur (ADR-005).
  installChangeTriggers(database);
  // Trigger'lardan SONRA: var olan satırlar için tek seferlik change_log seed'i.
  // Sıra önemli değil (seed doğrudan change_log'a yazar, kaynak tablolara dokunmaz)
  // ama kavramsal olarak "trigger'lar kuruldu, geçmiş de dolduruldu" okunur.
  seedChangeLog(database);
}

function migrateLegacyRelations(database: Database.Database): void {
  const marker = database.prepare("SELECT value FROM system_metadata WHERE key = 'legacy_relations_backfilled'").get() as
    | { value: string }
    | undefined;
  if (marker?.value === "1") return;
  const rows = database
    .prepare(
      `SELECT m.uid AS from_uid, json_each.value AS to_uid
       FROM memories m, json_each(m.related)
       WHERE json_valid(m.related) AND json_each.type = 'text' AND m.uid != json_each.value`
    )
    .all() as { from_uid: string; to_uid: string }[];
  const insert = database.prepare(
    `INSERT OR IGNORE INTO memory_relations(
       uid, from_uid, to_uid, relation_type, confidence, source, metadata, created_at, updated_at
     ) VALUES (?, ?, ?, 'related', 1.0, 'legacy-related-backfill', '{}', ${NOW_MS}, ${NOW_MS})`
  );
  database.transaction(() => {
    for (const row of rows) {
      const uid = createHash("sha256")
        .update(`legacy-related\0${row.from_uid}\0${row.to_uid}`)
        .digest("hex")
        .slice(0, 32);
      insert.run(uid, row.from_uid, row.to_uid);
    }
    database
      .prepare(
        `INSERT INTO system_metadata(key, value, updated_at) VALUES ('legacy_relations_backfilled', '1', ${NOW_MS})
         ON CONFLICT(key) DO UPDATE SET value='1', updated_at=${NOW_MS}`
      )
      .run();
  })();
}

function backfillDocumentHashes(database: Database.Database): void {
  const docs = database
    .prepare("SELECT id FROM documents WHERE content_hash IS NULL")
    .all() as { id: number }[];
  const chunks = database.prepare("SELECT seq, heading, text FROM chunks WHERE document_id = ? ORDER BY seq");
  const update = database.prepare("UPDATE documents SET content_hash = ? WHERE id = ?");
  database.transaction(() => {
    for (const doc of docs) {
      const rows = chunks.all(doc.id) as { seq: number; heading: string | null; text: string }[];
      if (rows.length === 0) continue;
      const hash = createHash("sha256")
        .update("stored-chunks-v1\0")
        .update(JSON.stringify(rows))
        .digest("hex");
      update.run(hash, doc.id);
    }
  })();
}

function migrateMemoryFts(database: Database.Database): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get() as
    | { sql: string }
    | undefined;
  if (row?.sql.includes("canonical_summary")) return;
  database.transaction(() => {
    database.exec(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TABLE IF EXISTS memories_fts;
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        title, body, canonical_summary, content='memories', content_rowid='id', tokenize='unicode61'
      );
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, body, canonical_summary)
          VALUES (new.id, new.title, new.body, new.canonical_summary);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, body, canonical_summary)
          VALUES('delete', old.id, old.title, old.body, old.canonical_summary);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, body, canonical_summary)
          VALUES('delete', old.id, old.title, old.body, old.canonical_summary);
        INSERT INTO memories_fts(rowid, title, body, canonical_summary)
          VALUES (new.id, new.title, new.body, new.canonical_summary);
      END;
      INSERT INTO memories_fts(rowid, title, body, canonical_summary)
        SELECT id, title, body, canonical_summary FROM memories;
    `);
  })();
}

function migrateDeletionPrimaryKey(database: Database.Database): void {
  const info = database.prepare("PRAGMA table_info(deletions)").all() as { name: string; pk: number }[];
  const pk = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  if (pk.length === 2 && pk[0] === "tbl" && pk[1] === "uid") return;
  database.transaction(() => {
    database.exec(`
      ALTER TABLE deletions RENAME TO deletions_legacy;
      CREATE TABLE deletions(
        uid TEXT NOT NULL,
        tbl TEXT NOT NULL,
        deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
        PRIMARY KEY(tbl, uid)
      );
      INSERT OR REPLACE INTO deletions(uid, tbl, deleted_at)
        SELECT uid, tbl, deleted_at FROM deletions_legacy;
      DROP TABLE deletions_legacy;
    `);
  })();
}

export function configuredEmbeddingGeneration(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: "gemini",
        model: config.embeddingModel,
        dimensions: config.embeddingDim,
        normalization: "l2-v1",
        chunker: CHUNKER_VERSION,
      })
    )
    .digest("hex");
}

function setMetadata(database: Database.Database, key: string, value: string): void {
  database
    .prepare(
      `INSERT INTO system_metadata(key, value, updated_at) VALUES (?, ?, ${NOW_MS})
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=${NOW_MS}`
    )
    .run(key, value);
}

function getMetadata(database: Database.Database, key: string): string | null {
  const row = database.prepare("SELECT value FROM system_metadata WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function ensureEmbeddingGeneration(database: Database.Database): void {
  const configured = configuredEmbeddingGeneration();
  const active = getMetadata(database, "active_embedding_generation");
  const vectorCount = vecAvailable
    ? ((database.prepare("SELECT (SELECT COUNT(*) FROM memories_vec) + (SELECT COUNT(*) FROM chunks_vec) AS n").get() as { n: number }).n)
    : 0;
  setMetadata(database, "configured_embedding_generation", configured);
  if (!active) {
    setMetadata(database, "active_embedding_generation", configured);
    setMetadata(database, "embedding_generation_provenance", vectorCount > 0 ? "inferred_on_upgrade" : "created_empty");
    setMetadata(database, "embedding_reindex_required", "0");
    return;
  }
  if (active !== configured && vectorCount > 0) {
    setMetadata(database, "embedding_reindex_required", "1");
  } else if (vectorCount === 0) {
    setMetadata(database, "active_embedding_generation", configured);
    setMetadata(database, "embedding_generation_provenance", "created_empty");
    setMetadata(database, "embedding_reindex_required", "0");
  }
}

function vectorTableSql(database: Database.Database, table: string): string | null {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | undefined;
  return row?.sql ?? null;
}

/**
 * sqlite-vec partition/metadata columns must be declared when vec0 is created.
 * Existing v1 tables are rebuilt transactionally while preserving same-dimension
 * embeddings. Filters can then run inside KNN instead of after global top-k.
 */
function ensureVectorSchema(database: Database.Database): void {
  const memorySql = vectorTableSql(database, "memories_vec");
  const chunkSql = vectorTableSql(database, "chunks_vec");
  const expectedDim = `float[${config.embeddingDim}]`;

  const rebuildMemories = Boolean(
    memorySql &&
      (!memorySql.includes("project text partition key") ||
        !memorySql.includes("is_current integer") ||
        !memorySql.includes(expectedDim))
  );
  const rebuildChunks = Boolean(
    chunkSql &&
      (!chunkSql.includes("project text partition key") ||
        !chunkSql.includes("enabled integer") ||
        !chunkSql.includes("is_current integer") ||
        !chunkSql.includes("kind text") ||
        !chunkSql.includes(expectedDim))
  );

  database.transaction(() => {
    if (rebuildMemories) {
      const sameDim = memorySql!.includes(expectedDim);
      database.exec("DROP TABLE IF EXISTS temp.memories_vec_backup");
      if (sameDim) {
        // ADR-006: memories.is_current migration'ı bu noktadan önce (migrate() içinde)
        // zaten çalıştı, bu yüzden JOIN burada güncel değeri okuyabilir.
        database.exec(`CREATE TEMP TABLE memories_vec_backup AS
          SELECT v.rowid, COALESCE(NULLIF(trim(m.project), ''), '${GLOBAL_VECTOR_PROJECT}') AS project,
                 CAST(m.is_current AS INTEGER) AS is_current, v.embedding
          FROM memories_vec v JOIN memories m ON m.id = v.rowid`);
      }
      database.exec("DROP TABLE memories_vec");
      database.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(
        project text partition key,
        is_current integer,
        embedding float[${config.embeddingDim}]
      )`);
      if (sameDim) {
        database.prepare(
          "INSERT INTO memories_vec(rowid, project, is_current, embedding) SELECT rowid, project, is_current, embedding FROM memories_vec_backup"
        ).run();
        database.exec("DROP TABLE memories_vec_backup");
      } else {
        console.warn("[hub] embedding dimension changed; memory vectors were cleared and require reindex");
      }
    } else if (!memorySql) {
      database.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(
        project text partition key,
        is_current integer,
        embedding float[${config.embeddingDim}]
      )`);
    }

    if (rebuildChunks) {
      const sameDim = chunkSql!.includes(expectedDim);
      database.exec("DROP TABLE IF EXISTS temp.chunks_vec_backup");
      if (sameDim) {
        database.exec(`CREATE TEMP TABLE chunks_vec_backup AS
          SELECT v.rowid,
                 COALESCE(NULLIF(trim(d.project), ''), '${GLOBAL_VECTOR_PROJECT}') AS project,
                 CAST(d.enabled AS INTEGER) AS enabled,
                 CAST(d.is_current AS INTEGER) AS is_current,
                 d.kind AS kind,
                 v.embedding
          FROM chunks_vec v
          JOIN chunks c ON c.id = v.rowid
          JOIN documents d ON d.id = c.document_id`);
      }
      database.exec("DROP TABLE chunks_vec");
      database.exec(`CREATE VIRTUAL TABLE chunks_vec USING vec0(
        project text partition key,
        enabled integer,
        is_current integer,
        kind text,
        embedding float[${config.embeddingDim}]
      )`);
      if (sameDim) {
        database.prepare(
          "INSERT INTO chunks_vec(rowid, project, enabled, is_current, kind, embedding) SELECT rowid, project, enabled, is_current, kind, embedding FROM chunks_vec_backup"
        ).run();
        database.exec("DROP TABLE chunks_vec_backup");
      } else {
        console.warn("[hub] embedding dimension changed; chunk vectors were cleared and require reindex");
      }
    } else if (!chunkSql) {
      database.exec(`CREATE VIRTUAL TABLE chunks_vec USING vec0(
        project text partition key,
        enabled integer,
        is_current integer,
        kind text,
        embedding float[${config.embeddingDim}]
      )`);
    }
  })();
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
  // Eşzamanlı yazma (sync + hook + web) SQLITE_BUSY üretebilir — kısa bekleme çökme yerine sıraya sokar.
  db.pragma("busy_timeout = 5000");
  // Vektör/FTS aramaları sayfa-yoğun: daha büyük page cache (negatif = KiB, ~64MB) + mmap okuma.
  db.pragma("cache_size = -65536");
  db.pragma("mmap_size = 268435456");

  try {
    // require: sqlite-vec CJS dağıtılıyor
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(db);
    vecAvailable = true;
  } catch (err) {
    vecAvailable = false;
    vecErrorMsg = `${(err as Error).message} (tespit: ${new Date().toISOString()})`;
    console.error(`[hub] sqlite-vec yüklenemedi, vektör arama kapalı: ${(err as Error).message}`);
  }

  db.exec(SCHEMA);
  migrate(db);

  if (vecAvailable) {
    ensureVectorSchema(db);
    ensureEmbeddingGeneration(db);
  }
  return db;
}

export function hasVec(): boolean {
  getDb();
  return vecAvailable;
}

/** sqlite-vec yüklenemediyse hata mesajı + tespit zamanı; her şey yolundaysa null. */
export function vecError(): string | null {
  getDb();
  return vecErrorMsg;
}

export interface EmbeddingGenerationState {
  configured: string;
  active: string | null;
  provenance: string | null;
  reindex_required: boolean;
}

export function embeddingGenerationState(): EmbeddingGenerationState {
  const database = getDb();
  return {
    configured: configuredEmbeddingGeneration(),
    active: getMetadata(database, "active_embedding_generation"),
    provenance: getMetadata(database, "embedding_generation_provenance"),
    reindex_required: getMetadata(database, "embedding_reindex_required") === "1",
  };
}

export function vectorIndexReady(): boolean {
  if (!hasVec()) return false;
  const state = embeddingGenerationState();
  return !state.reindex_required && state.active === state.configured;
}

export function markEmbeddingGenerationReady(provenance = "reindexed"): void {
  const database = getDb();
  setMetadata(database, "active_embedding_generation", configuredEmbeddingGeneration());
  setMetadata(database, "configured_embedding_generation", configuredEmbeddingGeneration());
  setMetadata(database, "embedding_generation_provenance", provenance);
  setMetadata(database, "embedding_reindex_required", "0");
}

/**
 * Insert or replace one memory vector with retrieval-time partition + lifecycle metadata.
 * `isCurrent` mirrors `putChunkVector`'s `isCurrent` argument (ADR-006): the filter must
 * run inside the KNN via vec0 metadata, not as a post-top-k pass.
 */
export function putMemoryVector(
  rowid: number,
  project: string | null | undefined,
  isCurrent: boolean | number,
  embedding: Buffer
): void {
  if (!hasVec()) return;
  if (embedding.byteLength !== config.embeddingDim * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`memory vector dimension mismatch: ${embedding.byteLength} bytes`);
  }
  const database = getDb();
  database.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(BigInt(rowid));
  database
    .prepare("INSERT INTO memories_vec(rowid, project, is_current, embedding) VALUES (?, ?, ?, ?)")
    .run(BigInt(rowid), vectorProject(project), BigInt(isCurrent ? 1 : 0), embedding);
}

/** Insert or replace one chunk vector with project and lifecycle metadata. */
export function putChunkVector(
  rowid: number,
  project: string | null | undefined,
  enabled: boolean | number,
  isCurrent: boolean | number,
  embedding: Buffer,
  kind = "reference"
): void {
  if (!hasVec()) return;
  if (embedding.byteLength !== config.embeddingDim * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`chunk vector dimension mismatch: ${embedding.byteLength} bytes`);
  }
  const database = getDb();
  database.prepare("DELETE FROM chunks_vec WHERE rowid = ?").run(BigInt(rowid));
  database
    .prepare("INSERT INTO chunks_vec(rowid, project, enabled, is_current, kind, embedding) VALUES (?, ?, ?, ?, ?, ?)")
    .run(BigInt(rowid), vectorProject(project), BigInt(enabled ? 1 : 0), BigInt(isCurrent ? 1 : 0), kind, embedding);
}

export function closeDb(): void {
  if (db) {
    // Sorgu planlayıcı istatistiklerini güncel tut (ANALYZE'ın hafif, artımlı hali).
    try {
      db.pragma("optimize");
    } catch {
      /* kapatmayı engelleme */
    }
  }
  db?.close();
  db = null;
}
