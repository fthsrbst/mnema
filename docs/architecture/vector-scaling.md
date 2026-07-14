# Vector Index Scaling and Migration Gates

Mnema treats a vector database as a rebuildable retrieval index. SQLite remains the system of record for memories, documents, lifecycle, projects, sessions, relations, policy metadata, and sync state.

## Current backend

`HUB_VECTOR_BACKEND=sqlite-vec` is the only production adapter in this release. Online retrieval and vector write/delete paths use `src/core/vector-store.ts`; sqlite-vec schema creation and repair remain SQLite-specific maintenance code.

This is a deliberate product constraint, not a claim that an external backend already exists. Setting another backend fails at startup instead of silently serving incomplete results.

## When SQLite remains the right choice

- one writer or one owning service instance;
- local/private deployment;
- filtered retrieval meets recall and latency SLOs;
- online backup and full reindex meet RPO/RTO;
- no tenant requires physical storage isolation;
- corpus size and concurrency remain within measured host capacity.

Do not migrate based on an arbitrary vector-count slogan. Vector dimension, filter selectivity, storage, concurrency, update rate, and recovery objectives matter more than count alone.

## External backend gate

Start an adapter project only when a repeatable benchmark shows one of:

- p95 filtered vector latency violates the product SLO at representative concurrency;
- full reindex or backup/restore violates RTO;
- horizontal read replicas are required;
- tenant isolation cannot be met with the current process/database boundary;
- filtered recall falls below the held-out target because the local index cannot search a sufficiently broad candidate set.

## Adapter choice

- PostgreSQL + pgvector: prefer when the company already operates PostgreSQL and transactional metadata/filter joins dominate. It reduces system count, but high-scale ANN tuning and vacuum/index operations require database expertise.
- Qdrant: prefer when vector filtering, payload indexes, high update volume, and vector-native operations are the primary need. It adds another durable service and backup/recovery surface.
- Weaviate or Milvus: consider only when their managed/cluster capabilities solve an established operational requirement. Their broader platform surface is not automatically a retrieval-quality improvement.
- Pinecone or another managed service: consider when reducing operations is worth data residency, vendor dependency, egress, and cost trade-offs.

No backend compensates for stale lifecycle metadata, weak labels, post-filtering, unversioned embeddings, or a missing evaluation set.

## Required adapter contract

An adapter must preserve:

- stable memory/chunk identity;
- project partition and global-scope semantics;
- document `enabled`, `is_current`, and `kind` filters during KNN candidate retrieval;
- embedding-generation rejection;
- idempotent put/delete;
- deterministic distance semantics and configured cutoff;
- export/rebuild from the SQLite source of truth;
- parity tests against sqlite-vec on the held-out corpus.

Migration is dual-read shadow first, then measured cutover. Never dual-write indefinitely without reconciliation metrics. Rollback is changing the active adapter after proving the SQLite index is current; source records never move during the first vector-index migration.
