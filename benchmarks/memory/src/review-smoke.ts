import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { assessPublicationReadiness, loadDataset } from "./dataset.js";
import {
  applyReviewOverlay,
  assessReviewOverlay,
  createReviewOverlayTemplate,
  createReviewPacket,
  parseReviewOverlay,
  renderReviewArtifact,
  reviewArtifactSha256,
  scenarioReviewSubjectSha256,
  verifyDatasetReviewEvidence,
} from "./review.js";
import type { ReviewOverlay } from "./review.js";

const draftFile = fileURLToPath(
  new URL("../datasets/core-draft-v0.1.json", import.meta.url)
);
const draftBytes = await import("node:fs").then((fs) => fs.readFileSync(draftFile));
const draftDataset = loadDataset(draftFile);
const draftSha256 = reviewArtifactSha256(draftBytes);
const acceptedAttestation = {
  independentFromScenarioAuthors: true,
  rightsToPublish: true,
  noPrivateOrSecretData: true,
} as const;

function withMaintainerVerification(
  overlay: ReviewOverlay,
  id: string,
  verifiedAt: string
): ReviewOverlay {
  return {
    ...overlay,
    maintainer: {
      id,
      type: "human",
      affiliation: "memory-bench-maintainers",
      verifiedAt,
      reviewerIdentityVerified: true,
      conflictsReviewed: true,
      disposition: "No disqualifying reviewer conflict was identified.",
    },
  } as ReviewOverlay;
}

const packet = createReviewPacket(draftDataset, draftSha256);
const secondPacket = createReviewPacket(draftDataset, draftSha256);
assert.equal(packet.scenarios.length, 120);
assert.equal(
  renderReviewArtifact(packet),
  renderReviewArtifact(secondPacket),
  "review packets must be deterministic for one dataset artifact"
);
assert.equal(packet.dataset.sha256, draftSha256);
assert.equal(
  packet.scenarios[0]!.scenarioSha256,
  scenarioReviewSubjectSha256(draftDataset.scenarios[0]!)
);

const template = createReviewOverlayTemplate(packet);
assert.equal(template.decisions.length, 120);
assert(template.decisions.every((decision) => decision.decision === "pending"));
const templateAssessment = assessReviewOverlay(
  draftDataset,
  draftSha256,
  template
);
assert.equal(templateAssessment.readyToApply, false);
assert.equal(templateAssessment.counts.pending, 120);
assert(
  templateAssessment.issues.some((issue) => issue.includes("reviewer is required"))
);
assert(
  templateAssessment.issues.some((issue) => issue.includes("reviewedAt is required"))
);

const firstScenario = draftDataset.scenarios[0]!;
const reviewedAt = "2026-07-27T10:00:00.000Z";
const oneApproval: ReviewOverlay = {
  ...template,
  reviewer: {
    id: "reviewer-alice",
    type: "human",
    conflicts: [],
  },
  attestation: acceptedAttestation,
  reviewedAt,
  decisions: [
    {
      scenarioId: firstScenario.id,
      scenarioSha256: scenarioReviewSubjectSha256(firstScenario),
      decision: "approve",
      note: "Ground truth and isolation labels checked against every operation.",
    },
  ],
};
const reviewerOnlyAssessment = assessReviewOverlay(
  draftDataset,
  draftSha256,
  oneApproval
);
assert.equal(
  reviewerOnlyAssessment.readyToApply,
  false,
  "a reviewer cannot apply an overlay without maintainer verification"
);
assert(
  reviewerOnlyAssessment.issues.some((issue) =>
    issue.includes("maintainer verifier")
  ),
  "missing maintainer verification must be explicit"
);
const verifiedApproval = withMaintainerVerification(
  oneApproval,
  "maintainer-morgan",
  "2026-07-27T10:01:00.000Z"
);
const sameIdentityVerification = withMaintainerVerification(
  oneApproval,
  "REVIEWER-ALICE",
  "2026-07-27T10:01:00.000Z"
);
assert(
  assessReviewOverlay(
    draftDataset,
    draftSha256,
    sameIdentityVerification
  ).issues.some((issue) => issue.includes("differ from the reviewer")),
  "maintainer verifier must not self-verify the review"
);
const prematureVerification = withMaintainerVerification(
  oneApproval,
  "maintainer-morgan",
  "2026-07-27T09:59:00.000Z"
);
assert(
  assessReviewOverlay(
    draftDataset,
    draftSha256,
    prematureVerification
  ).issues.some((issue) => issue.includes("before reviewedAt")),
  "maintainer verification must not predate the review"
);
const unverifiedIdentity = withMaintainerVerification(
  oneApproval,
  "maintainer-morgan",
  "2026-07-27T10:01:00.000Z"
);
unverifiedIdentity.maintainer!.reviewerIdentityVerified = false;
assert(
  assessReviewOverlay(
    draftDataset,
    draftSha256,
    unverifiedIdentity
  ).issues.some((issue) => issue.includes("verify reviewer identity")),
  "maintainer must affirm reviewer identity verification"
);
const unreviewedConflicts = withMaintainerVerification(
  oneApproval,
  "maintainer-morgan",
  "2026-07-27T10:01:00.000Z"
);
unreviewedConflicts.maintainer!.conflictsReviewed = false;
assert(
  assessReviewOverlay(
    draftDataset,
    draftSha256,
    unreviewedConflicts
  ).issues.some((issue) => issue.includes("reviewer conflicts")),
  "maintainer must affirm reviewer conflict review"
);
const parsedApproval = parseReviewOverlay(
  JSON.parse(renderReviewArtifact(verifiedApproval)) as unknown
);
const approvalSha256 = reviewArtifactSha256(renderReviewArtifact(parsedApproval));
const approvedDataset = applyReviewOverlay(
  draftDataset,
  draftSha256,
  parsedApproval,
  approvalSha256,
  "0.1.0-review.1"
);
assert.equal(draftDataset.scenarios[0]!.review.status, "draft", "source dataset must stay immutable");
assert.equal(approvedDataset.publicationStatus, "draft");
assert.equal(approvedDataset.version, "0.1.0-review.1");
assert.equal(approvedDataset.scenarios[0]!.review.status, "reviewed");
assert.deepEqual(approvedDataset.scenarios[0]!.review.entries, [
  {
    reviewer: {
      id: "reviewer-alice",
      type: "human",
    },
    reviewedAt,
    evidence: {
      kind: "review-overlay",
      sha256: approvalSha256,
    },
  },
]);
assert.deepEqual(
  verifyDatasetReviewEvidence(approvedDataset, [
    { sha256: approvalSha256, overlay: parsedApproval },
  ]),
  []
);

const tamperedDataset = structuredClone(approvedDataset);
tamperedDataset.scenarios[0]!.description = "Changed after approval";
assert(
  verifyDatasetReviewEvidence(tamperedDataset, [
    { sha256: approvalSha256, overlay: parsedApproval },
  ]).some((issue) => issue.includes("scenario hash")),
  "review evidence must fail after approved content is changed"
);

assert.throws(
  () =>
    applyReviewOverlay(
      draftDataset,
      "0".repeat(64),
      parsedApproval,
      approvalSha256,
      "0.1.0-invalid"
    ),
  /dataset SHA-256/,
  "an overlay must be bound to the exact source artifact"
);

const selfReview = structuredClone(oneApproval);
selfReview.reviewer = {
  id: firstScenario.provenance.author.toLocaleUpperCase("en-US"),
  type: "human",
  conflicts: [],
};
assert(
  assessReviewOverlay(draftDataset, draftSha256, selfReview).issues.some((issue) =>
    issue.includes("independent")
  ),
  "reviewer independence checks must be case-insensitive"
);

const aiReview = structuredClone(oneApproval);
aiReview.reviewer = {
  id: "reviewer-bot",
  type: "ai",
  conflicts: [],
};
assert(
  assessReviewOverlay(draftDataset, draftSha256, aiReview).issues.some((issue) =>
    issue.includes("human reviewer")
  ),
  "AI review must not satisfy the independent-human gate"
);

const unacceptedAttestation = structuredClone(oneApproval);
unacceptedAttestation.attestation = {
  ...acceptedAttestation,
  rightsToPublish: false,
};
assert(
  assessReviewOverlay(
    draftDataset,
    draftSha256,
    unacceptedAttestation
  ).issues.some((issue) => issue.includes("rightsToPublish")),
  "review evidence must not apply without an affirmative publication-rights attestation"
);

const revisedOperations = structuredClone(firstScenario.operations);
const revisedQuery = revisedOperations.find((operation) => operation.op === "query");
assert(revisedQuery?.op === "query");
revisedQuery.query = `${revisedQuery.query} Return only the stored value.`;
const revisionOverlay = withMaintainerVerification({
  ...template,
  reviewer: {
    id: "reviewer-bob",
    type: "human",
    conflicts: [],
  },
  attestation: acceptedAttestation,
  reviewedAt: "2026-07-27T10:05:00.000Z",
  decisions: [
    {
      scenarioId: firstScenario.id,
      scenarioSha256: scenarioReviewSubjectSha256(firstScenario),
      decision: "revise",
      note: "The original question allowed an underspecified response.",
      replacement: {
        description: "Recall one fact with an explicit response constraint.",
        language: firstScenario.language,
        difficulty: firstScenario.difficulty,
        operations: revisedOperations,
      },
    },
  ],
}, "maintainer-riley", "2026-07-27T10:06:00.000Z");
const revisionSha256 = reviewArtifactSha256(renderReviewArtifact(revisionOverlay));
const revisedDataset = applyReviewOverlay(
  draftDataset,
  draftSha256,
  revisionOverlay,
  revisionSha256,
  "0.1.0-review.2"
);
const revisedScenario = revisedDataset.scenarios[0]!;
assert.equal(revisedScenario.review.status, "draft");
assert.deepEqual(revisedScenario.review.entries, []);
assert.equal(revisedScenario.provenance.author, "reviewer-bob");
assert.equal(revisedScenario.provenance.authorType, "human");
assert.equal(revisedScenario.provenance.origin, "contributed");
assert.equal(
  revisedScenario.provenance.revisionEvidenceSha256,
  revisionSha256
);
assert.deepEqual(
  verifyDatasetReviewEvidence(revisedDataset, [
    {
      sha256: revisionSha256,
      overlay: revisionOverlay,
    },
  ]),
  []
);

const revisedPacket = createReviewPacket(
  revisedDataset,
  reviewArtifactSha256(renderReviewArtifact(revisedDataset))
);
const secondReviewerOverlay = withMaintainerVerification({
  ...createReviewOverlayTemplate(revisedPacket),
  reviewer: {
    id: "reviewer-carol",
    type: "human",
    conflicts: [],
  },
  attestation: acceptedAttestation,
  reviewedAt: "2026-07-27T10:10:00.000Z",
  decisions: [
    {
      scenarioId: revisedScenario.id,
      scenarioSha256: scenarioReviewSubjectSha256(revisedScenario),
      decision: "approve",
      note: "Revised query and labels checked independently.",
    },
  ],
}, "maintainer-sam", "2026-07-27T10:11:00.000Z");
assert.equal(
  assessReviewOverlay(
    revisedDataset,
    revisedPacket.dataset.sha256,
    secondReviewerOverlay
  ).readyToApply,
  true,
  "a second human reviewer must be able to approve a human revision"
);
const secondApprovalSha256 = reviewArtifactSha256(
  renderReviewArtifact(secondReviewerOverlay)
);
const secondApprovedDataset = applyReviewOverlay(
  revisedDataset,
  revisedPacket.dataset.sha256,
  secondReviewerOverlay,
  secondApprovalSha256,
  "0.1.0-review.2-approved"
);
assert.deepEqual(
  verifyDatasetReviewEvidence(secondApprovedDataset, [
    {
      sha256: revisionSha256,
      overlay: revisionOverlay,
    },
    {
      sha256: secondApprovalSha256,
      overlay: secondReviewerOverlay,
    },
  ]),
  []
);
assert(
  verifyDatasetReviewEvidence(secondApprovedDataset, [
    {
      sha256: secondApprovalSha256,
      overlay: secondReviewerOverlay,
    },
  ]).some((issue) => issue.includes("required by 1 scenarios")),
  "the revision overlay must remain part of the final evidence chain"
);

const rejectionOverlay = withMaintainerVerification({
  ...template,
  reviewer: {
    id: "reviewer-dana",
    type: "human",
    conflicts: [],
  },
  attestation: acceptedAttestation,
  reviewedAt: "2026-07-27T10:15:00.000Z",
  decisions: [
    {
      scenarioId: firstScenario.id,
      scenarioSha256: scenarioReviewSubjectSha256(firstScenario),
      decision: "reject",
      note: "The case depends on an ambiguous distractor.",
    },
  ],
}, "maintainer-taylor", "2026-07-27T10:16:00.000Z");
const rejectedDataset = applyReviewOverlay(
  draftDataset,
  draftSha256,
  rejectionOverlay,
  reviewArtifactSha256(renderReviewArtifact(rejectionOverlay)),
  "0.1.0-review.3"
);
assert.equal(rejectedDataset.scenarios.length, 119);
assert(!rejectedDataset.scenarios.some((scenario) => scenario.id === firstScenario.id));

const completeApproval = withMaintainerVerification({
  ...template,
  reviewer: {
    id: "reviewer-erin",
    type: "human",
    conflicts: [],
  },
  attestation: acceptedAttestation,
  reviewedAt: "2026-07-27T10:20:00.000Z",
  decisions: template.decisions.map((decision) => ({
    ...decision,
    decision: "approve" as const,
    note: "Ground truth, scope, and lifecycle behavior checked.",
  })),
}, "maintainer-uma", "2026-07-27T10:21:00.000Z");
const completeApprovalSha256 = reviewArtifactSha256(
  renderReviewArtifact(completeApproval)
);
const finalizedDataset = applyReviewOverlay(
  draftDataset,
  draftSha256,
  completeApproval,
  completeApprovalSha256,
  "1.0.0",
  {
    finalize: true,
    evidence: [
      {
        sha256: completeApprovalSha256,
        overlay: completeApproval,
      },
    ],
  }
);
assert.equal(finalizedDataset.publicationStatus, "reviewed");
assert.equal(assessPublicationReadiness(finalizedDataset).ready, true);
assert.deepEqual(
  verifyDatasetReviewEvidence(finalizedDataset, [
    {
      sha256: completeApprovalSha256,
      overlay: completeApproval,
    },
  ]),
  []
);

console.log(
  JSON.stringify(
    {
      ok: true,
      packetScenarios: packet.scenarios.length,
      partialApproval: approvedDataset.scenarios[0]!.review.status,
      rejectedScenarios: rejectedDataset.scenarios.length,
      finalized: finalizedDataset.publicationStatus,
      reviewerIdentityVerified: true,
    },
    null,
    2
  )
);
