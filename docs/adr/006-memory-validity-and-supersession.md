# ADR-006: Memory validity, supersession, and verification age

- Status: Proposed
- Date: 2026-07-21

## Context

Agents on every device keep acting on memories that are no longer true. This is
the most-reported failure of the system, and it is structural rather than
accidental.

**A memory has no lifecycle.** The `memories` table carries only `created_at` and
`updated_at`. The `documents` table, in the same database, already carries a full
one — `kind`, `version`, `is_current`, `supersedes_uid`, `valid_from`, `valid_to`,
`archived_at` — and retrieval enforces it: `chunks_vec` declares `is_current`,
`enabled`, and `kind` as vec0 metadata columns so stale chunks are filtered
*inside* the KNN rather than after top-k. Memories received none of this.

**Decay cannot express falsehood, and deliberately so.** Memory ranking is
`score × importance × decay`, where
`decay = decayFloor + (1 - decayFloor) · exp(-ln2 · age / halflife)`
(`src/core/memories.ts:353`). The floor exists on purpose — the comment says a
year-old "how did I fix this" record must still be findable. The consequence is
that **a confidently wrong record can never sink below the floor.** Age is the
only lever, and age is the wrong lever: the system can say a memory is *old*, but
never that it is *false*.

**There is no primitive for "this is no longer true."** `memory_update` edits
fields; `memory_delete` destroys the record and its history. Nothing expresses
invalidation, so agents either silently overwrite prose or leave the wrong record
in place. Both happened in the live database.

**Contradiction is invisible at retrieval time.** Memories 24 and 52 both describe
SSH access between devices. Memory 52 said the Mac had no authorized key and the
mesh was blocked; memory 24, written later, said the key works and explicitly noted
the earlier record was wrong. Both were returned by the same search, adjacent, with
comparable scores and no structural relation between them. An agent reading 52 would
have abandoned a working path. The `memory_relations` table already has
`supersedes` and `contradicts` edge types with `valid_from`/`valid_to`, but nothing
creates them and `src/core/context.ts:393` only includes an edge when *both*
endpoints were independently retrieved — so a superseded memory can be delivered
alone, with its replacement nowhere in sight.

**Not all memories rot at the same rate.** "Paddle is the first Merchant of Record
because Turkey cannot onboard to Stripe" is true indefinitely. "Tailscale is stuck
in NoState on this PC" was true for hours. Both are stored identically and decay
identically. During the session that produced this ADR, the Tailscale claim had
already become false and was still being served as fact.

**Careless invalidation is the symmetric danger.** In the same session, an agent
concluded a *correct* memory was stale because `curl http://fatihpi-lan:8033/health`
returned nothing — not realizing `fatihpi-lan` is an `~/.ssh/config` alias that curl
cannot resolve. The memory was right; the test was wrong. A one-click "mark this
false" would have corrupted good knowledge. Invalidation must therefore be as
evidence-bound as assertion, and reversible.

## Decision

Memories get the lifecycle model documents already have, plus a verification age.
Four layers, each independently useful; the first two carry most of the value.

### 1. Lifecycle columns (mirrors `documents`)

Add to `memories`: `valid_from`, `valid_to`, `is_current` (default 1),
`supersedes_uid`, `invalidated_reason`. Existing rows migrate to
`is_current = 1, valid_from = created_at, valid_to = NULL` — no retroactive claim
that anything is stale.

`memories_vec` gains `is_current` as a vec0 metadata column, exactly as
`chunks_vec` has it, so superseded memories are excluded inside the KNN instead of
consuming top-k slots.

### 2. Read-time enforcement

`searchMemories`, `recall`, and `context_get` return only `is_current = 1` records
by default. A superseded record is reachable with an explicit
`include_superseded` flag for history questions, and always carries its
`supersedes_uid` so the caller can follow the chain forward.

This is the layer that actually fixes the reported symptom. Without it the other
three are bookkeeping.

### 3. `memory_invalidate` — the missing primitive

One call marks a memory not-current: `uid`, `reason`, optional `replaced_by_uid`,
and required `evidence` (the command, output, or observation that establishes it).
It sets `valid_to`, clears `is_current`, records the reason, and creates a typed
`supersedes` relation when a replacement is named. It never deletes: the record and
its history stay queryable, and the operation is reversible by an explicit
`memory_revalidate`.

`memory_save` surfaces the near-duplicate candidates it *already computes* —
`findSimilar` runs a k=4 KNN on every write (`src/core/memories.ts:68-73`) — so the
writing agent is asked "does this supersede one of these?" instead of silently
adding a fifth contradictory record. The system does not decide this on its own:
automatic LLM adjudication is deliberately out of scope for the first version,
because a false invalidation is worse than a stale record.

### 4. Verification age for volatile claims

Add `verified_at` and optional `review_after`. Claims about environment state — a
host is reachable, a service is running, a key is installed — set a review horizon.
Recall does not hide expired records; it labels them: *"37 gündür doğrulanmadı."*

This is honest about what the system can know. It cannot detect that a fact became
false, but it can always tell that nobody has checked, and saying so lets the
reading agent decide whether to re-verify before acting. It is also the cheapest
layer: no LLM, no inference, no risk of wrongly discarding good knowledge.

## Consequences

- The reported failure — agents acting on false memories — is addressed at the
  retrieval layer, where it manifests, rather than only at the write layer.
- Supersession becomes machine-readable. The 24-versus-52 case produces a link the
  reader can follow instead of two rival records with similar scores.
- Memory ranking stops carrying a burden it was never designed for. `decayFloor`
  can keep protecting old-but-true records precisely because validity is now a
  separate axis.
- The taxonomy grows: agents must now think about whether a claim is durable or
  volatile. Guidance belongs in `CLAUDE.md`/`AGENTS.md`, and agents that ignore it
  degrade to today's behavior rather than something worse.
- `is_current` becomes a new way to lose data — a wrongly invalidated memory is
  invisible even though it is present. Requiring evidence, keeping the row, and
  providing `memory_revalidate` are the mitigations; `hygiene_report` should list
  recently invalidated records so mistakes surface.
- Sync carries five more columns. They ride the ADR-005 change log like any other
  field, and legacy peers that omit them must not clobber local values — the
  `COALESCE(@col, col)` pattern established for `origin_machine`.
- **Deliberately excluded:** automatic contradiction detection by an LLM at write
  time (the Mem0 pattern). It belongs on the roadmap, not in the first version;
  this ADR's job is to make validity *representable* and *enforced*. Automating who
  decides comes after the representation exists and has been observed in use.
