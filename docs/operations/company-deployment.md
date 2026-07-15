# Company Deployment Profile

Status: operational baseline
Last updated: 2026-07-14

Mnema has three deployment profiles:

- `personal`: local-first compatibility. Legacy bearer and query-token transport may be used during migration.
- `team`: shared internal service. Scoped tokens, strict project ownership, generation-aware sync, and header-only credentials are mandatory.
- `enterprise`: the same fail-closed application controls as `team`; the operator must additionally provide managed TLS, secret rotation, centralized backups, monitoring, and an external audit export.

The process refuses to start in `team` or `enterprise` when scoped policies are missing, query tokens are enabled, unknown project writes are allowed, or legacy-generation vectors are accepted.

## Minimum team configuration

```dotenv
HUB_DEPLOYMENT_PROFILE=team
HUB_HOST=127.0.0.1
HUB_DB_PATH=/var/lib/mnema/hub.db
HUB_TOKEN=
HUB_ALLOW_LEGACY_ADMIN=false
HUB_ALLOW_QUERY_TOKEN=false
HUB_STRICT_PROJECTS=true
HUB_ACCEPT_LEGACY_VECTORS=false
HUB_VECTOR_BACKEND=sqlite-vec
HUB_RATE_LIMIT_PER_MINUTE=600
HUB_AUTH_TOKENS=[{"id":"agent-reader","token":"use-a-secret-manager-generated-value","scopes":["context:read","knowledge:read","project:read","session:read"],"projects":["project-a"]}]
```

For a measured scale-out deployment, replace the backend line and add:

```dotenv
HUB_VECTOR_BACKEND=qdrant
HUB_QDRANT_URL=https://qdrant.internal.example
HUB_QDRANT_API_KEY=<secret-manager-reference>
HUB_QDRANT_COLLECTION_PREFIX=mnema
```

Non-local plain HTTP or unauthenticated Qdrant endpoints are rejected in team/enterprise profiles. After first start, run `vector_projection_rebuild`, drain the durable outbox, and require `vector_projection_verify.ok=true` before parity/load testing. This proves generation readiness, zero backlog, and exact local/remote counts. Do not delete the local sqlite-vec index: it is the safe degraded-mode fallback and the source for projection recovery.

Keep `HUB_AUTH_TOKENS` in a secret manager or protected service environment, not in Git. Give each agent or integration a unique token ID. Rotate one policy at a time by temporarily accepting old and new tokens, update clients, then remove the old policy and restart.

Bind Mnema to loopback behind a TLS reverse proxy or a private service mesh. Do not expose plain HTTP or use query-string credentials in a company profile. `/health` is intentionally public and contains no paths, secrets, provider errors, or knowledge data.

## Safe upgrade sequence

1. Stop writers or enter a short maintenance window.
2. Take a SQLite online backup and verify it can be opened.
3. Run `npm run migration:audit -- <backup-path>` against a copy.
4. Deploy the new binary in `personal` profile first if old clients still use `HUB_TOKEN` or query tokens.
5. Run `integrity_check`, `audit_verify`, the context evaluation suite, and a forced reindex only when embedding generation reports it is required.
6. Create scoped policies and update every client to `Authorization: Bearer`.
7. Remove `HUB_TOKEN`, switch to `team`, and restart. Fail-closed startup is the acceptance check.
8. Verify cross-project denials, current-status freshness, relation sync, and backup restore on the live profile.

Never deploy a new embedding model to only one sync peer. Upgrade every peer, complete reindex, and then disable `HUB_ACCEPT_LEGACY_VECTORS`.

## SLO baseline

Measure with representative project filters and concurrent agents:

- context availability: 99.9% monthly for the internal endpoint;
- p95 `context_get`: under 300 ms without remote embedding and under the embedding provider SLO otherwise;
- stale current-status evidence: zero in the held-out suite;
- cross-project leakage: zero;
- backup RPO: 24 hours or better; restore RTO: four hours or better;
- audit-chain verification: daily;
- retrieval release gate: at least 50 human-reviewed held-out queries before ranking changes.

Embedding-provider loss is a degraded state, not an outage: FTS remains available and health/stats must report the degradation.

## Backup and restore

Back up the SQLite database with SQLite's online backup API or a service stop; never copy only the main file while a WAL writer is active. Keep encrypted, versioned, access-controlled backups outside the host. A backup is not accepted until a scheduled restore drill has opened it, run migrations, passed `integrity_check`, and executed representative `context_get` cases.

The local audit log is tamper-evident, not immutable. Export it to append-only centralized storage for enterprise compliance. Request bodies, prompts, tokens, document text, and memory bodies are intentionally absent from audit events.

## Multi-instance boundary

The included rate limiter and audit chain are process/node local. Do not run multiple writers against the same SQLite file over a network filesystem. Before horizontal serving, move rate limiting to the gateway, export audit events centrally, and replace local-first LWW with a server-authoritative revision protocol. The Qdrant search projection can scale retrieval reads, but it does not make multiple Mnema writers safe by itself.
