# ADR-009: Qualify immutable Memory Bench evidence with overlays

**Status:** Accepted  
**Date:** 2026-07-27  
**Deciders:** Mnema and Memory Bench maintainers

## Context

Memory Bench agent reports record the component configuration and result class
observed at execution time. The implemented Mnema, Mem0, Letta, Zep, OpenAI
reader, and LongMemEval judge integrations are candidate-class until live
provider behavior and evaluator parity are independently reviewed.

A benchmark release must connect later human review and live provenance to the
exact reports that were run. It must also reject self-review, fake services,
configuration drift, dirty source state, missing parity, and incomplete
disclosures. At the same time, changing an old report from `candidate` to
`benchmark` would destroy the audit trail and make its original checksum
meaningless.

## Decision

Keep normalized reports and comparison manifests immutable. Add two separate,
versioned evidence contracts:

1. A component-qualification overlay canonicalizes and hashes one complete
   adapter, reader, or judge configuration. It binds role-specific source
   artifacts by SHA-256 and records distinct submitter, independent human
   reviewer, and human maintainer-verifier attestations.
2. A post-run agent-publication manifest re-reads the comparison and every
   referenced report, qualification, and evaluator-parity artifact. It resolves
   all candidate component hashes, verifies one exact parity artifact per
   report, requires a clean source commit and complete release attestations, and
   creates the only benchmark-class publication claim.

Both paths fail closed. Contract/fake/local network endpoints cannot qualify.
Schema-valid JSON is necessary but not sufficient; maintainers still verify
identity, provenance, conflicts, and public evidence outside the artifact.

## Options Considered

### Option A: Rewrite candidate reports after review

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Auditability | Poor |
| Tamper resistance | Poor |
| Portability | Medium |

**Pros:** Fewer artifact types and a simpler consumer view.

**Cons:** Changes report hashes, blurs execution-time facts with later review,
breaks immutable evidence bundles, and makes correction history difficult to
audit.

### Option B: Store qualification only in a registry

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Auditability | Medium |
| Offline verification | Poor |
| Portability | Poor |

**Pros:** Central policy changes and revocations are easy to apply.

**Cons:** Published results depend on a mutable online authority, cannot be
verified from a downloaded bundle, and are harder for other projects to adopt.

### Option C: Hash-bound overlays plus a publication manifest

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Auditability | High |
| Tamper resistance | High |
| Portability | High |

**Pros:** Preserves immutable measurements, supports offline verification,
separates mechanical checks from human attestations, and makes every promotion
and correction explicit.

**Cons:** Produces more files, requires evidence-bundle discipline, and still
cannot cryptographically prove a reviewer's real-world identity or that a live
run occurred.

## Trade-off Analysis

The additional artifact complexity is acceptable because the benchmark's main
product is trustworthy evidence, not only a score table. Content hashes close
the configuration and file-drift gaps. Separate roles and attestations expose
governance claims without pretending that JSON can prove human identity. The
publication manifest gives consumers one final verification entry point while
leaving the underlying evidence independently inspectable.

## Consequences

- Candidate reports and comparison manifests remain byte-stable.
- A component can be reviewed once per exact configuration hash and reused by
  multiple reports with the same configuration.
- Every report still needs its own hash-bound evaluator-parity artifact.
- Live qualification and human review remain external gates; contract smoke
  tests can validate the workflow but cannot create an official result.
- Corrections create new overlays or publication versions instead of replacing
  existing artifacts.
- Evidence bundles must keep qualification source files beside their overlays
  so offline re-verification can resolve safe sibling filenames.

## Action Items

1. [x] Add versioned component-qualification and agent-publication schemas.
2. [x] Add fail-closed template, check, and finalize CLIs.
3. [x] Cover self-review, local endpoints, tampering, missing parity, dirty
   source, and incomplete release attestations in smoke tests.
4. [ ] Independently review and release the public core corpus.
5. [ ] Execute and review live provider qualifications.
6. [ ] Publish official-evaluator parity and the first immutable result bundle.
