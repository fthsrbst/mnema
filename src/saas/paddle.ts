import { createHash } from "node:crypto";
import { z } from "zod";
import {
  reduceSubscriptionEvent,
  verifyPaddleSignature,
  type NormalizedSubscriptionEvent,
  type PlanId,
  type SubscriptionSnapshot,
} from "./billing.js";

export type BillingInterval = "monthly" | "annual";

export interface PaddlePriceCatalog {
  starter: Record<BillingInterval, string>;
  pro: Record<BillingInterval, string>;
  team: Record<BillingInterval, string>;
}

export interface PaddleCheckoutConfig {
  apiKey: string;
  environment: "sandbox" | "production";
  approvedCheckoutUrl: string;
  prices: PaddlePriceCatalog;
  fetch?: typeof globalThis.fetch;
}

export interface CreateCheckoutInput {
  organizationId: string;
  userId: string;
  plan: Exclude<PlanId, "free">;
  interval: BillingInterval;
}

const transactionResponseSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    checkout: z.object({ url: z.string().url().nullable() }).nullable(),
  }),
});

/** Creates a catalog-bound Paddle checkout. Arbitrary client price ids are never accepted. */
export async function createPaddleCheckout(
  config: PaddleCheckoutConfig,
  input: CreateCheckoutInput
): Promise<{ transactionId: string; checkoutUrl: string }> {
  const priceId = config.prices[input.plan][input.interval];
  if (!priceId?.startsWith("pri_")) throw new Error(`Missing Paddle price for ${input.plan}/${input.interval}`);
  const request = config.fetch ?? globalThis.fetch;
  const base = config.environment === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
  const response = await request(`${base}/transactions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Paddle-Version": "1",
    },
    body: JSON.stringify({
      items: [{ price_id: priceId, quantity: 1 }],
      collection_mode: "automatic",
      custom_data: {
        organization_id: input.organizationId,
        user_id: input.userId,
        plan: input.plan,
        billing_interval: input.interval,
      },
      checkout: { url: config.approvedCheckoutUrl },
    }),
  });
  if (!response.ok) throw new Error(`Paddle checkout failed with status ${response.status}`);
  const parsed = transactionResponseSchema.parse(await response.json());
  if (!parsed.data.checkout?.url) throw new Error("Paddle did not return a checkout URL");
  return { transactionId: parsed.data.id, checkoutUrl: parsed.data.checkout.url };
}

const portalResponseSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    urls: z.object({ general: z.object({ overview: z.string().url() }) }),
  }),
});

/** Creates a short-lived hosted portal link; callers must never persist it. */
export async function createPaddlePortalSession(
  config: Pick<PaddleCheckoutConfig, "apiKey" | "environment" | "fetch">,
  input: { customerId: string; subscriptionId?: string }
): Promise<{ sessionId: string; portalUrl: string }> {
  if (!input.customerId.startsWith("ctm_")) throw new Error("Invalid Paddle customer id");
  if (input.subscriptionId && !input.subscriptionId.startsWith("sub_")) throw new Error("Invalid Paddle subscription id");
  const request = config.fetch ?? globalThis.fetch;
  const base = config.environment === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
  const response = await request(`${base}/customers/${encodeURIComponent(input.customerId)}/portal-sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Paddle-Version": "1",
    },
    body: JSON.stringify(input.subscriptionId ? { subscription_ids: [input.subscriptionId] } : {}),
  });
  if (!response.ok) throw new Error(`Paddle portal session failed with status ${response.status}`);
  const parsed = portalResponseSchema.parse(await response.json());
  return { sessionId: parsed.data.id, portalUrl: parsed.data.urls.general.overview };
}

const paddleEnvelopeSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string().datetime(),
  data: z.unknown(),
});

const paddleEventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string().datetime(),
  data: z.object({
    id: z.string().min(1),
    customer_id: z.string().min(1),
    status: z.enum(["trialing", "active", "past_due", "paused", "canceled"]),
    current_billing_period: z.object({ ends_at: z.string().datetime() }).nullable().optional(),
    scheduled_change: z.object({ action: z.string() }).nullable().optional(),
    custom_data: z.record(z.unknown()).nullable().optional(),
    items: z.array(z.object({ price: z.object({ id: z.string().min(1) }) })).min(1),
  }),
});

export interface PaddleWebhookStore {
  /** Atomically inserts provider+event id. False means already processed/claimed. */
  beginEvent(eventId: string, payloadSha256: string): Promise<boolean>;
  getCustomer(organizationId: string): Promise<string | null>;
  saveCustomer(organizationId: string, customerId: string): Promise<void>;
  getSubscription(organizationId: string): Promise<SubscriptionSnapshot | null>;
  /** Atomically applies only a snapshot newer than stored state. */
  saveSubscription(organizationId: string, snapshot: SubscriptionSnapshot): Promise<boolean>;
  finishEvent(eventId: string, status: "processed" | "ignored" | "failed", errorCode?: string): Promise<void>;
}

export interface ProcessPaddleWebhookConfig {
  secret: string;
  prices: PaddlePriceCatalog;
  store: PaddleWebhookStore;
  nowMs?: number;
  toleranceSeconds?: number;
}

function planForPrice(prices: PaddlePriceCatalog, priceId: string): Exclude<PlanId, "free"> | null {
  for (const plan of ["starter", "pro", "team"] as const) {
    if (prices[plan].monthly === priceId || prices[plan].annual === priceId) return plan;
  }
  return null;
}

/** Signature verification, durable idempotency, tenant routing and monotonic state in one boundary. */
export async function processPaddleWebhook(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  config: ProcessPaddleWebhookConfig
): Promise<{ accepted: boolean; duplicate?: boolean; organizationId?: string }> {
  if (!verifyPaddleSignature(rawBody, signatureHeader, config.secret, config.nowMs, config.toleranceSeconds)) {
    return { accepted: false };
  }
  const rawText = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const rawJson: unknown = JSON.parse(rawText);
  const envelope = paddleEnvelopeSchema.parse(rawJson);
  if (!envelope.event_type.startsWith("subscription.")) {
    return { accepted: true };
  }
  const parsed = paddleEventSchema.parse(rawJson);
  const organizationId = parsed.data.custom_data?.organization_id;
  if (typeof organizationId !== "string" || organizationId.length < 1) {
    throw new Error("Paddle subscription event is missing organization_id custom data");
  }
  const plan = planForPrice(config.prices, parsed.data.items[0]!.price.id);
  if (!plan) throw new Error("Paddle subscription references an unknown price");
  const payloadSha256 = createHash("sha256").update(rawText).digest("hex");
  if (!(await config.store.beginEvent(parsed.event_id, payloadSha256))) {
    return { accepted: true, duplicate: true, organizationId };
  }
  try {
    await config.store.saveCustomer(organizationId, parsed.data.customer_id);
    const event: NormalizedSubscriptionEvent = {
      id: parsed.event_id,
      occurredAt: parsed.occurred_at,
      provider: "paddle",
      providerSubscriptionId: parsed.data.id,
      plan,
      status: parsed.data.status,
      currentPeriodEnd: parsed.data.current_billing_period?.ends_at ?? null,
      cancelAtPeriodEnd: parsed.data.scheduled_change?.action === "cancel",
    };
    const current = await config.store.getSubscription(organizationId);
    const reduced = reduceSubscriptionEvent(current, event);
    const applied = reduced.changed
      ? await config.store.saveSubscription(organizationId, reduced.snapshot)
      : false;
    await config.store.finishEvent(parsed.event_id, applied ? "processed" : "ignored");
    return { accepted: true, organizationId };
  } catch (error) {
    await config.store.finishEvent(parsed.event_id, "failed", error instanceof Error ? error.name : "unknown_error");
    throw error;
  }
}
