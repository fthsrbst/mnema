# ADR-004: Cloud multitenancy and billing boundary

- Status: Accepted
- Date: 2026-07-16

## Context

Mnema began as a local-first, single-owner service whose SQLite database is the
authoritative copy. A hosted product adds accounts, organizations, collaboration,
subscriptions, and a public endpoint. Treating the existing `project` field as a
tenant boundary would be unsafe: global records exist by design, project names are
mutable, and the current bearer-token policy is intended for trusted self-hosted
deployments rather than public account lifecycle management.

Turkey is not a supported country for opening a direct Stripe payments account.
The first hosted release therefore needs a Merchant of Record (MoR) that can sell
software globally and handle indirect tax, refunds, and chargebacks.

## Decision

Mnema has two deployment profiles with one product model:

1. **Community / self-hosted** keeps SQLite, MCP + REST, local auth tokens, and
   Mnema's own device-to-device sync. Git never transports runtime databases.
2. **Mnema Cloud** uses Supabase Auth and Postgres. An organization is the tenant.
   Every tenant-owned row carries `organization_id`; Postgres RLS is enabled and
   forced on every tenant table. API checks are defense in depth, not the primary
   isolation mechanism.

Paddle is the initial billing adapter, but billing state uses provider-neutral
identifiers and normalized subscription events. Lemon Squeezy remains a compatible
fallback. Provider webhooks are verified over the untouched raw request body,
atomically claimed by provider event id, and applied only when newer than stored
state. A failed claim may be retried; a completed/concurrent duplicate or a
different payload for the same event id cannot be applied. Subscription state is
also reduced inside a tenant-locking database RPC, closing the race between two
different out-of-order event ids.

Organization membership is invitation-only for authenticated clients. An invite
is bound to a verified email address, reserves the plan's member quota, and is
accepted atomically. Existing users discover it in-app; new-user email delivery
is delegated to Supabase Auth.

Membership listing, role changes, ownership transfer, and removal use
AAL2-protected RPCs. Authenticated clients have no direct organization or
membership mutation grants, so they cannot bypass MFA through PostgREST.

Owners receive an RLS-scoped NDJSON portability export. Organization deletion is
delayed, cannot precede the end of an active paid term, blocks new writes once
scheduled, and is purged only after billing is canceled. Account deletion is
server-only and refused while the user owns an organization. The final purge is
one database transaction that locks and rechecks the deletion and billing state.

## Security invariants

- The organization id comes from the authenticated session / selected membership,
  never from an untrusted body without equality verification.
- Every repository method requires an explicit organization id.
- Owners and admins may manage billing; destructive organization and billing
  mutations require MFA (`aal2`).
- Billing tables have no grants or RLS policies for the authenticated client role.
- Cross-tenant foreign keys are composite `(organization_id, id)` constraints.
- Service-role credentials never reach the browser, MCP clients, logs, or audit
  metadata.
- Webhook handlers verify signatures before JSON parsing and persist event ids
  before side effects.
- Public Cloud routes send restrictive browser headers and use a process-local
  IP/token limiter; production scale-out additionally requires a shared edge
  limiter.
- The browser receives only Supabase's public key. Server-only Supabase and
  Paddle credentials are never used as application bearer tokens.
- Opaque Supabase secret keys are sent only as API keys; the legacy
  `Authorization: Bearer` form is retained only for legacy service-role JWTs.
- Billable project and document allocations use transaction-scoped Postgres RPCs;
  authenticated clients do not have direct insert grants that could bypass quotas.
- Tenant isolation is release-blocking and tested against Postgres-compatible RLS,
  not only mocked application code.

## Consequences

- The local SQLite core remains simple and usable offline.
- Cloud storage is exposed through a narrow Postgres/RLS knowledge gateway for
  project maps, memories, documents, sessions, relations, and full-text search.
  SQLite files are not copied into a shared cloud database.
- A user may belong to more than one organization, while each request has exactly
  one active organization.
- The public repository can contain cloud schema, adapters, and tests without
  containing customer data or deployment secrets.
