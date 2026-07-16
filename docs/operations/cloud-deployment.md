# Mnema Cloud deployment runbook

This runbook describes the implemented cloud control plane. It does not turn a
green local test into production proof; staging checkout, auth email, RLS, and
restore exercises remain required before launch.

## 1. Supabase project

1. Create a Supabase project in the selected data region.
2. Enable email confirmation and configure the production Site URL / redirect
   allowlist. Set an appropriate password policy and leaked-password protection.
3. Apply `cloud/migrations/0001_tenancy.sql`.
4. Confirm TOTP enrollment/challenge is enabled.
5. Never copy the service-role key into Vite/browser variables.

The migration creates accounts' profile boundary, organizations and membership,
tenant-owned knowledge tables, service-only billing tables, forced RLS policies,
composite tenant foreign keys, and the atomic `app.create_organization` RPC.

## 2. Paddle catalog and webhook

1. Start in Paddle Sandbox.
2. Create monthly and annual prices for Starter, Pro, and Team.
3. Approve the checkout return domain.
4. Configure a webhook destination at
   `https://YOUR_HOST/cloud/api/billing/webhook` for
   `subscription.created` and `subscription.updated`.
5. Store the API key and destination secret only in the server secret manager.

The server endpoint is mounted before JSON parsing, verifies `Paddle-Signature`
over raw bytes, deduplicates provider event ids, and rejects older subscription
state. Checkout accepts only `{plan, interval}`; price ids come from the server
catalog and organization/user ids are written as Paddle custom data.

## 3. Runtime configuration

Copy `.env.cloud.example` into the deployment secret manager, not into Git.

- `VITE_*` values are public browser configuration.
- `SUPABASE_SERVICE_ROLE_KEY`, `PADDLE_API_KEY`, and
  `PADDLE_WEBHOOK_SECRET` are server-only.
- `PADDLE_ENVIRONMENT=sandbox` must be used until end-to-end staging approval.

With no cloud variables, Mnema starts in Community/self-hosted mode and the
Cloud page reports that it is disabled. A partial cloud configuration fails at
startup rather than silently weakening authentication.

## 4. Verification

```bash
npm run build
npm run smoke:cloud
npm --prefix web run build
```

Before production, repeat tenant isolation with two real Supabase users and two
organizations, run Paddle's webhook simulator for duplicate/out-of-order cases,
complete a sandbox checkout, revoke a user session, and restore a backup into a
separate staging project.
