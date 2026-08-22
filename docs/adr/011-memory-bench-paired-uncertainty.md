# ADR-011: Publish paired scenario-cluster uncertainty

**Status:** Accepted  
**Date:** 2026-07-27  
**Deciders:** Mnema and Memory Bench maintainers

## Context

Memory Bench core and agent reports preserve per-query or per-scenario traces,
but comparison manifests previously exposed only aggregate point estimates. A
score difference such as three percentage points therefore carried no estimate
of sampling uncertainty. Reporting independent intervals per adapter would
also discard the strongest property of the benchmark design: every adapter is
evaluated on the same immutable scenarios.

Queries within one scenario can share setup, memories, and failure causes, so
treating every query as an independent resampling unit can create
pseudo-replication. Agent/provider runs can add a second source of variability,
but repeated live trials are expensive and are not yet present in the evidence
model.

## Decision

Add an immutable statistical-comparison artifact generated after either a core
or agent comparison. It:

- re-reads schema-valid reports and verifies their manifest SHA-256 values;
- recomputes every supported quality aggregate from the raw traces;
- requires exact paired observation identities and metric missingness;
- resamples eligible scenarios as clusters with replacement;
- reports percentile confidence intervals for adapter B minus adapter A;
- derives a stable per-pair/per-metric PRNG stream from a recorded unsigned
  32-bit seed;
- records confidence level, iteration count, algorithm, and report hashes; and
- omits raw queries, answers, hypotheses, and retrieved evidence.

The default method is 10,000 iterations at a 95% confidence level. A metric with
one eligible scenario is marked `insufficient-data`; a metric with no eligible
observations is `not-applicable`. Final agent publication requires a
hash-bound statistical artifact with no insufficient-data blocker.

Intervals are descriptive. The artifact explicitly claims neither rankings nor
statistical significance and applies no multiplicity correction.

## Options Considered

### Option A: Independent per-adapter binomial intervals

| Dimension | Assessment |
|---|---|
| Implementation cost | Low |
| Uses paired design | No |
| Handles non-binary metrics | Poorly |
| Scenario clustering | No |

**Pros:** Familiar and inexpensive.

**Cons:** Throws away pairing, cannot consistently cover recall/MRR, and treats
correlated scenario queries as independent.

### Option B: Paired scenario-cluster percentile bootstrap

| Dimension | Assessment |
|---|---|
| Implementation cost | Medium |
| Uses paired design | Yes |
| Handles declared quality metrics | Yes |
| Offline reproducibility | High |

**Pros:** Works directly from existing immutable traces, preserves paired
evaluation, handles binary and continuous bounded metrics uniformly, and needs
no new dependency.

**Cons:** Percentile intervals have known small-sample limitations and do not
measure model/provider variation across repeated executions.

### Option C: Repeated trials with a hierarchical model

| Dimension | Assessment |
|---|---|
| Statistical scope | Highest |
| Provider cost | High |
| Evidence-model complexity | High |
| Available repeated-run data | None |

**Pros:** Can separate scenario sampling from stochastic run/provider variance.

**Cons:** Requires a repeated-run protocol, substantially more paid calls, and
a new model whose assumptions cannot yet be validated from current evidence.

## Trade-off Analysis

Option B closes the immediate point-estimate gap using data Memory Bench already
retains. Scenario clustering is more conservative than query-level resampling
when a scenario contains multiple correlated queries. Stable derived PRNG
streams mean adding a new adapter or metric does not silently change existing
pairwise intervals.

The method must not be presented as proof that one provider is universally
better. It measures corpus-sampling uncertainty conditional on the exact
reports, dataset, reader, judge, and configurations. Repeated-run variability
remains a separate future layer.

## Consequences

- Report or comparison tampering invalidates statistical verification.
- Different query/scenario identities or nullability patterns fail closed
  instead of being compared on an accidental intersection.
- All pairwise quality differences are reproducible from public artifacts.
- Final agent publication binds the statistical artifact and its method
  parameters by SHA-256.
- Sparse metrics cannot silently receive degenerate confidence intervals.
- Multiple pairwise intervals remain unadjusted and descriptive.
- Latency is intentionally excluded because sequential provider execution does
  not establish a controlled paired latency experiment.

## Action Items

1. [x] Implement core and agent trace normalization and aggregate verification.
2. [x] Add deterministic paired scenario-cluster bootstrap analysis.
3. [x] Add a strict portable schema plus `create` and `check` CLI commands.
4. [x] Bind the exact statistical artifact into final agent publication.
5. [ ] Define and fund a repeated-live-run protocol before claiming stochastic
   provider variance or significance.
