/**
 * Task queue: agent-to-agent work delegation and tracking.
 * Tasks can have dependencies (depends_on JSON array of task uids) and are
 * claimed atomically by agents. Status flow: pending -> claimed -> in_progress -> done/cancelled.
 */
import { randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { config } from "./config.js";
import { notifyWrite } from "./events.js";
import { emitHubEvent } from "./events-bus.js";
import { recordDeletion } from "./sync.js";
import type { Task, TaskInput, TaskPatch, TaskFilter, TaskStatus } from "./types.js";

function rowToTask(row: Record<string, unknown>): Task {
  return {
    ...(row as unknown as Task),
    depends_on: JSON.parse((row.depends_on as string) ?? "[]"),
    tags: JSON.parse((row.tags as string) ?? "[]"),
  };
}

function taskRow(uid: string): Task | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE uid = ?").get(uid) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

/** Check if all dependencies of a task are completed. */
function dependenciesMet(dependsOn: string[]): boolean {
  if (dependsOn.length === 0) return true;
  const db = getDb();
  const placeholders = dependsOn.map(() => "?").join(",");
  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE uid IN (${placeholders}) AND status NOT IN ('done', 'cancelled')`)
    .get(...dependsOn) as { n: number };
  return pending.n === 0;
}

/** Create a new task with optional dependencies. */
export function createTask(input: TaskInput): Task {
  const uid = randomUUID().replaceAll("-", "");
  const db = getDb();
  const dependsOn = input.depends_on ?? [];
  // Validate dependencies exist
  if (dependsOn.length > 0) {
    const placeholders = dependsOn.map(() => "?").join(",");
    const found = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE uid IN (${placeholders})`).get(...dependsOn) as { n: number };
    if (found.n !== dependsOn.length) {
      throw new Error("One or more dependency task UIDs not found");
    }
  }
  db.prepare(
    `INSERT INTO tasks(uid, project, title, description, status, priority, created_by, depends_on, tags, due_at, created_at, updated_at)
     VALUES (@uid, @project, @title, @description, 'pending', @priority, @created_by, @depends_on, @tags, @due_at, ${NOW_MS}, ${NOW_MS})`
  ).run({
    uid,
    project: input.project ?? null,
    title: input.title,
    description: input.description ?? null,
    priority: input.priority ?? 0,
    created_by: input.created_by ?? null,
    depends_on: JSON.stringify(dependsOn),
    tags: JSON.stringify(input.tags ?? []),
    due_at: input.due_at ?? null,
  });
  notifyWrite();
  const created = taskRow(uid)!;
  emitHubEvent({ type: "task_created", payload: { task_uid: uid, project: created.project ?? null } });
  return created;
}

/** Atomically claim a task (only if pending and dependencies are met). */
export function claimTask(uid: string, agent: string): Task {
  const db = getDb();
  const task = taskRow(uid);
  if (!task) throw new Error(`Task ${uid} not found`);
  if (task.status !== "pending") throw new Error(`Task ${uid} is not pending (status: ${task.status})`);
  if (!dependenciesMet(task.depends_on)) throw new Error(`Task ${uid} has unmet dependencies`);
  const info = db
    .prepare(
      `UPDATE tasks SET status='claimed', claimed_by=@agent, claimed_at=${NOW_MS}, started_at=${NOW_MS}, updated_at=${NOW_MS} WHERE uid=@uid AND status='pending'`
    )
    .run({ uid, agent });
  // The precondition checks above are not atomic with this UPDATE — another agent
  // may have claimed it in between. changes===0 means we lost that race.
  if (info.changes === 0) throw new Error(`Task ${uid} was claimed by another agent`);
  notifyWrite();
  const claimed = taskRow(uid)!;
  emitHubEvent({ type: "task_claimed", payload: { task_uid: uid, project: claimed.project ?? null, agent } });
  return claimed;
}

/** Update a task's mutable fields. */
export function updateTask(uid: string, patch: TaskPatch): Task {
  const db = getDb();
  const task = taskRow(uid);
  if (!task) throw new Error(`Task ${uid} not found`);
  const sets: string[] = [];
  const params: Record<string, unknown> = { uid };
  if (patch.status !== undefined) {
    sets.push("status=@status");
    params.status = patch.status;
    if (patch.status === "in_progress" && !task.started_at) sets.push(`started_at=${NOW_MS}`);
    if (patch.status === "done" || patch.status === "cancelled") sets.push(`finished_at=${NOW_MS}`);
  }
  if (patch.priority !== undefined) {
    sets.push("priority=@priority");
    params.priority = patch.priority;
  }
  if (patch.description !== undefined) {
    sets.push("description=@description");
    params.description = patch.description;
  }
  if (patch.result !== undefined) {
    sets.push("result=@result");
    params.result = patch.result;
  }
  if (patch.error !== undefined) {
    sets.push("error=@error");
    params.error = patch.error;
  }
  if (patch.tags !== undefined) {
    sets.push("tags=@tags");
    params.tags = JSON.stringify(patch.tags);
  }
  if (sets.length === 0) return task;
  sets.push(`updated_at=${NOW_MS}`);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE uid=@uid`).run(params);
  notifyWrite();
  const updated = taskRow(uid)!;
  if (patch.status === "done") {
    emitHubEvent({ type: "task_completed", payload: { task_uid: uid, project: updated.project ?? null, agent: updated.claimed_by ?? undefined } });
  } else if (patch.status === "cancelled") {
    emitHubEvent({ type: "task_cancelled", payload: { task_uid: uid, project: updated.project ?? null, agent: updated.claimed_by ?? undefined } });
  }
  return updated;
}

/** Mark a task as done with an optional result. */
export function completeTask(uid: string, result?: string): Task {
  return updateTask(uid, { status: "done", result });
}

/** Mark a task as cancelled with an optional error reason. */
export function cancelTask(uid: string, error?: string): Task {
  return updateTask(uid, { status: "cancelled", error });
}

/** Get a single task by UID. */
export function getTask(uid: string): Task | null {
  return taskRow(uid);
}

/** List tasks with optional filters. */
export function listTasks(filter: TaskFilter = {}): Task[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.project) {
    conditions.push("project = ?");
    params.push(filter.project);
  }
  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }
  if (filter.claimed_by) {
    conditions.push("claimed_by = ?");
    params.push(filter.claimed_by);
  }
  if (filter.tag) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE json_each.value = ?)");
    params.push(filter.tag);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filter.limit ?? 50, 200);
  const rows = db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/** Get the next actionable tasks for a project (pending, dependencies met, ordered by priority). */
export function taskQueue(project?: string, limit = 10): Task[] {
  const pending = listTasks({ project, status: "pending", limit: 100 });
  return pending.filter((task) => dependenciesMet(task.depends_on)).slice(0, limit);
}

/** Get tasks claimed by a specific agent. */
export function agentTasks(agent: string, activeOnly = true): Task[] {
  const db = getDb();
  const statusFilter = activeOnly ? "AND status IN ('claimed', 'in_progress', 'blocked')" : "";
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE claimed_by = ? ${statusFilter} ORDER BY priority DESC, updated_at DESC`)
    .all(agent) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/** Prune old done/cancelled tasks (older than config.taskPruneDays). */
export function pruneOldTasks(): number {
  const db = getDb();
  const cutoff = (
    db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f', 'now', '-${config.taskPruneDays} days') AS c`).get() as { c: string }
  ).c;
  const rows = db
    .prepare("SELECT uid FROM tasks WHERE status IN ('done', 'cancelled') AND COALESCE(finished_at, updated_at) <= ?")
    .all(cutoff) as { uid: string }[];
  for (const r of rows) {
    db.prepare("DELETE FROM tasks WHERE uid = ?").run(r.uid);
    recordDeletion("tasks", r.uid);
  }
  if (rows.length > 0) notifyWrite();
  return rows.length;
}

/** Get task statistics for a project. */
export function taskStats(project?: string): { status: TaskStatus; count: number }[] {
  const db = getDb();
  const where = project ? "WHERE project = ?" : "";
  const params = project ? [project] : [];
  return db
    .prepare(`SELECT status, COUNT(*) AS count FROM tasks ${where} GROUP BY status ORDER BY count DESC`)
    .all(...params) as { status: TaskStatus; count: number }[];
}
