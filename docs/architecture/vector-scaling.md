# Vector Index Scaling and Migration Gates

Mnema treats a vector database as a rebuildable retrieval index. SQLite remains the system of record for memories, documents, lifecycle, projects, sessions, relations, policy metadata, and sync state.

## Current backends

- `HUB_VECTOR_BACKEND=sqlite-vec` is the default embedded path.
- `HUB_VECTOR_BACKEND=qdrant` is an optional scale-out search projection. SQLite and sqlite-vec remain authoritative; every local-vector mutation atomically queues an idempotent Qdrant upsert/delete in `vector_outbox`. A bounded worker retries with exponential backoff. Revision checks prevent an in-flight delivery from clearing a newer mutation. While an ID is pending, local vector state or local deletion overrides the stale remote point. Qdrant query failure falls back to sqlite-vec and FTS rather than rejecting a knowledge write or context request.

Qdrant collections are embedding-generation-specific. Project/type/tag/lifecycle payloads are indexed and applied during ANN candidate retrieval. `vector_projection_rebuild` queues a full backfill from local authoritative vectors; status and flush operations are exposed through REST and MCP.

## When SQLite remains the right choice

- one writer or one owning service instance;
- local/private deployment;
- filtered retrieval meets recall and latency SLOs;
- online backup and full reindex meet RPO/RTO;
- no tenant requires physical storage isolation;
- corpus size and concurrency remain within measured host capacity.

Do not migrate based on an arbitrary vector-count slogan. Vector dimension, filter selectivity, storage, concurrency, update rate, and recovery objectives matter more than count alone.

Use the checked-in harness for host-specific evidence:

```powershell
npm run benchmark:vector -- --rows=100000 --queries=200 --projects=50 --dim=768 --gate
```

The development-workstation baseline is recorded under `docs/benchmarks/`; repeat it on the actual Pi or company host rather than transferring latency claims between machines.

## Qdrant activation gate

Enable the included Qdrant projection only when a repeatable benchmark shows one of:

- p95 filtered vector latency violates the product SLO at representative concurrency;
- full reindex or backup/restore violates RTO;
- horizontal read replicas are required;
- tenant isolation cannot be met with the current process/database boundary;
- filtered recall falls below the held-out target because the local index cannot search a sufficiently broad candidate set.

## Backend choice

- PostgreSQL + pgvector: prefer when the company already operates PostgreSQL and transactional metadata/filter joins dominate. It reduces system count, but high-scale ANN tuning and vacuum/index operations require database expertise.
- Qdrant: the implemented external projection; prefer when vector filtering, payload indexes, high update volume, read scaling, or physical service separation is required. It adds another service, but not another knowledge source of truth.
- Weaviate or Milvus: consider only when their managed/cluster capabilities solve an established operational requirement. Their broader platform surface is not automatically a retrieval-quality improvement.
- Pinecone or another managed service: consider when reducing operations is worth data residency, vendor dependency, egress, and cost trade-offs.

No backend compensates for stale lifecycle metadata, weak labels, post-filtering, unversioned embeddings, or a missing evaluation set.

## Adapter contract

Every adapter must preserve:

- stable memory/chunk identity;
- project partition and global-scope semantics;
- memory type/tag and document `enabled`, `is_current`, and `kind` filters during candidate retrieval;
- embedding-generation rejection;
- idempotent put/delete;
- deterministic distance semantics and configured cutoff;
- export/rebuild from the SQLite source of truth;
- parity tests against sqlite-vec on the held-out corpus.

Migration is shadow/backfill first, followed by parity measurements and a configuration cutover. Monitor `outbox_pending` and `outbox_failed`; zero backlog is required before comparison. Rollback is changing `HUB_VECTOR_BACKEND` to `sqlite-vec`; source records and the local index never move.

## Qdrant bootstrap

```dotenv
HUB_VECTOR_BACKEND=qdrant
HUB_QDRANT_URL=https://qdrant.internal.example
HUB_QDRANT_API_KEY=<secret-manager-reference>
HUB_QDRANT_COLLECTION_PREFIX=mnema
```

1. Start Mnema and confirm `/health` reports a ready local generation.
2. Call `vector_projection_rebuild` once to queue the authoritative corpus.
3. Flush/observe until both outbox counters reach zero.
4. Run `vector_projection_verify`; exact local/remote counts, generation readiness, and the outbox must agree.
5. Run the context eval and retrieval parity suite before accepting the cutover.
6. Back up Qdrant according to its replication/snapshot policy; it remains rebuildable from SQLite, but a rebuild may exceed the desired RTO.
