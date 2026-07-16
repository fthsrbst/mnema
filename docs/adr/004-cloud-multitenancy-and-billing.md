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
deduplicated by provider event id, and applied only when newer than stored state.

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
- Tenant isolation is release-blocking and tested against Postgres-compatible RLS,
  not only mocked application code.

## Consequences

- The local SQLite core remains simple and usable offline.
- Cloud storage needs a Postgres adapter behind the existing core boundaries;
  SQLite files are not copied into a shared cloud database.
- A user may belong to more than one organization, while each request has exactly
  one active organization.
- The public repository can contain cloud schema, adapters, and tests without
  containing customer data or deployment secrets.
