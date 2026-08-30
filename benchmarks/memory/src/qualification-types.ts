import type {
  AgentBenchmarkReport,
  AgentComponentInfo,
  AgentResultClass,
} from "./agent-types.js";
import type { BenchmarkReport } from "./types.js";

export const qualificationRoles = [
  "adapter",
  "reader",
  "judge",
] as const;

export type QualificationRole = (typeof qualificationRoles)[number];

export interface QualificationSubmitter {
  id: string;
  type: "human" | "organization" | "automation";
  affiliation: string;
}

export interface QualificationReviewer {
  id: string;
  type: "human";
  affiliation: string;
  conflicts: string[];
  reviewedAt: string;
}

export interface QualificationMaintainer {
  id: string;
  type: "human";
  verifiedAt: string;
  reviewerIdentityVerified: boolean;
  conflictsReviewed: boolean;
  disposition: string;
}

export interface QualificationAttestation {
  evidenceAuthentic: boolean;
  realServiceOrImplementation: boolean;
  noContractOrFakeServer: boolean;
  configurationPinned: boolean;
  credentialsExcluded: boolean;
  evidencePublished: boolean;
  independentReproduction: boolean;
  authenticationFailureObserved: boolean | null;
  lifecycleOperationsObserved: boolean | null;
  disposableIsolationObserved: boolean | null;
  cleanupVerified: boolean | null;
  apiContractObserved: boolean | null;
  requestPolicyVerified: boolean | null;
  officialEvaluatorParityVerified: boolean | null;
}

export interface QualificationAgentReportEvidence {
  file: string;
  sha256: string;
  runId: string;
  reportStatus: AgentBenchmarkReport["run"]["status"];
  resultClass: AgentResultClass;
  datasetArtifactSha256: string;
  scenarios: number;
  runtimeFailures: number;
  cleanupVerificationRate: number | null;
}

export interface QualificationCoreReportEvidence {
  file: string;
  sha256: string;
  runId: string;
  datasetName: string;
  datasetVersion: string;
  datasetPublicationStatus:
    BenchmarkReport["run"]["dataset"]["publicationStatus"];
  adapterName: string;
  adapterVersion: string;
  adapterInfoSha256: string;
  queries: number;
  queryFailures: number;
  cleanupVerified: boolean;
  operationCounts: {
    write: number;
    update: number;
    delete: number;
    query: number;
  };
}

export interface QualificationParityEvidence {
  file: string;
  sha256: string;
  candidateReportSha256: string;
  comparable: boolean;
  exactAgreement: boolean;
  labelMismatches: number;
  evaluatorRevision: string;
  evaluatorScriptSha256: string;
}

export interface ComponentQualification {
  schemaVersion: 1;
  kind: "memory-bench-component-qualification";
  qualificationId: string;
  subject: {
    role: QualificationRole;
    component: AgentComponentInfo;
    componentSha256: string;
  };
  evidence: {
    agentReport: QualificationAgentReportEvidence;
    coreReport: QualificationCoreReportEvidence | null;
    evaluatorParity: QualificationParityEvidence | null;
  };
  submitter: QualificationSubmitter | null;
  reviewer: QualificationReviewer | null;
  maintainer: QualificationMaintainer | null;
  attestation: QualificationAttestation | null;
  decision: "pending" | "qualified" | "rejected";
  decisionNote: string | null;
}

export interface ComponentQualificationOptions {
  role: QualificationRole;
  agentReport: string;
  coreReport?: string;
  evaluatorParity?: string;
}

export interface ComponentQualificationAssessment {
  qualified: boolean;
  qualificationId: string;
  role: QualificationRole;
  componentSha256: string;
  issues: string[];
  warnings: string[];
}
