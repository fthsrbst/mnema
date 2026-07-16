# Mnema Cloud deployment runbook

This runbook describes the implemented cloud control plane. It does not turn a
green local test into production proof; staging checkout, auth email, RLS, and
restore exercises remain required before launch.

## 1. Supabase project

1. Create a Supabase project in the selected data region.
2. Enable email confirmation and configure the production Site URL / redirect
   allowlist. Set an appropriate password policy and leaked-password protection.
3. Apply `cloud/migrations/0001_tenancy.sql`, then add the migration's `app`
   schema to the project's exposed API schemas. Mnema selects that schema with
   PostgREST `Accept-Profile` / `Content-Profile` headers for every guarded RPC;
   leave tenant tables in `public` behind forced RLS.
4. Confirm TOTP enrollment/challenge is enabled.
5. Prefer `SUPABASE_PUBLISHABLE_KEY=sb_publishable_...` for public requests and
   `SUPABASE_SECRET_KEY=sb_secret_...` for server work. Legacy anon/service-role
   JWTs remain supported during migration. Opaque secret keys are sent only in
   the `apikey` header; putting one in `Authorization: Bearer` causes Supabase
   to reject it as an invalid JWT.
6. Configure the Auth email provider and verify both new-account invitation
   delivery and in-app discovery for existing accounts.

The migration creates accounts' profile boundary, organizations and membership,
tenant-owned knowledge and invitation tables, service-only billing tables,
forced RLS policies, composite tenant foreign keys, atomic quota RPCs, and
delayed deletion controls.

## 2. Paddle catalog and webhook

1. Start in Paddle Sandbox.
2. Create monthly and annual prices for Starter, Pro, and Team.
3. Approve the checkout return domain.
4. Configure a webhook destination at
   `https://YOUR_HOST/cloud/api/billing/webhook` for all subscription lifecycle
   events used by the catalog, including created, updated, and canceled.
5. Store the API key and destination secret only in the server secret manager.

The server endpoint is mounted before JSON parsing, verifies `Paddle-Signature`
over raw bytes, atomically claims provider event ids, permits retry after failed
processing, and rejects both payload changes and older subscription state. The
subscription snapshot is applied by a database RPC that locks the tenant and
rechecks event time, so concurrent out-of-order handlers cannot overwrite newer
billing state.
Checkout accepts only `{plan, interval}`; price ids come from the server catalog
and organization/user ids are written as Paddle custom data. Billing management
uses a short-lived, server-created Paddle customer portal URL.

## 3. Runtime configuration

Copy `.env.cloud.example` into the deployment secret manager, not into Git.

- `VITE_*` values are public browser configuration.
- Prefer `VITE_SUPABASE_PUBLISHABLE_KEY`; the legacy
  `VITE_SUPABASE_ANON_KEY` fallback is temporary.
- `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`),
  `PADDLE_API_KEY`, and `PADDLE_WEBHOOK_SECRET` are server-only.
- `PADDLE_ENVIRONMENT=sandbox` must be used until end-to-end staging approval.
- Set `CLOUD_HTTPS_ONLY=true` in production. Set `CLOUD_TRUST_PROXY_HOPS` only
  to the exact number of trusted proxies; a wrong value makes IP enforcement
  unreliable.
- `CLOUD_RATE_LIMIT_PER_MINUTE` and
  `CLOUD_WEBHOOK_RATE_LIMIT_PER_MINUTE` set policy. Sandbox may use the
  process-local store; Paddle production fails startup unless
  `CLOUD_RATE_LIMIT_REDIS_URL` points to shared Redis/Valkey. Counter keys hash
  IP/token identity and contain no bearer token or raw IP. Store failure is
  fail-closed with `503 rate_limit_unavailable`.
- Hosted Cloud defaults `CLOUD_ENABLE_COMMUNITY_API=false`. This prevents the
  local Community REST/MCP authority from being exposed beside tenant APIs.
  If an operator explicitly enables it, scoped Community authentication is
  mandatory.

With no cloud variables, Mnema starts in Community/self-hosted mode and the
Cloud page reports that it is disabled. A partial cloud configuration fails at
startup rather than silently weakening authentication.

The Node process checks due organization deletions at startup and hourly. A
transactional service-only RPC locks the tenant, rechecks both due time and
billing state, then purges only if the subscription is absent or canceled. Run
exactly the same worker logic from a singleton scheduled job if the web
deployment can scale to zero or has multiple replicas.

### Single-server production container profile

`deploy/cloud/compose.yaml` is the reference profile for the planned rented
server: a non-root/read-only Node container, private Valkey rate-limit store,
and Caddy automatic HTTPS edge. Valkey is intentionally non-persistent because
rate counters are disposable; Supabase remains tenant data authority.

```bash
cd deploy/cloud
cp .env.cloud.example .env.cloud
chmod 600 .env.cloud
# Fill real domain/public build values and server-only staging secrets.
docker compose --env-file .env.cloud config --quiet
docker compose --env-file .env.cloud build --pull
docker compose --env-file .env.cloud up -d
docker compose --env-file .env.cloud ps
curl -fsS https://YOUR_DOMAIN/health
```

Keep only ports 22, 80, and 443 open on the host. Do not publish Valkey or the
Node port. Back up Caddy's volumes for ACME continuity, but treat Supabase PITR
and provider exports—not container volumes—as Cloud customer-data recovery.

## 4. Data lifecycle

- Organization export is owner-only, requires AAL2, streams NDJSON through the
  requesting user's RLS-scoped token, and is a portability export—not a database
  backup or point-in-time snapshot.
- Organization deletion requires the slug as confirmation, waits at least seven
  days (and through a paid period), and blocks subsequent writes once scheduled.
- Account deletion requires AAL2 and email confirmation and is refused while the
  account still owns an organization. Owners can transfer ownership through the
  AAL2-protected member-role RPC; the final Auth Admin deletion is server-only.
- Keep Supabase PITR/backups and perform an independent restoration drill; the
  export endpoint does not replace them.

## 5. Verification

```bash
npm run build
npm run smoke:cloud
npm --prefix web run build
```

Before production, repeat tenant isolation with two real Supabase users and two
organizations, verify invitation email and acceptance, run Paddle's webhook
simulator for duplicate/retry/out-of-order/canceled cases, complete a sandbox
checkout and customer-portal round trip, revoke a user session, exercise export
and delayed deletion, test shared-edge throttling, scan response headers, and
restore a backup into a separate staging project.

The destructive staging helpers require an explicit acknowledgement and clean
up their generated principals/tenants. They never print passwords or tokens:

```bash
export CLOUD_STAGING_CONFIRM=mnema-staging
npm run staging:supabase  # two real users, same-tenant success, cross-tenant denial
npm run staging:paddle    # validates six sandbox prices and creates one draft checkout
```

Email delivery, a human TOTP ceremony, paid checkout completion, provider
webhook retry/cancel/refund, and a Supabase backup restore remain manual launch
gates because a mocked or admin-confirmed account cannot prove those external
systems.
