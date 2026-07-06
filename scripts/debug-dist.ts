process.env.HUB_DB_PATH = `./data/dist-${Date.now()}.db`;
import fs from "node:fs";
const { getDb, closeDb } = await import("../src/core/db.js");
const { embed, embedOne, toBuffer } = await import("../src/core/embeddings.js");

const db = getDb();
const docs = [
  "Gemini embedding API'si batchEmbedContents ucunu kullanır. Rate limit 429 döner, backoff gerekir.",
  "SQLite WAL modu eşzamanlı okumaları hızlandırır, tek yazar kuralı devam eder.",
  "Raspberry Pi üzerinde systemd servisi kurulumu: unit dosyası ve enable komutu.",
  "Pasta tarifi: un, şeker, yumurta ve kabartma tozu karıştırılır, 180 derecede pişirilir.",
];
const vecs = (await embed(docs, "RETRIEVAL_DOCUMENT"))!;
const ins = db.prepare("INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)");
vecs.forEach((v, i) => ins.run(BigInt(i + 1), toBuffer(v)));

const queries = [
  "api rate limit nasıl aşılır",          // doc1 ile güçlü ilişkili
  "veritabanı eşzamanlılık",              // doc2 ile ilişkili
  "kek nasıl yapılır",                    // doc4 ile ilişkili
  "futbol maçı skoru",                    // alakasız
  "xyzzy qqqwww zzzyyy",                  // saçma
];
for (const q of queries) {
  const qv = (await embedOne(q, "RETRIEVAL_QUERY"))!;
  const rows = db
    .prepare("SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 4 ORDER BY distance")
    .all(toBuffer(qv)) as { rowid: number; distance: number }[];
  console.log(`\n"${q}"`);
  for (const r of rows) console.log(`  doc${r.rowid}: dist=${r.distance.toFixed(3)} (cos=${(1 - r.distance ** 2 / 2).toFixed(3)}) — ${docs[r.rowid - 1].slice(0, 50)}`);
}
closeDb();
fs.rmSync(process.env.HUB_DB_PATH!, { force: true });
