/**
 * In-memory metrics collection with Prometheus-compatible output.
 * Tracks requests, latency, errors, embedding calls, and system stats.
 */
import { getDb } from "./db.js";
import { jobStats } from "./worker.js";
import type { MetricsSnapshot } from "./types.js";

interface Counter {
  value: number;
}

interface Histogram {
  values: number[];
  maxSamples: number;
}

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const startTime = Date.now();

function getCounter(name: string): Counter {
  let c = counters.get(name);
  if (!c) {
    c = { value: 0 };
    counters.set(name, c);
  }
  return c;
}

function getHistogram(name: string, maxSamples = 1000): Histogram {
  let h = histograms.get(name);
  if (!h) {
    h = { values: [], maxSamples };
    histograms.set(name, h);
  }
  return h;
}

/** Increment a named counter. */
export function incCounter(name: string, amount = 1): void {
  getCounter(name).value += amount;
}

/** Record a value in a histogram (e.g., latency in ms). */
export function observeHistogram(name: string, value: number): void {
  const h = getHistogram(name);
  h.values.push(value);
  if (h.values.length > h.maxSamples) h.values.shift();
}

/** Record a request with method, path, status, and duration. */
export function recordRequest(method: string, path: string, status: number, durationMs: number): void {
  incCounter("http_requests_total");
  incCounter(`http_requests_${method.toLowerCase()}`);
  if (status >= 500) incCounter("http_errors_5xx");
  else if (status >= 400) incCounter("http_errors_4xx");
  observeHistogram("http_request_duration_ms", durationMs);
}

/** Record an embedding call. */
export function recordEmbeddingCall(count: number, durationMs: number): void {
  incCounter("embedding_calls_total");
  incCounter("embedding_vectors_total", count);
  observeHistogram("embedding_duration_ms", durationMs);
}

/** Record a sync operation. */
export function recordSyncOp(direction: "push" | "pull", success: boolean): void {
  incCounter(`sync_${direction}_total`);
  if (!success) incCounter(`sync_${direction}_errors`);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Get a full metrics snapshot. */
export function getMetricsSnapshot(): MetricsSnapshot {
  const db = getDb();

  const memoryCount = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
  const documentCount = (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
  const taskCount = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  const activeTasks = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('pending', 'claimed', 'in_progress')").get() as { n: number }).n;
  const agentCount = (db.prepare("SELECT COUNT(*) AS n FROM agent_capabilities WHERE status != 'offline'").get() as { n: number }).n;

  const durations = getHistogram("http_request_duration_ms").values;
  const jobs = jobStats();

  return {
    uptime_sec: Math.round((Date.now() - startTime) / 1000),
    requests_total: getCounter("http_requests_total").value,
    errors_5xx: getCounter("http_errors_5xx").value,
    errors_4xx: getCounter("http_errors_4xx").value,
    latency_p50_ms: Math.round(percentile(durations, 50)),
    latency_p95_ms: Math.round(percentile(durations, 95)),
    latency_p99_ms: Math.round(percentile(durations, 99)),
    embedding_calls: getCounter("embedding_calls_total").value,
    memory_count: memoryCount,
    document_count: documentCount,
    task_count: taskCount,
    active_tasks: activeTasks,
    agent_count: agentCount,
    jobs,
  };
}

/** Generate Prometheus-compatible text metrics. */
export function prometheusMetrics(): string {
  const lines: string[] = [];
  const snap = getMetricsSnapshot();

  lines.push("# HELP hub_uptime_seconds Server uptime in seconds");
  lines.push("# TYPE hub_uptime_seconds gauge");
  lines.push(`hub_uptime_seconds ${snap.uptime_sec}`);

  lines.push("# HELP hub_http_requests_total Total HTTP requests");
  lines.push("# TYPE hub_http_requests_total counter");
  lines.push(`hub_http_requests_total ${snap.requests_total}`);

  lines.push("# HELP hub_http_errors_total HTTP errors by class");
  lines.push("# TYPE hub_http_errors_total counter");
  lines.push(`hub_http_errors_total{class="5xx"} ${snap.errors_5xx}`);
  lines.push(`hub_http_errors_total{class="4xx"} ${snap.errors_4xx}`);

  lines.push("# HELP hub_http_request_duration_ms Request latency");
  lines.push("# TYPE hub_http_request_duration_ms summary");
  lines.push(`hub_http_request_duration_ms{quantile="0.5"} ${snap.latency_p50_ms}`);
  lines.push(`hub_http_request_duration_ms{quantile="0.95"} ${snap.latency_p95_ms}`);
  lines.push(`hub_http_request_duration_ms{quantile="0.99"} ${snap.latency_p99_ms}`);

  lines.push("# HELP hub_embedding_calls_total Total embedding API calls");
  lines.push("# TYPE hub_embedding_calls_total counter");
  lines.push(`hub_embedding_calls_total ${snap.embedding_calls}`);

  lines.push("# HELP hub_memories Total stored memories");
  lines.push("# TYPE hub_memories gauge");
  lines.push(`hub_memories ${snap.memory_count}`);

  lines.push("# HELP hub_documents Total stored documents");
  lines.push("# TYPE hub_documents gauge");
  lines.push(`hub_documents ${snap.document_count}`);

  lines.push("# HELP hub_tasks Tasks by state");
  lines.push("# TYPE hub_tasks gauge");
  lines.push(`hub_tasks{state="total"} ${snap.task_count}`);
  lines.push(`hub_tasks{state="active"} ${snap.active_tasks}`);

  lines.push("# HELP hub_agents Active registered agents");
  lines.push("# TYPE hub_agents gauge");
  lines.push(`hub_agents ${snap.agent_count}`);

  lines.push("# HELP hub_jobs Job queue by status");
  lines.push("# TYPE hub_jobs gauge");
  lines.push(`hub_jobs{status="queued"} ${snap.jobs.queued}`);
  lines.push(`hub_jobs{status="running"} ${snap.jobs.running}`);
  lines.push(`hub_jobs{status="done"} ${snap.jobs.done}`);
  lines.push(`hub_jobs{status="failed"} ${snap.jobs.failed}`);

  return lines.join("\n") + "\n";
}
