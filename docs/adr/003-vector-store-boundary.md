# ADR 003: Keep the vector index replaceable

Status: accepted
Date: 2026-07-14

## Decision

All online vector search and mutation paths depend on the `VectorStore` port. sqlite-vec is the only supported adapter until measured scale gates justify another backend. SQLite remains the knowledge system of record.

## Rationale

Direct sqlite-vec SQL had spread into retrieval, memory, document, project-migration, and sync code. That made a future backend change a whole-application rewrite. Installing Qdrant or pgvector now would add operational cost without evidence that the current corpus needs it.

## Consequences

- Unsupported backend values fail at startup.
- SQLite-specific migrations, integrity repair, and reindex code remain in the maintenance layer for now.
- An external adapter must pass filter, generation, parity, rebuild, and rollback tests before cutover.
- The port is not an excuse to implement a lowest-common-denominator abstraction; lifecycle filters are part of its contract.
