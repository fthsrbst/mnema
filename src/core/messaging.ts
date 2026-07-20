/**
 * Agent messaging: structured communication between agents.
 * Supports info, request, response, handoff, and alert message types.
 * Messages can be linked to tasks for context.
 */
import { randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import { emitHubEvent } from "./events-bus.js";
import { recordDeletion } from "./sync.js";
import type { AgentMessage, AgentMessageInput, MessageKind, HandoffPackage } from "./types.js";
import { getProject } from "./projects.js";
import { recentSessionLogs } from "./sessions.js";
import { listTasks, taskQueue } from "./tasks.js";
import { agentActive } from "./presence.js";
import { searchMemories } from "./memories.js";

const MESSAGE_PRUNE_DAYS = 30;

function rowToMessage(row: Record<string, unknown>): AgentMessage {
  return {
    ...(row as unknown as AgentMessage),
    payload: JSON.parse((row.payload as string) ?? "{}"),
  };
}

function messageRow(uid: string): AgentMessage | null {
  const row = getDb().prepare("SELECT * FROM agent_messages WHERE uid = ?").get(uid) as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : null;
}

/** Send a message to another agent (or broadcast if to_agent is null). */
export function sendMessage(input: AgentMessageInput): AgentMessage {
  const uid = randomUUID().replaceAll("-", "");
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_messages(uid, from_agent, to_agent, project, task_uid, kind, subject, body, payload, created_at)
     VALUES (@uid, @from_agent, @to_agent, @project, @task_uid, @kind, @subject, @body, @payload, ${NOW_MS})`
  ).run({
    uid,
    from_agent: input.from_agent,
    to_agent: input.to_agent ?? null,
    project: input.project ?? null,
    task_uid: input.task_uid ?? null,
    kind: input.kind ?? "info",
    subject: input.subject,
    body: input.body,
    payload: JSON.stringify(input.payload ?? {}),
  });
  notifyWrite();
  const msg = messageRow(uid)!;
  emitHubEvent({
    type: "message_sent",
    payload: { message_uid: uid, from_agent: msg.from_agent, to_agent: msg.to_agent, kind: msg.kind, project: msg.project ?? null },
  });
  return msg;
}

/**
 * Get unread messages for an agent (inbox). read_at on agent_messages is only
 * meaningful for direct messages (to_agent set) — one recipient, one read state.
 * Broadcasts (to_agent IS NULL) are read per-agent via agent_message_reads, so
 * one agent reading a broadcast does not mark it read for every other agent.
 */
export function inbox(agent: string, opts: { includeRead?: boolean; limit?: number } = {}): AgentMessage[] {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  if (opts.includeRead) {
    const rows = db
      .prepare(`SELECT * FROM agent_messages WHERE (to_agent = ? OR to_agent IS NULL) ORDER BY created_at DESC LIMIT ?`)
      .all(agent, limit) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }
  const rows = db
    .prepare(
      `SELECT * FROM agent_messages
       WHERE (to_agent = ? AND read_at IS NULL)
          OR (to_agent IS NULL AND NOT EXISTS (
                SELECT 1 FROM agent_message_reads r WHERE r.message_uid = agent_messages.uid AND r.agent = ?
              ))
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(agent, agent, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/** Get unread message count for an agent (direct + not-yet-read-by-this-agent broadcasts). */
export function unreadCount(agent: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_messages
       WHERE (to_agent = ? AND read_at IS NULL)
          OR (to_agent IS NULL AND NOT EXISTS (
                SELECT 1 FROM agent_message_reads r WHERE r.message_uid = agent_messages.uid AND r.agent = ?
              ))`
    )
    .get(agent, agent) as { n: number };
  return row.n;
}

/**
 * Mark a message as read. Direct messages set read_at globally (single recipient).
 * Broadcasts record a per-agent read in agent_message_reads instead — pass `agent`
 * so the isolation actually applies; without it a broadcast read is a no-op.
 */
export function markRead(uid: string, agent?: string): AgentMessage | null {
  const db = getDb();
  const msg = messageRow(uid);
  if (!msg) return null;
  if (msg.to_agent === null) {
    if (agent) {
      db.prepare(
        `INSERT INTO agent_message_reads(message_uid, agent, read_at) VALUES (?, ?, ${NOW_MS})
         ON CONFLICT(message_uid, agent) DO NOTHING`
      ).run(uid, agent);
      notifyWrite();
    }
    return messageRow(uid);
  }
  db.prepare(`UPDATE agent_messages SET read_at=${NOW_MS} WHERE uid=? AND read_at IS NULL`).run(uid);
  notifyWrite();
  return messageRow(uid);
}

/** Mark all messages for an agent as read (direct messages + all unread broadcasts, per-agent). */
export function markAllRead(agent: string): number {
  const db = getDb();
  let changes = 0;
  const direct = db
    .prepare(`UPDATE agent_messages SET read_at=${NOW_MS} WHERE to_agent = ? AND read_at IS NULL`)
    .run(agent);
  changes += direct.changes;
  const unreadBroadcasts = db
    .prepare(
      `SELECT uid FROM agent_messages
       WHERE to_agent IS NULL AND NOT EXISTS (
         SELECT 1 FROM agent_message_reads r WHERE r.message_uid = agent_messages.uid AND r.agent = ?
       )`
    )
    .all(agent) as { uid: string }[];
  if (unreadBroadcasts.length > 0) {
    const insertRead = db.prepare(
      `INSERT INTO agent_message_reads(message_uid, agent, read_at) VALUES (?, ?, ${NOW_MS})
       ON CONFLICT(message_uid, agent) DO NOTHING`
    );
    db.transaction(() => {
      for (const b of unreadBroadcasts) {
        insertRead.run(b.uid, agent);
        changes++;
      }
    })();
  }
  if (changes > 0) notifyWrite();
  return changes;
}

/** Get messages sent BY an agent (outbox). */
export function sentMessages(agent: string, opts: { limit?: number } = {}): AgentMessage[] {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  const rows = db
    .prepare(
      `SELECT * FROM agent_messages WHERE from_agent = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(agent, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/** Get recent messages across the whole fleet (activity wire). */
export function recentMessages(limit = 50): AgentMessage[] {
  const rows = getDb()
    .prepare(`SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?`)
    .all(Math.min(limit, 200)) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/** Get all messages linked to a task. */
export function taskMessages(taskUid: string): AgentMessage[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_messages WHERE task_uid = ? ORDER BY created_at ASC")
    .all(taskUid) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/** Get messages for a project. */
export function projectMessages(project: string, limit = 50): AgentMessage[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_messages WHERE project = ? ORDER BY created_at DESC LIMIT ?")
    .all(project, Math.min(limit, 200)) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/**
 * Create a structured handoff package between agents.
 * Collects project context, recent sessions, active tasks, presence, and relevant memories.
 */
export async function createHandoff(
  fromAgent: string,
  toAgent: string,
  project: string,
  notes = ""
): Promise<HandoffPackage> {
  const projectMap = getProject(project);
  const recentSessions = recentSessionLogs({ project, limit: 3 });
  const activeTasks = listTasks({ project, status: "in_progress", limit: 20 });
  const pendingTasks = taskQueue(project, 10);
  const activeAgents = agentActive(project);

  // Get relevant memories for the project
  const relevantMemories = await searchMemories(project, { project, limit: 5 });

  // Identify blockers from blocked tasks
  const blockedTasks = listTasks({ project, status: "blocked", limit: 10 });
  const blockers = blockedTasks.map((t) => `${t.title}: ${t.error ?? "unknown blocker"}`);

  const handoff: HandoffPackage = {
    project,
    from_agent: fromAgent,
    to_agent: toAgent,
    generated_at: new Date().toISOString(),
    project_map: projectMap,
    recent_sessions: recentSessions,
    active_tasks: activeTasks,
    pending_tasks: pendingTasks,
    active_agents: activeAgents,
    relevant_memories: relevantMemories,
    blockers,
    notes,
  };

  // Also send a handoff message
  sendMessage({
    from_agent: fromAgent,
    to_agent: toAgent,
    project,
    kind: "handoff",
    subject: `Handoff: ${project}`,
    body: notes || `Project handoff from ${fromAgent} to ${toAgent}`,
    payload: handoff as unknown as Record<string, unknown>,
  });

  return handoff;
}

/** Send an alert message to all agents (broadcast). */
export function sendAlert(fromAgent: string, subject: string, body: string, project?: string): AgentMessage {
  return sendMessage({
    from_agent: fromAgent,
    kind: "alert",
    subject,
    body,
    project,
  });
}

/** Send a request message to a specific agent. */
export function sendRequest(
  fromAgent: string,
  toAgent: string,
  subject: string,
  body: string,
  opts: { project?: string; task_uid?: string; payload?: Record<string, unknown> } = {}
): AgentMessage {
  return sendMessage({
    from_agent: fromAgent,
    to_agent: toAgent,
    kind: "request",
    subject,
    body,
    ...opts,
  });
}

/** Send a response to a request. */
export function sendResponse(
  fromAgent: string,
  toAgent: string,
  subject: string,
  body: string,
  opts: { project?: string; task_uid?: string; payload?: Record<string, unknown> } = {}
): AgentMessage {
  return sendMessage({
    from_agent: fromAgent,
    to_agent: toAgent,
    kind: "response",
    subject,
    body,
    ...opts,
  });
}

/** Prune old read messages. */
export function pruneOldMessages(): number {
  const db = getDb();
  const cutoff = (
    db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f', 'now', '-${MESSAGE_PRUNE_DAYS} days') AS c`).get() as { c: string }
  ).c;
  const rows = db
    .prepare("SELECT uid FROM agent_messages WHERE read_at IS NOT NULL AND created_at <= ?")
    .all(cutoff) as { uid: string }[];
  for (const r of rows) {
    db.prepare("DELETE FROM agent_messages WHERE uid = ?").run(r.uid);
    recordDeletion("agent_messages", r.uid);
  }
  if (rows.length > 0) notifyWrite();
  return rows.length;
}
