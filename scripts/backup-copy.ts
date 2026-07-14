/** Create a transactionally consistent SQLite online backup for verification. */
import path from "node:path";
import Database from "better-sqlite3";

const source = process.argv[2];
const destination = process.argv[3];
if (!source || !destination) {
  throw new Error("usage: npx tsx scripts/backup-copy.ts <source.db> <destination.db>");
}
if (path.resolve(source) === path.resolve(destination)) throw new Error("backup destination must differ from source");

const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(destination);
  const backup = new Database(destination, { readonly: true });
  const integrity = (backup.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  backup.close();
  if (integrity !== "ok") throw new Error(`backup integrity_check failed: ${integrity}`);
  console.log(JSON.stringify({ ok: true, destination, integrity }));
} finally {
  db.close();
}
