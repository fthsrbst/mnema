import { createHmac } from "node:crypto";
import express from "express";
import {
  buildCloudAccountRouter,
  buildCloudWebhookRouter,
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
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${encode({ alg: "none" })}.${encode({ sub: userId, aal: "aal2" })}.test`;
const aal1Token = `${encode({ alg: "none" })}.${encode({ sub: userId, aal: "aal1" })}.test`;

const config: CloudRuntimeConfig = {
  supabaseUrl: "https://supabase.test",
  supabaseAnonKey: "anon-key",
  supabaseServiceRoleKey: "service-role-key",
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
let createdProjectBody: Record<string, unknown> | null = null;
let knowledgeUsedUserToken = true;
const claimed = new Set<string>();
const fakeFetch: typeof globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === `${config.supabaseUrl}/auth/v1/user`) {
    const auth = new Headers(init?.headers).get("authorization");
    if (!auth?.startsWith("Bearer ")) return new Response("", { status: 401 });
    return Response.json({ id: userId, email: "owner@example.com" });
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
  if (url === "https://sandbox-api.paddle.com/transactions") {
    paddleCheckoutBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ data: { id: "txn_1", checkout: { url: "https://checkout.paddle.test/txn_1" } } });
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/billing_webhook_events?on_conflict=`)) {
    const eventId = (JSON.parse(String(init?.body)) as { event_id: string }).event_id;
    if (claimed.has(eventId)) return Response.json([]);
    claimed.add(eventId);
    return Response.json([{ event_id: eventId }], { status: 201 });
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/subscriptions?organization_id=`)) return Response.json([]);
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/subscriptions?on_conflict=`)) {
    subscriptionSaved = true;
    return new Response(null, { status: 201 });
  }
  if (url.startsWith(`${config.supabaseUrl}/rest/v1/billing_webhook_events?provider=`)) {
    return new Response(null, { status: 204 });
  }
  throw new Error(`Unexpected fake fetch: ${url}`);
};

const app = express();
app.use("/webhook", express.raw({ type: "application/json" }), buildCloudWebhookRouter(config, fakeFetch));
app.use(express.json());
app.use("/api", buildCloudAccountRouter(config, fakeFetch));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
const base = `http://127.0.0.1:${address.port}`;

const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const session = await fetch(`${base}/api/session`, { headers: authHeaders });
const sessionJson = (await session.json()) as { organizations?: unknown[] };
check("verified Supabase account returns organizations", session.status === 200 && sessionJson.organizations?.length === 1);

const created = await fetch(`${base}/api/organizations`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ slug: "new-org", name: "New Org" }),
});
check("authenticated account creates an organization through RPC", created.status === 201);

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
check("raw signed webhook persists subscription state", webhook.status === 200 && subscriptionSaved);

const forged = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Paddle-Signature": `ts=${webhookTimestamp};h1=00` },
  body: webhookBody,
});
check("forged webhook is rejected", forged.status === 401);

await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
console.log(failed === 0 ? "\nCloud account and billing router smoke passed." : `\n${failed} cloud router checks failed.`);
process.exitCode = failed === 0 ? 0 : 1;
