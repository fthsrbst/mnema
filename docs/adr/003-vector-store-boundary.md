# ADR 003: Keep the vector index replaceable

Status: accepted
Date: 2026-07-14

## Decision

All online vector search and mutation paths depend on the `VectorStore` port. sqlite-vec is the default. Qdrant is supported as an outbox-driven search projection with sqlite-vec fallback. SQLite remains the knowledge system of record.

## Rationale

Direct sqlite-vec SQL had spread into retrieval, memory, document, project-migration, and sync code. A synchronous external write inside those transactions would couple knowledge durability to a second service. The durable-outbox design preserves atomic local writes and makes remote delivery retryable and observable.

## Consequences

- Unsupported backend values fail at startup; Qdrant requires an explicit URL and company profiles require TLS for non-local endpoints.
- SQLite-specific migrations, integrity repair, and reindex code remain in the maintenance layer for now.
- Qdrant uses generation-specific collections, native project/type/tag/lifecycle filters, idempotent writes, full backfill, retry state, and sqlite fallback.
- Outbox rows carry monotonic revisions: an in-flight worker cannot delete or mark a newer mutation, and pending IDs use local scores/absence so stale remote points never violate read-your-write semantics.
- A real deployment must still pass corpus parity, load, restore, and Qdrant snapshot tests before production acceptance.
- The port is not an excuse to implement a lowest-common-denominator abstraction; lifecycle filters are part of its contract.
