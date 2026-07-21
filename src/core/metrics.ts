/**
 * In-memory metrics collection with Prometheus-compatible output.
 * Tracks requests, latency, errors, embedding calls, and system stats.
 */
import { getDb } from "./db.js";
import { jobStats } from "./worker.js";
import type { CoordinationMetrics, MetricsSnapshot } from "./types.js";

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

/**
 * Agent koordinasyon-yükü sinyalleri: tek SQL turunda 7 günlük pencere için.
 *
 * - tasks_completed_7d: done task sayısı (finished_at >= 7 gün önce).
 * - avg_task_cycle_time_min: claimed_at→finished_at ortalaması (dakika).
 *   NULL claimed_at olanlar AVG'de otomatik hariç; hiç completed yoksa 0.
 * - handoff_ratio: handoff mesaj sayısı / tamamlanan görev sayısı; completed=0 ise 0 (MAX(1,...)).
 * - reclaim_count_7d: (total task_claimed events) − (unique claim edilen task sayısı).
 *   hub_events.payload JSON'dan json_extract ile task_uid çekilir.
 * - verification_coverage: kind != 'none' ile verification'lı tamamlanan görev oranı.
 *
 * Sorgu tek bir CTE + prepared statement'le sıcak yolu tıkamadan işletilebilir:
 * getMetricsSnapshot'da zaten saniyede en fazla bir kez çağrılmaktadır.
 */
export function coordinationStats(): CoordinationMetrics {
  const db = getDb();
  const since = (
    db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%f','now','-7 days') AS c").get() as { c: string }
  ).c;
  const row = db
    .prepare(
      `WITH recent_claims AS (
         SELECT json_extract(payload, '$.payload.task_uid') AS tu
         FROM hub_events
         WHERE type = 'task_claimed' AND created_at >= ?
       )
       SELECT
         COALESCE((SELECT COUNT(*) FROM tasks
                    WHERE status = 'done' AND finished_at >= ?), 0) AS tasks_completed_7d,
         COALESCE((SELECT AVG((julianday(finished_at) - julianday(claimed_at)) * 1440)
                    FROM tasks
                    WHERE status = 'done' AND finished_at >= ? AND claimed_at IS NOT NULL), 0) AS avg_task_cycle_time_min,
         COALESCE(
           (SELECT COUNT(*) FROM agent_messages
              WHERE kind = 'handoff' AND created_at >= ?) * 1.0 /
           MAX(1, (SELECT COUNT(*) FROM tasks
                     WHERE status = 'done' AND finished_at >= ?)), 0
         ) AS handoff_ratio,
         COALESCE(
           (SELECT COUNT(*) FROM recent_claims) -
           (SELECT COUNT(DISTINCT tu) FROM recent_claims), 0
         ) AS reclaim_count_7d,
         COALESCE(
           (SELECT COUNT(*) FROM tasks
              WHERE status = 'done' AND finished_at >= ?
                AND verification IS NOT NULL
                AND json_extract(verification, '$.kind') != 'none') * 1.0 /
           MAX(1, (SELECT COUNT(*) FROM tasks
                     WHERE status = 'done' AND finished_at >= ?)), 0
         ) AS verification_coverage`
    )
    .get(since, since, since, since, since, since, since) as {
    tasks_completed_7d: number;
    avg_task_cycle_time_min: number | null;
    handoff_ratio: number | null;
    reclaim_count_7d: number | null;
    verification_coverage: number | null;
  };
  return {
    tasks_completed_7d: row.tasks_completed_7d ?? 0,
    avg_task_cycle_time_min: Math.round(row.avg_task_cycle_time_min ?? 0),
    handoff_ratio: Math.round((row.handoff_ratio ?? 0) * 1000) / 1000,
    reclaim_count_7d: row.reclaim_count_7d ?? 0,
    verification_coverage: Math.round((row.verification_coverage ?? 0) * 1000) / 1000,
  };
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
  const coordination = coordinationStats();

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
    coordination,
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

  lines.push("# HELP hub_coordination Agent koordinasyon-yükü sinyalleri (7 gün pencere)");
  lines.push("# TYPE hub_coordination gauge");
  lines.push(`hub_coordination{signal="tasks_completed_7d"} ${snap.coordination.tasks_completed_7d}`);
  lines.push(`hub_coordination{signal="avg_task_cycle_time_min"} ${snap.coordination.avg_task_cycle_time_min}`);
  lines.push(`hub_coordination{signal="handoff_ratio"} ${snap.coordination.handoff_ratio}`);
  lines.push(`hub_coordination{signal="reclaim_count_7d"} ${snap.coordination.reclaim_count_7d}`);
  lines.push(`hub_coordination{signal="verification_coverage"} ${snap.coordination.verification_coverage}`);

  return lines.join("\n") + "\n";
}
