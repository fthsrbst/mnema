import type {
  AgentAdapterName,
  AgentResultClass,
} from "./agent-types.js";
import type { QualificationRole } from "./qualification-types.js";

export interface AgentPublicationOptions {
  comparison: string;
  qualifications: string[];
  evaluatorParities: string[];
  statistics?: string;
}

export interface AgentPublicationRelease {
  version: string;
  releasedAt: string;
  publisher: {
    id: string;
    type: "human" | "organization";
    affiliation: string;
  };
  maintainer: {
    id: string;
    type: "human";
    affiliation: string;
  };
  evidenceBundleUri: string;
  releaseNotesUri: string;
  correctionsUri: string;
  providerAffiliations: string[];
  sponsorships: string[];
  knownLimitations: string[];
  attestation: {
    datasetRightsVerified: boolean;
    noQuerySpecificTuning: boolean;
    providerDisclosuresComplete: boolean;
    sponsorshipDisclosuresComplete: boolean;
    allEvidencePublished: boolean;
    independentAuditComplete: boolean;
    secretsExcluded: boolean;
    correctionsPolicyAccepted: boolean;
  };
}

export interface AgentPublicationRun {
  adapter: AgentAdapterName;
  processId: number;
  reportFile: string;
  reportSha256: string;
  resultClass: AgentResultClass;
  componentSha256: {
    adapter: string;
    reader: string;
    judge: string;
  };
  evaluatorParityFile: string | null;
  evaluatorParitySha256: string | null;
}

export interface AgentPublicationQualification {
  file: string;
  sha256: string;
  qualificationId: string;
  role: QualificationRole;
  componentName: string;
  componentSha256: string;
  reviewerId: string;
  maintainerId: string;
}

export interface AgentPublicationStatistics {
  file: string;
  sha256: string;
  analysisId: string;
  comparisonSha256: string;
  iterations: number;
  confidenceLevel: number;
  seed: number;
  allIntervalsAvailable: boolean;
}

export interface AgentPublicationManifest {
  schemaVersion: 1;
  kind: "memory-bench-agent-publication";
  publicationId: string;
  status: "draft" | "final";
  assembledAt: string;
  finalizedAt: string | null;
  comparison: {
    file: string;
    sha256: string;
    comparisonId: string;
    datasetArtifactSha256: string;
    evaluationSha256: string;
    sourceCommit: string | null;
    sourceDirty: boolean | null;
  };
  runs: AgentPublicationRun[];
  qualifications: AgentPublicationQualification[];
  statistics: AgentPublicationStatistics | null;
  release: AgentPublicationRelease | null;
  claim: {
    resultClass: "candidate" | "benchmark";
    mechanicallyVerified: boolean;
    publicationEligible: boolean;
    blockers: string[];
  };
}

export interface AgentPublicationAssessment {
  mechanicallyVerified: boolean;
  releaseVerified: boolean;
  readyToFinalize: boolean;
  issues: string[];
  warnings: string[];
}
