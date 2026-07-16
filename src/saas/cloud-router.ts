import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { CloudRuntimeConfig } from "./cloud-config.js";
import { createSupabasePaddleStore } from "./cloud-store.js";
import { createPaddleCheckout, processPaddleWebhook } from "./paddle.js";

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

const userSchema = z.object({ id: z.string().uuid(), email: z.string().email().nullable().optional() });
const membershipSchema = z.object({
  organization_id: z.string().uuid(),
  role: z.enum(["owner", "admin", "member", "viewer"]),
  organizations: z
    .object({ id: z.string().uuid(), name: z.string(), slug: z.string() })
    .nullable()
    .optional(),
});

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
    headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new CloudHttpError(401, "unauthorized");
  const user = userSchema.parse(await response.json());
  const claims = jwtPayload(token);
  if (claims.sub !== user.id) throw new CloudHttpError(401, "invalid_session");
  return { id: user.id, email: user.email ?? null, aal: claims.aal === "aal2" ? "aal2" : "aal1", token };
}

function userHeaders(config: CloudRuntimeConfig, token: string, prefer?: string): Record<string, string> {
  return {
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function memberships(
  config: CloudRuntimeConfig,
  user: VerifiedCloudUser,
  request: typeof globalThis.fetch,
  organizationId?: string
) {
  const params = new URLSearchParams({
    user_id: `eq.${user.id}`,
    select: "organization_id,role,organizations(id,name,slug)",
    ...(organizationId ? { organization_id: `eq.${organizationId}` } : {}),
  });
  const response = await request(`${config.supabaseUrl}/rest/v1/organization_members?${params}`, {
    headers: userHeaders(config, user.token),
  });
  if (!response.ok) throw new CloudHttpError(502, "membership_lookup_failed");
  return z.array(membershipSchema).parse(await response.json());
}

function sendCloudError(res: Response, error: unknown) {
  if (error instanceof CloudHttpError) return res.status(error.status).json({ error: error.code });
  if (error instanceof z.ZodError) return res.status(400).json({ error: "invalid_request" });
  return res.status(500).json({ error: "cloud_operation_failed" });
}

export function buildCloudAccountRouter(
  config: CloudRuntimeConfig,
  request: typeof globalThis.fetch = globalThis.fetch
) {
  const router = Router();
  router.get("/session", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const organizations = await memberships(config, user, request);
      res.json({ user: { id: user.id, email: user.email, aal: user.aal }, organizations });
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
  router.post("/billing/checkout", async (req, res) => {
    try {
      const user = await verifyCloudUser(req, config, request);
      const organizationId = z.string().uuid().parse(req.header("x-mnema-organization-id"));
      const [membership] = await memberships(config, user, request, organizationId);
      if (!membership || !["owner", "admin"].includes(membership.role)) throw new CloudHttpError(403, "forbidden");
      if (user.aal !== "aal2") throw new CloudHttpError(403, "mfa_required");
      const input = z.object({ plan: z.enum(["starter", "pro", "team"]), interval: z.enum(["monthly", "annual"]) }).parse(req.body);
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
