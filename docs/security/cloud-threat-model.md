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
| Cross-tenant read/write | `organization_id` on every domain row, forced RLS, composite tenant foreign keys | `npm run smoke:tenant` |
| Tenant id substitution | Session-selected organization must equal repository organization argument | `npm run smoke:saas-security` |
| Privilege escalation | Owner/admin/member/viewer matrix; membership changes restricted to owner/admin | RLS policy and domain tests |
| Stolen password/session | Email verification, secure HTTP-only cookies, short-lived sessions, revocation; MFA for billing/destruction | Auth-provider integration tests before launch |
| Webhook spoof/replay | HMAC over raw body, timestamp tolerance, durable provider event id, monotonic event time | Billing signature and reducer tests |
| Service credential leak | Server-only environment secret, redacted logs, no client grants to billing tables | Deployment secret scan and SQL grant test |
| Query bypass | No general-purpose service-role endpoint; explicit tenant repository methods | Code review and endpoint authorization matrix |
| Quota bypass/race | Revoke direct inserts for billable records; serialize check-and-create RPCs on the organization row | Postgres quota and direct-insert tests |
| Expensive abuse | Per-user and per-organization rate/usage limits before embeddings and LLM calls | Load/abuse tests before launch |
| Data loss | Point-in-time recovery, encrypted backups, restore drills, export/delete workflow | Quarterly restore exercise |
| Supply-chain compromise | Locked dependencies, automated audit, signed releases, secret scanning | CI gates |

## Launch gates

The hosted service is not production-ready until all of these are proven in a
deployed staging environment:

1. Supabase Auth email verification and session revocation.
2. RLS isolation test using two real authenticated users and two organizations.
3. Paddle sandbox checkout, signed webhook, retry, duplicate and out-of-order cases.
4. Organization deletion/export and backup restoration.
5. Rate limits at the public edge and at the usage-metering boundary.
6. Dependency, secret and HTTP security-header scans.
