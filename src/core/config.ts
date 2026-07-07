import fs from "node:fs";
import path from "node:path";

function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    let value = raw.trim();
    if (/^["']/.test(value)) {
      value = value.replace(/^(["'])(.*?)\1.*$/, "$2");
    } else {
      value = value.replace(/(^|\s)#.*$/, "").trim(); // satır içi/başı yorumu at
    }
    process.env[key] = value;
  }
}
loadDotEnv();

export const config = {
  dbPath: process.env.HUB_DB_PATH ?? "./data/hub.db",
  host: process.env.HUB_HOST ?? "127.0.0.1",
  port: Number(process.env.HUB_PORT ?? 8033),
  token: process.env.HUB_TOKEN ?? "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  embeddingDim: Number(process.env.EMBEDDING_DIM ?? 768),
  embeddingModel: process.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
  // Alaka eşiği: normalize vektörlerde L2 mesafesi (0.86 ≈ cos 0.63).
  // Ölçüm: gerçek eşleşmeler cos 0.70+, alakasızlar 0.51-0.59 (scripts/debug-dist kalibrasyonu)
  vecMaxDistance: Number(process.env.VEC_MAX_DISTANCE ?? 0.86),
  // Local-first eşitleme: tanımlıysa bu instance, primary (Pi) ile periyodik eşitlenir.
  // Virgülle ayrılmış çoklu adres desteklenir (örn. Tailscale + LAN yedeği):
  // "http://100.x:8033,http://192.168.1.53:8033" — sırayla denenir, ilk erişilebilenle çalışılır.
  primaryUrls: (process.env.HUB_PRIMARY_URL ?? "")
    .split(",")
    .map((u) => u.trim().replace(/\/$/, ""))
    .filter((u) => u.length > 0),
  primaryToken: process.env.HUB_PRIMARY_TOKEN ?? "",
  syncIntervalSec: Number(process.env.HUB_SYNC_INTERVAL ?? 60),
  // Recall skorlamasında güncellik decay yarı ömrü (gün). Büyütmek eski kayıtları daha uzun canlı tutar.
  decayHalflifeDays: Number(process.env.HUB_DECAY_HALFLIFE_DAYS ?? 90),
};
