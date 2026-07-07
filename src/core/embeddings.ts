import { config } from "./config.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const BATCH_SIZE = 100;

export type EmbedTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export function embeddingsEnabled(): boolean {
  return config.geminiApiKey.length > 0;
}

function normalize(v: number[]): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

async function callBatch(texts: string[], taskType: EmbedTask): Promise<Float32Array[]> {
  const model = `models/${config.embeddingModel}`;
  const url = `${API_BASE}/${model}:batchEmbedContents?key=${config.geminiApiKey}`;
  const body = {
    requests: texts.map((text) => ({
      model,
      content: { parts: [{ text: text.slice(0, 30000) }] },
      taskType,
      outputDimensionality: config.embeddingDim,
    })),
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Gemini embedding hatası ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { embeddings: { values: number[] }[] };
    return data.embeddings.map((e) => normalize(e.values));
  }
  throw new Error("Gemini embedding: 3 denemede yanıt alınamadı (rate limit / sunucu hatası)");
}

/** Metinleri embed eder. API key yoksa null döner (FTS-only moda düşülür). */
export async function embed(texts: string[], taskType: EmbedTask): Promise<Float32Array[] | null> {
  if (!embeddingsEnabled() || texts.length === 0) return embeddingsEnabled() ? [] : null;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    out.push(...(await callBatch(texts.slice(i, i + BATCH_SIZE), taskType)));
  }
  return out;
}

export async function embedOne(text: string, taskType: EmbedTask): Promise<Float32Array | null> {
  const res = await embed([text], taskType);
  return res?.[0] ?? null;
}

export function toBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
