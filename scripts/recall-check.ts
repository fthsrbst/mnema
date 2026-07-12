/**
 * Gerçek DB üzerinde recall/bridge kalite kontrolü (yazma yok, sadece skorlama).
 * Kullanım: npx tsx scripts/recall-check.ts "<sorgu>" [cwd]
 */
const query = process.argv[2] ?? "test";
const cwd = process.argv[3];
const { recall, formatRecall, bridge } = await import("../src/core/index.js");

const res = await recall(query, undefined, cwd);
console.log(`--- recall (project=${res.project ?? "yok"}) ---`);
for (const m of res.memories) console.log(`mem #${m.id} score=${m.score.toFixed(4)} channels=${m.channels?.join("+")} ${m.title.slice(0, 50)}`);
for (const c of res.chunks) console.log(`chunk #${c.chunk_id} score=${c.score.toFixed(4)} channels=${c.channels?.join("+")} ${c.document_title.slice(0, 50)}`);
console.log(formatRecall(res) || "(boş — eşiği geçen kayıt yok)");
if (cwd) {
  console.log("\n--- bridge ---");
  console.log(bridge(cwd) || "(boş — cwd proje map'ine çözülemedi)");
}
