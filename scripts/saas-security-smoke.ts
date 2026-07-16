import { createHmac } from "node:crypto";
import fs from "node:fs";
import {
  canTenantAccess,
  createPaddleCheckout,
  processPaddleWebhook,
  reduceSubscriptionEvent,
  requireTenantAccess,
  TenantAccessError,
  verifyPaddleSignature,
  type PaddlePriceCatalog,
  type PaddleWebhookStore,
  type SubscriptionSnapshot,
  type TenantPrincipal,
} from "../src/saas/index.js";

let failed = 0;
function check(name: string, condition: boolean): void {
  console.log(`${condition ? "OK  " : "FAIL"} ${name}`);
  if (!condition) failed++;
}

const owner: TenantPrincipal = {
  userId: "user-a",
  organizationId: "org-a",
  role: "owner",
  aal: "aal2",
};
const member: TenantPrincipal = { ...owner, role: "member", aal: "aal1" };
const viewer: TenantPrincipal = { ...owner, role: "viewer", aal: "aal1" };

check("owner can write own tenant", canTenantAccess(owner, "org-a", "knowledge:write"));
check("cross-tenant access denied before role check", !canTenantAccess(owner, "org-b", "knowledge:read"));
check("viewer is read-only", canTenantAccess(viewer, "org-a", "knowledge:read") && !canTenantAccess(viewer, "org-a", "knowledge:write"));
check("member cannot mutate billing", !canTenantAccess(member, "org-a", "billing:write"));

let mfaCode: string | null = null;
try {
  requireTenantAccess({ ...owner, aal: "aal1" }, "org-a", "billing:write");
} catch (error) {
  if (error instanceof TenantAccessError) mfaCode = error.code;
}
check("sensitive owner action requires MFA", mfaCode === "mfa_required");

const secret = "pdl_ntfset_test_secret";
const timestamp = 1_750_000_000;
const rawBody = JSON.stringify({ event_id: "evt_1", event_type: "subscription.updated" });
const signature = createHmac("sha256", secret).update(`${timestamp}:${rawBody}`).digest("hex");
const header = `ts=${timestamp};h1=${signature}`;
check("valid Paddle signature accepted", verifyPaddleSignature(rawBody, header, secret, timestamp * 1_000));
check("tampered Paddle body rejected", !verifyPaddleSignature(`${rawBody} `, header, secret, timestamp * 1_000));
check("stale Paddle webhook rejected", !verifyPaddleSignature(rawBody, header, secret, (timestamp + 6) * 1_000));
check("malformed Paddle signature rejected", !verifyPaddleSignature(rawBody, "ts=nope;h1=00", secret, timestamp * 1_000));

const first = reduceSubscriptionEvent(null, {
  id: "evt_new",
  occurredAt: "2026-07-16T12:00:00.000Z",
  provider: "paddle",
  providerSubscriptionId: "sub_1",
  plan: "pro",
  status: "active",
});
const older = reduceSubscriptionEvent(first.snapshot, {
  id: "evt_old",
  occurredAt: "2026-07-16T11:59:59.000Z",
  provider: "paddle",
  providerSubscriptionId: "sub_1",
  plan: "starter",
  status: "canceled",
});
check("out-of-order billing event ignored", first.changed && !older.changed && older.snapshot.status === "active");

const prices: PaddlePriceCatalog = {
  starter: { monthly: "pri_starter_month", annual: "pri_starter_year" },
  pro: { monthly: "pri_pro_month", annual: "pri_pro_year" },
  team: { monthly: "pri_team_month", annual: "pri_team_year" },
};
let checkoutRequestBody: Record<string, unknown> | null = null;
const checkout = await createPaddleCheckout(
  {
    apiKey: "test-api-key",
    environment: "sandbox",
    approvedCheckoutUrl: "https://app.mnema.example/billing/complete",
    prices,
    fetch: async (_url, init) => {
      checkoutRequestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: { id: "txn_1", checkout: { url: "https://checkout.paddle.test/txn_1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
  { organizationId: "org-a", userId: "user-a", plan: "pro", interval: "annual" }
);
const checkoutItems = checkoutRequestBody?.items as { price_id: string }[] | undefined;
const checkoutCustomData = checkoutRequestBody?.custom_data as Record<string, unknown> | undefined;
check(
  "checkout binds server catalog price and tenant metadata",
  checkout.transactionId === "txn_1" &&
    checkoutItems?.[0]?.price_id === "pri_pro_year" &&
    checkoutCustomData?.organization_id === "org-a"
);

const subscriptions = new Map<string, SubscriptionSnapshot>();
const claimedEvents = new Set<string>();
const store: PaddleWebhookStore = {
  async beginEvent(eventId) {
    if (claimedEvents.has(eventId)) return false;
    claimedEvents.add(eventId);
    return true;
  },
  async getSubscription(organizationId) {
    return subscriptions.get(organizationId) ?? null;
  },
  async saveSubscription(organizationId, snapshot) {
    subscriptions.set(organizationId, snapshot);
  },
  async finishEvent() {},
};
const webhookBody = JSON.stringify({
  event_id: "evt_webhook_1",
  event_type: "subscription.created",
  occurred_at: "2026-07-16T12:00:00.000Z",
  data: {
    id: "sub_1",
    status: "active",
    current_billing_period: { ends_at: "2026-08-16T12:00:00.000Z" },
    scheduled_change: null,
    custom_data: { organization_id: "org-a" },
    items: [{ price: { id: "pri_pro_month" } }],
  },
});
const webhookTs = 1_768_478_400;
const webhookSig = createHmac("sha256", secret).update(`${webhookTs}:${webhookBody}`).digest("hex");
const webhookConfig = { secret, prices, store, nowMs: webhookTs * 1_000 };
const processed = await processPaddleWebhook(webhookBody, `ts=${webhookTs};h1=${webhookSig}`, webhookConfig);
const duplicate = await processPaddleWebhook(webhookBody, `ts=${webhookTs};h1=${webhookSig}`, webhookConfig);
check(
  "verified webhook provisions tenant subscription exactly once",
  processed.accepted && processed.organizationId === "org-a" && duplicate.duplicate === true && subscriptions.get("org-a")?.plan === "pro"
);

const migration = fs.readFileSync(new URL("../cloud/migrations/0001_tenancy.sql", import.meta.url), "utf8");
const tenantTables = ["projects", "memories", "documents", "document_chunks", "session_logs", "memory_relations", "audit_events"];
for (const table of tenantTables) {
  check(`${table} has tenant column`, new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]*?organization_id uuid not null`, "i").test(migration));
  check(`${table} forces RLS`, migration.includes(`alter table public.${table} force row level security;`));
}
check("billing tables have no authenticated grants", !/grant[^;]+billing_(customers|webhook_events)[^;]+to authenticated/i.test(migration));
check("subscription table has no authenticated grants", !/grant[^;]+subscriptions[^;]+to authenticated/i.test(migration));

console.log(failed === 0 ? "\nSaaS security smoke passed." : `\n${failed} SaaS security checks failed.`);
process.exit(failed === 0 ? 0 : 1);
