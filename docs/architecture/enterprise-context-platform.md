# Mnema Enterprise Context Platform

Status: accepted target architecture, correctness and company-baseline implementation complete; scale validation in progress
Last updated: 2026-07-14

## Objective

Mnema is not a general-purpose vector database. It is a vendor-neutral context control plane for AI agents. It owns project state, durable memory, document retrieval, session continuity, provenance, evaluation, access policy, and synchronization while keeping the underlying retrieval store replaceable.

The target is a system that remains correct as data, teams, agents, and devices grow. More data must improve answer quality instead of increasing stale context, cross-project leakage, or prompt-injection risk.

## Invariants

1. Current state is deterministic. Project maps, canonical current documents, and latest sessions outrank semantic similarity for status questions.
2. Retrieved content is data, never instructions. Memories, documents, project maps, and sessions cannot override the consuming agent's system or developer policy.
3. Every result has provenance, lifecycle state, and a stable UID.
4. Retrieval quality is changed only against a versioned held-out evaluation set.
5. Filters are applied during candidate retrieval, not after a global top-k query.
6. Every embedding is tied to an embedding generation: provider, model, dimensions, normalization, and chunker version.
7. Storage is replaceable behind a VectorStore boundary. SQLite remains the default until measured limits justify an external backend.
8. Writes are authenticated, authorized, validated, auditable, and idempotent.
9. Original text is never destroyed by normalization or translation.
10. FTS-only fallback remains operational and observable when embeddings are unavailable.

## Recommended architecture

Keep a modular monolith while there is one owning team:

- Context Orchestrator: intent routing, authority ordering, token budget, trust envelope, provenance.
- Knowledge Core: memories, documents, versions, relations, sessions, projects.
- Retrieval Engine: lexical retrieval, vector retrieval, fusion, reranking, freshness, deduplication.
- Storage Ports: metadata repository, lexical index, VectorStore, blob/document source.
- Policy Plane: principals, scopes, project membership, audit events, retention rules.
- Evaluation Plane: golden queries, retrieval traces, feedback, offline metrics, regression gates.
- Sync/Replication: generation-aware, transactional replication for personal/local-first installations.

Do not split these into microservices yet. Preserve module boundaries so the vector index, embedding worker, or sync transport can be extracted when an operational constraint—not speculation—requires it.

## Authority order

For `current_status` requests:

1. Canonical project map
2. Latest project session
3. Current canonical status document
4. Recent project decisions
5. Other retrieved evidence

For technical-history requests, semantic memory and runbooks may lead. For documentation requests, current project documents lead. `context_get` owns this routing; callers should not manually concatenate unrelated tool results.

## Language policy

English-only storage is rejected as a hard rule. Translation can lose names, constraints, quotations, and legal or domain nuance; English is not guaranteed to use fewer tokens for every model/tokenizer.

The policy is:

- Preserve `original_text` as the source of truth.
- Record the original BCP-47 language when known.
- Keep identifiers, schemas, tool contracts, relation types, and operational metadata in English.
- Add an optional English `canonical_summary` or `search_aliases` only through a versioned normalizer, with model/version provenance.
- Index both original and canonical search text when evaluation proves a benefit.
- Generate the final context in the consuming agent's requested language; never translate stored evidence destructively.

## Scale strategy

SQLite + FTS5 + sqlite-vec remains the default single-node profile. It is the correct operational choice for the current corpus. Scale decisions use measured gates:

- p95 context retrieval latency exceeds the product SLO under representative concurrency.
- index size or rebuild time exceeds the recovery objective.
- multi-tenant isolation or horizontal read capacity is required.
- filtered vector search no longer meets recall targets.

At that point, implement a Qdrant or PostgreSQL/pgvector VectorStore adapter without moving project/session/policy ownership out of Mnema. A vector database is an index, not the system of record.

## Delivery phases

### Phase 1 — correctness foundation

- Add `context_get` with intent routing, authority order, trust envelope, provenance, and token budget.
- Count only context that was actually injected, not discarded candidates.
- Establish a versioned retrieval evaluation harness and baseline.
- Add project-integrity diagnostics.

### Phase 2 — document lifecycle

- Canonical URI uniqueness and idempotent replacement.
- `kind`, `version`, `is_current`, `supersedes_uid`, validity interval, archive state, content hash, and language metadata.
- Current-status retrieval must exclude archived/superseded documents during candidate search.

### Phase 3 — retrieval engine

- Push project/current/enabled filters into FTS and sqlite-vec queries.
- Separate lexical/vector scores, calibrated fusion, optional reranking, diversity, and source caps.
- Version embedding/chunker generations and make reindex race-safe.

### Phase 4 — security and tenancy

- Shared request schemas for MCP and REST.
- Principal identity, scoped tokens, project membership, rate limits, audit log, secret rotation.
- Explicit untrusted-evidence envelope and write-policy enforcement.

### Phase 5 — replication and operations

- Transactional apply, `(table, uid)` tombstones, clock/generation safeguards, pagination and compression.
- Backup/restore drills, metrics, traces, SLOs, retention and compaction.

### Phase 6 — knowledge lifecycle

- Typed and temporal relations with provenance.
- Consolidation and contradiction workflows.
- MCP graph traversal tools, or explicitly retain the simpler navigation-graph name.

## Implemented baseline (2026-07-14)

The repository now contains the context orchestrator, current-document lifecycle, in-candidate project/lifecycle filters, embedding-generation gates, transactional sync apply, composite tombstones, shared Zod schemas, scoped project-aware auth, team/enterprise fail-closed profiles, generalized retrieval feedback, source diversity, retrieval traces, typed temporal memory relations, relation sync, a VectorStore port, integrity checks, and a redacted tamper-evident audit chain.

The remaining scale work is evidence-driven: grow the human-labelled held-out suite, run concurrency/latency/recovery benchmarks, implement a server-authoritative conflict protocol before multi-writer company use, and add an external vector adapter only after the documented migration gate is crossed.

## Quality gates

No phase is complete without executable evidence:

- Typecheck and smoke tests
- Migration test from a real prior schema snapshot
- Held-out retrieval metrics with no stale-hit regression
- Negative-query and cross-project isolation tests
- Concurrency tests for replacement/reindex/sync
- Authz and prompt-injection tests
- Live runtime verification on the deployed profile
