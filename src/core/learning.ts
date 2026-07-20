/**
 * Learning loop: task-level feedback and lesson extraction.
 * Captures outcomes from completed tasks and extracts reusable lessons
 * that are saved as howto memories for future reference.
 */
import { randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import { emitHubEvent } from "./events-bus.js";
import { saveMemory, searchMemories } from "./memories.js";
import type { TaskFeedback, TaskFeedbackInput, TaskOutcome } from "./types.js";

function rowToFeedback(row: Record<string, unknown>): TaskFeedback {
  return row as unknown as TaskFeedback;
}

/** Record feedback for a completed task. */
export function recordTaskFeedback(input: TaskFeedbackInput): TaskFeedback {
  const uid = randomUUID().replaceAll("-", "");
  const db = getDb();
  db.prepare(
    `INSERT INTO task_feedback(uid, task_uid, project, agent, outcome, what_worked, what_failed, lessons, duration_min, created_at)
     VALUES (@uid, @task_uid, @project, @agent, @outcome, @what_worked, @what_failed, @lessons, @duration_min, ${NOW_MS})`
  ).run({
    uid,
    task_uid: input.task_uid ?? null,
    project: input.project ?? null,
    agent: input.agent ?? null,
    outcome: input.outcome,
    what_worked: input.what_worked ?? null,
    what_failed: input.what_failed ?? null,
    lessons: input.lessons ?? null,
    duration_min: input.duration_min ?? null,
  });
  notifyWrite();
  emitHubEvent({ type: "feedback_recorded", payload: { feedback_uid: uid, outcome: input.outcome, project: input.project ?? null } });

  // Auto-save significant lessons as howto memories
  if (input.lessons && input.lessons.length > 20) {
    saveMemory({
      type: "howto",
      title: `Lesson: ${input.task_uid ? `Task ${input.task_uid.slice(0, 8)}` : "Task"} (${input.outcome})`,
      body: input.lessons,
      project: input.project,
      tags: ["auto-lesson", `outcome-${input.outcome}`],
      source: input.agent ?? "learning-loop",
      importance: input.outcome === "failure" ? 1.5 : 1.0,
    });
  }

  return getTaskFeedback(uid)!;
}

/** Get a single task feedback by UID. */
export function getTaskFeedback(uid: string): TaskFeedback | null {
  const row = getDb().prepare("SELECT * FROM task_feedback WHERE uid = ?").get(uid) as Record<string, unknown> | undefined;
  return row ? rowToFeedback(row) : null;
}

/** Get feedback for a specific task. */
export function taskFeedbackList(taskUid: string): TaskFeedback[] {
  const rows = getDb()
    .prepare("SELECT * FROM task_feedback WHERE task_uid = ? ORDER BY created_at DESC")
    .all(taskUid) as Record<string, unknown>[];
  return rows.map(rowToFeedback);
}

/** Get aggregated lessons for a project. */
export function projectLessons(project: string, limit = 20): TaskFeedback[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM task_feedback
       WHERE project = ? AND lessons IS NOT NULL AND lessons != ''
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(project, Math.min(limit, 100)) as Record<string, unknown>[];
  return rows.map(rowToFeedback);
}

/** Get lessons by outcome type. */
export function lessonsByOutcome(outcome: TaskOutcome, project?: string, limit = 20): TaskFeedback[] {
  const db = getDb();
  const conditions = ["outcome = ?", "lessons IS NOT NULL", "lessons != ''"];
  const params: unknown[] = [outcome];
  if (project) {
    conditions.push("project = ?");
    params.push(project);
  }
  const rows = db
    .prepare(`SELECT * FROM task_feedback WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, Math.min(limit, 100)) as Record<string, unknown>[];
  return rows.map(rowToFeedback);
}

/**
 * Suggest relevant past lessons when starting a similar task.
 * Uses semantic search to find related howto memories with auto-lesson tag.
 */
export async function suggestForTask(taskTitle: string, project?: string): Promise<TaskFeedback[]> {
  // Search for auto-lesson memories related to the task
  const lessons = await searchMemories(taskTitle, {
    project,
    type: "howto",
    tag: "auto-lesson",
    limit: 5,
  });

  // Also get recent failures for the project (common pitfalls)
  const failures = project ? lessonsByOutcome("failure", project, 3) : [];

  // Combine and dedupe
  const seen = new Set<string>();
  const suggestions: TaskFeedback[] = [];

  for (const lesson of lessons) {
    // Find the original feedback if it exists
    const feedback = getDb()
      .prepare("SELECT * FROM task_feedback WHERE lessons LIKE ? ORDER BY created_at DESC LIMIT 1")
      .get(`%${lesson.title.slice(0, 50)}%`) as Record<string, unknown> | undefined;
    if (feedback && !seen.has(feedback.uid as string)) {
      seen.add(feedback.uid as string);
      suggestions.push(rowToFeedback(feedback));
    }
  }

  for (const failure of failures) {
    if (!seen.has(failure.uid)) {
      seen.add(failure.uid);
      suggestions.push(failure);
    }
  }

  return suggestions.slice(0, 5);
}

/** Get learning statistics for a project. */
export function learningStats(project?: string): {
  total_feedback: number;
  by_outcome: { outcome: TaskOutcome; count: number }[];
  avg_duration_min: number | null;
  lessons_count: number;
} {
  const db = getDb();
  const where = project ? "WHERE project = ?" : "";
  const params = project ? [project] : [];

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM task_feedback ${where}`).get(...params) as { n: number }).n;

  const byOutcome = db
    .prepare(`SELECT outcome, COUNT(*) AS count FROM task_feedback ${where} GROUP BY outcome ORDER BY count DESC`)
    .all(...params) as { outcome: TaskOutcome; count: number }[];

  const avgDuration = (
    db.prepare(`SELECT AVG(duration_min) AS avg FROM task_feedback ${where} ${where ? "AND" : "WHERE"} duration_min IS NOT NULL`).get(...params) as { avg: number | null }
  ).avg;

  const lessonsCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM task_feedback ${where} ${where ? "AND" : "WHERE"} lessons IS NOT NULL AND lessons != ''`).get(...params) as { n: number }
  ).n;

  return { total_feedback: total, by_outcome: byOutcome, avg_duration_min: avgDuration, lessons_count: lessonsCount };
}

/** Format lessons as a markdown summary for context injection. */
export function formatLessonsForContext(lessons: TaskFeedback[]): string {
  if (lessons.length === 0) return "";
  const lines = ["<project-lessons>", "Relevant lessons from past tasks:"];
  for (const lesson of lessons.slice(0, 3)) {
    const outcome = lesson.outcome === "success" ? "+" : lesson.outcome === "failure" ? "-" : "~";
    lines.push(`- [${outcome}] ${lesson.lessons?.slice(0, 200) ?? "No lesson recorded"}`);
  }
  lines.push("</project-lessons>");
  return lines.join("\n");
}
