import type { CloudRuntimeConfig } from "./cloud-config.js";
import type { SubscriptionSnapshot } from "./billing.js";
import type { PaddleWebhookStore } from "./paddle.js";

export function cloudServiceHeaders(config: CloudRuntimeConfig, prefer?: string): Record<string, string> {
  const opaqueSecret = config.supabaseServiceRoleKey.startsWith("sb_secret_");
  return {
    apikey: config.supabaseServiceRoleKey,
    ...(!opaqueSecret ? { Authorization: `Bearer ${config.supabaseServiceRoleKey}` } : {}),
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

export async function checkedCloudResponse(response: Response, operation: string): Promise<Response> {
  if (!response.ok) throw new Error(`Cloud billing store ${operation} failed with status ${response.status}`);
  return response;
}

/** Best-effort delivery for new accounts; existing users discover pending invites in-app. */
export async function sendSupabaseUserInvite(
  config: CloudRuntimeConfig,
  email: string,
  invitationId: string,
  request: typeof globalThis.fetch = globalThis.fetch
): Promise<"sent" | "existing_account" | "delivery_failed"> {
  const redirect = new URL(config.appUrl);
  redirect.searchParams.set("mnema_invitation", invitationId);
  const url = new URL(`${config.supabaseUrl}/auth/v1/invite`);
  url.searchParams.set("redirect_to", redirect.toString());
  const response = await request(url, {
    method: "POST",
    headers: cloudServiceHeaders(config),
    body: JSON.stringify({ email, data: { mnema_invitation_id: invitationId } }),
  });
  if (response.ok) return "sent";
  if (response.status === 422) return "existing_account";
  return "delivery_failed";
}

export async function deleteSupabaseUser(
  config: CloudRuntimeConfig,
  userId: string,
  request: typeof globalThis.fetch = globalThis.fetch
): Promise<void> {
  const url = new URL(`${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`);
  url.searchParams.set("should_soft_delete", "false");
  await checkedCloudResponse(
    await request(url, { method: "DELETE", headers: cloudServiceHeaders(config) }),
    "delete auth user"
  );
}

export interface CloudPurgeResult {
  examined: number;
  purged: number;
  waitingForBilling: number;
}

/** Deletes only due organizations whose provider subscription is already canceled. */
export async function purgeDueOrganizations(
  config: CloudRuntimeConfig,
  request: typeof globalThis.fetch = globalThis.fetch,
  now = new Date()
): Promise<CloudPurgeResult> {
  const rest = `${config.supabaseUrl}/rest/v1`;
  const response = await checkedCloudResponse(
    await request(`${rest}/rpc/purge_due_organizations`, {
      method: "POST",
      headers: cloudServiceHeaders(config),
      body: JSON.stringify({ due_before: now.toISOString(), batch_limit: 100 }),
    }),
    "purge organizations"
  );
  const [result] = (await response.json()) as Array<{
    examined?: unknown;
    purged?: unknown;
    waiting_for_billing?: unknown;
  }>;
  if (
    !result ||
    !Number.isInteger(result.examined) ||
    !Number.isInteger(result.purged) ||
    !Number.isInteger(result.waiting_for_billing)
  ) {
    throw new Error("Cloud billing store purge organizations returned an invalid result");
  }
  return {
    examined: result.examined as number,
    purged: result.purged as number,
    waitingForBilling: result.waiting_for_billing as number,
  };
}

/** Server-only Supabase REST adapter for idempotent webhook/subscription state. */
export function createSupabasePaddleStore(
  config: CloudRuntimeConfig,
  request: typeof globalThis.fetch = globalThis.fetch
): PaddleWebhookStore {
  const rest = `${config.supabaseUrl}/rest/v1`;
  return {
    async beginEvent(eventId, payloadSha256) {
      const response = await checkedCloudResponse(
        await request(`${rest}/rpc/claim_billing_webhook`, {
          method: "POST",
          headers: cloudServiceHeaders(config),
          body: JSON.stringify({ provider_name: "paddle", provider_event_id: eventId, body_sha256: payloadSha256 }),
        }),
        "begin event"
      );
      return Boolean(await response.json());
    },
    async getCustomer(organizationId) {
      const params = new URLSearchParams({
        organization_id: `eq.${organizationId}`,
        provider: "eq.paddle",
        select: "provider_customer_id",
        limit: "1",
      });
      const response = await checkedCloudResponse(
        await request(`${rest}/billing_customers?${params}`, { headers: cloudServiceHeaders(config) }),
        "get customer"
      );
      const rows = (await response.json()) as Array<{ provider_customer_id?: string }>;
      return rows[0]?.provider_customer_id ?? null;
    },
    async saveCustomer(organizationId, customerId) {
      await checkedCloudResponse(
        await request(`${rest}/billing_customers?on_conflict=organization_id`, {
          method: "POST",
          headers: cloudServiceHeaders(config, "return=minimal,resolution=merge-duplicates"),
          body: JSON.stringify({
            organization_id: organizationId,
            provider: "paddle",
            provider_customer_id: customerId,
            updated_at: new Date().toISOString(),
          }),
        }),
        "save customer"
      );
    },
    async getSubscription(organizationId) {
      const params = new URLSearchParams({
        organization_id: `eq.${organizationId}`,
        select:
          "provider,provider_subscription_id,plan,status,current_period_end,cancel_at_period_end,last_event_id,last_event_at",
        limit: "1",
      });
      const response = await checkedCloudResponse(
        await request(`${rest}/subscriptions?${params}`, { headers: cloudServiceHeaders(config) }),
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
      const response = await checkedCloudResponse(
        await request(`${rest}/rpc/apply_subscription_snapshot`, {
          method: "POST",
          headers: cloudServiceHeaders(config),
          body: JSON.stringify({
            target_organization_id: organizationId,
            provider_name: snapshot.provider,
            subscription_id: snapshot.providerSubscriptionId,
            plan_name: snapshot.plan,
            subscription_status: snapshot.status,
            period_end: snapshot.currentPeriodEnd,
            cancels_at_period_end: snapshot.cancelAtPeriodEnd,
            provider_event_id: snapshot.lastEventId,
            provider_event_at: snapshot.lastEventAt,
          }),
        }),
        "save subscription"
      );
      return Boolean(await response.json());
    },
    async finishEvent(eventId, status, errorCode) {
      const params = new URLSearchParams({ provider: "eq.paddle", event_id: `eq.${eventId}` });
      await checkedCloudResponse(
        await request(`${rest}/billing_webhook_events?${params}`, {
          method: "PATCH",
          headers: cloudServiceHeaders(config, "return=minimal"),
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
