/**
 * Reproducible local filtered-ANN/FTS growth benchmark.
 * Example: npm run benchmark:vector -- --rows=100000 --queries=200 --projects=50 --dim=768
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

function argNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

const rows = argNumber("rows", 10_000, 100, 2_000_000);
const queryCount = argNumber("queries", 100, 1, 10_000);
const projects = argNumber("projects", 20, 1, 10_000);
const dimension = argNumber("dim", 768, 3, 4096);
const gate = process.argv.includes("--gate");
const maxP95Ms = Number(process.env.HUB_BENCH_MAX_P95_MS ?? "100");
const minRecall = Number(process.env.HUB_BENCH_MIN_RECALL_AT_10 ?? "1");
if (!Number.isFinite(maxP95Ms) || maxP95Ms <= 0) throw new Error("HUB_BENCH_MAX_P95_MS must be positive");
if (!Number.isFinite(minRecall) || minRecall < 0 || minRecall > 1) throw new Error("HUB_BENCH_MIN_RECALL_AT_10 must be 0..1");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnema-vector-bench-"));
const dbPath = path.join(tempDir, "hub.db");
process.env.HUB_DB_PATH = dbPath;
process.env.HUB_DEPLOYMENT_PROFILE = "personal";
process.env.HUB_VECTOR_BACKEND = "sqlite-vec";
process.env.EMBEDDING_DIM = String(dimension);
process.env.GEMINI_API_KEY = "";

const { closeDb, getDb, vectorStore } = await import("../src/core/index.js");
const { ftsSearch } = await import("../src/core/search.js");

function seededVector(seed: number): Buffer {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  const values = new Float32Array(dimension);
  let norm = 0;
  for (let i = 0; i < dimension; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const value = ((state >>> 0) / 0xffffffff) * 2 - 1;
    values[i] = value;
    norm += value * value;
  }
  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < dimension; i++) values[i] *= scale;
  return Buffer.from(values.buffer);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

try {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO memories(uid, type, title, body, project, tags, source)
     VALUES (?, 'fact', ?, ?, ?, '[]', 'vector-benchmark')`
  );
  const insertStarted = performance.now();
  const batchSize = 500;
  for (let start = 1; start <= rows; start += batchSize) {
    const end = Math.min(rows, start + batchSize - 1);
    db.transaction(() => {
      for (let id = start; id <= end; id++) {
        const project = `bench-${id % projects}`;
        insert.run(`bench${String(id).padStart(24, "0")}`, `Benchmark memory ${id}`, `needle${id} synthetic corpus row`, project);
        vectorStore.putMemory(id, project, seededVector(id));
      }
    })();
  }
  const insertMs = performance.now() - insertStarted;

  const vectorLatencies: number[] = [];
  const ftsLatencies: number[] = [];
  let vectorHits = 0;
  let ftsHits = 0;
  for (let i = 0; i < queryCount; i++) {
    const id = 1 + Math.floor((i * rows) / queryCount);
    const project = `bench-${id % projects}`;
    let started = performance.now();
    const hits = await vectorStore.search("memory", seededVector(id), 10, { project });
    vectorLatencies.push(performance.now() - started);
    if (hits.some((hit) => hit.id === id)) vectorHits++;

    started = performance.now();
    const ftsHitsForQuery = ftsSearch("memories_fts", `needle${id}`, 10, { project });
    ftsLatencies.push(performance.now() - started);
    if (ftsHitsForQuery.includes(id)) ftsHits++;
  }

  const report = {
    backend: vectorStore.backend,
    rows,
    projects,
    dimension,
    queries: queryCount,
    insert_seconds: Number((insertMs / 1000).toFixed(3)),
    insert_rows_per_second: Number((rows / (insertMs / 1000)).toFixed(1)),
    vector_recall_at_10: vectorHits / queryCount,
    fts_recall_at_10: ftsHits / queryCount,
    vector_latency_ms: {
      p50: Number(percentile(vectorLatencies, 0.5).toFixed(3)),
      p95: Number(percentile(vectorLatencies, 0.95).toFixed(3)),
      max: Number(Math.max(...vectorLatencies).toFixed(3)),
    },
    fts_latency_ms: {
      p50: Number(percentile(ftsLatencies, 0.5).toFixed(3)),
      p95: Number(percentile(ftsLatencies, 0.95).toFixed(3)),
      max: Number(Math.max(...ftsLatencies).toFixed(3)),
    },
    database_mb: Number((fs.statSync(dbPath).size / 1024 / 1024).toFixed(2)),
    rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
    gate: gate ? { max_p95_ms: maxP95Ms, min_recall_at_10: minRecall } : null,
  };
  console.log(JSON.stringify(report, null, 2));
  if (gate && (report.vector_latency_ms.p95 > maxP95Ms || report.vector_recall_at_10 < minRecall || report.fts_recall_at_10 < minRecall)) {
    console.error("Vector benchmark gate failed.");
    process.exitCode = 1;
  }
} finally {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
