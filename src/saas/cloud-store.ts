import type { CloudRuntimeConfig } from "./cloud-config.js";
import type { SubscriptionSnapshot } from "./billing.js";
import type { PaddleWebhookStore } from "./paddle.js";

function serviceHeaders(config: CloudRuntimeConfig, prefer?: string): Record<string, string> {
  return {
    apikey: config.supabaseServiceRoleKey,
    Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function checked(response: Response, operation: string): Promise<Response> {
  if (!response.ok) throw new Error(`Cloud billing store ${operation} failed with status ${response.status}`);
  return response;
}

/** Server-only Supabase REST adapter for idempotent webhook/subscription state. */
export function createSupabasePaddleStore(
  config: CloudRuntimeConfig,
  request: typeof globalThis.fetch = globalThis.fetch
): PaddleWebhookStore {
  const rest = `${config.supabaseUrl}/rest/v1`;
  return {
    async beginEvent(eventId, payloadSha256) {
      const response = await checked(
        await request(`${rest}/billing_webhook_events?on_conflict=provider,event_id`, {
          method: "POST",
          headers: serviceHeaders(config, "return=representation,resolution=ignore-duplicates"),
          body: JSON.stringify({ provider: "paddle", event_id: eventId, payload_sha256: payloadSha256 }),
        }),
        "begin event"
      );
      const rows = (await response.json()) as unknown[];
      return rows.length > 0;
    },
    async getSubscription(organizationId) {
      const params = new URLSearchParams({
        organization_id: `eq.${organizationId}`,
        select:
          "provider,provider_subscription_id,plan,status,current_period_end,cancel_at_period_end,last_event_id,last_event_at",
        limit: "1",
      });
      const response = await checked(
        await request(`${rest}/subscriptions?${params}`, { headers: serviceHeaders(config) }),
        "get subscription"
      );
      const rows = (await response.json()) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) return null;
      return {
        provider: row.provider as SubscriptionSnapshot["provider"],
        providerSubscriptionId: String(row.provider_subscription_id),
        plan: row.plan as SubscriptionSnapshot["plan"],
        status: row.status as SubscriptionSnapshot["status"],
        currentPeriodEnd: row.current_period_end ? String(row.current_period_end) : null,
        cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
        lastEventId: String(row.last_event_id),
        lastEventAt: String(row.last_event_at),
      };
    },
    async saveSubscription(organizationId, snapshot) {
      await checked(
        await request(`${rest}/subscriptions?on_conflict=organization_id`, {
          method: "POST",
          headers: serviceHeaders(config, "return=minimal,resolution=merge-duplicates"),
          body: JSON.stringify({
            organization_id: organizationId,
            provider: snapshot.provider,
            provider_subscription_id: snapshot.providerSubscriptionId,
            plan: snapshot.plan,
            status: snapshot.status,
            current_period_end: snapshot.currentPeriodEnd,
            cancel_at_period_end: snapshot.cancelAtPeriodEnd,
            last_event_id: snapshot.lastEventId,
            last_event_at: snapshot.lastEventAt,
            updated_at: new Date().toISOString(),
          }),
        }),
        "save subscription"
      );
    },
    async finishEvent(eventId, status, errorCode) {
      const params = new URLSearchParams({ provider: "eq.paddle", event_id: `eq.${eventId}` });
      await checked(
        await request(`${rest}/billing_webhook_events?${params}`, {
          method: "PATCH",
          headers: serviceHeaders(config, "return=minimal"),
          body: JSON.stringify({
            status,
            processed_at: new Date().toISOString(),
            error_code: errorCode ?? null,
          }),
        }),
        "finish event"
      );
    },
  };
}
