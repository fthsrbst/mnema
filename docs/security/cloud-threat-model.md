# Mnema Cloud security baseline

## Protected assets

- Memory bodies, RAG documents and embeddings
- Project architecture and decision history
- User identity, organization membership and invitations
- Billing customer/subscription state
- API keys, webhook secrets and service-role credentials

## Principal threats and controls

| Threat | Required controls | Verification |
|---|---|---|
| Cross-tenant read/write | `organization_id` on every domain row, forced RLS, composite tenant foreign keys, explicit `app` PostgREST profile for guarded RPCs | `npm run smoke:tenant` plus real-provider staging |
| Tenant id substitution | Session-selected organization must equal repository organization argument | `npm run smoke:saas-security` |
| Privilege escalation | Owner/admin/member/viewer matrix; owner-only role transfer, no direct membership mutations, last-owner and self-promotion guards | RLS, membership RPC, invitation, and domain tests |
| Invitation theft/abuse | Verified-email binding, AAL2 to issue/revoke, pending invites reserve plan quota, atomic acceptance | Postgres invitation and quota tests |
| Stolen password/session | Verified email, short-lived Supabase access tokens, strict CSP/HSTS, revocation, and AAL2 for billing/destruction | Auth-provider integration tests before launch |
| Browser token theft/XSS | The current SPA persists the Supabase session in browser storage; forbid inline/script injection with CSP, keep dependencies patched, and never expose service credentials | Header smoke test, dependency audit, and deployed CSP scan |
| Webhook spoof/replay/race | HMAC over raw body, timestamp tolerance, atomic provider-event claim, retryable failed claims, payload-hash match, database-atomic monotonic subscription apply | Billing signature, concurrency, retry, and reducer tests |
| Service credential leak | Server-only environment secret, redacted logs, no client grants to billing tables | Deployment secret scan and SQL grant test |
| Query bypass | No general-purpose service-role endpoint; explicit tenant repository methods | Code review and endpoint authorization matrix |
| Quota bypass/race | Revoke direct inserts for billable records; serialize check-and-create RPCs on the organization row | Postgres quota and direct-insert tests |
| Expensive abuse | Hashed IP/token identity, atomic shared Redis/Valkey counters required in production, process-local sandbox fallback, and organization usage limits before embeddings/LLM calls | Local/fail-closed middleware smoke, real Valkey CI service, and deployed load tests |
| Community authority exposed by hosted app | Cloud-only is the default hosted surface; Community REST/MCP return 404 unless explicitly enabled with scoped authentication | Hosted-process smoke checks REST, MCP, health, and SPA fallback |
| Accidental/destructive deletion | No direct organization lifecycle grants; owner confirmation + AAL2, paid-period guard, seven-day delay, RLS write freeze, transactional purge only after billing is canceled | Postgres lifecycle and worker tests |
| Data loss | RLS-scoped NDJSON portability export, point-in-time recovery, encrypted backups, and restore drills | Export smoke plus quarterly restore exercise |
| Supply-chain compromise | Locked dependencies, automated audit, signed releases, secret scanning | CI gates |

## Launch gates

The hosted service is not production-ready until all of these are proven in a
deployed staging environment:

1. Supabase Auth email/invitation delivery, token expiry, logout, and session revocation.
2. RLS isolation test using two real authenticated users and two organizations.
3. Paddle sandbox checkout, signed webhook, retry, duplicate and out-of-order cases.
4. Organization/account deletion, export, lifecycle purge, and backup restoration.
5. Shared Redis/Valkey throttling is configured and its fail-closed behavior is
   observed under load; edge/WAF limits and organization usage metering remain
   additional controls.
6. Dependency, secret and HTTP security-header scans.
