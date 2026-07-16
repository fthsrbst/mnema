import { createHmac } from "node:crypto";
import express from "express";
import {
  buildCloudAccountRouter,
  buildCloudWebhookRouter,
  cloudSecurityHeaders,
  createCloudRateLimiter,
  purgeDueOrganizations,
  type CloudRateLimitStore,
  type CloudRuntimeConfig,
} from "../src/saas/index.js";

let failed = 0;
function check(name: string, condition: boolean): void {
  console.log(`${condition ? "OK  " : "FAIL"} ${name}`);
  if (!condition) failed++;
}

const userId = "10000000-0000-4000-8000-000000000001";
const organizationId = "20000000-0000-4000-8000-000000000001";
const otherOrganizationId = "20000000-0000-4000-8000-000000000099";
const createdOrganizationId = "20000000-0000-4000-8000-000000000002";
const projectId = "30000000-0000-4000-8000-000000000001";
const createdProjectId = "30000000-0000-4000-8000-000000000002";
const memoryId = "40000000-0000-4000-8000-000000000001";
const secondMemoryId = "40000000-0000-4000-8000-000000000002";
const documentId = "50000000-0000-4000-8000-000000000001";
const chunkId = "60000000-0000-4000-8000-000000000001";
const invitationId = "80000000-0000-4000-8000-000000000001";
const memberId = "90000000-0000-4000-8000-000000000001";
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${encode({ alg: "none" })}.${encode({ sub: userId, aal: "aal2" })}.test`;
const aal1Token = `${encode({ alg: "none" })}.${encode({ sub: userId, aal: "aal1" })}.test`;
const unverifiedToken = `${encode({ alg: "none" })}.${encode({ sub: userId, aal: "aal2", verified: false })}.test`;

const config: CloudRuntimeConfig = {
  appUrl: "https://app.mnema.test",
  supabaseUrl: "https://supabase.test",
  supabasePublicKey: "anon-key",
  supabaseServiceRoleKey: "service-role-key",
  httpsOnly: true,
  trustProxyHops: 0,
  rateLimitPerMinute: 300,
  webhookRateLimitPerMinute: 120,
  paddle: {
    apiKey: "paddle-api-key",
    webhookSecret: "paddle-webhook-secret",
    environment: "sandbox",
    approvedCheckoutUrl: "https://app.mnema.test/billing/complete",
    prices: {
      starter: { monthly: "pri_starter_month", annual: "pri_starter_year" },
      pro: { monthly: "pri_pro_month", annual: "pri_pro_year" },
      team: { monthly: "pri_team_month", annual: "pri_team_year" },
    },
  },
};

let paddleCheckoutBody: Record<string, unknown> | null = null;
let subscriptionSaved = false;
let customerSaved = false;
let createdProjectBody: Record<string, unknown> | null = null;
let knowledgeUsedUserToken = true;
let authUserDeleted = false;
let memberRoleChanged = false;
let memberRemoved = false;
const claimed = new Set<string>();
const fakeFetch: typeof globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes("/rest/v1/rpc/")) {
    const headers = new Headers(init?.headers);
    if (headers.get("Accept-Profile") !== "app" || headers.get("Content-Profile") !== "app") {
      throw new Error("Cloud RPC request did not select the app PostgREST schema");
    }
  }
  if (url === `${config.supabaseUrl}/auth/v1/user`) {
    const auth = new Headers(init?.headers).get("authorization");
    if (!auth?.startsWith("Bearer ")) return new Response("", { status: 401 });
    return Response.json({
      id: userId,
      email: "owner@example.com",
      ...(auth === `Bearer ${unverifiedToken}` ? {} : { email_confirmed_at: new Date().toISOString() }),
    });
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/organization_members?`)) {
    const selectedOrganization = new URL(url).searchParams.get("organization_id");
    if (selectedOrganization && selectedOrganization !== `eq.${organizationId}`) return Response.json([]);
    return Response.json([
      {
        organization_id: organizationId,
        role: "owner",
        organizations: { id: organizationId, name: "Org A", slug: "org-a" },
      },
    ]);
  }
  if (url === `${config.supabaseUrl}/rest/v1/rpc/create_organization`) {
    return Response.json(createdOrganizationId, { status: 200 });
  }
  if (url === `${config.supabaseUrl}/rest/v1/rpc/list_my_organization_invitations`) {
    return Response.json([{ invitation_id: invitationId, organization_id: organizationId, organization_name: "Org A", organization_slug: "org-a", invitation_role: "viewer", expires_at: new Date(Date.now() + 86_400_000).toISOString() }]);
  }
  if (url === `${config.supabaseUrl}/rest/v1/rpc/list_organization_invitations`) {
    return Response.json([{ invitation_id: invitationId, email: "invitee@example.com", invitation_role: "viewer", invitation_status: "pending", expires_at: new Date(Date.now() + 86_400_000).toISOString() }]);
  }
  if (url === `${config.supabaseUrl}/rest/v1/rpc/list_organization_members`) {
    return Response.json([
      { member_user_id: userId, member_email: "owner@example.com", member_role: "owner", joined_at: new Date().toISOString() },
      { member_user_id: memberId, member_email: "member@example.com", member_role: "viewer", joined_at: new Date().toISOString() },
    ]);
  }
  if (url === `${config.supabaseUrl}/rest/v1/rpc/change_organization_member_role`) {
    memberRoleChanged = true;
    return Response.json(true);
  }
  if (url === `${config.supabaseUrl}/rest/v1/rpc/remove_organization_member`) {
    memberRemoved = true;
    return Response.json(true);
  }
  if (url === `${config.supabaseUrl}/rest/v1/rpc/create_organization_invitation`) return Response.json(invitationId);
  if (url === `${config.supabaseUrl}/rest/v1/rpc/accept_organization_invitation`) return Response.json(organizationId);
  if (url === `${config.supabaseUrl}/rest/v1/rpc/revoke_organization_invitation`) return Response.json(true);
  if (url === `${config.supabaseUrl}/rest/v1/rpc/request_organization_deletion`) return Response.json(new Date(Date.now() + 7 * 86_400_000).toISOString());
  if (url === `${config.supabaseUrl}/rest/v1/rpc/cancel_organization_deletion`) return Response.json(true);
  if (url === `${config.supabaseUrl}/rest/v1/rpc/assert_account_deletable`) return Response.json(true);
  if (url.startsWith(`${config.supabaseUrl}/auth/v1/invite?`)) return Response.json({ id: "invited-user" });
  if (url.startsWith(`${config.supabaseUrl}/auth/v1/admin/users/${userId}?`) && init?.method === "DELETE") {
    authUserDeleted = true;
    return new Response(null, { status: 204 });
  }
  if (url === `${config.supabaseUrl}/rest/v1/rpc/create_project`) {
    createdProjectBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json(createdProjectId);
  }
  if (url === `${config.supabaseUrl}/rest/v1/rpc/add_memory`) return Response.json(secondMemoryId);
  if (url === `${config.supabaseUrl}/rest/v1/rpc/add_document`) {
    return Response.json([{ document_id: documentId, chunk_id: chunkId }]);
  }
  if (url === `${config.supabaseUrl}/rest/v1/rpc/search_knowledge`) {
    return Response.json([{ resource_type: "memory", resource_id: memoryId, project_id: projectId, title: "Decision", snippet: "tenant-safe", rank: 0.9 }]);
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/projects?`)) {
    knowledgeUsedUserToken &&= new Headers(init?.headers).get("authorization") === `Bearer ${token}`;
    return Response.json([{ id: projectId, slug: "mnema", map: { architecture: ["api"] }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/memories?`)) {
    return Response.json([{ id: memoryId, type: "decision", title: "Decision", body: "tenant-safe", tags: [], importance: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/documents?`)) {
    return Response.json([{ id: documentId, uri: "docs/design", title: "Design", source: "test", kind: "reference", is_current: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/session_logs?`)) return Response.json([]);
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/memory_relations?`)) {
    return Response.json([{ id: "70000000-0000-4000-8000-000000000001", from_memory_id: memoryId, to_memory_id: memoryId, relation_type: "supports", confidence: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/organizations?`)) {
    return Response.json([{ id: organizationId, slug: "org-a", name: "Org A", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deletion_requested_at: null, deletion_scheduled_for: null }]);
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/document_chunks?`)) {
    return Response.json([{ organization_id: organizationId, document_id: documentId, id: chunkId, sequence: 0, heading: null, content: "Tenant content", created_at: new Date().toISOString() }]);
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/audit_events?`)) return Response.json([]);
  if (url === "https://sandbox-api.paddle.com/transactions") {
    paddleCheckoutBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ data: { id: "txn_1", checkout: { url: "https://checkout.paddle.test/txn_1" } } });
  }
  if (url === "https://sandbox-api.paddle.com/customers/ctm_cloud_1/portal-sessions") {
    return Response.json({ data: { id: "cpls_cloud_1", urls: { general: { overview: "https://portal.paddle.test/cloud" } } } }, { status: 201 });
  }
  if (url === `${config.supabaseUrl}/rest/v1/rpc/claim_billing_webhook`) {
    const eventId = (JSON.parse(String(init?.body)) as { provider_event_id: string }).provider_event_id;
    if (claimed.has(eventId)) return Response.json(false);
    claimed.add(eventId);
    return Response.json(true);
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/billing_customers?organization_id=`)) {
    return Response.json(customerSaved ? [{ provider_customer_id: "ctm_cloud_1" }] : []);
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/billing_customers?on_conflict=`)) {
    customerSaved = true;
    return new Response(null, { status: 201 });
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/subscriptions?organization_id=`)) {
    return Response.json(subscriptionSaved ? [{
      provider: "paddle",
      provider_subscription_id: "sub_cloud_1",
      plan: "pro",
      status: "active",
      current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
      cancel_at_period_end: false,
      last_event_id: "evt_cloud_1",
      last_event_at: new Date().toISOString(),
    }] : []);
  }
  if (url === `${config.supabaseUrl}/rest/v1/rpc/apply_subscription_snapshot`) {
    subscriptionSaved = true;
    return Response.json(true);
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/billing_webhook_events?provider=`)) {
    return new Response(null, { status: 204 });
  }
  throw new Error(`Unexpected fake fetch: ${url}`);
};

const app = express();
app.disable("x-powered-by");
app.use(cloudSecurityHeaders({ supabaseUrl: config.supabaseUrl, httpsOnly: true }));
app.get("/limit-probe", createCloudRateLimiter({ limit: 2, namespace: "smoke" }), (_req, res) => res.json({ ok: true }));
const distributedCounts = new Map<string, number>();
const distributedStore: CloudRateLimitStore = {
  async consume(key) {
    const count = (distributedCounts.get(key) ?? 0) + 1;
    distributedCounts.set(key, count);
    return { count, resetAfterMs: 60_000 };
  },
};
const distributedOptions = { limit: 2, namespace: "distributed-smoke", store: distributedStore };
app.get("/distributed-a", createCloudRateLimiter(distributedOptions), (_req, res) => res.json({ ok: true }));
app.get("/distributed-b", createCloudRateLimiter(distributedOptions), (_req, res) => res.json({ ok: true }));
app.get("/distributed-failure", createCloudRateLimiter({
  limit: 2,
  store: { async consume() { throw new Error("store offline"); } },
}), (_req, res) => res.json({ should_not_run: true }));
app.use("/webhook", express.raw({ type: "application/json" }), buildCloudWebhookRouter(config, fakeFetch));
app.use(express.json());
app.use("/api", buildCloudAccountRouter(config, fakeFetch));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
const base = `http://127.0.0.1:${address.port}`;

const headerProbe = await fetch(`${base}/limit-probe`);
await fetch(`${base}/limit-probe`);
const limitedProbe = await fetch(`${base}/limit-probe`);
check(
  "Cloud edge sets CSP/HSTS, hides Express, and rate-limits abuse",
  headerProbe.headers.get("content-security-policy")?.includes(config.supabaseUrl) === true &&
    headerProbe.headers.get("content-security-policy")?.includes("font-src 'self' data:") === true &&
    headerProbe.headers.get("strict-transport-security") !== null &&
    headerProbe.headers.get("x-powered-by") === null && limitedProbe.status === 429
);
const distributedFirst = await fetch(`${base}/distributed-a`);
await fetch(`${base}/distributed-b`);
const distributedLimited = await fetch(`${base}/distributed-a`);
check(
  "Cloud replicas share one distributed rate-limit counter",
  distributedFirst.headers.get("x-ratelimit-backend") === "distributed" &&
    distributedLimited.status === 429
);
const distributedFailure = await fetch(`${base}/distributed-failure`);
check(
  "Cloud distributed rate-limit failure is fail-closed",
  distributedFailure.status === 503 &&
    (await distributedFailure.json() as { error?: string }).error === "rate_limit_unavailable"
);

const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const session = await fetch(`${base}/api/session`, { headers: authHeaders });
const sessionJson = (await session.json()) as { organizations?: unknown[] };
check("verified Supabase account returns organizations", session.status === 200 && sessionJson.organizations?.length === 1);

const unverifiedSession = await fetch(`${base}/api/session`, {
  headers: { Authorization: `Bearer ${unverifiedToken}` },
});
check("Cloud rejects an authenticated but unverified email", unverifiedSession.status === 403);

const created = await fetch(`${base}/api/organizations`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ slug: "new-org", name: "New Org" }),
});
check("authenticated account creates an organization through RPC", created.status === 201);

const personalInvitations = await fetch(`${base}/api/invitations`, { headers: authHeaders });
const personalInvitationJson = (await personalInvitations.json()) as { invitations?: unknown[] };
check("verified account lists pending email-bound invitations", personalInvitations.status === 200 && personalInvitationJson.invitations?.length === 1);

const invitationCreated = await fetch(`${base}/api/organizations/invitations`, {
  method: "POST",
  headers: { ...authHeaders, "x-mnema-organization-id": organizationId },
  body: JSON.stringify({ email: "Invitee@Example.com", role: "viewer" }),
});
const invitationCreatedJson = (await invitationCreated.json()) as { delivery?: string };
check("MFA owner creates and delivers an organization invitation", invitationCreated.status === 201 && invitationCreatedJson.delivery === "sent");

const invitationNoMfa = await fetch(`${base}/api/organizations/invitations`, {
  method: "POST",
  headers: { Authorization: `Bearer ${aal1Token}`, "Content-Type": "application/json", "x-mnema-organization-id": organizationId },
  body: JSON.stringify({ email: "invitee@example.com", role: "viewer" }),
});
check("organization invitation requires MFA", invitationNoMfa.status === 403);

const invitationAccepted = await fetch(`${base}/api/invitations/${invitationId}/accept`, { method: "POST", headers: authHeaders, body: "{}" });
check("email-bound invitation acceptance returns its organization", invitationAccepted.status === 200);

const organizationInvitations = await fetch(`${base}/api/organizations/invitations`, {
  headers: { ...authHeaders, "x-mnema-organization-id": organizationId },
});
const organizationInvitationJson = (await organizationInvitations.json()) as { invitations?: unknown[] };
check("MFA administrator lists tenant invitation state", organizationInvitations.status === 200 && organizationInvitationJson.invitations?.length === 1);

const organizationMembers = await fetch(`${base}/api/organizations/members`, {
  headers: { ...authHeaders, "x-mnema-organization-id": organizationId },
});
const organizationMembersJson = (await organizationMembers.json()) as { members?: unknown[] };
check("MFA owner lists tenant members", organizationMembers.status === 200 && organizationMembersJson.members?.length === 2);

const memberRole = await fetch(`${base}/api/organizations/members/${memberId}`, {
  method: "PATCH",
  headers: { ...authHeaders, "x-mnema-organization-id": organizationId },
  body: JSON.stringify({ role: "member" }),
});
check("MFA owner changes a member role through the guarded RPC", memberRole.status === 200 && memberRoleChanged);

const memberRemoval = await fetch(`${base}/api/organizations/members/${memberId}`, {
  method: "DELETE",
  headers: { ...authHeaders, "x-mnema-organization-id": organizationId },
});
check("MFA owner removes a member through the guarded RPC", memberRemoval.status === 200 && memberRemoved);

const invitationRevoked = await fetch(`${base}/api/organizations/invitations/${invitationId}`, {
  method: "DELETE",
  headers: { ...authHeaders, "x-mnema-organization-id": organizationId },
});
check("MFA administrator revokes a tenant-bound invitation", invitationRevoked.status === 200);

const deletionScheduled = await fetch(`${base}/api/organizations/deletion`, {
  method: "POST",
  headers: { ...authHeaders, "x-mnema-organization-id": organizationId },
  body: JSON.stringify({ confirmationSlug: "org-a" }),
});
check("MFA owner schedules delayed organization deletion", deletionScheduled.status === 202);

const deletionCanceled = await fetch(`${base}/api/organizations/deletion`, {
  method: "DELETE",
  headers: { ...authHeaders, "x-mnema-organization-id": organizationId },
});
check("MFA owner cancels scheduled organization deletion", deletionCanceled.status === 200);

const organizationExport = await fetch(`${base}/api/organizations/export`, {
  headers: { ...authHeaders, "x-mnema-organization-id": organizationId },
});
const organizationExportText = await organizationExport.text();
check(
  "MFA owner streams an RLS-scoped portable NDJSON export",
  organizationExport.status === 200 &&
    organizationExport.headers.get("content-type")?.includes("application/x-ndjson") === true &&
    organizationExportText.includes('"type":"mnema-export"') && organizationExportText.includes('"table":"memories"')
);

const knowledgeHeaders = { ...authHeaders, "x-mnema-organization-id": organizationId };
const projects = await fetch(`${base}/api/knowledge/projects`, { headers: knowledgeHeaders });
const projectsJson = (await projects.json()) as { projects?: unknown[] };
check("tenant knowledge gateway lists RLS-scoped projects", projects.status === 200 && projectsJson.projects?.length === 1);
check("knowledge reads use the verified user JWT, never the service role", knowledgeUsedUserToken);

const projectCreated = await fetch(`${base}/api/knowledge/projects`, {
  method: "POST",
  headers: knowledgeHeaders,
  body: JSON.stringify({ slug: "new-project", map: { decisions: ["RLS"] } }),
});
check(
  "project creation is bound to the selected tenant quota RPC",
  projectCreated.status === 201 && createdProjectBody?.target_organization_id === organizationId
);

const projectDetail = await fetch(`${base}/api/knowledge/projects/${projectId}`, { headers: knowledgeHeaders });
const projectDetailJson = (await projectDetail.json()) as { memories?: unknown[]; documents?: unknown[] };
check(
  "project map detail joins tenant memories and documents",
  projectDetail.status === 200 && projectDetailJson.memories?.length === 1 && projectDetailJson.documents?.length === 1
);

const memoryCreated = await fetch(`${base}/api/knowledge/memories`, {
  method: "POST",
  headers: knowledgeHeaders,
  body: JSON.stringify({ projectId, type: "howto", title: "Fix", body: "Use the tenant RPC" }),
});
check("memory creation uses the tenant-bound RPC", memoryCreated.status === 201);

const documentCreated = await fetch(`${base}/api/knowledge/documents`, {
  method: "POST",
  headers: knowledgeHeaders,
  body: JSON.stringify({ projectId, uri: "docs/new", title: "New doc", content: "Tenant content" }),
});
check("document creation uses the atomic storage-quota RPC", documentCreated.status === 201);

const search = await fetch(`${base}/api/knowledge/search?q=tenant`, { headers: knowledgeHeaders });
const searchJson = (await search.json()) as { results?: unknown[] };
check("cloud knowledge search remains tenant-scoped", search.status === 200 && searchJson.results?.length === 1);

const crossTenant = await fetch(`${base}/api/knowledge/projects`, {
  headers: { ...authHeaders, "x-mnema-organization-id": otherOrganizationId },
});
check("gateway rejects a tenant header without membership", crossTenant.status === 403);

const entitlement = await fetch(`${base}/api/billing/subscription`, { headers: knowledgeHeaders });
const entitlementJson = (await entitlement.json()) as { plan?: string; entitlements?: { projects?: number } };
check(
  "missing subscription safely resolves to free-plan server entitlements",
  entitlement.status === 200 && entitlementJson.plan === "free" && entitlementJson.entitlements?.projects === 2
);

const checkout = await fetch(`${base}/api/billing/checkout`, {
  method: "POST",
  headers: { ...authHeaders, "x-mnema-organization-id": organizationId },
  body: JSON.stringify({ plan: "pro", interval: "annual" }),
});
const checkoutCustom = paddleCheckoutBody?.custom_data as Record<string, unknown> | undefined;
check(
  "owner with MFA can create tenant-bound checkout",
  checkout.status === 201 && checkoutCustom?.organization_id === organizationId
);

const noMfa = await fetch(`${base}/api/billing/checkout`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${aal1Token}`,
    "Content-Type": "application/json",
    "x-mnema-organization-id": organizationId,
  },
  body: JSON.stringify({ plan: "starter", interval: "monthly" }),
});
check("billing checkout requires MFA", noMfa.status === 403);

const webhookTimestamp = Math.floor(Date.now() / 1_000);
const webhookBody = JSON.stringify({
  event_id: "evt_cloud_1",
  event_type: "subscription.created",
  occurred_at: new Date().toISOString(),
  data: {
    id: "sub_cloud_1",
    customer_id: "ctm_cloud_1",
    status: "active",
    current_billing_period: { ends_at: new Date(Date.now() + 86_400_000).toISOString() },
    scheduled_change: null,
    custom_data: { organization_id: organizationId },
    items: [{ price: { id: "pri_pro_month" } }],
  },
});
const webhookSignature = createHmac("sha256", config.paddle.webhookSecret)
  .update(`${webhookTimestamp}:${webhookBody}`)
  .digest("hex");
const webhook = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Paddle-Signature": `ts=${webhookTimestamp};h1=${webhookSignature}` },
  body: webhookBody,
});
check("raw signed webhook persists customer and subscription state", webhook.status === 200 && subscriptionSaved && customerSaved);

const duplicateCheckout = await fetch(`${base}/api/billing/checkout`, {
  method: "POST",
  headers: knowledgeHeaders,
  body: JSON.stringify({ plan: "team", interval: "annual" }),
});
check("an existing non-canceled subscription blocks duplicate checkout", duplicateCheckout.status === 409);

const portal = await fetch(`${base}/api/billing/portal`, { method: "POST", headers: knowledgeHeaders, body: "{}" });
const portalJson = (await portal.json()) as { portalUrl?: string };
check("MFA owner receives a temporary Paddle customer portal", portal.status === 201 && portalJson.portalUrl === "https://portal.paddle.test/cloud");

const forged = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Paddle-Signature": `ts=${webhookTimestamp};h1=00` },
  body: webhookBody,
});
check("forged webhook is rejected", forged.status === 401);

const accountNoMfa = await fetch(`${base}/api/account`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${aal1Token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ confirmationEmail: "owner@example.com" }),
});
check("account deletion requires MFA", accountNoMfa.status === 403);

const accountDeleted = await fetch(`${base}/api/account`, {
  method: "DELETE",
  headers: authHeaders,
  body: JSON.stringify({ confirmationEmail: "owner@example.com" }),
});
check("deletable account is removed through server-only Auth Admin", accountDeleted.status === 204 && authUserDeleted);

let lifecyclePurgeCount = 0;
const lifecycleFetch: typeof globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/rpc/purge_due_organizations") && init?.method === "POST") {
    lifecyclePurgeCount += 1;
    return Response.json([{ examined: 2, purged: 1, waiting_for_billing: 1 }]);
  }
  throw new Error(`Unexpected lifecycle fetch: ${url}`);
};
const lifecycle = await purgeDueOrganizations(config, lifecycleFetch, new Date());
check(
  "lifecycle worker purges only due tenants with canceled billing",
  lifecycle.purged === 1 && lifecycle.waitingForBilling === 1 && lifecyclePurgeCount === 1
);

await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
console.log(failed === 0 ? "\nCloud account and billing router smoke passed." : `\n${failed} cloud router checks failed.`);
process.exitCode = failed === 0 ? 0 : 1;
