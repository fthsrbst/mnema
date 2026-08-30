import type { AgentAdapterName } from "./agent-types.js";
import type { BenchmarkAdapterName } from "./types.js";

export type StatisticalComparisonTrack = "core" | "agent";
export type StatisticalAdapterName =
  | BenchmarkAdapterName
  | AgentAdapterName;
export type StatisticalMetricName =
  | "query-pass-rate"
  | "qa-accuracy"
  | "macro-recall-at-k"
  | "macro-precision-at-k"
  | "mean-reciprocal-rank"
  | "forbidden-hit-rate"
  | "abstention-accuracy"
  | "cleanup-verification-rate";
export type StatisticalMetricDirection =
  | "higher-is-better"
  | "lower-is-better";
export type StatisticalMetricStatus =
  | "estimated"
  | "insufficient-data"
  | "not-applicable";

export interface StatisticalPointEstimate {
  adapterA: number;
  adapterB: number;
  bMinusA: number;
}

export interface StatisticalConfidenceInterval {
  lower: number;
  upper: number;
}

export interface StatisticalMetricResult {
  name: StatisticalMetricName;
  direction: StatisticalMetricDirection;
  status: StatisticalMetricStatus;
  eligibleClusters: number;
  pairedObservations: number;
  pointEstimate: StatisticalPointEstimate | null;
  confidenceInterval: StatisticalConfidenceInterval | null;
}

export interface StatisticalPairwiseComparison {
  adapterA: StatisticalAdapterName;
  adapterB: StatisticalAdapterName;
  sharedClusters: number;
  sharedObservations: number;
  metrics: StatisticalMetricResult[];
}

export interface StatisticalReportEvidence {
  adapter: StatisticalAdapterName;
  file: string;
  sha256: string;
  clusters: number;
  observations: number;
}

export interface StatisticalComparisonArtifact {
  schemaVersion: 1;
  kind: "memory-bench-statistical-comparison";
  analysisId: string;
  createdAt: string;
  track: StatisticalComparisonTrack;
  comparison: {
    file: string;
    sha256: string;
    comparisonId: string;
    datasetSha256: string;
    evaluationSha256: string | null;
  };
  method: {
    name: "paired-scenario-cluster-bootstrap-percentile";
    resamplingUnit: "scenario";
    comparison: "adapter-b-minus-adapter-a";
    interval: "percentile";
    rng: "xorshift32";
    iterations: number;
    confidenceLevel: number;
    seed: number;
    multiplicityAdjustment: "none-descriptive-only";
  };
  reports: StatisticalReportEvidence[];
  coverage: {
    adapters: number;
    pairs: number;
    clusterIdentityExact: true;
    observationIdentityExact: true;
    metricMissingnessExact: true;
  };
  pairwise: StatisticalPairwiseComparison[];
  policy: {
    descriptiveOnly: true;
    rankingClaimed: false;
    statisticalSignificanceClaimed: false;
    rawQueriesIncluded: false;
    rawExpectedAnswersIncluded: false;
    rawHypothesesIncluded: false;
    rawEvidenceIncluded: false;
  };
  claim: {
    allIntervalsAvailable: boolean;
    blockers: string[];
  };
}

export interface StatisticalComparisonOptions {
  comparison: string;
  iterations?: number;
  confidenceLevel?: number;
  seed?: number;
  createdAt?: string;
}

export interface StatisticalComparisonAssessment {
  valid: boolean;
  issues: string[];
}
