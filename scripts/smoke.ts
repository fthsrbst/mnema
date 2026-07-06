/**
 * Uçtan uca smoke test: geçici DB ile core fonksiyonları doğrular.
 * GEMINI_API_KEY yoksa FTS-only yolda çalışır (beklenen davranış).
 */
process.env.HUB_DB_PATH = `./data/smoke-${Date.now()}.db`;

import fs from "node:fs";
import {
  addDocument,
  addSessionLog,
  closeDb,
  deleteMemory,
  embeddingsEnabled,
  getProject,
  hasVec,
  recall,
  formatRecall,
  saveMemory,
  searchChunks,
  searchMemories,
  upsertProject,
} from "../src/core/index.js";

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
}

const mem = await saveMemory({
  type: "decision",
  title: "Vector DB olarak sqlite-vec seçildi",
  body: "Qdrant yerine sqlite-vec: tek dosya, sıfır operasyon yükü. Pi 5 için yeterli.",
  project: "ai-hub",
  tags: ["architecture"],
  source: "smoke",
});
check("memory_save", mem.id > 0, `id=${mem.id}, vec=${hasVec()}, embeddings=${embeddingsEnabled()}`);

const hits = await searchMemories("qdrant sqlite vektör");
check("memory_search (hibrit/FTS)", hits.length > 0 && hits[0].id === mem.id);

const filtered = await searchMemories("sqlite", { project: "yok-boyle-proje" });
check("memory_search proje filtresi", filtered.length === 0);

const doc = await addDocument({
  title: "Test notu",
  text: "# Embedding\n\nGemini embedding API'si batchEmbedContents ucunu kullanır. Normalizasyon 768 boyutta şarttır.\n\n## Tuzaklar\n\nRate limit 429 döner, backoff gerekir. Türkçe karakterler unicode61 tokenizer ile aranabilir.",
  uri: "smoke/test-notu",
  project: "learning",
  source: "smoke",
});
check("rag_add", doc.chunk_count > 0, `${doc.chunk_count} chunk, embedded=${doc.embedded}`);

const chunks = await searchChunks("rate limit backoff");
check("rag_search", chunks.length > 0 && chunks[0].document_title === "Test notu");

await addDocument({ title: "Test notu v2", text: "# Güncel\n\nYeni içerik burada, eskisi silinmiş olmalı. Anahtar kelime: zümrüdüanka.", uri: "smoke/test-notu" });
const oldGone = (await searchChunks("rate limit backoff")).length === 0;
const newFound = (await searchChunks("zümrüdüanka")).some((c) => c.document_title === "Test notu v2");
check("rag_add re-index (aynı uri)", oldGone && newFound, `eski silindi=${oldGone}, yeni bulundu=${newFound}`);

upsertProject({ name: "ai-hub", status: "active", summary: "Ortak hafıza sistemi", current_focus: "Faz 1" });
upsertProject({ name: "ai-hub", current_focus: "Faz 2" });
const proj = getProject("ai-hub");
check("project upsert+merge", proj?.current_focus === "Faz 2" && proj?.summary === "Ortak hafıza sistemi");

const log = addSessionLog("Smoke test oturumu", "ai-hub", "smoke");
check("session_log", log.id > 0);

const rec = await recall("sqlite vektör kararı");
const recText = formatRecall(rec);
check("recall + format", rec.memories.length > 0 && recText.includes("<hub-recall>"));

const emptyRec = formatRecall(await recall("xyzzy qqqwww zzzyyy"));
check("recall boş sonuç → boş string", emptyRec === "");

check("memory_delete", deleteMemory(mem.id) && (await searchMemories("qdrant sqlite")).every((m) => m.id !== mem.id));

closeDb();
fs.rmSync(process.env.HUB_DB_PATH!, { force: true });
fs.rmSync(process.env.HUB_DB_PATH! + "-wal", { force: true });
fs.rmSync(process.env.HUB_DB_PATH! + "-shm", { force: true });

console.log(failed === 0 ? "\nTüm smoke testleri geçti." : `\n${failed} test BAŞARISIZ`);
process.exit(failed === 0 ? 0 : 1);
