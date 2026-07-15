/**
 * Opens a SQLite backup with the current schema migrator and reports invariants.
 * Always run this against a copy, never the only production database file.
 */
const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: npx tsx scripts/migration-audit.ts <db-copy>");
process.env.HUB_DB_PATH = dbPath;

const { closeDb, embeddingGenerationState, getDb, knowledgeIntegrity } = await import("../src/core/index.js");
const db = getDb();
const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
const sqlFor = (name: string): string =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string }).sql;

try {
  console.log(
    JSON.stringify(
      {
        db_path: dbPath,
        integrity: (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
        memories: count("SELECT COUNT(*) AS n FROM memories"),
        chunks: count("SELECT COUNT(*) AS n FROM chunks"),
        memory_vectors: count("SELECT COUNT(*) AS n FROM memories_vec"),
        chunk_vectors: count("SELECT COUNT(*) AS n FROM chunks_vec"),
        current_documents: count("SELECT COUNT(*) AS n FROM documents WHERE enabled = 1 AND is_current = 1"),
        vector_outbox: count("SELECT COUNT(*) AS n FROM vector_outbox"),
        memory_vec_schema: sqlFor("memories_vec"),
        chunk_vec_schema: sqlFor("chunks_vec"),
        memory_fts_schema: sqlFor("memories_fts"),
        embedding_generation: embeddingGenerationState(),
        deletion_primary_key: (db.prepare("PRAGMA table_info(deletions)").all() as { name: string; pk: number }[])
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => column.name),
        vector_outbox_primary_key: (db.prepare("PRAGMA table_info(vector_outbox)").all() as { name: string; pk: number }[])
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => column.name),
        vector_outbox_revision: (db.prepare("PRAGMA table_info(vector_outbox)").all() as { name: string }[])
          .some((column) => column.name === "revision"),
        knowledge_integrity: knowledgeIntegrity(),
      },
      null,
      2
    )
  );
} finally {
  closeDb();
}
