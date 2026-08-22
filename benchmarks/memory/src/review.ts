import { createHash } from "node:crypto";
import fs from "node:fs";
import type {
  BenchmarkDataset,
  BenchmarkOperation,
  BenchmarkScenario,
  DatasetPublicationStatus,
  ScenarioDifficulty,
  ScenarioReviewerType,
} from "./types.js";
import { assessPublicationReadiness, parseDataset } from "./dataset.js";

const sha256Pattern = /^[a-f0-9]{64}$/;
const reviewerTypes = new Set<ScenarioReviewerType>(["human", "ai"]);
const difficulties = new Set<ScenarioDifficulty>([
  "basic",
  "intermediate",
  "advanced",
]);

export interface ReviewPacket {
  schemaVersion: 1;
  kind: "memory-bench-review-packet";
  dataset: {
    name: string;
    version: string;
    license: string;
    publicationStatus: DatasetPublicationStatus;
    sha256: string;
    scenarioCount: number;
    queryCount: number;
  };
  instructions: string[];
  scenarios: Array<{
    scenarioId: string;
    scenarioSha256: string;
    scenario: BenchmarkScenario;
  }>;
}

export interface ScenarioRevision {
  description: string;
  language: string;
  difficulty: ScenarioDifficulty;
  operations: BenchmarkOperation[];
}

interface ReviewDecisionBase {
  scenarioId: string;
  scenarioSha256: string;
}

export type ReviewDecision =
  | (ReviewDecisionBase & {
      decision: "pending";
      note?: string;
    })
  | (ReviewDecisionBase & {
      decision: "approve";
      note?: string;
    })
  | (ReviewDecisionBase & {
      decision: "reject";
      note: string;
    })
  | (ReviewDecisionBase & {
      decision: "revise";
      note: string;
      replacement: ScenarioRevision;
    });

export interface ReviewOverlay {
  schemaVersion: 1;
  kind: "memory-bench-review-overlay";
  dataset: {
    name: string;
    version: string;
    sha256: string;
    packetSha256: string;
  };
  reviewer: {
    id: string;
    type: ScenarioReviewerType;
    affiliation?: string;
    conflicts: string[];
  } | null;
  maintainer: {
    id: string;
    type: "human";
    affiliation: string;
    verifiedAt: string;
    reviewerIdentityVerified: boolean;
    conflictsReviewed: boolean;
    disposition: string;
  } | null;
  attestation: {
    independentFromScenarioAuthors: boolean;
    rightsToPublish: boolean;
    noPrivateOrSecretData: boolean;
  } | null;
  reviewedAt: string | null;
  decisions: ReviewDecision[];
}

export interface ReviewOverlayAssessment {
  readyToApply: boolean;
  counts: Record<ReviewDecision["decision"], number>;
  issues: string[];
  warnings: string[];
}

export interface LoadedReviewOverlayEvidence {
  sha256: string;
  overlay: ReviewOverlay;
}

interface ApplyReviewOptions {
  finalize?: boolean;
  evidence?: LoadedReviewOverlayEvidence[];
}

function assertObject(
  value: unknown,
  path: string
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalNote(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, path);
}

function sha256Value(value: unknown, path: string): string {
  const digest = stringValue(value, path);
  if (!sha256Pattern.test(digest)) {
    throw new Error(`${path} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function queryCount(dataset: BenchmarkDataset): number {
  return dataset.scenarios.reduce(
    (total, scenario) =>
      total +
      scenario.operations.filter((operation) => operation.op === "query").length,
    0
  );
}

function reviewSubject(scenario: BenchmarkScenario): Omit<BenchmarkScenario, "review"> {
  return {
    id: scenario.id,
    description: scenario.description,
    language: scenario.language,
    difficulty: scenario.difficulty,
    provenance: scenario.provenance,
    operations: scenario.operations,
  };
}

export function renderReviewArtifact(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function reviewArtifactSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function scenarioReviewSubjectSha256(
  scenario: BenchmarkScenario
): string {
  return reviewArtifactSha256(JSON.stringify(reviewSubject(scenario)));
}

export function createReviewPacket(
  dataset: BenchmarkDataset,
  datasetSha256: string
): ReviewPacket {
  sha256Value(datasetSha256, "datasetSha256");
  return {
    schemaVersion: 1,
    kind: "memory-bench-review-packet",
    dataset: {
      name: dataset.name,
      version: dataset.version,
      license: dataset.license,
      publicationStatus: dataset.publicationStatus,
      sha256: datasetSha256,
      scenarioCount: dataset.scenarios.length,
      queryCount: queryCount(dataset),
    },
    instructions: [
      "Check every memory operation, query, relevant ID, forbidden ID, and content assertion.",
      "Use approve only when the current labels are correct and unambiguous.",
      "Use revise with a complete replacement scenario body; the reviser becomes its author, so another human must approve it.",
      "Use reject when the case cannot be made objective without changing what it measures.",
      "Do not edit the generated source dataset. Record decisions only in the review overlay.",
      "Declare relevant affiliations and conflicts, then affirm every attestation before applying the overlay.",
      "A distinct human maintainer must verify the reviewer identity, review disclosed conflicts, and record a disposition after the review.",
      "Use a public reviewer identifier and do not put email addresses, secrets, or private notes in an overlay intended for publication.",
    ],
    scenarios: dataset.scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      scenarioSha256: scenarioReviewSubjectSha256(scenario),
      scenario,
    })),
  };
}

export function createReviewOverlayTemplate(
  packet: ReviewPacket
): ReviewOverlay {
  return {
    schemaVersion: 1,
    kind: "memory-bench-review-overlay",
    dataset: {
      name: packet.dataset.name,
      version: packet.dataset.version,
      sha256: packet.dataset.sha256,
      packetSha256: reviewArtifactSha256(renderReviewArtifact(packet)),
    },
    reviewer: null,
    maintainer: null,
    attestation: null,
    reviewedAt: null,
    decisions: packet.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      scenarioSha256: scenario.scenarioSha256,
      decision: "pending",
    })),
  };
}

function parseRevision(value: unknown, path: string): ScenarioRevision {
  assertObject(value, path);
  const difficulty = stringValue(
    value.difficulty,
    `${path}.difficulty`
  ) as ScenarioDifficulty;
  if (!difficulties.has(difficulty)) {
    throw new Error(`${path}.difficulty is unsupported: ${difficulty}`);
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    throw new Error(`${path}.operations must be a non-empty array`);
  }
  return {
    description: stringValue(value.description, `${path}.description`),
    language: stringValue(value.language, `${path}.language`),
    difficulty,
    operations: structuredClone(value.operations) as BenchmarkOperation[],
  };
}

function parseDecision(value: unknown, path: string): ReviewDecision {
  assertObject(value, path);
  const base = {
    scenarioId: stringValue(value.scenarioId, `${path}.scenarioId`),
    scenarioSha256: sha256Value(
      value.scenarioSha256,
      `${path}.scenarioSha256`
    ),
  };
  const decision = stringValue(
    value.decision,
    `${path}.decision`
  ) as ReviewDecision["decision"];
  if (decision === "pending" || decision === "approve") {
    const note = optionalNote(value.note, `${path}.note`);
    return {
      ...base,
      decision,
      ...(note === undefined ? {} : { note }),
    };
  }
  if (decision === "reject") {
    return {
      ...base,
      decision,
      note: stringValue(value.note, `${path}.note`),
    };
  }
  if (decision === "revise") {
    return {
      ...base,
      decision,
      note: stringValue(value.note, `${path}.note`),
      replacement: parseRevision(value.replacement, `${path}.replacement`),
    };
  }
  throw new Error(`${path}.decision is unsupported: ${decision}`);
}

export function parseReviewOverlay(raw: unknown): ReviewOverlay {
  assertObject(raw, "reviewOverlay");
  if (raw.schemaVersion !== 1) {
    throw new Error("reviewOverlay.schemaVersion must be 1");
  }
  if (raw.kind !== "memory-bench-review-overlay") {
    throw new Error(
      "reviewOverlay.kind must be memory-bench-review-overlay"
    );
  }
  assertObject(raw.dataset, "reviewOverlay.dataset");
  let reviewer: ReviewOverlay["reviewer"] = null;
  if (raw.reviewer !== null) {
    assertObject(raw.reviewer, "reviewOverlay.reviewer");
    const type = stringValue(
      raw.reviewer.type,
      "reviewOverlay.reviewer.type"
    ) as ScenarioReviewerType;
    if (!reviewerTypes.has(type)) {
      throw new Error(`reviewOverlay.reviewer.type is unsupported: ${type}`);
    }
    const affiliation =
      raw.reviewer.affiliation === undefined
        ? undefined
        : stringValue(
            raw.reviewer.affiliation,
            "reviewOverlay.reviewer.affiliation"
          );
    if (
      !Array.isArray(raw.reviewer.conflicts) ||
      raw.reviewer.conflicts.some(
        (conflict) => typeof conflict !== "string" || conflict.trim() === ""
      )
    ) {
      throw new Error(
        "reviewOverlay.reviewer.conflicts must be an array of non-empty strings"
      );
    }
    const conflicts = [...raw.reviewer.conflicts] as string[];
    const normalizedConflicts = conflicts.map((conflict) =>
      conflict.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    );
    if (new Set(normalizedConflicts).size !== conflicts.length) {
      throw new Error(
        "reviewOverlay.reviewer.conflicts must not contain duplicates"
      );
    }
    reviewer = {
      id: stringValue(raw.reviewer.id, "reviewOverlay.reviewer.id"),
      type,
      ...(affiliation === undefined ? {} : { affiliation }),
      conflicts,
    };
  }
  let attestation: ReviewOverlay["attestation"] = null;
  if (raw.attestation !== null) {
    assertObject(raw.attestation, "reviewOverlay.attestation");
    for (const field of [
      "independentFromScenarioAuthors",
      "rightsToPublish",
      "noPrivateOrSecretData",
    ] as const) {
      if (typeof raw.attestation[field] !== "boolean") {
        throw new Error(`reviewOverlay.attestation.${field} must be a boolean`);
      }
    }
    attestation = {
      independentFromScenarioAuthors:
        raw.attestation.independentFromScenarioAuthors as boolean,
      rightsToPublish: raw.attestation.rightsToPublish as boolean,
      noPrivateOrSecretData: raw.attestation.noPrivateOrSecretData as boolean,
    };
  }
  let maintainer: ReviewOverlay["maintainer"] = null;
  if (raw.maintainer !== null) {
    assertObject(raw.maintainer, "reviewOverlay.maintainer");
    if (raw.maintainer.type !== "human") {
      throw new Error("reviewOverlay.maintainer.type must be human");
    }
    for (const field of [
      "reviewerIdentityVerified",
      "conflictsReviewed",
    ] as const) {
      if (typeof raw.maintainer[field] !== "boolean") {
        throw new Error(
          `reviewOverlay.maintainer.${field} must be a boolean`
        );
      }
    }
    const verifiedAt = stringValue(
      raw.maintainer.verifiedAt,
      "reviewOverlay.maintainer.verifiedAt"
    );
    if (Number.isNaN(Date.parse(verifiedAt))) {
      throw new Error(
        "reviewOverlay.maintainer.verifiedAt must be an ISO-8601 timestamp"
      );
    }
    maintainer = {
      id: stringValue(raw.maintainer.id, "reviewOverlay.maintainer.id"),
      type: "human",
      affiliation: stringValue(
        raw.maintainer.affiliation,
        "reviewOverlay.maintainer.affiliation"
      ),
      verifiedAt,
      reviewerIdentityVerified:
        raw.maintainer.reviewerIdentityVerified as boolean,
      conflictsReviewed: raw.maintainer.conflictsReviewed as boolean,
      disposition: stringValue(
        raw.maintainer.disposition,
        "reviewOverlay.maintainer.disposition"
      ),
    };
  }
  let reviewedAt: string | null = null;
  if (raw.reviewedAt !== null) {
    reviewedAt = stringValue(raw.reviewedAt, "reviewOverlay.reviewedAt");
    if (Number.isNaN(Date.parse(reviewedAt))) {
      throw new Error(
        "reviewOverlay.reviewedAt must be an ISO-8601 timestamp"
      );
    }
  }
  if (!Array.isArray(raw.decisions) || raw.decisions.length === 0) {
    throw new Error("reviewOverlay.decisions must be a non-empty array");
  }
  return {
    schemaVersion: 1,
    kind: "memory-bench-review-overlay",
    dataset: {
      name: stringValue(raw.dataset.name, "reviewOverlay.dataset.name"),
      version: stringValue(
        raw.dataset.version,
        "reviewOverlay.dataset.version"
      ),
      sha256: sha256Value(
        raw.dataset.sha256,
        "reviewOverlay.dataset.sha256"
      ),
      packetSha256: sha256Value(
        raw.dataset.packetSha256,
        "reviewOverlay.dataset.packetSha256"
      ),
    },
    reviewer,
    maintainer,
    attestation,
    reviewedAt,
    decisions: raw.decisions.map((decision, index) =>
      parseDecision(decision, `reviewOverlay.decisions[${index}]`)
    ),
  };
}

function maintainerVerificationIssues(
  overlay: ReviewOverlay
): string[] {
  if (overlay.maintainer === null) {
    return ["a human maintainer verifier is required before applying an overlay"];
  }
  const issues: string[] = [];
  const maintainer = overlay.maintainer;
  if (maintainer.type !== "human") {
    issues.push("maintainer verifier type must be human");
  }
  if (
    overlay.reviewer !== null &&
    normalizeIdentity(maintainer.id) ===
      normalizeIdentity(overlay.reviewer.id)
  ) {
    issues.push("maintainer verifier must differ from the reviewer");
  }
  if (!maintainer.reviewerIdentityVerified) {
    issues.push("maintainer verifier must verify reviewer identity");
  }
  if (!maintainer.conflictsReviewed) {
    issues.push(
      "maintainer verifier must review disclosed reviewer conflicts"
    );
  }
  const verifiedAt = Date.parse(maintainer.verifiedAt);
  if (!Number.isFinite(verifiedAt)) {
    issues.push("maintainer verifiedAt must be an ISO-8601 timestamp");
  }
  if (overlay.reviewedAt !== null) {
    const reviewedAt = Date.parse(overlay.reviewedAt);
    if (
      Number.isFinite(verifiedAt) &&
      Number.isFinite(reviewedAt) &&
      verifiedAt < reviewedAt
    ) {
      issues.push("maintainer verifiedAt cannot be before reviewedAt");
    }
  }
  return issues;
}

function materializeRevision(
  dataset: BenchmarkDataset,
  scenario: BenchmarkScenario,
  decision: Extract<ReviewDecision, { decision: "revise" }>,
  reviewerId: string,
  revisionEvidenceSha256: string
): BenchmarkScenario {
  const candidate = parseDataset({
    ...dataset,
    scenarios: [
      {
        id: scenario.id,
        description: decision.replacement.description,
        language: decision.replacement.language,
        difficulty: decision.replacement.difficulty,
        provenance: {
          origin: "contributed",
          author: reviewerId,
          authorType: "human",
          sourceUri: `memory-bench:sha256:${decision.scenarioSha256}#${encodeURIComponent(
            scenario.id
          )}`,
          revisionEvidenceSha256,
        },
        review: {
          status: "draft",
          entries: [],
        },
        operations: decision.replacement.operations,
      },
    ],
  });
  return candidate.scenarios[0]!;
}

export function assessReviewOverlay(
  dataset: BenchmarkDataset,
  datasetSha256: string,
  overlay: ReviewOverlay
): ReviewOverlayAssessment {
  const counts: ReviewOverlayAssessment["counts"] = {
    pending: 0,
    approve: 0,
    revise: 0,
    reject: 0,
  };
  const issues: string[] = [];
  const warnings: string[] = [];
  const expectedPacketSha256 = reviewArtifactSha256(
    renderReviewArtifact(createReviewPacket(dataset, datasetSha256))
  );
  if (overlay.dataset.name !== dataset.name) {
    issues.push(
      `overlay dataset name is ${overlay.dataset.name}, expected ${dataset.name}`
    );
  }
  if (overlay.dataset.version !== dataset.version) {
    issues.push(
      `overlay dataset version is ${overlay.dataset.version}, expected ${dataset.version}`
    );
  }
  if (
    overlay.dataset.sha256 !== datasetSha256 ||
    !sha256Pattern.test(datasetSha256)
  ) {
    issues.push("overlay dataset SHA-256 does not match the source artifact");
  }
  if (overlay.dataset.packetSha256 !== expectedPacketSha256) {
    issues.push("overlay packet SHA-256 does not match the deterministic packet");
  }
  if (dataset.publicationStatus !== "draft") {
    issues.push(
      `source dataset publicationStatus is ${dataset.publicationStatus}, expected draft`
    );
  }
  if (overlay.reviewer === null) {
    issues.push("reviewer is required before applying an overlay");
  } else if (overlay.reviewer.type !== "human") {
    issues.push("an independent human reviewer is required");
  }
  if (overlay.attestation === null) {
    issues.push("reviewer attestation is required before applying an overlay");
  } else {
    for (const [field, accepted] of Object.entries(overlay.attestation)) {
      if (!accepted) issues.push(`reviewer attestation ${field} must be accepted`);
    }
  }
  if (overlay.reviewedAt === null) {
    issues.push("reviewedAt is required before applying an overlay");
  }
  issues.push(...maintainerVerificationIssues(overlay));

  const scenariosById = new Map(
    dataset.scenarios.map((scenario) => [scenario.id, scenario])
  );
  const seenScenarioIds = new Set<string>();
  for (const decision of overlay.decisions) {
    counts[decision.decision]++;
    if (seenScenarioIds.has(decision.scenarioId)) {
      issues.push(`duplicate decision for scenario ${decision.scenarioId}`);
      continue;
    }
    seenScenarioIds.add(decision.scenarioId);
    const scenario = scenariosById.get(decision.scenarioId);
    if (scenario === undefined) {
      issues.push(`overlay references unknown scenario ${decision.scenarioId}`);
      continue;
    }
    if (
      decision.scenarioSha256 !== scenarioReviewSubjectSha256(scenario)
    ) {
      issues.push(`scenario hash does not match ${decision.scenarioId}`);
    }
    if (decision.decision === "pending") continue;
    if (scenario.review.status !== "draft") {
      issues.push(
        `${decision.scenarioId} review status is ${scenario.review.status}, expected draft`
      );
    }
    if (
      overlay.reviewer !== null &&
      normalizeIdentity(overlay.reviewer.id) ===
        normalizeIdentity(scenario.provenance.author)
    ) {
      issues.push(
        `${decision.scenarioId} reviewer must be independent from the provenance author`
      );
    }
    if (decision.decision === "revise" && overlay.reviewer !== null) {
      try {
        materializeRevision(
          dataset,
          scenario,
          decision,
          overlay.reviewer.id,
          "0".repeat(64)
        );
      } catch (error) {
        issues.push(
          `${decision.scenarioId} replacement is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
  const completed = counts.approve + counts.revise + counts.reject;
  if (completed === 0) {
    issues.push("overlay must contain at least one completed decision");
  }
  if (counts.pending > 0) {
    warnings.push(
      `${counts.pending} pending decisions will be ignored during this application`
    );
  }
  return {
    readyToApply: issues.length === 0,
    counts,
    issues,
    warnings,
  };
}

export function applyReviewOverlay(
  dataset: BenchmarkDataset,
  datasetSha256: string,
  overlay: ReviewOverlay,
  overlaySha256: string,
  outputVersion: string,
  options: ApplyReviewOptions = {}
): BenchmarkDataset {
  sha256Value(overlaySha256, "overlaySha256");
  const version = outputVersion.trim();
  if (version === "") throw new Error("outputVersion must be a non-empty string");
  if (version === dataset.version) {
    throw new Error("outputVersion must differ from the source dataset version");
  }
  const assessment = assessReviewOverlay(dataset, datasetSha256, overlay);
  if (!assessment.readyToApply) {
    throw new Error(
      `review overlay cannot be applied: ${assessment.issues.join("; ")}`
    );
  }
  const reviewer = overlay.reviewer!;
  const reviewedAt = overlay.reviewedAt!;
  const decisionsByScenario = new Map(
    overlay.decisions.map((decision) => [decision.scenarioId, decision])
  );
  const scenarios: BenchmarkScenario[] = [];
  for (const sourceScenario of dataset.scenarios) {
    const decision = decisionsByScenario.get(sourceScenario.id);
    if (decision === undefined || decision.decision === "pending") {
      scenarios.push(structuredClone(sourceScenario));
      continue;
    }
    if (decision.decision === "reject") continue;
    if (decision.decision === "revise") {
      scenarios.push(
        materializeRevision(
          dataset,
          sourceScenario,
          decision,
          reviewer.id,
          overlaySha256
        )
      );
      continue;
    }
    scenarios.push({
      ...structuredClone(sourceScenario),
      review: {
        status: "reviewed",
        entries: [
          {
            reviewer,
            reviewedAt,
            evidence: {
              kind: "review-overlay",
              sha256: overlaySha256,
            },
          },
        ],
      },
    });
  }
  let result = parseDataset({
    ...dataset,
    version,
    publicationStatus: "draft",
    scenarios,
  });
  if (options.finalize !== true) return result;

  const finalized = parseDataset({
    ...result,
    publicationStatus: "reviewed",
  });
  const evidenceByHash = new Map(
    [...(options.evidence ?? []), { sha256: overlaySha256, overlay }].map(
      (item) => [item.sha256, item]
    )
  );
  const evidenceIssues = verifyDatasetReviewEvidence(finalized, [
    ...evidenceByHash.values(),
  ]);
  const readiness = assessPublicationReadiness(finalized);
  const issues = [...readiness.issues, ...evidenceIssues];
  if (issues.length > 0) {
    throw new Error(`reviewed dataset cannot be finalized: ${issues.join("; ")}`);
  }
  result = finalized;
  return result;
}

export function loadReviewOverlayEvidence(
  file: string
): LoadedReviewOverlayEvidence {
  const bytes = fs.readFileSync(file);
  return {
    sha256: reviewArtifactSha256(bytes),
    overlay: parseReviewOverlay(JSON.parse(bytes.toString("utf8")) as unknown),
  };
}

export function verifyDatasetReviewEvidence(
  dataset: BenchmarkDataset,
  evidence: LoadedReviewOverlayEvidence[]
): string[] {
  const issues: string[] = [];
  const missingEvidenceCounts = new Map<string, number>();
  let scenariosWithoutVerifiedHumanReview = 0;
  const evidenceByHash = new Map<string, LoadedReviewOverlayEvidence>();
  for (const item of evidence) {
    if (evidenceByHash.has(item.sha256)) {
      issues.push(`duplicate review overlay evidence ${item.sha256}`);
      continue;
    }
    evidenceByHash.set(item.sha256, item);
    issues.push(
      ...maintainerVerificationIssues(item.overlay).map(
        (issue) => `review overlay ${item.sha256}: ${issue}`
      )
    );
  }
  for (const scenario of dataset.scenarios) {
    const revisionEvidenceSha256 =
      scenario.provenance.revisionEvidenceSha256;
    if (revisionEvidenceSha256 !== undefined) {
      const artifact = evidenceByHash.get(revisionEvidenceSha256);
      if (artifact === undefined) {
        missingEvidenceCounts.set(
          revisionEvidenceSha256,
          (missingEvidenceCounts.get(revisionEvidenceSha256) ?? 0) + 1
        );
      } else {
        const revisionReviewer = artifact.overlay.reviewer;
        const revisionDecisions = artifact.overlay.decisions.filter(
          (decision) =>
            decision.scenarioId === scenario.id &&
            decision.decision === "revise"
        ) as Array<Extract<ReviewDecision, { decision: "revise" }>>;
        if (
          revisionReviewer === null ||
          revisionReviewer.type !== "human" ||
          normalizeIdentity(revisionReviewer.id) !==
            normalizeIdentity(scenario.provenance.author)
        ) {
          issues.push(
            `${scenario.id} revision author does not match overlay ${revisionEvidenceSha256}`
          );
        } else if (revisionDecisions.length !== 1) {
          issues.push(
            `${scenario.id} needs exactly one revision in overlay ${revisionEvidenceSha256}`
          );
        } else {
          try {
            const expectedScenario = materializeRevision(
              dataset,
              scenario,
              revisionDecisions[0]!,
              revisionReviewer.id,
              revisionEvidenceSha256
            );
            if (
              scenarioReviewSubjectSha256(expectedScenario) !==
              scenarioReviewSubjectSha256(scenario)
            ) {
              issues.push(
                `${scenario.id} revision does not match overlay ${revisionEvidenceSha256}`
              );
            }
          } catch (error) {
            issues.push(
              `${scenario.id} revision overlay is invalid: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      }
    }
    if (scenario.review.status !== "reviewed") continue;
    let verifiedHumanReviews = 0;
    for (const entry of scenario.review.entries) {
      const artifact = evidenceByHash.get(entry.evidence.sha256);
      if (artifact === undefined) {
        missingEvidenceCounts.set(
          entry.evidence.sha256,
          (missingEvidenceCounts.get(entry.evidence.sha256) ?? 0) + 1
        );
        continue;
      }
      const reviewer = artifact.overlay.reviewer;
      if (
        reviewer === null ||
        normalizeIdentity(reviewer.id) !==
          normalizeIdentity(entry.reviewer.id) ||
        reviewer.type !== entry.reviewer.type
      ) {
        issues.push(
          `${scenario.id} reviewer does not match overlay ${entry.evidence.sha256}`
        );
        continue;
      }
      if (artifact.overlay.reviewedAt !== entry.reviewedAt) {
        issues.push(
          `${scenario.id} review timestamp does not match overlay ${entry.evidence.sha256}`
        );
        continue;
      }
      const decisions = artifact.overlay.decisions.filter(
        (decision) =>
          decision.scenarioId === scenario.id &&
          decision.decision === "approve"
      );
      if (decisions.length !== 1) {
        issues.push(
          `${scenario.id} needs exactly one approval in overlay ${entry.evidence.sha256}`
        );
        continue;
      }
      if (
        decisions[0]!.scenarioSha256 !==
        scenarioReviewSubjectSha256(scenario)
      ) {
        issues.push(
          `${scenario.id} scenario hash does not match overlay ${entry.evidence.sha256}`
        );
        continue;
      }
      if (entry.reviewer.type === "human") verifiedHumanReviews++;
    }
    if (verifiedHumanReviews === 0) {
      scenariosWithoutVerifiedHumanReview++;
    }
  }
  for (const [sha256, count] of missingEvidenceCounts) {
    issues.push(
      `review overlay ${sha256} required by ${count} scenarios was not supplied`
    );
  }
  if (scenariosWithoutVerifiedHumanReview > 0) {
    issues.push(
      `${scenariosWithoutVerifiedHumanReview} reviewed scenarios have no verified independent human review`
    );
  }
  return issues;
}
