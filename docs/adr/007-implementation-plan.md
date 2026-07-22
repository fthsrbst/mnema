# ADR-007 implementation plan

Companion to [ADR-007](007-procedural-memory-from-trajectories.md). Three phases,
each independently testable and shippable. Order is chosen so the security-
critical, deterministic logic lands and is verified *before* the model is wired
in.

## Phase 1 — Candidate store + corroboration gate (deterministic, no model)

The novel and security-critical part is the admission logic, and it is pure. It
ships and is tested first, with distillation stubbed by direct candidate
insertion.

New module `src/core/procedural.ts` and a `lesson_candidates` table.

- **Table `lesson_candidates`** (device-local; no `change_log` trigger, like
  `recall_feedback` — candidates are staging, only promoted memories sync):
  `id`, `uid`, `kind` (`strategy`|`recovery`|`optimization`), `situation`,
  `guidance`, `project`, `episode_key`, `evidence_refs` (JSON array), `status`
  (`pending`|`promoted`|`rejected`|`held`), `created_at`. A candidate with an
  empty `evidence_refs` is refused at write time.
- **`admitCandidate(input)`** — the gate. Steps:
  1. Reject if no evidence reference.
  2. Screen `guidance` + `situation` with the existing `instruction_like`
     detector; if it reads as an imperative to an agent, set `status='rejected'`.
  3. Screen against a sensitive-topic matcher (credentials / security config /
     deploy commands); if matched, set `status='held'` and stop — never
     auto-promote.
  4. Corroboration: find a `pending` candidate with the same `kind` and a
     near-duplicate `situation` (reuse the FTS+distance logic already in
     `findDuplicates`), from a *different* `episode_key`. If found, promote:
     write a `howto` memory via `saveMemory` (tags `auto-lesson`,
     `procedural`, `kind-<kind>`; `source=trajectory-distiller`; body carries
     `situation` + `guidance`; the memory records `episode_key` and
     `evidence_refs` in its `source`/tags for bulk revocation), mark both
     candidates `promoted`. Otherwise leave `pending`.
- **`revokeEpisode(episode_key)`** — deletes candidates and invalidates promoted
  memories from one episode in a single call (uses ADR-006 `memory_invalidate`,
  so revocation is reversible and evidence-bound).
- **Smoke tests** appended to `scripts/smoke.ts`:
  - no evidence → refused
  - single episode → stays `pending`, no memory created
  - second independent episode, same pattern → promoted, one `howto` memory
  - two candidates from the *same* episode → do NOT corroborate
  - imperative guidance → `rejected`, no memory
  - credential-touching guidance → `held`, no memory even with corroboration
  - `revokeEpisode` → promoted memory becomes `is_current=0`

## Phase 2 — Episode assembly + distillation (wires the model)

- **`assembleEpisode(episode_key)`** — gathers the coarse trajectory from rows
  Mnema already stores: task lifecycle transitions, `verification` evidence,
  `audit_events` for the actor/window, `session_logs`. Raw shell output,
  environment, and command lines are never read (they are not in these rows).
- **`distillEpisode(episode_key)`** — feeds the assembled trajectory to
  `localLlm` (mirroring `compaction.ts` `summarize()` with the same availability
  check and fallback), constrained to a fixed JSON schema. Free-form output is
  rejected; parsed candidates go through `admitCandidate`. Never used as a system
  prompt.
- **Job handler** `registerJobHandler('distill', …)` + enqueue on
  `task_complete`/`agent_checkout`. Runs on the worker, off the hot path.
- **Smoke**: distillation with local model unavailable → deterministic fallback,
  no crash (mirrors compaction's FTS-only discipline); schema-invalid model
  output → rejected, no candidate.

## Phase 3 — Surfacing + housekeeping + metrics

- Promoted memories already surface through `context_get`/`project_lessons`
  (they are ordinary `howto` memories). No retrieval change needed — this is the
  payoff of promoting into the existing type rather than inventing a new one.
- **Hygiene**: `pending` candidates that never corroborate are pruned by the
  existing `hygiene` job (age threshold); `held` candidates are surfaced in
  `hygiene_report` for human review.
- **Metrics**: `metrics_overview` gains candidate counts by status and
  promotion rate, per ADR-007's requirement that an abandoned queue is a visible
  failure.
- **MCP**: read-only `lesson_candidates_list` and a human `candidate_promote`
  for the `held` set. `runDigest` reports what was generated and promoted.

## Non-goals (restated from ADR)

Fine-grained Claude Code hook traces, cross-project transfer, and the write-time
admission gate (ADR-008, deferred) are out of scope for all three phases.
