/**
 * SQLite-backed worker queue for async operations.
 * Supports job types: embed, compact, hygiene, webhook, sync, reindex.
 * Atomic claiming supports multiple worker loops/processes without duplicate work.
 */
import { randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import type { Job, JobKind, JobStatus } from "./types.js";

type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

const jobHandlers = new Map<JobKind, JobHandler>();

function rowToJob(row: Record<string, unknown>): Job {
  return {
    ...row,
    payload: JSON.parse((row.payload as string) || "{}"),
    status: row.status as JobStatus,
    kind: row.kind as JobKind,
  } as unknown as Job;
}

/** Register a handler for a job kind. */
export function registerJobHandler(kind: JobKind, handler: JobHandler): void {
  jobHandlers.set(kind, handler);
}

/** Enqueue a new job. */
export function enqueueJob(kind: JobKind, payload: Record<string, unknown> = {}, opts: { maxAttempts?: number; delayMs?: number } = {}): Job {
  const uid = randomUUID().replaceAll("-", "");
  const db = getDb();
  const delayMs = opts.delayMs ?? 0;
  const nextRunAt = delayMs > 0
    ? (db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f', 'now', '+${delayMs / 1000} seconds') AS t`).get() as { t: string }).t
    : (db.prepare(`SELECT ${NOW_MS} AS t`).get() as { t: string }).t;

  db.prepare(
    `INSERT INTO jobs(uid, kind, payload, status, attempts, max_attempts, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?, ${NOW_MS}, ${NOW_MS})`
  ).run(uid, kind, JSON.stringify(payload), opts.maxAttempts ?? 3, nextRunAt);
  notifyWrite();
  return getJob(uid)!;
}

/** Get a job by UID. */
export function getJob(uid: string): Job | null {
  const row = getDb().prepare("SELECT * FROM jobs WHERE uid = ?").get(uid) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

/** List jobs with optional status filter. */
export function listJobs(opts: { status?: JobStatus; kind?: JobKind; limit?: number } = {}): Job[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts.kind) {
    conditions.push("kind = ?");
    params.push(opts.kind);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, opts.limit ?? 50) as Record<string, unknown>[];
  return rows.map(rowToJob);
}

/** Get queue statistics. */
export function jobStats(): { queued: number; running: number; done: number; failed: number } {
  const db = getDb();
  const rows = db
    .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
    .all() as { status: string; count: number }[];
  const stats = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in stats) stats[row.status as keyof typeof stats] = row.count;
  }
  return stats;
}

/**
 * Atomically claim the oldest due job.
 *
 * The previous SELECT-then-UPDATE sequence let two server processes observe the
 * same queued row and execute it twice. SQLite evaluates this single UPDATE under
 * its write lock; RETURNING yields a row to exactly one claimant.
 */
export function claimNextJob(): Job | null {
  const row = getDb()
    .prepare(
      `UPDATE jobs
       SET status = 'running', attempts = attempts + 1, updated_at = ${NOW_MS}
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued' AND next_run_at <= ${NOW_MS}
         ORDER BY next_run_at ASC, id ASC
         LIMIT 1
       )
       AND status = 'queued'
       RETURNING *`
    )
    .get() as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

/** Process all due jobs. Called on interval by the server. */
export async function processJobs(): Promise<number> {
  const db = getDb();
  let processed = 0;

  for (let claimed = 0; claimed < 10; claimed += 1) {
    const job = claimNextJob();
    if (!job) break;
    const handler = jobHandlers.get(job.kind);

    if (!handler) {
      // No handler registered — mark as failed
      db.prepare(
        `UPDATE jobs SET status = 'failed', last_error = 'no handler registered', updated_at = ${NOW_MS}
         WHERE uid = ? AND status = 'running'`
      ).run(job.uid);
      continue;
    }

    try {
      const result = await handler(job.payload);
      db.prepare(
        `UPDATE jobs SET status = 'done', result = ?, last_error = NULL, updated_at = ${NOW_MS}
         WHERE uid = ? AND status = 'running'`
      ).run(JSON.stringify(result ?? null), job.uid);
      processed++;
    } catch (err) {
      const errorMsg = (err as Error).message;
      const attempts = job.attempts;
      if (attempts >= job.max_attempts) {
        db.prepare(
          `UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ${NOW_MS}
           WHERE uid = ? AND status = 'running'`
        ).run(errorMsg, job.uid);
      } else {
        // Exponential backoff: 2^attempts * 5 seconds
        const backoffSec = Math.pow(2, attempts) * 5;
        const nextRun = (db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f', 'now', '+${backoffSec} seconds') AS t`).get() as { t: string }).t;
        db.prepare(
          `UPDATE jobs SET status = 'queued', last_error = ?, next_run_at = ?, updated_at = ${NOW_MS}
           WHERE uid = ? AND status = 'running'`
        ).run(errorMsg, nextRun, job.uid);
      }
    }
  }

  return processed;
}

/** Cancel a queued job. */
export function cancelJob(uid: string): boolean {
  const info = getDb()
    .prepare(`UPDATE jobs SET status = 'failed', last_error = 'cancelled', updated_at = ${NOW_MS} WHERE uid = ? AND status = 'queued'`)
    .run(uid);
  return info.changes > 0;
}

/** Prune completed/failed jobs older than N days. */
export function pruneJobs(daysOld = 30): number {
  const info = getDb()
    .prepare(`DELETE FROM jobs WHERE status IN ('done', 'failed') AND created_at < strftime('%Y-%m-%d %H:%M:%f', 'now', '-${daysOld} days')`)
    .run();
  return info.changes;
}

let workerInterval: ReturnType<typeof setInterval> | null = null;

/** Start the worker processing interval. */
export function startWorker(intervalMs = 5000): void {
  if (workerInterval) return;
  workerInterval = setInterval(() => {
    processJobs().catch((err) => {
      console.error(`[hub:worker] processing error: ${(err as Error).message}`);
    });
  }, intervalMs);
  // Don't keep the process alive just for the worker
  if (workerInterval.unref) workerInterval.unref();
}

/** Stop the worker processing interval. */
export function stopWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}
