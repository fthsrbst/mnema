import { createHmac, timingSafeEqual } from "node:crypto";

export type BillingProvider = "paddle" | "lemonsqueezy";
export type PlanId = "free" | "starter" | "pro" | "team";
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "canceled";

export interface PlanEntitlements {
  projects: number;
  members: number;
  storageMb: number;
  monthlyEmbeddingTokens: number;
  auditRetentionDays: number;
}

export const PLAN_ENTITLEMENTS: Readonly<Record<PlanId, PlanEntitlements>> = {
  free: {
    projects: 2,
    members: 1,
    storageMb: 100,
    monthlyEmbeddingTokens: 100_000,
    auditRetentionDays: 7,
  },
  starter: {
    projects: 10,
    members: 1,
    storageMb: 1_024,
    monthlyEmbeddingTokens: 1_000_000,
    auditRetentionDays: 30,
  },
  pro: {
    projects: 50,
    members: 3,
    storageMb: 5_120,
    monthlyEmbeddingTokens: 5_000_000,
    auditRetentionDays: 90,
  },
  team: {
    projects: 250,
    members: 10,
    storageMb: 20_480,
    monthlyEmbeddingTokens: 20_000_000,
    auditRetentionDays: 365,
  },
};

export interface SubscriptionSnapshot {
  provider: BillingProvider;
  providerSubscriptionId: string;
  plan: PlanId;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  lastEventId: string;
  lastEventAt: string;
}

export interface NormalizedSubscriptionEvent {
  id: string;
  occurredAt: string;
  provider: BillingProvider;
  providerSubscriptionId: string;
  plan: PlanId;
  status: SubscriptionStatus;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
}

function secureHexEqual(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]+$/i.test(actual) || !/^[a-f0-9]+$/i.test(expected)) return false;
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verifies Paddle's ts:raw-body HMAC without parsing or re-serializing the body.
 * The default five-second tolerance matches Paddle's SDK default and rejects
 * replayed requests. Callers must persist event ids for durable idempotency.
 */
export function verifyPaddleSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secret: string,
  nowMs = Date.now(),
  toleranceSeconds = 5
): boolean {
  if (!signatureHeader || !secret || toleranceSeconds < 0) return false;
  const parts = signatureHeader.split(";");
  const timestamp = parts.find((part) => part.startsWith("ts="))?.slice(3);
  const signatures = parts.filter((part) => part.startsWith("h1=")).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) return false;
  const timestampMs = Number(timestamp) * 1_000;
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > toleranceSeconds * 1_000) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const expected = createHmac("sha256", secret)
    .update(timestamp)
    .update(":")
    .update(body)
    .digest("hex");
  return signatures.some((candidate) => secureHexEqual(candidate, expected));
}

/**
 * Applies only newer provider state. Webhook delivery is retried and may arrive
 * out of order, so an older event must never downgrade a newer subscription.
 */
export function reduceSubscriptionEvent(
  current: SubscriptionSnapshot | null,
  event: NormalizedSubscriptionEvent
): { changed: boolean; snapshot: SubscriptionSnapshot } {
  if (
    current &&
    (event.id === current.lastEventId || Date.parse(event.occurredAt) <= Date.parse(current.lastEventAt))
  ) {
    return { changed: false, snapshot: current };
  }
  return {
    changed: true,
    snapshot: {
      provider: event.provider,
      providerSubscriptionId: event.providerSubscriptionId,
      plan: event.plan,
      status: event.status,
      currentPeriodEnd: event.currentPeriodEnd ?? current?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: event.cancelAtPeriodEnd ?? current?.cancelAtPeriodEnd ?? false,
      lastEventId: event.id,
      lastEventAt: event.occurredAt,
    },
  };
}

export function subscriptionHasAccess(status: SubscriptionStatus): boolean {
  return status === "trialing" || status === "active" || status === "past_due";
}
