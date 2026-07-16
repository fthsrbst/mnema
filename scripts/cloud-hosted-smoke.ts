import { spawn } from "node:child_process";
import { createServer } from "node:net";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a smoke-test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const port = await freePort();
const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HUB_HOST: "127.0.0.1",
    HUB_PORT: String(port),
    HUB_DEPLOYMENT_PROFILE: "personal",
    CLOUD_APP_URL: `https://app.mnema.test:${port}`,
    CLOUD_HTTPS_ONLY: "true",
    CLOUD_ENABLE_COMMUNITY_API: "false",
    CLOUD_RATE_LIMIT_PER_MINUTE: "100",
    CLOUD_WEBHOOK_RATE_LIMIT_PER_MINUTE: "100",
    SUPABASE_URL: "https://supabase.mnema.test",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_smoke",
    SUPABASE_SECRET_KEY: "sb_secret_smoke",
    PADDLE_API_KEY: "pdl_sdbx_smoke",
    PADDLE_WEBHOOK_SECRET: "pdl_ntfset_smoke",
    PADDLE_ENVIRONMENT: "sandbox",
    PADDLE_APPROVED_CHECKOUT_URL: `https://app.mnema.test:${port}/billing/complete`,
    PADDLE_PRICE_STARTER_MONTHLY: "pri_starter_month",
    PADDLE_PRICE_STARTER_ANNUAL: "pri_starter_year",
    PADDLE_PRICE_PRO_MONTHLY: "pri_pro_month",
    PADDLE_PRICE_PRO_ANNUAL: "pri_pro_year",
    PADDLE_PRICE_TEAM_MONTHLY: "pri_team_month",
    PADDLE_PRICE_TEAM_ANNUAL: "pri_team_year",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
child.stderr.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });

const base = `http://127.0.0.1:${port}`;
try {
  let health: Response | null = null;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`hosted server exited early (${child.exitCode})\n${output}`);
    try {
      health = await fetch(`${base}/health`);
      if (health.ok) break;
    } catch {
      // Startup race; bounded retry below.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!health?.ok) throw new Error(`hosted server did not become healthy\n${output}`);
  const healthJson = await health.json() as Record<string, unknown>;
  if (healthJson.community !== "disabled" || healthJson.vector_projection !== null || healthJson.cloud !== "configured") {
    throw new Error(`unexpected hosted health payload: ${JSON.stringify(healthJson)}`);
  }

  const community = await fetch(`${base}/api/projects`, { headers: { Accept: "application/json" } });
  const communityJson = await community.json() as { error?: string };
  if (community.status !== 404 || communityJson.error !== "community_api_disabled") {
    throw new Error("hosted mode exposed the Community API");
  }

  const mcp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  if (mcp.status !== 404) throw new Error("hosted mode exposed MCP");

  const returnRoute = await fetch(`${base}/billing/complete`, { headers: { Accept: "text/html" } });
  if (!returnRoute.ok || !returnRoute.headers.get("content-type")?.includes("text/html")) {
    throw new Error("hosted SPA fallback did not serve the Paddle return route");
  }

  const cloudSession = await fetch(`${base}/cloud/api/session`, { headers: { Accept: "application/json" } });
  if (cloudSession.status !== 401) throw new Error(`Cloud API auth did not fail closed (${cloudSession.status})`);

  console.log("OK   hosted Cloud disables Community REST/MCP and serves auth/billing SPA routes");
} finally {
  child.kill();
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(() => resolve(), 2_000);
  });
}
