import { randomBytes } from "node:crypto";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (process.env.CLOUD_STAGING_CONFIRM !== "mnema-staging") {
  throw new Error("Set CLOUD_STAGING_CONFIRM=mnema-staging to create and clean up isolated staging users");
}

const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || required("SUPABASE_ANON_KEY");
const secretKey = process.env.SUPABASE_SECRET_KEY?.trim() || required("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)(?::|\/)/.test(supabaseUrl)) {
  throw new Error("SUPABASE_URL must use HTTPS outside localhost");
}

const suffix = randomBytes(6).toString("hex");
const password = `${randomBytes(24).toString("base64url")}Aa1!`;
const emails = [`mnema-a-${suffix}@example.invalid`, `mnema-b-${suffix}@example.invalid`];
const userIds: string[] = [];
const organizationIds: string[] = [];

const secretHeaders = (): Record<string, string> => ({
  apikey: secretKey,
  ...(secretKey.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${secretKey}` }),
  "Content-Type": "application/json",
});
const userHeaders = (token: string, profile?: "app"): Record<string, string> => ({
  apikey: publicKey,
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  ...(profile ? { "Accept-Profile": profile, "Content-Profile": profile } : {}),
});

async function checked(response: Response, operation: string): Promise<Response> {
  if (response.ok) return response;
  const body = await response.text();
  throw new Error(`${operation} failed (${response.status}): ${body.slice(0, 160)}`);
}

async function createUser(email: string): Promise<string> {
  const response = await checked(await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: secretHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true }),
  }), "create staging user");
  const payload = await response.json() as { id?: string; user?: { id?: string } };
  const id = payload.id ?? payload.user?.id;
  if (!id) throw new Error("create staging user returned no id");
  userIds.push(id);
  return id;
}

async function signIn(email: string): Promise<string> {
  const response = await checked(await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publicKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }), "sign in staging user");
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error("staging sign-in returned no access token");
  return payload.access_token;
}

async function rpc<T>(name: string, token: string, body: Record<string, unknown>): Promise<T> {
  const response = await checked(await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: userHeaders(token, "app"),
    body: JSON.stringify(body),
  }), `RPC ${name}`);
  return await response.json() as T;
}

try {
  await Promise.all(emails.map(createUser));
  const [tokenA, tokenB] = await Promise.all(emails.map(signIn));
  const organizationA = await rpc<string>("create_organization", tokenA, {
    organization_slug: `mnema-a-${suffix}`,
    organization_name: "Mnema staging tenant A",
  });
  const organizationB = await rpc<string>("create_organization", tokenB, {
    organization_slug: `mnema-b-${suffix}`,
    organization_name: "Mnema staging tenant B",
  });
  organizationIds.push(organizationA, organizationB);

  const projectA = await rpc<string>("create_project", tokenA, {
    target_organization_id: organizationA,
    project_slug: "isolation-proof",
    project_map: { summary: "staging RLS proof" },
  });
  if (!projectA) throw new Error("tenant A project creation returned no id");

  const crossRead = await checked(await fetch(
    `${supabaseUrl}/rest/v1/projects?organization_id=eq.${organizationA}&select=id`,
    { headers: userHeaders(tokenB) }
  ), "cross-tenant read probe");
  const crossRows = await crossRead.json() as unknown[];
  if (crossRows.length !== 0) throw new Error("RLS exposed tenant A projects to tenant B");

  const crossWrite = await fetch(`${supabaseUrl}/rest/v1/rpc/create_project`, {
    method: "POST",
    headers: userHeaders(tokenB, "app"),
    body: JSON.stringify({
      target_organization_id: organizationA,
      project_slug: "forbidden-cross-write",
      project_map: {},
    }),
  });
  if (crossWrite.ok) throw new Error("tenant B created a project inside tenant A");

  const ownRead = await checked(await fetch(
    `${supabaseUrl}/rest/v1/projects?organization_id=eq.${organizationA}&select=id`,
    { headers: userHeaders(tokenA) }
  ), "same-tenant read probe");
  const ownRows = await ownRead.json() as Array<{ id?: string }>;
  if (!ownRows.some((row) => row.id === projectA)) throw new Error("tenant A could not read its own project");

  console.log("OK   real Supabase users proved same-tenant access and cross-tenant read/write denial");
} finally {
  for (const organizationId of organizationIds) {
    await fetch(`${supabaseUrl}/rest/v1/organizations?id=eq.${organizationId}`, {
      method: "DELETE",
      headers: { ...secretHeaders(), Prefer: "return=minimal" },
    }).catch(() => undefined);
  }
  for (const userId of userIds) {
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: secretHeaders(),
    }).catch(() => undefined);
  }
}
