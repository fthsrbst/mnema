# ADR-007: Procedural memory from agent trajectories

- Status: Accepted
- Date: 2026-07-21

## Context

An LLM cannot learn from deployment. Its weights are frozen, and the transformer
computes each request statelessly, so an agent that walks into a wall on Monday
walks into the same wall on Tuesday. Mnema already supplies the prosthetic for
one architectural deficit — the model cannot remember across sessions, so we
built a memory system. Learning from experience is the same class of deficit and
has no prosthetic yet.

What this ADR adds is not a new kind of knowledge. It is a new *origin* for an
existing one: `howto` memories, written automatically from what happened instead
of by a human who noticed a pattern and sat down to record it.

The gap is visible in this repository's own history. Memory `a845a4ba`
("Cihazlara SSH erişimi") records that the `fatihpi-lan` alias works when the
Tailscale path does not. A human wrote that by hand, after agents had repeatedly
claimed the Pi was unreachable. The information needed to produce it already
existed in the session record: a command was attempted, it failed, an alternative
succeeded. Nothing extracted it. `task_feedback` and `project_lessons` exist for
exactly this purpose but are manual, so they are populated only when someone
remembers to populate them.

External work confirms both the size of the prize and the shape of the solution.
IBM Research's trajectory-informed memory generation (arXiv:2603.10600, February
2026) parses agent execution logs into three kinds of guidance — *Strategy* from
clean successes, *Recovery* from failure-then-success sequences, and
*Optimization* from inefficient successes — and injects them into later prompts
as procedural memory. It reports +28.5 points of scenario goal completion on
AppWorld, a 149% relative gain. A large-scale study of 20,574 real coding
sessions (arXiv:2605.29442) independently finds that agents fail less from
missing knowledge than from repeating known-bad approaches.

Two constraints shape what is buildable here.

**Mnema does not run agents.** Claude Code, Codex, and opencode execute in their
own processes and reach Mnema over MCP. The full thought-and-action trace used by
the IBM framework is not visible from this position. What *is* visible is what
agents already report: `audit_events`, `hub_events`, task status transitions with
the `verification` evidence attached at `task_complete`, `session_logs`, and
`agent_presence` episodes bounded by checkin and checkout. This is a coarse
trajectory, and it is free — no new capture path, and it works identically for
every agent.

**Generated text that reaches an agent's prompt is an injection surface.** A
trajectory can contain attacker-influenced text, most plausibly in the free-form
fields agents write themselves: session summaries, task descriptions,
verification summaries. An earlier draft of this ADR proposed human approval as
the gate. That was rejected on two grounds. First, it defeats the purpose: the
goal is to automate knowledge capture, and a queue a human must service is the
thing being replaced. Second, the risk was mis-sized. `memory_save` is an MCP
tool available to every agent, so a compromised agent can already write memory
directly, today, with no distiller involved. Distillation does not grant the
attacker a new capability; it changes volume and attribution. The correct control
is therefore not pre-approval but corroboration, provenance, and reversibility.

## Decision

Procedural memories are generated from coarse trajectories by a local model,
admitted automatically under a corroboration threshold, and fully attributable so
they can be revoked in bulk.

**Trajectory unit.** An episode is a task lifecycle from `task_claim` to
`task_complete`/`cancelled`, or, where no task exists, an `agent_presence`
episode from `agent_checkin` to `agent_checkout`, keyed by (machine, project,
uid). Both boundaries already exist in the data; no new instrumentation is added.

**Distillation input is curated records, not raw output.** The distiller reads
rows Mnema already stores. It never reads raw shell output, environment, or
command lines. `audit_events` already excludes request bodies, tokens, document
text, and prompts by design, so the highest-risk content never enters the
pipeline. This costs trace fidelity and buys the elimination of the most likely
secret-leakage path.

**Distillation runs on the local model through the job queue.** `compactSessions`
already establishes this pattern: bulk, repetitive text work goes to LM Studio or
Ollama via `local_llm`, scheduled through `jobs` and `worker.ts`, so per-episode
distillation creates no API bill. Distiller output is constrained to a fixed JSON
schema with typed fields (`kind`, `situation`, `guidance`, `evidence_refs`);
free-form prose is rejected. Distiller output is untrusted throughout and is
never used as a system prompt.

**Corroboration, not approval, is the admission gate.** A candidate derived from
a single episode is written at low confidence and is *not* injected into
`context_get`. It becomes an injectable `howto` memory once the same pattern
appears in **two independent episodes**. Repetition is the automated substitute
for human judgment: a one-off poisoned trajectory does not survive the threshold,
while a genuine recurring pattern does, and an attacker must consistently poison
multiple independent episodes to pass. The threshold starts at 2 and is tunable;
2 learns quickly, 3 stays cleaner, and the choice should be revisited against
observed false-positive rate rather than argued in advance.

"The same pattern" is decided by the near-duplicate detection already in
`src/core/hygiene.ts` (`findDuplicates`), matching on `kind` plus the existing
FTS-and-distance comparison over `situation`. Reusing that matcher is deliberate:
a second, independent notion of similarity would drift from the first, and
duplicate detection is the same question asked at a different moment. Episodes
count as independent when they differ in episode identifier; two candidates from
one episode never corroborate each other.

**Instruction-shaped candidates are rejected, not queued.** Candidates are
screened with the existing `instruction_like` detector from
`src/core/context.ts`. A description of what happened has no legitimate reason to
address an agent in the imperative, so this signature is discarded at write time.

**Every generated memory carries its origin.** `source=trajectory-distiller`,
plus the episode identifier and `evidence_refs` pointing at the rows it was
derived from. This makes generated knowledge attributable and *bulk-revocable*:
if something goes wrong, every memory from a given episode or time window can be
removed in one operation. Hand-written memories do not have this property today,
so generated knowledge is more recoverable than the knowledge it supplements. A
candidate with no evidence reference is discarded at write time.

**The human is an auditor, not a gate.** The existing `runDigest` reports what
was generated and what crossed the threshold. Any generated memory can be vetoed,
and its episode revoked, but nothing waits on a human and the system is fully
functional if no one ever looks.

**One narrow class stays gated.** Candidates whose guidance touches credentials,
security configuration, or deployment commands are held for explicit approval
regardless of corroboration. This set is small and rare, and it is the set where
an automated mistake is least reversible.

## Consequences

- Knowledge capture stops depending on a human noticing a pattern. The
  `fatihpi-lan` case is the reference: the episode that produced it is exactly
  the failure-then-success shape a Recovery candidate is derived from.
- Generated knowledge is more auditable than hand-written knowledge, because it
  carries evidence references and an episode identifier. Bulk revocation is
  possible for generated memories and not for existing ones.
- Corroboration delays learning by design. A genuine insight that occurs once is
  not captured until it recurs. This is accepted: the alternative admits
  single-episode noise, and single-episode noise is what makes a memory base
  untrustworthy.
- Coarse trajectories bound quality. Optimization candidates in particular need
  timing and retry detail that hub-side records carry only partially; early
  output is expected to be weaker than the published benchmark, which instruments
  the agent runtime directly.
- The distiller runs per episode and will produce candidates that never
  corroborate. Candidate storage grows and needs pruning; it attaches to the
  existing `hygiene` job rather than introducing a second cleanup mechanism.
- A compromised agent can still write memory directly through `memory_save`. This
  ADR does not change that exposure, and the corroboration gate should not be
  read as protecting against it. Write-path admission control is
  [ADR-008](008-write-time-admission-control.md).
- **Not addressed here:** candidates are unverified against reality. A memory
  that was true in July and false in September has no mechanism to report its own
  staleness. That is the verification phase, whose security boundary is fixed in
  advance below.
- **Not addressed here:** fine-grained trajectories via Claude Code hooks. The
  coarse path is agent-agnostic and ships first; a hook-based upgrade would apply
  only to Claude Code and carries a secret-redaction obligation that the
  curated-record path avoids entirely.
- **Not addressed here:** cross-project transfer. A pattern learned in `fit` may
  apply to `mnema`, but scoping and the risk of over-generalizing from one
  project are separate work.

## Pre-committed boundary for the verification phase

[ADR-006](006-memory-validity-and-supersession.md) handles staleness by reporting
verification *age* — it never claims a memory became false, only that nobody has
checked in N days. That is the correct first layer, and it is cheaper and safer
than what follows. A later phase may attach probes that actively test a claim.
Its security invariants are fixed now so they are not relitigated under delivery
pressure:

- Probes are a closed, declarative vocabulary. Arbitrary shell is never a probe.
- Probes are read-only by construction. A probe cannot mutate the device.
- Probes cannot exfiltrate. Match probes return a boolean, never matched content,
  and no probe performs arbitrary outbound HTTP.
- Probe file paths are scoped to the project root; traversal outside is rejected.
- Any probe that executes anything takes its command from device-local
  configuration, never from synced content. Synced knowledge may select an
  allowlisted entry by name; it may never supply the command itself.

The last invariant is load-bearing. Probe definitions replicate across devices,
so if synced content could name the thing to execute, writing a memory would be
remote code execution on every device. Selecting from a local allowlist keeps the
blast radius inside what the device owner already approved.
