# ADR-008: Write-time admission control for observations

- Status: Deferred — revisit after
  [ADR-006](006-memory-validity-and-supersession.md) ships and has been observed
  in use
- Date: 2026-07-21

> **Scope note.** ADR-006 independently specifies the memory lifecycle this ADR
> originally proposed (`valid_from`, `valid_to`, `is_current`, `supersedes_uid`),
> and specifies it better: it mirrors the model `documents` already uses and
> filters superseded rows inside the vector KNN rather than after top-k. Those
> parts of this document are superseded and should be read as ADR-006's.
>
> What remains here is one rule ADR-006 does not cover: a claim a live source can
> answer should not be stored at all. ADR-006 *labels* a written record with its
> verification age; it does not prevent the record from being written. Whether
> labeling turns out to be sufficient on its own is an empirical question, and
> ADR-006 deliberately defers write-time automation until the representation
> exists and has been observed. This ADR therefore waits on that evidence rather
> than competing with it.

## Context

An LLM cannot distinguish an observation from a fact. It sees something in its
context, is told to save what is useful, and saves it — with no notion that what
it saw has a shelf life. The result is that transient device state enters the
knowledge base as though it were durable knowledge, and then stays there, wrong,
looking authoritative.

This is not hypothetical. It is currently degrading this repository's own memory
base, and the damage compounds because agents spend real work maintaining state
that should never have been stored:

- Memory `c7de8cef` is titled "Cihazlar arası SSH mesh: ÇÖZÜLDÜ — eski engel
  listesi geçersiz" and opens with: *"Bu kaydın 06:33'teki hali '3 engel var'
  diyordu; ÜÇÜ DE artık geçerli değil veya yanlıştı."*
- Memory `a845a4ba` carries: *"GÜNCELLEME: bu kaydın önceki hali 'Tailscale yolu
  TIMEOUT veriyor' diyordu — o durum GİDERİLDİ."* It has been corrected
  repeatedly within a single day.
- Memory `59ea841a` carries: *"CİHAZ DURUMU (canlı doğrulandı, önceki 'ikisinde
  de yok' bilgisi YANLIŞTI)."*

These records have become palimpsests: layers of stale observation with
corrections written over them. The knowledge they still contain is real, but it
is now interleaved with measurements that expired hours after they were written.
Each correction cycle costs an agent session.

The correct rule is already written down — as advice, inside one of the affected
memories. Memory `a845a4ba` states: *"MAKİNENİN AÇIK OLUP OLMADIĞINI `tailscale
status` ile ölç — `machine_status` MCP aracı YANILTIR."* An agent worked out that
device liveness must be measured rather than recalled, and recorded it. Nothing
enforces it, so the next agent stores the state again.

This is the inverse of the verification phase sketched in
[ADR-006](006-procedural-memory-from-trajectories.md). Verification says: attach
a probe to a claim so staleness reports itself. This ADR says: if a probe can
answer the question outright, the claim should never have been stored. Same
principle, opposite direction.

The project's roadmap already ranks write-time admission as priority one —
*"yazma-anında fact-extraction + ADD/UPDATE/DELETE/NOOP karar motoru (Mem0
deseni) — hijyeni kaynağında çözer, şu an reaktif"* — and bitemporal validity as
priority two. This ADR does not add a work item; it supplies the decision
criterion those items were missing.

## Decision

`memory_save` classifies every write into one of three admissions. The criterion
is a single question: **can a live source answer this right now?**

**Durable knowledge — stored as today.** No query can produce it, and if it is
lost it does not come back: design decisions and their reasoning, causal
know-how, conventions, workarounds. *"cwd yanlışsa `.env` sessizce yüklenmez"* is
durable. *"Paddle seçtik çünkü Stripe TR'ye kapalı"* is durable.

**Live-checkable state — not stored.** A running command or tool answers it now,
so a stored answer can only be a stale copy of a truth that is freely available.
*"mac uykuda"* is live-checkable via `tailscale status`. The write is refused,
and the refusal is not an error: the response returns the measurement path
instead, so the caller learns *how to find out* rather than being blocked. Agents
needing to coordinate transient state — *"mac is down, don't retry for 20
minutes"* — already have `agent_messages` and `agent_presence`; no new store is
introduced for this.

**Time-bounded fact — stored with validity bounds.** True now, expected to change,
and not answerable by any current probe. *"Windows'a gelen SSH yok, kurulumu
yönetici gerektiriyor"* is of this kind. These are stored with `valid_from` /
`valid_until`, the bitemporal fields already present on `memory_relations` and
missing on `memories`. This bucket is what keeps the gate from destroying real
knowledge: such facts are not garbage, they are simply not eternal.

**When the classifier is unsure, it stores and flags.** The uncertain write
succeeds, is tagged as an unverified observation, and is surfaced in the hygiene
report for review. The asymmetry decides this: lost knowledge is unrecoverable,
while stored noise is cleanable by machinery that already exists. It also matches
the project's standing rule that degraded subsystems fall back rather than fail —
if the classifier is unavailable, writes proceed unclassified.

**The gate sits on `memory_save` itself.** Not on the distiller alone. The
polluted records above were written by agents calling `memory_save` directly, so
gating only generated knowledge would leave the actual source untouched. This
also means the gate applies to ADR-006's output as a matter of course.

**Existing pollution is swept once.** Hygiene gains a pass that classifies stored
memories against the same three buckets. Hybrid records such as `a845a4ba` and
`c7de8cef` are split rather than deleted: the durable runbook knowledge is kept,
and the point-in-time measurements are dropped.

## Consequences

- Device-state records stop accumulating, and the correction cycles they generate
  stop consuming agent sessions.
- The knowledge base becomes safe to trust in a way it currently is not. A
  memory that survives the gate is either durable or explicitly time-bounded;
  neither can silently be an expired measurement.
- Classification runs on a hot path. `memory_save` gains latency, mitigated by a
  cheap deterministic pre-filter — claims whose subject matches a known live
  source are decided without a model call — with the classifier consulted only
  for ambiguous writes.
- The classifier will be wrong sometimes, and its errors are biased toward
  storing noise rather than losing knowledge. Hygiene absorbs that bias; the
  false-positive rate is worth measuring rather than assuming.
- Refusals must be legible or agents will fight them. A refusal that returns the
  measurement path teaches; a refusal that returns an error will be retried,
  worked around, or rephrased until it passes.
- `memories` gains `valid_from` / `valid_until`, which every retrieval path must
  respect. A memory outside its validity window must not be presented as current
  truth, and `context_get`'s authority ordering has to account for it.
- **Not addressed here:** validity windows do not verify themselves. A memory
  whose `valid_until` was estimated optimistically is still wrong before it
  expires. Probe-based verification remains the phase that closes this.
- **Not addressed here:** the same problem exists in `session_logs` and project
  map fields, which also accumulate point-in-time observations. The gate covers
  memories only.
- **Not addressed here:** a per-machine state ledger, referenced as
  `memory_machine_state` in memory `59ea841a`. "Which devices is this true on" is
  a distinct question from "is this durable knowledge", and conflating them would
  overload this gate.
