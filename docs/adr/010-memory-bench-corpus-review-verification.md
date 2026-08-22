# ADR-010: Bind corpus reviewer verification into the review overlay

**Status:** Accepted  
**Date:** 2026-07-27  
**Deciders:** Mnema and Memory Bench maintainers

## Context

Memory Bench requires every released corpus scenario to have an independent
human review. Governance also requires a maintainer to verify the reviewer's
public identity and disposition disclosed conflicts. The first review-overlay
contract represented reviewer decisions and attestations but had no field for
that maintainer verification. Consequently, the release checklist named a gate
that no portable artifact or command could prove.

Generated datasets must remain immutable, and applied overlays already become
content-addressed evidence referenced by each reviewed scenario. Reviewer
verification must join that evidence chain without introducing an online
registry or making a mutable database the benchmark authority.

## Decision

Add a nullable `maintainer` block to the version-1 review overlay template. A
release-applicable overlay requires:

- a human maintainer-verifier distinct from the reviewer;
- public verifier identity and affiliation;
- affirmative reviewer-identity and conflict-review checks;
- a non-empty conflict disposition; and
- a verification timestamp at or after the review timestamp.

The overlay remains editable while pending. Once applied, its raw-byte SHA-256
binds reviewer decisions, reviewer attestations, and maintainer verification
together. Dataset review entries continue to reference that one immutable
overlay hash.

This mechanism records an attestation; it does not claim that JSON can prove a
person's real-world identity.

## Options Considered

### Option A: Keep maintainer verification outside the artifact

| Dimension | Assessment |
|---|---|
| Implementation cost | Low |
| Offline auditability | Poor |
| Policy enforcement | Poor |
| Portability | Poor |

**Pros:** No schema or workflow change.

**Cons:** The release checklist remains unverifiable, evidence can be lost, and
third-party consumers must trust undocumented maintainer state.

### Option B: Create a separate verifier overlay

| Dimension | Assessment |
|---|---|
| Implementation cost | High |
| Offline auditability | High |
| Evidence-chain complexity | High |
| Revocation flexibility | High |

**Pros:** Reviewer and verifier artifacts have independent lifecycles and
checksums.

**Cons:** Every review requires another artifact type and join, finalization
must resolve two evidence graphs, and the extra lifecycle has no current
revocation or signature requirement to justify it.

### Option C: Bind verification into the pending review overlay

| Dimension | Assessment |
|---|---|
| Implementation cost | Low |
| Offline auditability | High |
| Evidence-chain complexity | Low |
| Role separation | High |

**Pros:** Reuses the existing immutable overlay hash, keeps release verification
offline, and makes the documented gate executable.

**Cons:** Reviewer and maintainer must coordinate before application, and their
attestations cannot be versioned independently after the overlay is applied.

## Trade-off Analysis

Memory Bench has no published corpus artifacts yet, so strengthening the
version-1 contract does not invalidate a public evidence chain. The same-overlay
design is the smallest complete solution: it closes the policy gap without a
registry, database, signature system, or second overlay lifecycle. If future
governance requires cryptographic signatures or independent revocation, a
separate signed-verification artifact can supersede this decision in schema
version 2.

## Consequences

- Reviewer-only overlays can be drafted but cannot be applied.
- Review application and release verification fail closed when maintainer
  evidence is missing, self-verified, incomplete, or temporally impossible.
- Existing local pending overlays must be regenerated or gain the new
  `maintainer` field before use.
- Applied overlay hashes cover both review and verifier evidence.
- Human identity remains a governance attestation rather than a cryptographic
  fact.

## Action Items

1. [x] Extend review overlay types, parser, template, and generated schema.
2. [x] Enforce role separation, affirmative checks, and timestamp ordering.
3. [x] Add runtime, CLI, schema, and release-gate regression coverage.
4. [ ] Recruit independent reviewers and maintainer-verifiers for the
   120-scenario draft corpus.
