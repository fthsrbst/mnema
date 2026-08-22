export type BenchmarkTrack = "core";
export type DatasetPublicationStatus = "harness" | "draft" | "reviewed";
export type ScenarioReviewStatus = "harness" | "draft" | "reviewed";
export type ScenarioAuthorType = "human" | "ai" | "mixed";
export type ScenarioReviewerType = "human" | "ai";
export type ScenarioDifficulty = "basic" | "intermediate" | "advanced";
export type BenchmarkAdapterName =
  | "literal"
  | "mnema"
  | "mem0"
  | "letta"
  | "zep";

export type MemoryAbility =
  | "single-memory-recall"
  | "multi-memory-recall"
  | "knowledge-update"
  | "temporal-recall"
  | "abstention"
  | "scope-isolation";

export interface BenchmarkMemoryRecord {
  id: string;
  scope: string;
  content: string;
  observedAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WriteOperation {
  op: "write";
  record: BenchmarkMemoryRecord;
}

export interface UpdateOperation {
  op: "update";
  targetId: string;
  record: BenchmarkMemoryRecord;
}

export interface DeleteOperation {
  op: "delete";
  targetId: string;
  scope: string;
}

export interface QueryOperation {
  op: "query";
  id: string;
  scope: string;
  query: string;
  ability: MemoryAbility;
  topK: number;
  relevantIds: string[];
  forbiddenIds?: string[];
  mustContain?: string[];
  mustNotContain?: string[];
  expectEmpty?: boolean;
}

export type BenchmarkOperation = WriteOperation | UpdateOperation | DeleteOperation | QueryOperation;

export interface ScenarioReviewEntry {
  reviewer: {
    id: string;
    type: ScenarioReviewerType;
  };
  reviewedAt: string;
  evidence: {
    kind: "review-overlay";
    sha256: string;
  };
}

export interface BenchmarkScenario {
  id: string;
  description: string;
  language: string;
  difficulty: ScenarioDifficulty;
  provenance: {
    origin: "synthetic" | "adapted" | "contributed";
    author: string;
    authorType: ScenarioAuthorType;
    sourceUri?: string;
    templateId?: string;
    revisionEvidenceSha256?: string;
  };
  review: {
    status: ScenarioReviewStatus;
    entries: ScenarioReviewEntry[];
  };
  operations: BenchmarkOperation[];
}

export interface BenchmarkDataset {
  schemaVersion: 1;
  name: string;
  version: string;
  license: string;
  track: BenchmarkTrack;
  publicationStatus: DatasetPublicationStatus;
  description: string;
  scenarios: BenchmarkScenario[];
}

export interface AdapterInfo {
  name: string;
  version: string;
  mode: string;
  config: Record<string, string | number | boolean | null>;
}

export interface AdapterTelemetry {
  requestCount: number;
  retryCount: number;
  pollRequestCount: number;
  requestBytes: number;
  responseBytes: number;
  providerProcessingMs: number | null;
  providerCostUsd: number | null;
  costSource: "not-applicable" | "not-exposed" | "provider-reported" | "estimated";
  cleanup: {
    attempted: boolean;
    succeeded: boolean;
    verified: boolean;
  };
}

export interface BenchmarkRunContext {
  runId: string;
  datasetName: string;
  datasetVersion: string;
  scopes: string[];
}

export interface SearchInput {
  scope: string;
  query: string;
  topK: number;
}

export interface NormalizedMemoryHit {
  recordId: string | null;
  content: string;
  score: number | null;
  providerId: string | null;
}

export interface NormalizedRecallFeedback {
  queryId: string;
  verdict: "helpful" | "noisy" | "missing";
  recordId: string | null;
  rank: number | null;
}

export interface MemoryBenchAdapter {
  readonly info: AdapterInfo;
  setup(context: BenchmarkRunContext): Promise<void>;
  write(record: BenchmarkMemoryRecord): Promise<void>;
  update(targetId: string, record: BenchmarkMemoryRecord): Promise<void>;
  delete(targetId: string, scope: string): Promise<void>;
  search(input: SearchInput): Promise<NormalizedMemoryHit[]>;
  teardown(): Promise<void>;
  getTelemetry(): AdapterTelemetry;
}

export interface QueryTrace {
  scenarioId: string;
  queryId: string;
  ability: MemoryAbility;
  language: string;
  difficulty: ScenarioDifficulty;
  scope: string;
  query: string;
  topK: number;
  latencyMs: number;
  relevantIds: string[];
  retrievedIds: string[];
  missingRelevantIds: string[];
  forbiddenIdsFound: string[];
  recallAtK: number | null;
  precisionAtK: number | null;
  reciprocalRank: number | null;
  contentChecksPassed: boolean;
  abstentionPassed: boolean | null;
  passed: boolean;
  hits: NormalizedMemoryHit[];
  feedback: NormalizedRecallFeedback[];
}

export interface LatencySummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface BenchmarkQueryMetrics {
  queries: number;
  queryPassRate: number;
  macroRecallAtK: number | null;
  macroPrecisionAtK: number | null;
  meanReciprocalRank: number | null;
  forbiddenHitRate: number;
  abstentionAccuracy: number | null;
  queryLatency: LatencySummary;
}

export interface BenchmarkMetrics extends BenchmarkQueryMetrics {
  operationLatency: Record<BenchmarkOperation["op"], LatencySummary>;
  slices: {
    byAbility: Record<MemoryAbility, BenchmarkQueryMetrics>;
    byLanguage: Record<string, BenchmarkQueryMetrics>;
    byDifficulty: Record<ScenarioDifficulty, BenchmarkQueryMetrics>;
  };
}

export interface BenchmarkReport {
  schemaVersion: 1;
  run: {
    runId: string;
    startedAt: string;
    durationMs: number;
    dataset: {
      name: string;
      version: string;
      license: string;
      track: BenchmarkTrack;
      publicationStatus: DatasetPublicationStatus;
    };
    adapter: AdapterInfo;
    adapterTelemetry: AdapterTelemetry;
  };
  metrics: BenchmarkMetrics;
  queries: QueryTrace[];
}

export interface ComparisonRun {
  adapter: BenchmarkAdapterName;
  status: "completed" | "failed";
  exitCode: number | null;
  durationMs: number;
  reportFile: string | null;
  reportSha256: string | null;
  queryFailures: number | null;
  metrics: BenchmarkMetrics | null;
  adapterInfo: AdapterInfo | null;
  adapterTelemetry: AdapterTelemetry | null;
  error: string | null;
}

export interface ComparisonManifest {
  schemaVersion: 1;
  comparisonId: string;
  createdAt: string;
  dataset: {
    name: string;
    version: string;
    license: string;
    publicationStatus: DatasetPublicationStatus;
    file: string;
    sha256: string;
  };
  source: {
    gitCommit: string | null;
    gitDirty: boolean | null;
  };
  environment: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    osRelease: string;
    cpuModel: string | null;
    logicalCpuCount: number;
    totalMemoryBytes: number;
  };
  policy: {
    processIsolation: "one-process-per-adapter";
    runtimeFailureAffectsCommandExit: true;
    queryFailureAffectsCommandExit: false;
  };
  runs: ComparisonRun[];
}
