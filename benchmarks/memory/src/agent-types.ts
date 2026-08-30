export const agentMemoryAbilities = [
  "information-extraction",
  "multi-session-reasoning",
  "knowledge-update",
  "temporal-reasoning",
  "abstention",
] as const;

export type AgentMemoryAbility = (typeof agentMemoryAbilities)[number];

export const longMemEvalSubsets = ["oracle", "small", "medium"] as const;

export type LongMemEvalSubset = (typeof longMemEvalSubsets)[number];

export const longMemEvalQuestionTypes = [
  "single-session-user",
  "single-session-assistant",
  "single-session-preference",
  "multi-session",
  "knowledge-update",
  "temporal-reasoning",
] as const;

export type LongMemEvalQuestionType =
  (typeof longMemEvalQuestionTypes)[number];

export interface AgentMemoryMessage {
  role: "user" | "assistant";
  content: string;
  hasAnswer?: boolean;
}

export interface AgentMemorySession {
  id: string;
  date: string;
  messages: AgentMemoryMessage[];
}

export interface AgentMemoryScenario {
  id: string;
  sourceQuestionType: LongMemEvalQuestionType;
  ability: AgentMemoryAbility;
  question: string;
  expectedAnswer: string;
  questionDate: string;
  expectedAbstention: boolean;
  evidenceSessionIds: string[];
  sessions: AgentMemorySession[];
}

export interface AgentMemoryDataset {
  schemaVersion: 1;
  name: "memory-bench-longmemeval";
  version: string;
  license: "MIT";
  track: "agent";
  language: "en";
  description: string;
  source: {
    benchmark: "longmemeval";
    revision: string;
    subset: LongMemEvalSubset;
    uri: string;
    fileName: string;
    sha256: string;
    bytes: number;
  };
  scenarios: AgentMemoryScenario[];
}

export type AgentMemoryDatasetMetadata = Omit<
  AgentMemoryDataset,
  "scenarios"
>;

export interface AgentMemoryDatasetSource {
  file: string;
  artifactSha256: string;
  artifactBytes: number;
  readPasses: 2;
  metadata: AgentMemoryDatasetMetadata;
  scenarios(): AsyncGenerator<AgentMemoryScenario>;
}

export interface AgentComponentInfo {
  name: string;
  version: string;
  mode: string;
  classification: "harness" | "candidate" | "benchmark";
  config: Record<string, string | number | boolean | null>;
}

export interface AgentComponentTelemetry {
  requestCount: number;
  retryCount: number;
  requestBytes: number;
  responseBytes: number;
  inputTokens: number | null;
  outputTokens: number | null;
  providerProcessingMs: number | null;
  providerCostUsd: number | null;
  costSource:
    | "not-applicable"
    | "not-exposed"
    | "provider-reported"
    | "estimated";
}

export interface AgentRunContext {
  runId: string;
  datasetName: string;
  datasetVersion: string;
  datasetSubset: LongMemEvalSubset;
}

export interface AgentScenarioContext {
  scenarioId: string;
  sessionCount: number;
}

export interface AgentIngestMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentIngestSession {
  id: string;
  date: string;
  messages: AgentIngestMessage[];
}

export interface AgentMemoryQuery {
  question: string;
  questionDate: string;
  topK: number;
}

export interface AgentTextContextItem {
  type: "text";
  value: string;
  observedAt: string | null;
  sourceSessionId: string | null;
  score: number | null;
}

export interface AgentImageContextItem {
  type: "image";
  value: string;
  observedAt: string | null;
  sourceSessionId: string | null;
  score: number | null;
}

export type AgentContextItem =
  | AgentTextContextItem
  | AgentImageContextItem;

export interface AgentCleanupResult {
  attempted: boolean;
  succeeded: boolean;
  verified: boolean;
}

export interface AgentMemoryAdapter {
  readonly info: AgentComponentInfo;
  setup(context: AgentRunContext): Promise<void>;
  beginScenario(context: AgentScenarioContext): Promise<void>;
  ingest(session: AgentIngestSession): Promise<void>;
  query(input: AgentMemoryQuery): Promise<AgentContextItem[]>;
  endScenario(): Promise<AgentCleanupResult>;
  teardown(): Promise<void>;
  getTelemetry(): AgentComponentTelemetry;
}

export interface AgentReaderInput {
  question: string;
  questionDate: string;
  context: AgentContextItem[];
}

export interface AgentMemoryReader {
  readonly info: AgentComponentInfo;
  answer(input: AgentReaderInput): Promise<string>;
  getTelemetry(): AgentComponentTelemetry;
}

export interface AgentJudgeInput {
  question: string;
  expectedAnswer: string;
  expectedAbstention: boolean;
  sourceQuestionType: LongMemEvalQuestionType;
  ability: AgentMemoryAbility;
  hypothesis: string;
}

export interface AgentJudgeDecision {
  passed: boolean;
  score: 0 | 1;
  label: string;
}

export interface AgentMemoryJudge {
  readonly info: AgentComponentInfo;
  evaluate(input: AgentJudgeInput): Promise<AgentJudgeDecision>;
  getTelemetry(): AgentComponentTelemetry;
}

export type AgentRunStage =
  | "dataset"
  | "setup"
  | "begin-scenario"
  | "ingest"
  | "query"
  | "reader"
  | "judge"
  | "cleanup"
  | "teardown"
  | "telemetry";

export interface AgentRuntimeFailure {
  scenarioId: string | null;
  ability: AgentMemoryAbility | null;
  stage: AgentRunStage;
  component: "runner" | "adapter" | "reader" | "judge";
  message: string;
}

export interface AgentEvidenceDescriptor {
  type: AgentContextItem["type"];
  observedAt: string | null;
  sourceSessionId: string | null;
  score: number | null;
  valueSha256: string;
  valueBytes: number;
}

export interface AgentScenarioTrace {
  scenarioId: string;
  sourceQuestionType: LongMemEvalQuestionType;
  ability: AgentMemoryAbility;
  expectedAbstention: boolean;
  status: "completed" | "failed";
  sessionCount: number;
  turnCount: number;
  topK: number;
  expectedEvidenceSessionIds: string[];
  retrievedSessionIds: string[];
  missingEvidenceSessionIds: string[];
  retrievalEvaluated: boolean;
  recallAtK: number | null;
  reciprocalRank: number | null;
  hypothesis: string | null;
  judgeLabel: string | null;
  qaPassed: boolean | null;
  latencyMs: {
    ingestion: number;
    query: number;
    reader: number;
    judge: number;
    total: number;
  };
  cleanup: AgentCleanupResult;
  evidence: AgentEvidenceDescriptor[];
}

export interface AgentLatencyMetrics {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface AgentScenarioMetrics {
  scenarios: number;
  completed: number;
  failed: number;
  qaAccuracy: number | null;
  retrievalQueries: number;
  macroRecallAtK: number | null;
  meanReciprocalRank: number | null;
  cleanupVerificationRate: number | null;
  latency: {
    ingestion: AgentLatencyMetrics;
    query: AgentLatencyMetrics;
    reader: AgentLatencyMetrics;
    judge: AgentLatencyMetrics;
    total: AgentLatencyMetrics;
  };
}

export interface AgentBenchmarkMetrics extends AgentScenarioMetrics {
  runtimeFailures: number;
  slices: {
    byAbility: Record<AgentMemoryAbility, AgentScenarioMetrics>;
  };
}

export interface AgentBenchmarkReport {
  schemaVersion: 1;
  run: {
    runId: string;
    startedAt: string;
    durationMs: number;
    status: "completed" | "completed-with-errors" | "failed";
    resultClass: "harness" | "candidate" | "benchmark";
    dataset: {
      name: AgentMemoryDataset["name"];
      version: string;
      license: AgentMemoryDataset["license"];
      track: AgentMemoryDataset["track"];
      language: AgentMemoryDataset["language"];
      subset: LongMemEvalSubset;
      sourceRevision: string;
      sourceSha256: string;
      artifactSha256: string;
      artifactBytes: number;
      readPasses: 2;
    };
    topK: number;
    maxScenarios: number | null;
    components: {
      adapter: AgentComponentInfo;
      reader: AgentComponentInfo;
      judge: AgentComponentInfo;
    };
    telemetry: {
      adapter: AgentComponentTelemetry;
      reader: AgentComponentTelemetry;
      judge: AgentComponentTelemetry;
    };
  };
  metrics: AgentBenchmarkMetrics;
  scenarios: AgentScenarioTrace[];
  failures: AgentRuntimeFailure[];
}

export const agentAdapterNames = [
  "literal",
  "mnema",
  "mem0",
  "letta",
  "zep",
] as const;

export type AgentAdapterName = (typeof agentAdapterNames)[number];

export type AgentReaderName = "fixture" | "openai";
export type AgentJudgeName = "fixture" | "openai";
export type AgentResultClass = AgentComponentInfo["classification"];

export interface AgentComparisonRun {
  adapter: AgentAdapterName;
  status: "completed" | "failed";
  processId: number | null;
  exitCode: number | null;
  durationMs: number;
  reportStatus: AgentBenchmarkReport["run"]["status"] | null;
  reportFile: string | null;
  reportSha256: string | null;
  evaluationSha256: string | null;
  resultClass: AgentResultClass | null;
  runtimeFailures: number | null;
  metrics: AgentBenchmarkMetrics | null;
  components: AgentBenchmarkReport["run"]["components"] | null;
  telemetry: AgentBenchmarkReport["run"]["telemetry"] | null;
  error: string | null;
}

export interface AgentComparisonManifest {
  schemaVersion: 1;
  kind: "memory-bench-agent-comparison";
  comparisonId: string;
  createdAt: string;
  dataset: {
    name: AgentMemoryDataset["name"];
    version: string;
    license: AgentMemoryDataset["license"];
    track: AgentMemoryDataset["track"];
    language: AgentMemoryDataset["language"];
    subset: LongMemEvalSubset;
    sourceRevision: string;
    sourceSha256: string;
    artifactFile: string;
    artifactSha256: string;
    artifactBytes: number;
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
  evaluation: {
    reader: AgentReaderName;
    readerModel: string | null;
    judge: AgentJudgeName;
    judgeModel: string | null;
    topK: number;
    maxScenarios: number | null;
    configurationSha256: string | null;
  };
  policy: {
    processIsolation: "one-process-per-adapter";
    executionOrder: "sequential";
    runtimeFailureAffectsCommandExit: true;
    qaFailureAffectsCommandExit: false;
  };
  claim: {
    resultClass: AgentResultClass;
    comparable: boolean;
    publicationEligible: boolean;
    blockers: string[];
  };
  runs: AgentComparisonRun[];
}

export interface EvaluatorParitySliceMetrics {
  compared: number;
  matches: number;
  mismatches: number;
  agreementRate: number | null;
}

export interface EvaluatorParityMismatch {
  scenarioId: string;
  sourceQuestionType: LongMemEvalQuestionType;
  ability: AgentMemoryAbility;
  hypothesisSha256: string;
  candidatePassed: boolean;
  officialPassed: boolean;
  officialModel: string;
}

export interface EvaluatorParityArtifact {
  schemaVersion: 1;
  kind: "memory-bench-evaluator-parity";
  parityId: string;
  createdAt: string;
  candidate: {
    reportFile: string;
    reportSha256: string;
    runId: string;
    reportStatus: AgentBenchmarkReport["run"]["status"];
    resultClass: AgentResultClass;
    dataset: {
      name: AgentMemoryDataset["name"];
      version: string;
      subset: LongMemEvalSubset;
      sourceRevision: string;
      sourceSha256: string;
      artifactSha256: string;
    };
    judge: {
      name: string;
      model: string | null;
      promptRevision: string | null;
      apiSurface: string | null;
      decisionRule: string | null;
    };
  };
  official: {
    resultsFile: string;
    resultsSha256: string;
    resultModels: string[];
    evaluatorRevision: string;
    scriptUri: string;
    scriptSha256: string;
    apiSurface: "chat-completions";
    decisionRule: "case-insensitive-yes-substring";
  };
  coverage: {
    reportDecisions: number;
    officialDecisions: number;
    candidateOnlyIds: string[];
    officialOnlyIds: string[];
    hypothesisMismatchIds: string[];
  };
  compatibility: {
    reportComplete: boolean;
    nonEmptyDecisionSet: boolean;
    completeCoverage: boolean;
    hypothesesExact: boolean;
    modelExact: boolean;
    promptRevisionPinned: boolean;
    comparable: boolean;
  };
  metrics: {
    compared: number;
    labelMatches: number;
    labelMismatches: number;
    agreementRate: number | null;
    exactAgreement: boolean;
    confusion: {
      bothPass: number;
      candidateOnlyPass: number;
      officialOnlyPass: number;
      bothFail: number;
    };
    slices: {
      byAbility: Record<
        AgentMemoryAbility,
        EvaluatorParitySliceMetrics
      >;
      byQuestionType: Record<
        LongMemEvalQuestionType,
        EvaluatorParitySliceMetrics
      >;
    };
  };
  policy: {
    labelMismatchAffectsCommandExit: false;
    requireExactAffectsCommandExit: true;
    rawQuestionsIncluded: false;
    rawExpectedAnswersIncluded: false;
    rawHypothesesIncluded: false;
    rawEvidenceIncluded: false;
  };
  claim: {
    evidenceClass: AgentResultClass;
    exactAgreement: boolean;
    publicationEligible: false;
    blockers: string[];
  };
  mismatches: EvaluatorParityMismatch[];
}
