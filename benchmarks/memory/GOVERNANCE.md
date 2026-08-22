# Governance and review policy

Memory Bench is an evidence-first benchmark. Maintainers may change this policy
through a reviewed pull request, but they may not waive an existing release
gate silently for one dataset, provider, or result.

## Roles

- **Maintainer:** accepts changes, verifies reviewer identity, controls releases,
  and records corrections. Fatih Serbest is the initial maintainer.
- **Scenario author:** creates or adapts a benchmark case and owns its label
  provenance.
- **Reviewer:** checks every operation and ground-truth label in a scenario.
- **Adapter maintainer:** implements and documents one provider integration.
- **Result submitter:** runs a released dataset and publishes the complete
  evidence bundle.
- **Qualification reviewer:** independently inspects one exact component
  configuration and its hash-bound live evidence.
- **Maintainer verifier:** verifies reviewer identity and conflict disposition,
  then attests that a corpus-review or component-qualification record is
  complete.

One person can hold several roles across the project, but a release-qualifying
component overlay requires distinct submitter, human reviewer, and human
maintainer-verifier identifiers. Every role and conflict must remain visible
in the artifacts.

## Reviewer identity and independence

A release-qualifying reviewer must:

1. be a human using a stable public identifier, such as a GitHub handle or
   ORCID;
2. be verified by a distinct human maintainer in the same hash-bound overlay
   before it is applied;
3. disclose an affiliation when relevant and list every known conflict;
4. affirm the overlay attestations for independence, publication rights, and
   absence of private or secret material; and
5. inspect the complete scenario rather than only its final query.

The tooling prevents an exact author identifier from approving the same
scenario and prevents a reviewer from acting as their own maintainer-verifier.
Unicode normalization and case folding are applied to those checks. The
maintainer verification timestamp cannot predate the review. These are
artifact-level controls, not proof of real-world identity.

A person who revises a scenario becomes the author of the replacement labels.
The revised case returns to `draft` and requires approval from another human.
Review overlays are immutable after application: reformatting or editing one
changes its SHA-256 and invalidates the evidence chain. Reviewer decisions,
attestations, and maintainer verification are therefore finalized together.

## Conflict disclosure

Disclose at least:

- employment, contracting, investment, or advisory relationships with a memory
  provider being evaluated;
- authorship or paid work on the dataset, adapter, scoring code, or compared
  system;
- sponsorship tied to a desired ranking or publication date; and
- any close personal relationship that a reasonable reader could see as
  affecting the review.

A disclosed conflict does not automatically invalidate corpus-label review.
Maintainers must record the disposition. An official provider result, however,
requires at least one replay or audit by a person unaffiliated with the
provider and not involved in the submitted adapter configuration.

## Result classes

- **Contract result:** uses a local fake/contract server. It proves adapter
  behavior only and is never a provider-quality claim.
- **Self-submitted result:** produced by a provider or affiliated submitter and
  labelled as such.
- **Reproduced result:** replayed from the same released dataset/configuration
  by an independent maintainer or reviewer.
- **Official result:** a reproduced live result whose complete evidence bundle
  passes the release checklist.

No result may be promoted by copying aggregate numbers alone. Query traces,
configuration, environment, cost availability, cleanup status, dataset hash,
report hash, comparison manifest, and paired statistical artifact must remain
available.

Candidate reports are immutable. Qualification does not edit their embedded
component classification. A hash-bound component qualification records
independent evidence for an exact adapter, reader, or judge configuration. A
separate post-run publication manifest resolves all required qualifications
and evaluator-parity artifacts plus the exact paired statistical comparison,
re-verifies their source hashes, and is the only artifact allowed to promote a
complete result bundle to `benchmark`.

Statistical intervals are descriptive corpus-sampling uncertainty for the
published reports. With no multiplicity adjustment or repeated-run protocol,
they must not be reframed as universal provider rankings or significance
claims.

Schema validity alone is not qualification. Maintainers must verify live
provenance and public evidence outside the JSON files; fake endpoints,
self-authored official-evaluator output, or fabricated identities are grounds
for rejection or withdrawal.

## Corrections and removals

Maintainers will not rewrite a published artifact in place. A discovered label,
license, adapter, or scoring error produces:

1. a public correction note describing scope and impact;
2. a new immutable dataset/report version;
3. an updated checksum manifest; and
4. a clear withdrawn or superseded marker on affected results.

Security credentials, personal data, or material without redistribution rights
may be removed immediately. The public correction should describe the removal
without repeating sensitive content.

## Appeals

A contributor may challenge a rejection, conflict disposition, or withdrawn
result in a public issue containing reproducible evidence. Maintainers must
state the rule and evidence behind the final decision. Private or secret
material must not be pasted into an issue.
