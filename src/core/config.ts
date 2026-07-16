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

const deploymentProfile = (() => {
  const value = process.env.HUB_DEPLOYMENT_PROFILE ?? "personal";
  if (!["personal", "team", "enterprise"].includes(value)) {
    throw new Error("HUB_DEPLOYMENT_PROFILE must be personal, team, or enterprise");
  }
  return value as "personal" | "team" | "enterprise";
})();

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be one of: true/false, 1/0, yes/no, on/off`);
}

function envNumber(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {}
): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  if (opts.integer && !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  if (opts.min !== undefined && value < opts.min) throw new Error(`${name} must be >= ${opts.min}`);
  if (opts.max !== undefined && value > opts.max) throw new Error(`${name} must be <= ${opts.max}`);
  return value;
}

export const config = {
  deploymentProfile,
  dbPath: process.env.HUB_DB_PATH ?? "./data/hub.db",
  host: process.env.HUB_HOST ?? "127.0.0.1",
  port: envNumber("HUB_PORT", 8033, { min: 1, max: 65535, integer: true }),
  token: process.env.HUB_TOKEN ?? "",
  allowLegacyAdmin: envBool("HUB_ALLOW_LEGACY_ADMIN", deploymentProfile === "personal"),
  vectorBackend: (() => {
    const value = process.env.HUB_VECTOR_BACKEND ?? "sqlite-vec";
    if (!["sqlite-vec", "qdrant"].includes(value)) {
      throw new Error("HUB_VECTOR_BACKEND must be sqlite-vec or qdrant");
    }
    return value as "sqlite-vec" | "qdrant";
  })(),
  qdrantUrl: (() => {
    const value = (process.env.HUB_QDRANT_URL ?? "").trim().replace(/\/+$/, "");
    if (!value) return "";
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("HUB_QDRANT_URL must be an absolute http(s) URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("HUB_QDRANT_URL must use http or https");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("HUB_QDRANT_URL must not contain credentials, query parameters, or fragments");
    }
    return value;
  })(),
  qdrantApiKey: process.env.HUB_QDRANT_API_KEY ?? "",
  qdrantCollectionPrefix: (() => {
    const value = process.env.HUB_QDRANT_COLLECTION_PREFIX ?? "mnema";
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(value)) {
      throw new Error("HUB_QDRANT_COLLECTION_PREFIX must match [a-zA-Z0-9_-]{1,48}");
    }
    return value;
  })(),
  qdrantTimeoutMs: envNumber("HUB_QDRANT_TIMEOUT_MS", 3000, { min: 100, max: 60_000, integer: true }),
  qdrantBatchSize: envNumber("HUB_QDRANT_BATCH_SIZE", 128, { min: 1, max: 1000, integer: true }),
  qdrantFlushIntervalMs: envNumber("HUB_QDRANT_FLUSH_INTERVAL_MS", 2000, { min: 100, max: 60_000, integer: true }),
  // Enterprise profile: reject memory/document/session writes that reference a
  // project without a canonical project map. Disabled during legacy cleanup.
  strictProjects: envBool("HUB_STRICT_PROJECTS", deploymentProfile !== "personal"),
  allowQueryToken: envBool("HUB_ALLOW_QUERY_TOKEN", deploymentProfile === "personal"),
  rateLimitPerMinute: envNumber("HUB_RATE_LIMIT_PER_MINUTE", deploymentProfile === "personal" ? 120 : 600, { min: 1, max: 100_000, integer: true }),
  // Transition switch for peers that have not yet added embedding_generation
  // to sync payloads. Disable after every peer runs the generation-aware release.
  acceptLegacyVectors: envBool("HUB_ACCEPT_LEGACY_VECTORS", deploymentProfile === "personal"),
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  embeddingDim: envNumber("EMBEDDING_DIM", 768, { min: 1, max: 65_536, integer: true }),
  embeddingModel: process.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
  // Alaka eşiği: normalize vektörlerde L2 mesafesi (0.86 ≈ cos 0.63).
  // Ölçüm: gerçek eşleşmeler cos 0.70+, alakasızlar 0.51-0.59 (scripts/debug-dist kalibrasyonu)
  vecMaxDistance: envNumber("VEC_MAX_DISTANCE", 0.86, { min: 0, max: 2 }),
  // Kayıt anında benzerlik uyarısı eşiği: bundan yakın mesafedeki hafızalar dedup adayı sayılır.
  dupDistance: envNumber("HUB_DUP_DISTANCE", 0.35, { min: 0, max: 2 }),
  // Candidate count per retrieval channel after native project/lifecycle filters.
  // sqlite-vec JSON-tag/temporal gaps use bounded oversampling inside search.ts.
  searchCandidates: envNumber("HUB_SEARCH_CANDIDATES", 40, { min: 1, max: 5000, integer: true }),
  // Local-first eşitleme: tanımlıysa bu instance, primary (Pi) ile periyodik eşitlenir.
  // Virgülle ayrılmış çoklu adres desteklenir (örn. Tailscale + LAN yedeği):
  // "http://100.x:8033,http://192.168.1.53:8033" — sırayla denenir, ilk erişilebilenle çalışılır.
  primaryUrls: (process.env.HUB_PRIMARY_URL ?? "")
    .split(",")
    .map((u) => u.trim().replace(/\/$/, ""))
    .filter((u) => u.length > 0),
  primaryToken: process.env.HUB_PRIMARY_TOKEN ?? "",
  syncIntervalSec: envNumber("HUB_SYNC_INTERVAL", 1, { min: 1, max: 86_400, integer: true }),
  // Local writes remain authoritative immediately; this controls how quickly
  // they are mirrored to the primary after a burst of writes.
  syncDebounceMs: envNumber("HUB_SYNC_DEBOUNCE_MS", 250, { min: 0, max: 60_000, integer: true }),
  // Recall skorlamasında güncellik decay yarı ömrü (gün). Büyütmek eski kayıtları daha uzun canlı tutar.
  decayHalflifeDays: envNumber("HUB_DECAY_HALFLIFE_DAYS", 90, { min: 1, max: 36_500 }),
  // Decay taban değeri: skor çarpanı asla bunun altına inmez. Eski bilgi (1 yıl önceki
  // çözüm gibi) tazelere göre geriye düşer ama hiçbir zaman aranamaz hale gelmez.
  decayFloor: envNumber("HUB_DECAY_FLOOR", 0.25, { min: 0, max: 1 }),
  // --- Auto-recall hassasiyet ayarları (sadece recall/hook yolunu etkiler; memory_search geniş kalır) ---
  // Göreli eşik: en yüksek skorun bu oranının altındaki adaylar enjekte edilmez.
  recallMinRatio: envNumber("HUB_RECALL_MIN_RATIO", 0.45, { min: 0, max: 1 }),
  // Enjeksiyon üst sınırları: az ve isabetli > çok ve gürültülü.
  recallMaxMemories: envNumber("HUB_RECALL_MAX_MEMORIES", 3, { min: 0, max: 50, integer: true }),
  recallMaxChunks: envNumber("HUB_RECALL_MAX_CHUNKS", 2, { min: 0, max: 50, integer: true }),
  // Proje yakınlığı: aktif projeyle eşleşen kayıt yükselir, başka projenin kaydı geriler
  // (project=null olan global kayıtlar cezasız kalır).
  recallProjectBoost: envNumber("HUB_RECALL_PROJECT_BOOST", 1.25, { min: 0, max: 10 }),
  recallForeignPenalty: envNumber("HUB_RECALL_FOREIGN_PENALTY", 0.5, { min: 0, max: 10 }),
  // Tek kanallı eşleşme cezası: sadece FTS (anahtar kelime) bulduysa gürültü olasılığı
  // yüksek — iki kanalın (FTS+vektör) anlaştığı kayıtlar öne geçer.
  recallSingleSourcePenalty: envNumber("HUB_RECALL_SINGLE_SOURCE_PENALTY", 0.6, { min: 0, max: 10 }),
  // Agent presence advisory sinyali: bu süreden eski heartbeat "stale" (muhtemelen düşmüş) sayılır.
  // Kilit DEĞİL — sadece bridge/agent_active çıktısındaki bir uyarı eşiği.
  presenceTtlMin: envNumber("HUB_PRESENCE_TTL_MIN", 30, { min: 1, max: 10_080, integer: true }),
};

if (config.vectorBackend === "qdrant" && !config.qdrantUrl) {
  throw new Error("HUB_VECTOR_BACKEND=qdrant requires HUB_QDRANT_URL");
}

/** Fail closed when a shared/company profile is configured unsafely. */
export function assertDeploymentSafety(): void {
  if (config.deploymentProfile === "personal") return;
  const scopedPolicies = process.env.HUB_AUTH_TOKENS?.trim();
  if (!scopedPolicies) throw new Error(`${config.deploymentProfile} profile requires HUB_AUTH_TOKENS`);
  if (config.token && !config.allowLegacyAdmin) {
    throw new Error("HUB_TOKEN is a legacy all-powerful token; remove it or explicitly enable HUB_ALLOW_LEGACY_ADMIN during migration");
  }
  if (config.allowQueryToken) throw new Error(`${config.deploymentProfile} profile requires HUB_ALLOW_QUERY_TOKEN=false`);
  if (!config.strictProjects) throw new Error(`${config.deploymentProfile} profile requires HUB_STRICT_PROJECTS=true`);
  if (config.acceptLegacyVectors) throw new Error(`${config.deploymentProfile} profile requires HUB_ACCEPT_LEGACY_VECTORS=false`);
  if (config.primaryUrls.length > 0) {
    throw new Error(`${config.deploymentProfile} profile is server-authoritative and must not configure HUB_PRIMARY_URL`);
  }
  const localQdrant = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|$)/i.test(config.qdrantUrl);
  if (config.vectorBackend === "qdrant" && config.qdrantUrl.startsWith("http://") && !localQdrant) {
    throw new Error(`${config.deploymentProfile} profile requires HTTPS for a non-local Qdrant endpoint`);
  }
  if (config.vectorBackend === "qdrant" && !localQdrant && !config.qdrantApiKey) {
    throw new Error(`${config.deploymentProfile} profile requires HUB_QDRANT_API_KEY for a non-local Qdrant endpoint`);
  }
}
