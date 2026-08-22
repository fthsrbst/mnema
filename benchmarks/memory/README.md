# Memory Bench

Memory Bench is a provider-neutral, reproducible benchmark for agent memory
systems. It is being incubated in the Mnema repository and is intentionally
isolated from Mnema's product-specific `eval:context` suite.

“Memory Bench” is a working name. A unique public name must be selected before
repository extraction to avoid confusion with the existing academic MemBench
benchmark.

Code is licensed under the repository's MIT license. Original dataset artifacts
are licensed under [CC BY 4.0](DATA_LICENSE.md). Contributions and result
publication follow [CONTRIBUTING.md](CONTRIBUTING.md),
[GOVERNANCE.md](GOVERNANCE.md), and the
[release evidence checklist](RELEASE_CHECKLIST.md).

The first runnable track measures explicit memory lifecycle and retrieval
without an LLM judge:

- single- and multi-memory recall;
- knowledge updates;
- temporal recall;
- deletion and abstention;
- namespace isolation;
- query and mutation latency.

It reports metrics separately instead of hiding trade-offs in one composite
score.

Every query also emits normalized `helpful`, `noisy`, and `missing` feedback
events. These are the portable counterpart of Mnema's `recall_feedback` records
and make per-hit decisions auditable.

## Run

Requirements: Node.js 22+ and the dependencies installed at the repository root.

```bash
npm run bench:memory -- --adapter=literal
npm run bench:memory -- --adapter=mnema
npm run bench:memory -- --adapter=mem0
npm run bench:memory -- --adapter=letta
npm run bench:memory -- --adapter=zep
npm run bench:memory:check
npm run bench:memory:smoke
npm run bench:memory:compare-smoke
npm run bench:memory:corpus-check
npm run bench:memory:corpus-verify
npm run bench:memory:review-packet
npm run bench:memory:schema-check
npm run bench:memory:import-longmemeval -- --input=/path/to/longmemeval_oracle.json --output=artifacts/memory-bench/longmemeval-oracle.json
npm run bench:memory:agent -- --dataset=artifacts/memory-bench/longmemeval-oracle.json
```

Write a complete JSON report:

```bash
npm run bench:memory -- \
  --adapter=mnema \
  --dataset=benchmarks/memory/datasets/core-smoke-v1.json \
  --output=artifacts/memory-bench/mnema.json \
  --json
```

The `mnema` adapter always creates a disposable temporary database, disables
embeddings and remote sync, and removes the database after the run. It never
touches the configured production Mnema database. Because Mnema's local core
loads database configuration once per Node.js process, this adapter is intended
for the benchmark CLI's dedicated process, not an already-running Mnema server.

The `mem0` adapter targets the managed Platform REST API:

```bash
export MEM0_API_KEY="your-platform-key"
npm run bench:memory -- --adapter=mem0 --output=artifacts/memory-bench/mem0.json
```

It uses the current V3 add/search/list endpoints with `infer:false` for the
explicit core track, and V1 update/delete/event endpoints for lifecycle and
settling. Each scope becomes a hashed user ID; the entire run receives a unique
hashed run ID. Setup removes stale data for that exact run ID, and teardown
deletes and verifies that same scope. Raw scope names and API keys never enter
the report.

The `letta` adapter creates one disposable agent per run and stores explicit
records in archival memory. Scope isolation uses hashed passage tags. Letta
does not expose passage content updates, so the report declares its update
strategy as create replacement, settle, then delete the old passage. Teardown
deletes the agent and verifies that it is gone:

```bash
export LETTA_API_KEY="your-letta-key"
npm run bench:memory -- --adapter=letta --output=artifacts/memory-bench/letta.json
```

The `zep` adapter creates one disposable standalone graph per dataset scope and
stores records as explicit text episodes. Searches are pinned to
`scope:"episodes"`; using arbitrary entity nodes would be misleading because
Zep derives a node's search representation from its name. Zep does not expose
episode content updates, so updates use a settled replacement episode followed
by deletion of the old one. Teardown deletes and verifies every scope graph:

```bash
export ZEP_API_KEY="your-zep-key"
npm run bench:memory -- --adapter=zep --output=artifacts/memory-bench/zep.json
```

Configuration:

| Variable | Default | Purpose |
|---|---:|---|
| `MEMORY_BENCH_MEM0_BASE_URL` | `https://api.mem0.ai` | Credential-free Mem0 API origin |
| `MEMORY_BENCH_LETTA_BASE_URL` | `https://api.letta.com` | Credential-free Letta API origin |
| `MEMORY_BENCH_LETTA_MODEL` | `openai/gpt-4o-mini` | Pinned Letta agent model; no chat calls are made in the core track |
| `MEMORY_BENCH_LETTA_EMBEDDING` | `openai/text-embedding-3-small` | Letta archival-memory embedding handle |
| `MEMORY_BENCH_LETTA_AGENT_TYPE` | `letta_v1_agent` | Letta agent type |
| `MEMORY_BENCH_LETTA_PROJECT_ID` | unset | Optional `X-Project` target; only presence is reported |
| `MEMORY_BENCH_ZEP_BASE_URL` | `https://api.getzep.com` | Credential-free Zep API origin |
| `MEMORY_BENCH_ZEP_RERANKER` | `rrf` | Zep episode-search reranker |
| `MEMORY_BENCH_HTTP_TIMEOUT_MS` | `15000` | Per-request timeout |
| `MEMORY_BENCH_SETTLE_TIMEOUT_MS` | `60000` | Maximum async event/index settling time |
| `MEMORY_BENCH_POLL_INTERVAL_MS` | `500` | Event/list polling interval |
| `MEMORY_BENCH_HTTP_MAX_RETRIES` | `2` | Retries for safe reads and scoped cleanup |
| `MEMORY_BENCH_RETRY_BASE_DELAY_MS` | `250` | Linear retry backoff base |
| `MEMORY_BENCH_MEM0_SEARCH_THRESHOLD` | `0` | V3 retrieval threshold |
| `MEMORY_BENCH_MEM0_RERANK` | `false` | Managed reranker toggle |
| `MEMORY_BENCH_OPENAI_BASE_URL` | `https://api.openai.com/v1` | Credential-free OpenAI-compatible Responses API base |
| `MEMORY_BENCH_AGENT_READER_MODEL` | `gpt-4o-2024-08-06` | Pinned agent answer model |
| `MEMORY_BENCH_AGENT_JUDGE_MODEL` | `gpt-4o-2024-08-06` | Pinned LongMemEval judge model |
| `MEMORY_BENCH_AGENT_READER_MAX_OUTPUT_TOKENS` | `800` | Reader output limit |
| `MEMORY_BENCH_OPENAI_TIMEOUT_MS` | `60000` | Reader/judge request timeout |
| `MEMORY_BENCH_OPENAI_MAX_RETRIES` | `2` | Bounded retries after explicit transient HTTP responses |
| `MEMORY_BENCH_OPENAI_RETRY_BASE_DELAY_MS` | `500` | Linear model-request retry delay |
| `MEMORY_BENCH_OPENAI_MAX_RESPONSE_BYTES` | `10485760` | Hard response-body limit |

Mutation requests are not retried because an ambiguous network failure could
otherwise duplicate a write. Safe reads and idempotent run-scoped cleanup honor
bounded retries, including HTTP 408, 409, 429, and 5xx responses. Reports
include request/retry/poll counts, request and response body bytes, provider
processing latency when exposed, cleanup verification, and provider cost.
Mem0 reports the sum of add-event latency; Zep reports the sum of search
`server_latency_ms`; Letta exposes neither in these calls. None of the three
managed APIs exposes per-run cost in the used responses, so cost is explicitly
`null` with `costSource: "not-exposed"`.

Metric definitions:

- recall@k: expected record IDs returned in the first k hits;
- precision@k: relevant hits divided by k;
- MRR: reciprocal rank of the first relevant hit;
- forbidden-hit rate: queries that returned at least one explicitly forbidden
  record;
- abstention accuracy: empty-result expectations that returned no hits;
- query pass rate: all required IDs/content are present, no forbidden
  IDs/content appear, and the abstention expectation holds.

Reports also include the same query metrics sliced by memory ability, BCP 47
language tag, and declared difficulty. This prevents a strong aggregate from
hiding a failure concentrated in one capability or language.

## Compare adapters

The comparison command runs every adapter in a separate Node.js process. This
keeps Mnema's process-scoped local configuration isolated and gives every
provider a fresh adapter lifecycle:

```bash
npm run bench:memory:compare -- \
  --adapters=mnema,mem0,letta,zep \
  --dataset=benchmarks/memory/datasets/core-draft-v0.1.json \
  --output-dir=artifacts/memory-bench/live-core-draft
```

Each run writes its complete normalized report. The comparison manifest pins:

- dataset path and SHA-256;
- Git commit and dirty-worktree state;
- Node, OS, architecture, CPU, and memory;
- sanitized adapter configuration and telemetry;
- report SHA-256, query failures, latency, and cleanup verification;
- runtime failures separately from ordinary query-quality failures.

A query-quality failure remains a benchmark result and does not abort the
comparison. Missing credentials, timeouts, malformed reports, and other runtime
failures do make the command exit non-zero, after a manifest has been written.

## Artifact schemas

Versioned JSON Schema Draft 2020-12 contracts live in
[`schemas/v1`](schemas/v1). They cover:

- core datasets;
- normalized agent-memory datasets;
- normalized per-adapter reports;
- normalized agent-memory reports;
- core and agent comparison manifests;
- paired statistical-comparison artifacts;
- LongMemEval evaluator-parity artifacts;
- hash-bound component-qualification overlays;
- post-run agent-publication evidence manifests;
- deterministic review packets;
- editable review overlays.

The committed files are generated deterministically from
`src/schema-definitions.ts`. Regenerate them after an intentional contract
change, then run the drift and real-artifact checks:

```bash
npm run bench:memory:schema-generate
npm run bench:memory:schema-check
```

`schema-check` compiles every schema in strict mode, validates both committed
datasets, real core and agent reports, both comparison manifests, and review
packet/overlay, evaluator-parity, statistical-comparison, qualification, and
publication artifacts. It also exercises invalid examples. TypeScript
parsers remain authoritative for cross-record semantics that JSON Schema
cannot prove alone, including unique IDs across scenarios, operation
lifecycle, reviewer/author independence, and evidence-chain integrity.

## LongMemEval import

The agent-memory track normalizes the official cleaned LongMemEval oracle,
small, and medium files without loading the full source into memory. The
importer reads a user-supplied local file; it never downloads or commits
upstream data:

```bash
npm run bench:memory:import-longmemeval -- \
  --input=/path/to/longmemeval_oracle.json \
  --output=artifacts/memory-bench/longmemeval-oracle.json
```

The official filename selects the subset. Use `--subset=oracle`, `small`, or
`medium` only when the local file was renamed. The command accepts only the
exact files pinned in [THIRD_PARTY_DATA.md](THIRD_PARTY_DATA.md), verifies
their byte size and SHA-256, rejects source schema drift, and writes
atomically without replacing an existing output. The normalized artifact
preserves questions, expected answers, raw upstream dates, evidence-session
IDs, per-turn evidence labels, and ordered user/assistant sessions. Numeric
answers are normalized to strings for the future reader interface.

The output conforms to
[`agent-dataset.schema.json`](schemas/v1/agent-dataset.schema.json). Run the
provider-neutral execution contract with:

```bash
npm run bench:memory:agent -- \
  --dataset=artifacts/memory-bench/longmemeval-oracle.json \
  --top-k=5 \
  --output=artifacts/memory-bench/agent-literal.json \
  --hypotheses-output=artifacts/memory-bench/agent-literal-hypotheses.jsonl
```

The normalized dataset is read in two streaming passes: the first validates and
hashes metadata while discarding scenario bodies, and the second yields one
scenario at a time. This keeps the 2.7 GB medium subset out of process memory.
The runner gives the memory adapter only message role/content, dates, and the
question. Expected answers, evidence-session labels, and per-message
`hasAnswer` labels are withheld. Only the judge receives the expected answer.

Each scenario gets a fresh adapter lifecycle. Retrieval recall@k and MRR are
reported independently from QA accuracy; the official abstention cases are
excluded from retrieval metrics. Ingestion, query, reader, judge, and
end-to-end latency are separate. A reader or judge failure is recorded without
discarding the report, and the next scenario may continue only after cleanup is
verified. A cleanup failure stops further scenarios. Reports contain hashes and
byte counts for retrieved evidence, not raw conversation text or expected
answers.

The currently bundled `literal` adapter, deterministic fixture reader, and
fixture judge are marked `resultClass: "harness"`. They prove isolation,
label-withholding, streaming, failure recovery, report shape, and official
hypothesis JSONL compatibility; they are not LongMemEval quality results.

An OpenAI Responses reader and category-specific LongMemEval judge port are
also available:

```bash
export OPENAI_API_KEY="your-key"
npm run bench:memory:agent -- \
  --dataset=artifacts/memory-bench/longmemeval-oracle.json \
  --adapter=literal \
  --reader=openai \
  --judge=openai \
  --reader-model=gpt-4o-2024-08-06 \
  --judge-model=gpt-4o-2024-08-06 \
  --output=artifacts/memory-bench/agent-openai-candidate.json
```

Replace `--adapter=literal` with `--adapter=mnema` to exercise Mnema's actual
local memory core. The agent adapter creates a new temporary FTS-only database,
stores each dated conversation session as one or more bounded memory fragments,
maps every retrieved fragment back to its source session ID, and deletes plus
verifies every scenario namespace. Fragmentation preserves message order and
keeps each memory within Mnema's 20,000-character body contract.
It restores all managed environment variables and removes the temporary
database at teardown; the configured Mnema database and remote sync are never
used. Like the core Mnema adapter, it requires the dedicated benchmark process.

The managed provider adapters use the same environment variables as the core
track:

```bash
export MEM0_API_KEY="your-key"
npm run bench:memory:agent -- \
  --dataset=artifacts/memory-bench/longmemeval-oracle.json \
  --adapter=mem0 \
  --reader=openai \
  --judge=openai \
  --output=artifacts/memory-bench/agent-mem0-candidate.json
```

Use `--adapter=letta` with `LETTA_API_KEY`, or `--adapter=zep` with
`ZEP_API_KEY`. Mem0, Letta, and Zep reuse their contract-tested core REST
clients, but create and verify a separate disposable provider run for every
agent scenario. Upstream session IDs are never sent to a provider: local
SHA-256 record IDs are mapped back after retrieval. Source dates remain
unchanged for the reader; provider timestamp fields encode LongMemEval's
timezone-less wall clock as UTC so Letta and Zep receive valid ISO 8601.

Each session is one explicit provider record unless a documented boundary
requires fragmentation. Zep text episodes have a
[10,000-character request limit](https://help.getzep.com/adding-business-data),
so longer sessions are split into ordered, valid JSON message fragments that
retain one source-session identity. Letta may return multiple passages for one
write; the core adapter consolidates those passages back to the logical record.
Zep graph search also caps queries at 400 characters and non-auto result limits
at 50. The adapter rejects larger requests before contacting the provider
instead of silently truncating benchmark input.
Mem0 uses
[`infer=false` direct import](https://docs.mem0.ai/platform/features/direct-import)
to avoid model-derived memories. These policies are present in report component
configuration and remain candidate-class until exercised against live services.

Requests follow the current
[OpenAI Responses text contract](https://developers.openai.com/api/docs/guides/text),
set `temperature:0` and `store:false`, and parse nested `output_text` items plus
provider token usage. The judge has separate standard, temporal,
knowledge-update, preference, and abstention prompt branches ported from the
[official evaluator at a pinned commit](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/evaluation/evaluate_qa.py).
Its model and case-insensitive `yes` decision rule match that source. The API
surface differs from the upstream Python script's Chat Completions call, so
these model components remain `candidate`, not `benchmark`, until live
cross-validation against the official evaluator is published. The parity
command below records that cross-validation without treating locally fabricated
or contract-server outputs as publication evidence.

Reports include reader/judge request, retry, byte, token, optional provider
processing, and cost-availability telemetry. API keys and organization values
are omitted; only whether an organization header was configured is reported.
Explicit HTTP 408/409/429/5xx responses are retryable. Network failures and
timeouts are not retried because their billing outcome is ambiguous.

The provider agent adapters are contract-tested, not live-qualified. Real
Mem0, Letta, and Zep runs plus the official-evaluator cross-validation gate are
still required before comparative LongMemEval numbers can be published.

## Agent comparison

Run at least two agent-memory adapters with one immutable dataset and exactly
the same reader, judge, retrieval limit, and scenario bound:

```bash
npm run bench:memory:agent:compare -- \
  --dataset=artifacts/memory-bench/longmemeval-oracle.json \
  --adapters=mnema,mem0,letta,zep \
  --reader=openai \
  --judge=openai \
  --reader-model=gpt-4o-2024-08-06 \
  --judge-model=gpt-4o-2024-08-06 \
  --top-k=5 \
  --output-dir=artifacts/memory-bench/agent-live-candidate
```

The orchestrator runs adapters sequentially in separate child processes. It
validates every child report against the committed agent-report schema before
including it, then verifies dataset identity, top-k, scenario bound, component
names, and model IDs. A canonical SHA-256 fingerprint covers the dataset
artifact plus the complete reader/judge configurations; all completed runs
must share it before the manifest sets `claim.comparable` to `true`.

The agent comparison manifest records child PIDs, exit codes, report hashes,
Git/dirty state, hardware, component configs, telemetry, metrics, runtime
failures, and publication blockers. A QA miss remains a benchmark result and
does not fail the command. A timeout, malformed report, setup error, cleanup
error, or configuration mismatch marks only that adapter run failed, still
writes the manifest, and makes the command exit non-zero.

Using `fixture` reader or judge—or the literal adapter—forces the whole
comparison to `resultClass: "harness"` and
`publicationEligible: false`. Current live model/provider components are
candidate-class, so their manifests also remain publication-ineligible until
provider qualification and official evaluator cross-validation are recorded.
The portable contract is
[`agent-comparison-manifest.schema.json`](schemas/v1/agent-comparison-manifest.schema.json).

## Paired uncertainty

Generate one statistical artifact from either a core or agent comparison
manifest:

```bash
npm run bench:memory:statistics -- create \
  --comparison=/path/to/evidence/agent-comparison.json \
  --output=/path/to/evidence/agent-statistics.json \
  --iterations=10000 \
  --confidence-level=0.95 \
  --seed=20260727

npm run bench:memory:statistics -- check \
  --artifact=/path/to/evidence/agent-statistics.json \
  --comparison=/path/to/evidence/agent-comparison.json
```

The command re-reads every report, verifies its manifest SHA-256, recomputes
the supported quality aggregates from raw traces, and requires exact paired
query/scenario identities plus identical metric missingness. It then resamples
eligible scenarios as clusters and reports percentile intervals for adapter B
minus adapter A. Clustering prevents multiple queries sharing one scenario
from being treated as independent observations.

The seed, iteration count, confidence level, report hashes, and algorithm are
part of the artifact. Per-pair/per-metric random streams are derived
independently, so adding another adapter or metric does not change an existing
interval. A metric with one eligible scenario is explicitly
`insufficient-data`; zero observations are `not-applicable`.

These intervals describe corpus-sampling uncertainty conditional on the exact
reports and configurations. They are not a provider ranking, contain no
multiplicity adjustment, make no statistical-significance claim, and do not
measure stochastic provider variance across repeated runs. Latency is excluded
because sequential provider execution is not a controlled paired latency
experiment. The portable contract is
[`statistical-comparison.schema.json`](schemas/v1/statistical-comparison.schema.json).

## Evaluator parity

The Memory Bench judge is a Responses-API semantic port of the pinned
LongMemEval Python evaluator, not a claim that two API surfaces always return
the same label. Cross-validate a candidate report by sending its
LongMemEval-compatible hypothesis JSONL through the exact upstream script:

```bash
# In a checkout of LongMemEval at
# 9e0b455f4ef0e2ab8f2e582289761153549043fc:
python src/evaluation/evaluate_qa.py \
  gpt-4o \
  /path/to/candidate-hypotheses.jsonl \
  /path/to/longmemeval_oracle.json

# Back in Mnema:
npm run bench:memory:evaluator-parity -- \
  --report=artifacts/memory-bench/agent-candidate.json \
  --official-results=/path/to/candidate-hypotheses.jsonl.eval-results-gpt-4o \
  --output=artifacts/memory-bench/evaluator-parity.json \
  --require-exact
```

Generate the hypothesis input beside a single agent report with
`--hypotheses-output=<path>`. The parity parser accepts the official script's
strict JSONL rows only, rejects duplicate question IDs, and requires exact
question-ID coverage plus byte-for-byte hypothesis equality before labels are
comparable. It also requires one identical model ID and the pinned Memory Bench
prompt revision.

The artifact binds both input files by SHA-256 and pins the official evaluator
commit, source URI, source SHA-256, Chat Completions API surface, and `yes`
decision rule. It reports coverage gaps, hypothesis mismatches, agreement,
the four-cell pass/fail confusion matrix, ability/question-type slices, and
hash-only mismatch rows. It does not copy raw questions, expected answers,
hypotheses, or retrieved evidence.

A label mismatch is an ordinary measurement result and the command normally
exits zero. `--require-exact` writes the artifact first and then exits non-zero
unless the runs are comparable and every label agrees. Even exact agreement
keeps `publicationEligible: false`: this artifact cannot by itself attest that
the official file came from an independent live run or that a reviewer audited
it. The portable contract is
[`evaluator-parity.schema.json`](schemas/v1/evaluator-parity.schema.json).

## Component qualification and result publication

Candidate reports are immutable measurement evidence. They are never rewritten
from `candidate` to `benchmark`. Instead, a separate qualification overlay
binds a complete adapter, reader, or judge configuration and its source
artifacts by SHA-256:

```bash
# Adapter qualification requires both core- and agent-track evidence.
npm run bench:memory:qualify -- template \
  --role=adapter \
  --agent-report=/path/to/mem0-agent-report.json \
  --core-report=/path/to/mem0-core-report.json \
  --output=/path/to/evidence/mem0-adapter-qualification.json

# After the submitter, independent human reviewer, maintainer verifier,
# attestations, and decision have been filled:
npm run bench:memory:qualify -- check \
  --qualification=/path/to/evidence/mem0-adapter-qualification.json \
  --agent-report=/path/to/mem0-agent-report.json \
  --core-report=/path/to/mem0-core-report.json
```

A reader qualification needs its agent report. A judge qualification also
needs that report's evaluator-parity artifact. Localhost, loopback, `.local`,
`.test`, `.invalid`, and fake/contract endpoints cannot qualify a network
component; embedded URL credentials, query parameters, and fragments are also
rejected. Submitter, reviewer, and maintainer-verifier identities must be
distinct; the reviewer and maintainer must be declared humans. Role-specific
attestations make authentication, lifecycle, isolation, cleanup, request
policy, and official-evaluator checks explicit. The portable overlay contract
is
[`component-qualification.schema.json`](schemas/v1/component-qualification.schema.json).

Publication is a second, post-run verification step. Put each qualification
beside the exact reports, core reports, and parity artifacts named inside it,
then create a draft:

```bash
npm run bench:memory:publish-agent -- template \
  --comparison=/path/to/evidence/agent-comparison.json \
  --statistics=/path/to/evidence/agent-statistics.json \
  --qualification=/path/to/evidence/mem0-adapter-qualification.json \
  --qualification=/path/to/evidence/reader-qualification.json \
  --qualification=/path/to/evidence/judge-qualification.json \
  --evaluator-parity=/path/to/evidence/mem0-parity.json \
  --evaluator-parity=/path/to/evidence/mnema-parity.json \
  --output=/path/to/evidence/publication-draft.json
```

The draft intentionally remains `candidate` and publication-ineligible. Fill
its release metadata, public evidence/release/corrections URIs, affiliations,
sponsorships, known limitations, and attestations. Then re-check and finalize
with the same `--comparison`, repeated `--qualification`, and repeated
`--evaluator-parity` arguments plus the exact `--statistics` artifact:

```bash
npm run bench:memory:publish-agent -- check \
  --manifest=/path/to/evidence/publication-draft.json \
  --comparison=/path/to/evidence/agent-comparison.json \
  --statistics=/path/to/evidence/agent-statistics.json \
  --qualification=/path/to/evidence/mem0-adapter-qualification.json \
  --qualification=/path/to/evidence/reader-qualification.json \
  --qualification=/path/to/evidence/judge-qualification.json \
  --evaluator-parity=/path/to/evidence/mem0-parity.json \
  --evaluator-parity=/path/to/evidence/mnema-parity.json

npm run bench:memory:publish-agent -- finalize \
  --manifest=/path/to/evidence/publication-draft.json \
  --comparison=/path/to/evidence/agent-comparison.json \
  --statistics=/path/to/evidence/agent-statistics.json \
  --qualification=/path/to/evidence/mem0-adapter-qualification.json \
  --qualification=/path/to/evidence/reader-qualification.json \
  --qualification=/path/to/evidence/judge-qualification.json \
  --evaluator-parity=/path/to/evidence/mem0-parity.json \
  --evaluator-parity=/path/to/evidence/mnema-parity.json \
  --output=/path/to/evidence/publication-final.json
```

Finalization re-reads and re-hashes every source. It fails closed on a dirty or
missing source commit, reused process IDs, report/comparison drift, incomplete
component coverage, local/fake qualification evidence, missing or non-exact
per-report evaluator parity, missing/tampered/insufficient paired statistical
evidence, incomplete release attestations, or failed independence checks. Only
the final publication manifest may carry
`resultClass: "benchmark"` and `publicationEligible: true`. The contract is
[`agent-publication.schema.json`](schemas/v1/agent-publication.schema.json).

## Draft corpus

`datasets/core-draft-v0.1.json` is a deterministic, AI-authored candidate
corpus, not a leaderboard dataset. It contains:

- 120 scenarios and 120 queries;
- 20 queries for each of the six core abilities;
- 60 English and 60 Turkish queries;
- 40 basic, 60 intermediate, and 20 advanced cases;
- 60 declared generation templates, each used twice;
- no exact normalized query or record-content duplicates.

Regenerate and verify it:

```bash
npm run bench:memory:corpus-generate
npm run bench:memory:corpus-verify
npm run bench:memory:corpus-check -- \
  --dataset=benchmarks/memory/datasets/core-draft-v0.1.json
```

Generation is deterministic and the committed JSON is checked byte-for-byte.
The corpus analyzer reports ability/language/difficulty distributions,
authorship and review status, template concentration, duplicate queries,
duplicate record contents, and scenarios without queries.

## Corpus review gate

Every scenario carries provenance (`synthetic`, `adapted`, or `contributed`),
an author identifier and type (`human`, `ai`, or `mixed`), an optional
generation template, a BCP 47 language tag, difficulty, and an explicit review
status. AI-generated cases remain `draft`; the harness cases remain `harness`.
A case can become `reviewed` only with a timestamp, an overlay artifact hash,
and at least one declared human reviewer distinct from its author.

Generate a deterministic review packet and editable overlay without modifying
the generated dataset:

```bash
npm run bench:memory:review-packet -- \
  --output-dir=artifacts/memory-bench/review-round-1
```

The packet contains each complete scenario and an exact hash of the review
subject. The overlay starts with `reviewer: null`, `maintainer: null`,
`attestation: null`, `reviewedAt: null`, and `pending` decisions. A reviewer
fills their public identity, optional affiliation, conflict list, three required
attestations, and timestamp, then marks reviewed cases as:

- `approve`: keep the scenario and bind the approval to its current hash;
- `reject`: remove it from the materialized dataset; a note is required;
- `revise`: supply a complete replacement body and a note.

A distinct human maintainer-verifier then records their public identity and
affiliation, verifies the reviewer identity, reviews the disclosed conflicts,
records a disposition, and timestamps that verification. Verification cannot
predate the review. Reviewer and maintainer-verifier evidence becomes immutable
together when the overlay is applied and its SHA-256 enters the dataset.

A reviser becomes the replacement scenario's author. The revised case stays
`draft` and must be approved by a different human in a later overlay. Pending
decisions are ignored during an application, so review can proceed in batches.

Validate and apply a completed batch to a new version:

```bash
npm run bench:memory:review-check -- \
  --overlay=artifacts/memory-bench/review-round-1/memory-bench-core-draft-0.1.0-overlay.json

npm run bench:memory:review-apply -- \
  --overlay=artifacts/memory-bench/review-round-1/memory-bench-core-draft-0.1.0-overlay.json \
  --output=artifacts/memory-bench/core-review-1.json \
  --version=0.1.0-review.1
```

Input artifacts are never overwritten, and the output version must differ from
the source version. Generate the next packet from the materialized output for a
later batch. Use `--finalize` only for the last application; it fails unless
every retained scenario is independently reviewed and all publication gates
pass. Supply older overlay files with repeated `--evidence-overlay` arguments
when finalizing a multi-round review.

Verify a reviewed dataset against the exact immutable overlay bytes:

```bash
npm run bench:memory:review-verify -- \
  --dataset=artifacts/memory-bench/public-core-v1.json \
  --overlay=artifacts/memory-bench/review-round-1/memory-bench-core-draft-0.1.0-overlay.json \
  --evidence-overlay=artifacts/memory-bench/review-round-2/memory-bench-core-draft-0.1.0-review.1-overlay.json
```

Reformatting or changing an overlay after application changes its SHA-256 and
invalidates the evidence. The format records a declared human identity; it
cannot cryptographically prove that the named reviewer is a real person.
Maintainers perform the real-world identity check outside the software, then
record that attestation and conflict disposition inside the hash-bound overlay.

The non-blocking corpus check reports query count, ability coverage, and review
issues:

```bash
npm run bench:memory:corpus-check -- \
  --dataset=benchmarks/memory/datasets/core-smoke-v1.json
```

The release form exits non-zero unless the dataset is marked `reviewed`, has at
least 100 queries, uses an approved open identifier (`CC-BY-4.0`, `CC0-1.0`,
`MIT`, or `Apache-2.0`), has at least 10 queries for every core ability,
contains no exact duplicate query/content labels within one scope, and every
scenario passed the independent-review rule. Cross-scope duplicates remain
reported because they may be deliberate isolation cases. Adapted scenarios
must also name their source URI. Release mode requires an explicit dataset path
so the smoke corpus cannot be checked by accident:

```bash
npm run bench:memory:release-check -- \
  --dataset=/path/to/public-core-v1.json \
  --review-overlay=/path/to/review-round-1.json \
  --review-overlay=/path/to/review-round-2.json
```

This boundary is deliberate: AI can generate and validate candidate cases, but
it cannot self-certify that its own labels were independently reviewed, and a
reviewer cannot self-verify their identity or conflict disclosure.

## Current status

This is a contract-tested benchmark incubator, not a published comparison. The
small harness dataset verifies runner, lifecycle, scoring, and isolation
behavior. The 120-query corpus is an AI-authored draft awaiting independent
review. Mem0, Letta, and Zep are each covered by a local HTTP contract server,
including their provider-specific lifecycle, authentication, settling, retry,
timeout, failure cleanup, and response shapes. They have not yet been qualified
against the live paid services. Do not use contract-server numbers in product
claims.

Before a public leaderboard:

1. independently review, revise, and approve the 120-query draft corpus;
2. live-qualify and version-pin the Mem0, Letta, and Zep core and agent
   adapters through component-qualification overlays;
3. add cost and ingestion-settling measurements;
4. live-cross-validate the candidate reader/judge, run the official
   500-scenario oracle under equal provider configuration, then add a
   LongMemEval-V2 importer without vendoring upstream data;
5. assemble and independently audit a final agent-publication evidence
   manifest with its paired statistical artifact, then publish the raw
   normalized traces and immutable bundle.

See [the architecture
decision](../../docs/architecture/memory-bench.md) for track boundaries and
comparison rules. Third-party dataset status is tracked in
[THIRD_PARTY_DATA.md](THIRD_PARTY_DATA.md).
