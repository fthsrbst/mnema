import { Router, type Request, type Response } from "express";
import { once } from "node:events";
import { z } from "zod";
import { PLAN_ENTITLEMENTS, subscriptionHasAccess } from "./billing.js";
import type { CloudRuntimeConfig } from "./cloud-config.js";
import { createSupabasePaddleStore, deleteSupabaseUser, sendSupabaseUserInvite } from "./cloud-store.js";
import { createPaddleCheckout, createPaddlePortalSession, processPaddleWebhook } from "./paddle.js";

interface VerifiedCloudUser {
  id: string;
  email: string | null;
  aal: "aal1" | "aal2";
  token: string;
}

class CloudHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "CloudHttpError";
  }
}

const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().nullable().optional(),
  email_confirmed_at: z.string().nullable().optional(),
  confirmed_at: z.string().nullable().optional(),
});
const membershipSchema = z.object({
  organization_id: z.string().uuid(),
  role: z.enum(["owner", "admin", "member", "viewer"]),
  organizations: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      slug: z.string(),
      deletion_scheduled_for: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
type CloudMembership = z.infer<typeof membershipSchema>;

const projectSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  map: z.unknown(),
  created_at: z.string(),
  updated_at: z.string(),
});
const recordArraySchema = z.array(z.record(z.string(), z.unknown()));

function bearer(req: Request): string {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new CloudHttpError(401, "unauthorized");
  return header.slice(7);
}

function jwtPayload(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function verifyCloudUser(
  req: Request,
  config: CloudRuntimeConfig,
  request: typeof globalThis.fetch
): Promise<VerifiedCloudUser> {
  const token = bearer(req);
  const response = await request(`${config.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: config.supabasePublicKey, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new CloudHttpError(401, "unauthorized");
  const user = userSchema.parse(await response.json());
  if (!user.email || !(user.email_confirmed_at || user.confirmed_at)) {
    throw new CloudHttpError(403, "email_not_verified");
  }
  const claims = jwtPayload(token);
  if (claims.sub !== user.id) throw new CloudHttpError(401, "invalid_session");
  return { id: user.id, email: user.email ?? null, aal: claims.aal === "aal2" ? "aal2" : "aal1", token };
}

function userHeaders(config: CloudRuntimeConfig, token: string, prefer?: string): Record<string, string> {
  return {
    apikey: config.supabasePublicKey,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

function organizationId(req: Request): string {
  return z.string().uuid().parse(req.header("x-mnema-organization-id"));
}

async function memberships(
  config: CloudRuntimeConfig,
  user: VerifiedCloudUser,
  request: typeof globalThis.fetch,
  organizationId?: string
) {
  const params = new URLSearchParams({
    user_id: `eq.${user.id}`,
    select: "organization_id,role,organizations(id,name,slug,deletion_scheduled_for)",
    ...(organizationId ? { organization_id: `eq.${organizationId}` } : {}),
  });
  const response = await request(`${config.supabaseUrl}/rest/v1/organization_members?${params}`, {
    headers: userHeaders(config, user.token),
  });
  if (!response.ok) throw new CloudHttpError(502, "membership_lookup_failed");
  return z.array(membershipSchema).parse(await response.json());
}

async function requireMembership(
  req: Request,
  config: CloudRuntimeConfig,
  user: VerifiedCloudUser,
  request: typeof globalThis.fetch,
  write = false
): Promise<{ organizationId: string; membership: CloudMembership }> {
  const selectedOrganizationId = organizationId(req);
  const [membership] = await memberships(config, user, request, selectedOrganizationId);
  if (!membership || (write && membership.role === "viewer")) throw new CloudHttpError(403, "forbidden");
  if (write && membership.organizations?.deletion_scheduled_for) {
    throw new CloudHttpError(409, "organization_deletion_scheduled");
  }
  return { organizationId: selectedOrganizationId, membership };
}

async function restJson(
  response: globalThis.Response,
  failureCode: string
): Promise<unknown> {
  if (response.ok) return response.status === 204 ? null : response.json();
  const providerBody = await response.text();
  if (providerBody.includes("project_quota_exceeded")) throw new CloudHttpError(409, "project_quota_exceeded");
  if (providerBody.includes("storage_quota_exceeded")) throw new CloudHttpError(413, "storage_quota_exceeded");
  if (providerBody.includes("member_quota_exceeded")) throw new CloudHttpError(409, "member_quota_exceeded");
  if (providerBody.includes("subscription_cancellation_required")) throw new CloudHttpError(409, "subscription_cancellation_required");
  if (providerBody.includes("owned_organizations_remain")) throw new CloudHttpError(409, "owned_organizations_remain");
  if (providerBody.includes("mfa_required")) throw new CloudHttpError(403, "mfa_required");
  if (response.status === 401 || response.status === 403) throw new CloudHttpError(403, "forbidden");
  if (response.status === 409) throw new CloudHttpError(409, "conflict");
  throw new CloudHttpError(502, failureCode);
}

async function rpc(
  config: CloudRuntimeConfig,
  user: VerifiedCloudUser,
  request: typeof globalThis.fetch,
  name: string,
  body: Record<string, unknown>,
  failureCode: string
): Promise<unknown> {
  return restJson(
    await request(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: userHeaders(config, user.token),
      body: JSON.stringify(body),
    }),
    failureCode
  );
}

function tenantQuery(organizationId: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({ organization_id: `eq.${organizationId}`, ...extra });
}

function sendCloudError(res: Response, error: unknown) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof CloudHttpError) return res.status(error.status).json({ error: error.code });
  if (error instanceof z.ZodError) return res.status(400).json({ error: "invalid_request" });
  return res.status(500).json({ error: "cloud_operation_failed" });
}

const exportTables = [
  ["organizations", "id,slug,name,created_at,updated_at,deletion_requested_at,deletion_scheduled_for"],
  ["organization_members", "organization_id,user_id,role,created_at"],
  ["projects", "organization_id,id,slug,map,created_at,updated_at"],
  ["memories", "organization_id,id,project_id,type,title,body,tags,importance,created_at,updated_at"],
  ["documents", "organization_id,id,project_id,uri,title,source,kind,is_current,content_hash,created_at,updated_at"],
  ["document_chunks", "organization_id,document_id,id,sequence,heading,content,created_at"],
  ["session_logs", "organization_id,id,project_id,summary,source,created_at,updated_at"],
  ["memory_relations", "organization_id,id,from_memory_id,to_memory_id,relation_type,confidence,created_at,updated_at"],
  ["audit_events", "organization_id,id,actor_user_id,action,resource_type,resource_id,metadata,created_at"],
] as const;

async function streamOrganizationExport(
  res: Response,
  config: CloudRuntimeConfig,
  user: VerifiedCloudUser,
  organizationId: string,
  organizationSlug: string,
  request: typeof globalThis.fetch
): Promise<void> {
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="mnema-${organizationSlug}-export.ndjson"`);
  res.write(`${JSON.stringify({ type: "mnema-export", version: 1, organization_id: organizationId, exported_at: new Date().toISOString() })}\n`);
  for (const [table, select] of exportTables) {
    let offset = 0;
    while (!res.destroyed) {
      const params = tenantQuery(organizationId, { select, order: "created_at.asc" });
      const response = await request(`${config.supabaseUrl}/rest/v1/${table}?${params}`, {
        headers: { ...userHeaders(config, user.token), Range: `${offset}-${offset + 999}` },
      });
      const rows = recordArraySchema.parse(await restJson(response, "organization_export_failed"));
      for (const row of rows) {
        if (!res.write(`${JSON.stringify({ table, row })}\n`)) await once(res, "drain");
      }
      if (rows.length < 1_000) break;
      offset += rows.length;
    }
  }
  if (!res.destroyed) res.end();
}

export function buildCloudAccountRouter(
  config: CloudRuntimeConfig,
  request: typeof globalThis.fetch = globalThis.fetch
) {
  const router = Router();
  const billingStore = createSupabasePaddleStore(config, request);
  router.get("/session", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const organizations = await memberships(config, user, request);
      res.json({ user: { id: user.id, email: user.email, aal: user.aal }, organizations });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.delete("/account", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      const input = z.object({ confirmationEmail: z.string().trim().email() }).parse(req.body);
      const allowed = z.boolean().parse(await rpc(
        config, user, request, "assert_account_deletable",
        { confirmation_email: input.confirmationEmail }, "account_deletion_check_failed"
      ));
      if (!allowed) throw new CloudHttpError(409, "account_deletion_blocked");
      await deleteSupabaseUser(config, user.id, request);
      res.status(204).end();
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.post("/organizations", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const input = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), name: z.string().trim().min(1).max(120) }).parse(req.body);
      const response = await request(`${config.supabaseUrl}/rest/v1/rpc/create_organization`, {
        method: "POST",
        headers: userHeaders(config, user.token),
        body: JSON.stringify({ organization_slug: input.slug, organization_name: input.name }),
      });
      if (!response.ok) throw new CloudHttpError(response.status === 409 ? 409 : 502, "organization_create_failed");
      res.status(201).json({ organization_id: await response.json() });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.get("/invitations", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const invitations = recordArraySchema.parse(await rpc(
        config, user, request, "list_my_organization_invitations", {}, "invitation_list_failed"
      ));
      res.json({ invitations });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.post("/invitations/:invitationId/accept", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const invitationId = z.string().uuid().parse(req.params.invitationId);
      const organizationId = z.string().uuid().parse(await rpc(
        config, user, request, "accept_organization_invitation",
        { target_invitation_id: invitationId }, "invitation_accept_failed"
      ));
      res.status(200).json({ organization_id: organizationId });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.get("/organizations/invitations", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId, membership } = await requireMembership(req, config, user, request);
      if (!["owner", "admin"].includes(membership.role)) throw new CloudHttpError(403, "forbidden");
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      const invitations = recordArraySchema.parse(await rpc(
        config, user, request, "list_organization_invitations",
        { target_organization_id: organizationId }, "invitation_list_failed"
      ));
      res.json({ invitations });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.get("/organizations/members", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId, membership } = await requireMembership(req, config, user, request);
      if (!["owner", "admin"].includes(membership.role)) throw new CloudHttpError(403, "forbidden");
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      const members = recordArraySchema.parse(await rpc(
        config, user, request, "list_organization_members",
        { target_organization_id: organizationId }, "member_list_failed"
      ));
      res.json({ members });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.patch("/organizations/members/:userId", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId, membership } = await requireMembership(req, config, user, request, true);
      if (membership.role !== "owner") throw new CloudHttpError(403, "forbidden");
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      const targetUserId = z.string().uuid().parse(req.params.userId);
      const input = z.object({ role: z.enum(["owner", "admin", "member", "viewer"]) }).parse(req.body);
      const changed = z.boolean().parse(await rpc(
        config, user, request, "change_organization_member_role",
        { target_organization_id: organizationId, target_user_id: targetUserId, target_role: input.role },
        "member_role_change_failed"
      ));
      res.json({ changed });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.delete("/organizations/members/:userId", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId, membership } = await requireMembership(req, config, user, request, true);
      if (!["owner", "admin"].includes(membership.role)) throw new CloudHttpError(403, "forbidden");
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      const targetUserId = z.string().uuid().parse(req.params.userId);
      const removed = z.boolean().parse(await rpc(
        config, user, request, "remove_organization_member",
        { target_organization_id: organizationId, target_user_id: targetUserId },
        "member_remove_failed"
      ));
      res.json({ removed });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.post("/organizations/invitations", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId, membership } = await requireMembership(req, config, user, request, true);
      if (!["owner", "admin"].includes(membership.role)) throw new CloudHttpError(403, "forbidden");
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      const input = z.object({
        email: z.string().trim().email().transform((value) => value.toLowerCase()),
        role: z.enum(["admin", "member", "viewer"]),
      }).parse(req.body);
      const invitationId = z.string().uuid().parse(await rpc(
        config, user, request, "create_organization_invitation",
        { target_organization_id: organizationId, invitee_email: input.email, invitee_role: input.role },
        "invitation_create_failed"
      ));
      const delivery = await sendSupabaseUserInvite(config, input.email, invitationId, request);
      res.status(delivery === "delivery_failed" ? 202 : 201).json({ id: invitationId, delivery });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.delete("/organizations/invitations/:invitationId", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId, membership } = await requireMembership(req, config, user, request);
      if (!["owner", "admin"].includes(membership.role)) throw new CloudHttpError(403, "forbidden");
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      const invitationId = z.string().uuid().parse(req.params.invitationId);
      const revoked = z.boolean().parse(await rpc(
        config, user, request, "revoke_organization_invitation",
        { target_organization_id: organizationId, target_invitation_id: invitationId },
        "invitation_revoke_failed"
      ));
      res.json({ revoked });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.post("/organizations/deletion", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId, membership } = await requireMembership(req, config, user, request);
      if (membership.role !== "owner") throw new CloudHttpError(403, "forbidden");
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      const input = z.object({ confirmationSlug: z.string().min(2).max(63) }).parse(req.body);
      const scheduledFor = z.string().parse(await rpc(
        config, user, request, "request_organization_deletion",
        { target_organization_id: organizationId, confirmation_slug: input.confirmationSlug },
        "organization_deletion_failed"
      ));
      res.status(202).json({ scheduled_for: scheduledFor });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.delete("/organizations/deletion", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId, membership } = await requireMembership(req, config, user, request);
      if (membership.role !== "owner") throw new CloudHttpError(403, "forbidden");
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      const canceled = z.boolean().parse(await rpc(
        config, user, request, "cancel_organization_deletion",
        { target_organization_id: organizationId }, "organization_deletion_cancel_failed"
      ));
      res.json({ canceled });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.get("/organizations/export", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId, membership } = await requireMembership(req, config, user, request);
      if (membership.role !== "owner") throw new CloudHttpError(403, "forbidden");
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      await streamOrganizationExport(
        res,
        config,
        user,
        organizationId,
        membership.organizations?.slug ?? organizationId,
        request
      );
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.post("/billing/checkout", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId, membership } = await requireMembership(req, config, user, request);
      if (!["owner", "admin"].includes(membership.role)) throw new CloudHttpError(403, "forbidden");
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      const input = z.object({ plan: z.enum(["starter", "pro", "team"]), interval: z.enum(["monthly", "annual"]) }).parse(req.body);
      const existingSubscription = await billingStore.getSubscription(organizationId);
      if (existingSubscription && existingSubscription.status !== "canceled") {
        throw new CloudHttpError(409, "subscription_already_exists");
      }
      const checkout = await createPaddleCheckout(
        {
          apiKey: config.paddle.apiKey,
          environment: config.paddle.environment,
          approvedCheckoutUrl: config.paddle.approvedCheckoutUrl,
          prices: config.paddle.prices,
          fetch: request,
        },
        { organizationId, userId: user.id, ...input }
      );
      res.status(201).json(checkout);
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.get("/billing/subscription", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId } = await requireMembership(req, config, user, request);
      const subscription = await billingStore.getSubscription(organizationId);
      const plan = subscription && subscriptionHasAccess(subscription.status) ? subscription.plan : "free";
      res.json({
        plan,
        status: subscription?.status ?? "none",
        currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        entitlements: PLAN_ENTITLEMENTS[plan],
      });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.post("/billing/portal", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId, membership } = await requireMembership(req, config, user, request);
      if (!["owner", "admin"].includes(membership.role)) throw new CloudHttpError(403, "forbidden");
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      const [customerId, subscription] = await Promise.all([
        billingStore.getCustomer(organizationId),
        billingStore.getSubscription(organizationId),
      ]);
      if (!customerId || !subscription) throw new CloudHttpError(404, "subscription_not_found");
      const portal = await createPaddlePortalSession(
        { apiKey: config.paddle.apiKey, environment: config.paddle.environment, fetch: request },
        { customerId, subscriptionId: subscription.providerSubscriptionId }
      );
      res.status(201).json(portal);
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.get("/knowledge/projects", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId } = await requireMembership(req, config, user, request);
      const params = tenantQuery(organizationId, {
        select: "id,slug,map,created_at,updated_at",
        order: "updated_at.desc",
      });
      const rows = await restJson(
        await request(`${config.supabaseUrl}/rest/v1/projects?${params}`, {
          headers: userHeaders(config, user.token),
        }),
        "project_list_failed"
      );
      res.json({ projects: z.array(projectSchema).parse(rows) });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.post("/knowledge/projects", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId } = await requireMembership(req, config, user, request, true);
      const input = z.object({
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
        map: z.record(z.string(), z.unknown()).default({}),
      }).parse(req.body);
      const id = z.string().uuid().parse(await rpc(config, user, request, "create_project", {
        target_organization_id: organizationId,
        project_slug: input.slug,
        project_map: input.map,
      }, "project_create_failed"));
      res.status(201).json({ id });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.get("/knowledge/projects/:projectId", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId } = await requireMembership(req, config, user, request);
      const projectId = z.string().uuid().parse(req.params.projectId);
      const projectParams = tenantQuery(organizationId, {
        id: `eq.${projectId}`,
        select: "id,slug,map,created_at,updated_at",
        limit: "1",
      });
      const scoped = (select: string, projectField = "project_id") => tenantQuery(organizationId, {
        [projectField]: `eq.${projectId}`,
        select,
        order: "updated_at.desc",
        limit: "100",
      });
      const [projectRows, memoriesRows, documentsRows, sessionsRows, relationRows] = await Promise.all([
        restJson(await request(`${config.supabaseUrl}/rest/v1/projects?${projectParams}`, { headers: userHeaders(config, user.token) }), "project_get_failed"),
        restJson(await request(`${config.supabaseUrl}/rest/v1/memories?${scoped("id,type,title,body,tags,importance,created_at,updated_at")}`, { headers: userHeaders(config, user.token) }), "memory_list_failed"),
        restJson(await request(`${config.supabaseUrl}/rest/v1/documents?${scoped("id,uri,title,source,kind,is_current,created_at,updated_at")}`, { headers: userHeaders(config, user.token) }), "document_list_failed"),
        restJson(await request(`${config.supabaseUrl}/rest/v1/session_logs?${scoped("id,summary,source,created_at,updated_at")}`, { headers: userHeaders(config, user.token) }), "session_list_failed"),
        restJson(await request(`${config.supabaseUrl}/rest/v1/memory_relations?${tenantQuery(organizationId, { select: "id,from_memory_id,to_memory_id,relation_type,confidence,created_at,updated_at", limit: "500" })}`, { headers: userHeaders(config, user.token) }), "relation_list_failed"),
      ]);
      const [project] = z.array(projectSchema).parse(projectRows);
      if (!project) throw new CloudHttpError(404, "project_not_found");
      const memories = recordArraySchema.parse(memoriesRows);
      const memoryIds = new Set(memories.map((memory) => String(memory.id)));
      const relations = recordArraySchema.parse(relationRows).filter(
        (relation) => memoryIds.has(String(relation.from_memory_id)) && memoryIds.has(String(relation.to_memory_id))
      );
      res.json({
        project,
        memories,
        documents: recordArraySchema.parse(documentsRows),
        sessions: recordArraySchema.parse(sessionsRows),
        relations,
      });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.post("/knowledge/memories", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId } = await requireMembership(req, config, user, request, true);
      const input = z.object({
        projectId: z.string().uuid(),
        type: z.enum(["fact", "preference", "decision", "howto", "context"]).default("fact"),
        title: z.string().trim().min(1).max(240),
        body: z.string().trim().min(1).max(50_000),
        tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
        importance: z.number().min(0.5).max(2).default(1),
      }).parse(req.body);
      const id = z.string().uuid().parse(await rpc(config, user, request, "add_memory", {
        target_organization_id: organizationId,
        target_project_id: input.projectId,
        memory_type: input.type,
        memory_title: input.title,
        memory_body: input.body,
        memory_tags: input.tags,
        memory_importance: input.importance,
      }, "memory_create_failed"));
      res.status(201).json({ id });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.post("/knowledge/documents", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId } = await requireMembership(req, config, user, request, true);
      const input = z.object({
        projectId: z.string().uuid(),
        uri: z.string().trim().min(1).max(1_000),
        title: z.string().trim().min(1).max(240),
        source: z.string().trim().max(240).nullable().default(null),
        kind: z.string().trim().min(1).max(64).default("reference"),
        content: z.string().min(1).max(2_000_000),
      }).parse(req.body);
      const result = z.array(z.object({ document_id: z.string().uuid(), chunk_id: z.string().uuid() })).parse(
        await rpc(config, user, request, "add_document", {
          target_organization_id: organizationId,
          target_project_id: input.projectId,
          document_uri: input.uri,
          document_title: input.title,
          document_source: input.source,
          document_kind: input.kind,
          document_content: input.content,
        }, "document_create_failed")
      );
      res.status(201).json(result[0]);
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  router.get("/knowledge/search", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const { organizationId } = await requireMembership(req, config, user, request);
      const input = z.object({
        q: z.string().trim().min(2).max(500),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }).parse(req.query);
      const results = recordArraySchema.parse(await rpc(config, user, request, "search_knowledge", {
        target_organization_id: organizationId,
        search_query: input.q,
        result_limit: input.limit,
      }, "knowledge_search_failed"));
      res.json({ results });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  return router;
}

export function buildCloudWebhookRouter(
  config: CloudRuntimeConfig,
  request: typeof globalThis.fetch = globalThis.fetch
) {
  const router = Router();
  const store = createSupabasePaddleStore(config, request);
  router.post("/", async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) throw new CloudHttpError(400, "raw_body_required");
      const result = await processPaddleWebhook(req.body, req.header("paddle-signature"), {
        secret: config.paddle.webhookSecret,
        prices: config.paddle.prices,
        store,
      });
      if (!result.accepted) throw new CloudHttpError(401, "invalid_signature");
      res.status(200).json({ ok: true, duplicate: result.duplicate ?? false });
    } catch (error) {
      sendCloudError(res, error);
    }
  });
  return router;
}
