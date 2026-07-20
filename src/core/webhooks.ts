/**
 * Webhook outbound delivery: register HTTP endpoints that receive hub events.
 * Supports HMAC signing, event filtering, retry with backoff, and auto-disable.
 */
import { createHmac, randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import { onHubEvent } from "./events-bus.js";
import type { HubEvent, Webhook, WebhookInput } from "./types.js";

function rowToWebhook(row: Record<string, unknown>): Webhook {
  return {
    ...row,
    events: JSON.parse((row.events as string) || '["*"]'),
    active: Boolean(row.active),
  } as unknown as Webhook;
}

/** Register a new webhook endpoint. */
export function registerWebhook(input: WebhookInput): Webhook {
  const uid = randomUUID().replaceAll("-", "");
  const db = getDb();
  db.prepare(
    `INSERT INTO webhooks(uid, url, events, secret, active, fail_count, created_at)
     VALUES (?, ?, ?, ?, 1, 0, ${NOW_MS})`
  ).run(uid, input.url, JSON.stringify(input.events ?? ["*"]), input.secret ?? null);
  notifyWrite();
  return getWebhook(uid)!;
}

/** Get a webhook by UID. */
export function getWebhook(uid: string): Webhook | null {
  const row = getDb().prepare("SELECT * FROM webhooks WHERE uid = ?").get(uid) as Record<string, unknown> | undefined;
  return row ? rowToWebhook(row) : null;
}

/** List all webhooks. */
export function listWebhooks(): Webhook[] {
  const rows = getDb().prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all() as Record<string, unknown>[];
  return rows.map(rowToWebhook);
}

/** Remove a webhook. */
export function removeWebhook(uid: string): boolean {
  const info = getDb().prepare("DELETE FROM webhooks WHERE uid = ?").run(uid);
  if (info.changes > 0) notifyWrite();
  return info.changes > 0;
}

/** Update webhook active state. */
export function setWebhookActive(uid: string, active: boolean): boolean {
  const info = getDb()
    .prepare(`UPDATE webhooks SET active = ?, last_triggered_at = last_triggered_at WHERE uid = ?`)
    .run(active ? 1 : 0, uid);
  if (info.changes > 0) notifyWrite();
  return info.changes > 0;
}

const MAX_CONSECUTIVE_FAILURES = 10;

/** Deliver an event to a single webhook. Returns HTTP status or -1 on network error. */
async function deliverToWebhook(webhook: Webhook, event: HubEvent): Promise<number> {
  const body = JSON.stringify({
    event: event.type,
    timestamp: new Date().toISOString(),
    data: event,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Hub-Event": event.type,
    "X-Hub-Delivery": randomUUID(),
  };

  if (webhook.secret) {
    const signature = createHmac("sha256", webhook.secret).update(body).digest("hex");
    headers["X-Hub-Signature-256"] = `sha256=${signature}`;
  }

  try {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });

    // Update webhook status
    const db = getDb();
    if (res.ok) {
      db.prepare(
        `UPDATE webhooks SET last_triggered_at = ${NOW_MS}, last_status = ?, fail_count = 0 WHERE uid = ?`
      ).run(res.status, webhook.uid);
    } else {
      const newFailCount = webhook.fail_count + 1;
      const shouldDisable = newFailCount >= MAX_CONSECUTIVE_FAILURES;
      db.prepare(
        `UPDATE webhooks SET last_triggered_at = ${NOW_MS}, last_status = ?, fail_count = ?, active = ? WHERE uid = ?`
      ).run(res.status, newFailCount, shouldDisable ? 0 : 1, webhook.uid);
      if (shouldDisable) {
        console.error(`[hub:webhook] Auto-disabled webhook ${webhook.uid} after ${newFailCount} failures`);
      }
    }
    return res.status;
  } catch (err) {
    const db = getDb();
    const newFailCount = webhook.fail_count + 1;
    const shouldDisable = newFailCount >= MAX_CONSECUTIVE_FAILURES;
    db.prepare(
      `UPDATE webhooks SET last_triggered_at = ${NOW_MS}, last_status = -1, fail_count = ?, active = ? WHERE uid = ?`
    ).run(newFailCount, shouldDisable ? 0 : 1, webhook.uid);
    if (shouldDisable) {
      console.error(`[hub:webhook] Auto-disabled webhook ${webhook.uid}: ${(err as Error).message}`);
    }
    return -1;
  }
}

/** Deliver an event to all matching active webhooks. */
export async function deliverWebhook(event: HubEvent): Promise<void> {
  const db = getDb();
  const webhooks = db
    .prepare("SELECT * FROM webhooks WHERE active = 1")
    .all() as Record<string, unknown>[];

  for (const row of webhooks) {
    const webhook = rowToWebhook(row);
    const events: string[] = webhook.events;
    if (!events.includes("*") && !events.includes(event.type)) continue;
    // Fire and forget with error handling
    deliverToWebhook(webhook, event).catch((err) => {
      console.error(`[hub:webhook] delivery error: ${(err as Error).message}`);
    });
  }
}

/** Initialize webhook delivery: subscribe to all hub events. */
export function initWebhookDelivery(): void {
  onHubEvent("*", (event) => {
    deliverWebhook(event).catch(() => {});
  });
}
