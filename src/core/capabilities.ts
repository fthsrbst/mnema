/**
 * Agent capability registry: tracks what each agent can do and its current status.
 * Agents register their capabilities (code_review, testing, deploy, etc.) and
 * can be found by capability for task routing.
 */
import os from "node:os";
import { randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { config } from "./config.js";
import { notifyWrite } from "./events.js";
import { emitHubEvent } from "./events-bus.js";
import { recordDeletion } from "./sync.js";
import type { AgentCapability, AgentCapabilityInput, AgentCapabilityStatus } from "./types.js";

const CAPABILITY_PRUNE_DAYS = 7;

function rowToCapability(row: Record<string, unknown>): AgentCapability {
  return {
    ...(row as unknown as AgentCapability),
    capabilities: JSON.parse((row.capabilities as string) ?? "[]"),
    models: JSON.parse((row.models as string) ?? "[]"),
    metadata: JSON.parse((row.metadata as string) ?? "{}"),
  };
}

function capabilityRow(uid: string): AgentCapability | null {
  const row = getDb().prepare("SELECT * FROM agent_capabilities WHERE uid = ?").get(uid) as Record<string, unknown> | undefined;
  return row ? rowToCapability(row) : null;
}

function capabilityRowByAgentMachine(agent: string, machine: string | null): AgentCapability | null {
  const row = getDb()
    .prepare("SELECT * FROM agent_capabilities WHERE agent = ? AND machine IS ?")
    .get(agent, machine) as Record<string, unknown> | undefined;
  return row ? rowToCapability(row) : null;
}

/** Register or update an agent's capabilities. */
export function registerAgent(input: AgentCapabilityInput): AgentCapability {
  const db = getDb();
  const machine = input.machine?.trim() || os.hostname();
  const existing = capabilityRowByAgentMachine(input.agent, machine);

  if (existing) {
    // Update existing registration
    db.prepare(
      `UPDATE agent_capabilities SET
        capabilities=@capabilities, models=@models, max_concurrent=@max_concurrent,
        status=@status, metadata=@metadata, last_seen_at=${NOW_MS}, updated_at=${NOW_MS}
       WHERE uid=@uid`
    ).run({
      uid: existing.uid,
      capabilities: JSON.stringify(input.capabilities ?? existing.capabilities),
      models: JSON.stringify(input.models ?? existing.models),
      max_concurrent: input.max_concurrent ?? existing.max_concurrent,
      status: input.status ?? "available",
      metadata: JSON.stringify(input.metadata ?? existing.metadata),
    });
    notifyWrite();
    emitHubEvent({ type: "agent_registered", payload: { agent: input.agent, machine } });
    return capabilityRow(existing.uid)!;
  }

  // Create new registration
  const uid = randomUUID().replaceAll("-", "");
  db.prepare(
    `INSERT INTO agent_capabilities(uid, agent, machine, capabilities, models, max_concurrent, status, metadata, last_seen_at, created_at, updated_at)
     VALUES (@uid, @agent, @machine, @capabilities, @models, @max_concurrent, @status, @metadata, ${NOW_MS}, ${NOW_MS}, ${NOW_MS})`
  ).run({
    uid,
    agent: input.agent,
    machine,
    capabilities: JSON.stringify(input.capabilities ?? []),
    models: JSON.stringify(input.models ?? []),
    max_concurrent: input.max_concurrent ?? 1,
    status: input.status ?? "available",
    metadata: JSON.stringify(input.metadata ?? {}),
  });
  notifyWrite();
  emitHubEvent({ type: "agent_registered", payload: { agent: input.agent, machine } });
  return capabilityRow(uid)!;
}

/** Update agent heartbeat (last_seen_at) and optionally status. */
export function agentHeartbeat(uid: string, status?: AgentCapabilityStatus): AgentCapability | null {
  const db = getDb();
  const existing = capabilityRow(uid);
  if (!existing) return null;
  const sets = [`last_seen_at=${NOW_MS}`, `updated_at=${NOW_MS}`];
  const params: Record<string, unknown> = { uid };
  if (status) {
    sets.push("status=@status");
    params.status = status;
  }
  db.prepare(`UPDATE agent_capabilities SET ${sets.join(", ")} WHERE uid=@uid`).run(params);
  notifyWrite();
  return capabilityRow(uid);
}

/** Find agents that have a specific capability. */
export function findCapableAgents(capability: string, project?: string): AgentCapability[] {
  const db = getDb();
  // Find agents with the capability who are available or busy (not offline)
  const rows = db
    .prepare(
      `SELECT * FROM agent_capabilities
       WHERE status != 'offline'
         AND EXISTS (SELECT 1 FROM json_each(capabilities) WHERE json_each.value = ?)
       ORDER BY
         CASE status WHEN 'available' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END,
         last_seen_at DESC`
    )
    .all(capability) as Record<string, unknown>[];
  return rows.map(rowToCapability);
}

/** Get all agents that match multiple capabilities. */
export function findAgentsWithCapabilities(capabilities: string[]): AgentCapability[] {
  if (capabilities.length === 0) return listAgents({});
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM agent_capabilities WHERE status != 'offline' ORDER BY last_seen_at DESC`)
    .all() as Record<string, unknown>[];
  const all = rows.map(rowToCapability);
  return all.filter((agent) => capabilities.every((cap) => agent.capabilities.includes(cap)));
}

/** Get current status of a specific agent. */
export function agentStatus(agent: string, machine?: string): AgentCapability | null {
  if (machine) {
    return capabilityRowByAgentMachine(agent, machine);
  }
  // Return the most recently seen registration for this agent
  const row = getDb()
    .prepare("SELECT * FROM agent_capabilities WHERE agent = ? ORDER BY last_seen_at DESC LIMIT 1")
    .get(agent) as Record<string, unknown> | undefined;
  return row ? rowToCapability(row) : null;
}

/** List all registered agents with optional status filter. */
export function listAgents(filter: { status?: AgentCapabilityStatus; capability?: string }): AgentCapability[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }
  if (filter.capability) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(capabilities) WHERE json_each.value = ?)");
    params.push(filter.capability);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM agent_capabilities ${where} ORDER BY last_seen_at DESC`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(rowToCapability);
}

/** Mark agents as offline if not seen within TTL. */
export function pruneOfflineAgents(): number {
  const db = getDb();
  const ttlMs = config.agentTtlMin * 60_000;
  const cutoff = new Date(Date.now() - ttlMs).toISOString().replace("T", " ").replace("Z", "");
  const rows = db
    .prepare("SELECT uid FROM agent_capabilities WHERE status != 'offline' AND last_seen_at < ?")
    .all(cutoff) as { uid: string }[];
  if (rows.length === 0) return 0;
  const placeholders = rows.map(() => "?").join(",");
  db.prepare(
    `UPDATE agent_capabilities SET status='offline', updated_at=${NOW_MS} WHERE uid IN (${placeholders})`
  ).run(...rows.map((r) => r.uid));
  notifyWrite();
  return rows.length;
}

/** Delete old offline agent registrations. */
export function pruneOldAgents(): number {
  const db = getDb();
  const cutoff = (
    db.prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f', 'now', '-${CAPABILITY_PRUNE_DAYS} days') AS c`).get() as { c: string }
  ).c;
  const rows = db
    .prepare("SELECT uid FROM agent_capabilities WHERE status = 'offline' AND updated_at <= ?")
    .all(cutoff) as { uid: string }[];
  for (const r of rows) {
    db.prepare("DELETE FROM agent_capabilities WHERE uid = ?").run(r.uid);
    recordDeletion("agent_capabilities", r.uid);
  }
  if (rows.length > 0) notifyWrite();
  return rows.length;
}

/** Get count of available agents. */
export function availableAgentCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM agent_capabilities WHERE status = 'available'").get() as { n: number };
  return row.n;
}
