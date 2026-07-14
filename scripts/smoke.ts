/**
 * Uçtan uca smoke test: geçici DB ile core fonksiyonları doğrular.
 * GEMINI_API_KEY yoksa FTS-only yolda çalışır (beklenen davranış).
 */
// ESM import hoisting'e takılmamak için: önce env, sonra dinamik import
process.env.HUB_DB_PATH = `./data/smoke-${Date.now()}.db`;

import fs from "node:fs";
const {
  addDocument,
  addRecallFeedback,
  addSessionLog,
  extractFileText,
  applyChanges,
  bridge,
  closeDb,
  contentFingerprint,
  deleteMemory,
  embedOne,
  feedbackSummary,
  getMemory,
  listMemories,
  listRecallFeedback,
  embeddingsEnabled,
  getProject,
  hasVec,
  recall,
  formatRecall,
  resolveProjectFromPath,
  resolveRelated,
  saveMemory,
  searchChunks,
  searchMemories,
  updateMemory,
  upsertProject,
  usageStats,
} = await import("../src/core/index.js");

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

// kod haritası alanları: merge ile saklanır, bridge çıktısına girer
upsertProject({
  name: "ai-hub",
  architecture: "Core kütüphane + Express sunucu.",
  modules: [{ name: "core/search", path: "src/core/search.ts", purpose: "Hibrit arama (FTS+vec, RRF)." }],
  entry_points: { server: "src/server/index.ts" },
  commands: { dev: "npm run dev" },
});
const projMap = getProject("ai-hub");
check(
  "project kod haritası merge",
  projMap?.modules?.[0]?.name === "core/search" && projMap?.current_focus === "Faz 2"
);

const log = addSessionLog("Smoke test oturumu", "ai-hub", "smoke");
check("session_log", log.id > 0);

const rec = await recall("sqlite vektör kararı");
const recText = formatRecall(rec);
check("recall + format", rec.memories.length > 0 && recText.includes("<hub-recall>"));

const emptyRec = formatRecall(await recall("xyzzy qqqwww zzzyyy"));
check("recall boş sonuç → boş string", emptyRec === "");

// recall hassasiyet filtresi: yabancı projenin zayıf eşleşmesi, aktif projenin
// güçlü eşleşmesi varken enjekte edilmemeli
const foreign = await saveMemory({
  type: "context",
  title: "Başka projenin sqlite notu",
  body: "sqlite hakkında alakasız bir not — yabancı proje gürültüsü.",
  project: "baska-proje",
  source: "smoke",
});
const scopedRec = await recall("sqlite vektör kararı", undefined, "C:\\Users\\test\\dev\\ai-hub");
check(
  "recall proje yakınlığı (cwd çözümü + yabancı proje cezası)",
  scopedRec.project === "ai-hub" && scopedRec.memories.some((m) => m.id === mem.id),
  `project=${scopedRec.project}, ids=[${scopedRec.memories.map((m) => m.id).join(",")}]`
);
check(
  "recall enjeksiyon sınırı",
  scopedRec.memories.length <= 3 && scopedRec.chunks.length <= 2,
  `mem=${scopedRec.memories.length}, chunk=${scopedRec.chunks.length}`
);
deleteMemory(foreign.id);

// cwd → proje çözümü
check("resolveProjectFromPath segment eşleşmesi", resolveProjectFromPath("/home/fatih/ai-hub/src") === "ai-hub");
check("resolveProjectFromPath bilinmeyen yol → null", resolveProjectFromPath("C:\\tmp\\rastgele-klasor") === null);

// oturum köprüsü: map + son oturum özeti döner; çözülemeyen cwd'de susar
const bridgeText = bridge("/home/fatih/ai-hub");
check(
  "bridge proje map'i + son oturum",
  bridgeText.includes("<hub-bridge>") && bridgeText.includes("ai-hub") && bridgeText.includes("Smoke test oturumu"),
  bridgeText.slice(0, 80).replaceAll("\n", " ")
);
check(
  "bridge kod haritası enjeksiyonu",
  bridgeText.includes("Kod haritası:") && bridgeText.includes("core/search") && bridgeText.includes("Giriş noktaları:"),
  bridgeText.split("\n").find((l) => l.includes("core/search")) ?? "?"
);
check("bridge çözülemeyen cwd → boş", bridge("C:\\tmp\\rastgele-klasor") === "");

check("memory_delete", deleteMemory(mem.id) && (await searchMemories("qdrant sqlite")).every((m) => m.id !== mem.id));

// importance: aynı içerikli iki kayıttan yüksek önemli olan sırada önde çıkmalı
const impA = await saveMemory({
  type: "fact",
  title: "Onem testi A",
  body: "zirkonyum desenli anahtar kelime onem testi",
  tags: ["smoke-importance"],
  source: "smoke",
  importance: 2.0,
});
const impB = await saveMemory({
  type: "fact",
  title: "Onem testi B",
  body: "zirkonyum desenli anahtar kelime onem testi",
  tags: ["smoke-importance"],
  source: "smoke",
  importance: 0.5,
});
const impHits = await searchMemories("zirkonyum desenli anahtar kelime onem");
const aIdx = impHits.findIndex((m) => m.id === impA.id);
const bIdx = impHits.findIndex((m) => m.id === impB.id);
check(
  "memory importance skor sıralamasını etkiliyor",
  aIdx !== -1 && bIdx !== -1 && aIdx < bIdx,
  `A(2.0)#${aIdx} B(0.5)#${bIdx}`
);
deleteMemory(impA.id);
deleteMemory(impB.id);

// sync LWW tie-break: eşit updated_at'te içerik parmak izi büyük olan kazanmalı,
// uygulama sırasından bağımsız (iki cihaz aynı kurala göre aynı kazanana yakınsar)
const ts = "2030-01-01 00:00:00.000";
const emptyPayload = { now: ts, memories: [], documents: [], projects: [], sessions: [], machines: [], deletions: [] };
const mkConflict = (body: string) => ({
  uid: "smokeconflict0000000000000000001", type: "fact", title: "Sync çakışma testi", body,
  project: null, tags: "[]", source: "smoke", created_at: ts, updated_at: ts, importance: 1.0,
});
const fp = (body: string) => contentFingerprint(["fact", "Sync çakışma testi", body, null, "[]", "smoke", 1.0, "[]"]);
const winner = fp("versiyon A") > fp("versiyon B") ? "versiyon A" : "versiyon B";
const loser = winner === "versiyon A" ? "versiyon B" : "versiyon A";
applyChanges({ ...emptyPayload, memories: [mkConflict(loser)] });
applyChanges({ ...emptyPayload, memories: [mkConflict(winner)] }); // kazanan ezmeli
applyChanges({ ...emptyPayload, memories: [mkConflict(loser)] }); // kaybeden geri yazamamalı
const conflictRow = listMemories({ limit: 500 }).find((mm) => mm.title === "Sync çakışma testi");
check("sync LWW tie-break deterministik", conflictRow?.body === winner, `beklenen="${winner}", db="${conflictRow?.body}"`);
if (conflictRow) deleteMemory(conflictRow.id);

// dosya upload akışı: PDF fixture'ından metin çıkar + indeksle + ara
const pdfText = await extractFileText(fs.readFileSync("./scripts/fixtures/smoke.pdf"), "smoke.pdf");
check("extract PDF", pdfText.includes("Zumrutanka smoke upload testi"), JSON.stringify(pdfText.slice(0, 60)));
const upDoc = await addDocument({ title: "smoke.pdf", text: pdfText, uri: "upload/smoke.pdf", source: "upload:smoke.pdf" });
const upFound = (await searchChunks("Zumrutanka upload")).some((c) => c.document_title === "smoke.pdf");
check("upload indeks + arama", upDoc.chunk_count > 0 && upFound);
let extRejected = false;
try {
  await extractFileText(Buffer.from("x"), "kotu.exe");
} catch {
  extRejected = true;
}
check("extract desteklenmeyen uzantı reddi", extRejected);

// bağlantılı hafızalar: id → uid saklama, yerel çözüm, recall'da "ilgili" satırı
const linkA = await saveMemory({ type: "fact", title: "Bağlantı hedefi A", body: "bağlantı testi hedef kaydı", source: "smoke" });
const linkB = await saveMemory({
  type: "fact",
  title: "Bağlantı kaynağı B",
  body: "bu kayıt A'ya bağlı",
  source: "smoke",
  related_ids: [linkA.id, 99999], // bilinmeyen id sessizce atlanmalı
});
const storedB = getMemory(linkB.id)!;
const relRefs = resolveRelated(storedB);
check(
  "memory related: uid saklama + yerel çözüm",
  storedB.related.length === 1 && relRefs.length === 1 && relRefs[0].id === linkA.id,
  `related=${JSON.stringify(storedB.related.length)}, çözüm=[${relRefs.map((r) => r.id).join(",")}]`
);
const relText = formatRecall({ memories: [{ ...storedB, score: 1 }], chunks: [] });
check("recall formatı 'ilgili' satırı içeriyor", relText.includes(`ilgili: #${linkA.id} Bağlantı hedefi A`));
const cleared = await updateMemory(linkB.id, { related_ids: [] });
check("memory_update related temizleme", cleared?.related.length === 0);
deleteMemory(linkB.id);
deleteMemory(linkA.id);

// recall geri bildirimi: kayıt + liste + özet
addRecallFeedback({ query: "smoke recall sorgusu", verdict: "noisy", memory_id: 1, note: "alakasız kayıt", source: "smoke" });
addRecallFeedback({ query: "smoke recall sorgusu 2", verdict: "helpful", source: "smoke" });
const fbList = listRecallFeedback({ verdict: "noisy" });
const fbSum = feedbackSummary();
check(
  "recall_feedback kayıt + filtreli liste + özet",
  fbList.length === 1 && fbList[0].note === "alakasız kayıt" && fbSum.reduce((a, s) => a + s.count, 0) === 2,
  `noisy=${fbList.length}, toplam=${fbSum.reduce((a, s) => a + s.count, 0)}`
);

// bayat kayıt raporu: yeni oluşturulan (erişilmemiş) kayıt "bayat" SAYILMAMALI
const freshMem = await saveMemory({ type: "fact", title: "Taze kayıt bayat olmamalı", body: "usage stale testi", source: "smoke" });
const usage = usageStats();
check(
  "usageStats: taze kayıt bayat listesinde değil + importance alanı var",
  usage.stale.every((it) => it.id !== freshMem.id) && usage.top.every((it) => typeof it.importance === "number"),
  `stale=${usage.stale.length}, total=${usage.total}`
);
deleteMemory(freshMem.id);

// sorgu embedding cache'i: aynı sorgu ikinci çağrıda aynı referansı dönmeli (API'ye gitmeden)
if (embeddingsEnabled()) {
  const q1 = await embedOne("smoke cache sorgusu", "RETRIEVAL_QUERY");
  const q2 = await embedOne("  SMOKE cache sorgusu ", "RETRIEVAL_QUERY"); // normalize: trim + lowercase
  check("sorgu embedding LRU cache (referans eşitliği)", q1 !== null && q1 === q2);
} else {
  check("sorgu embedding LRU cache (embedding kapalı — atlandı)", true);
}

closeDb();
fs.rmSync(process.env.HUB_DB_PATH!, { force: true });
fs.rmSync(process.env.HUB_DB_PATH! + "-wal", { force: true });
fs.rmSync(process.env.HUB_DB_PATH! + "-shm", { force: true });

console.log(failed === 0 ? "\nTüm smoke testleri geçti." : `\n${failed} test BAŞARISIZ`);
process.exit(failed === 0 ? 0 : 1);
