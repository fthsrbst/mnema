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
    process.env[key] = raw.replace(/^["']|["']$/g, "");
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
};
