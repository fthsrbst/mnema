import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Ajv2020,
  type AnySchemaObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { agentEvaluationFingerprint } from "./agent-comparison.js";
import type {
  AgentBenchmarkReport,
  AgentComparisonManifest,
} from "./agent-types.js";
import type {
  StatisticalAdapterName,
  StatisticalComparisonArtifact,
  StatisticalComparisonAssessment,
  StatisticalComparisonOptions,
  StatisticalComparisonTrack,
  StatisticalMetricDirection,
  StatisticalMetricName,
  StatisticalMetricResult,
  StatisticalReportEvidence,
} from "./statistical-comparison-types.js";
import type {
  BenchmarkReport,
  ComparisonManifest,
} from "./types.js";

export type {
  StatisticalComparisonArtifact,
  StatisticalComparisonAssessment,
  StatisticalComparisonOptions,
} from "./statistical-comparison-types.js";

interface LoadedArtifact<T> {
  file: string;
  bytes: Buffer;
  sha256: string;
  value: T;
}

interface Observation {
  key: string;
  cluster: string;
  identity: string;
  values: Record<StatisticalMetricName, number | null>;
}

interface AnalysisReport {
  adapter: StatisticalAdapterName;
  evidence: StatisticalReportEvidence;
  observations: Map<string, Observation>;
}

interface AnalysisInputs {
  track: StatisticalComparisonTrack;
  comparison: StatisticalComparisonArtifact["comparison"];
  reports: AnalysisReport[];
}

interface MetricDefinition {
  name: StatisticalMetricName;
  direction: StatisticalMetricDirection;
}

const comparisonSchemaFile = fileURLToPath(
  new URL("../schemas/v1/comparison-manifest.schema.json", import.meta.url)
);
const agentComparisonSchemaFile = fileURLToPath(
  new URL(
    "../schemas/v1/agent-comparison-manifest.schema.json",
    import.meta.url
  )
);
const reportSchemaFile = fileURLToPath(
  new URL("../schemas/v1/report.schema.json", import.meta.url)
);
const agentReportSchemaFile = fileURLToPath(
  new URL("../schemas/v1/agent-report.schema.json", import.meta.url)
);
const statisticalComparisonSchemaFile = fileURLToPath(
  new URL(
    "../schemas/v1/statistical-comparison.schema.json",
    import.meta.url
  )
);
const maximumInputBytes = 100 * 1024 * 1024;
const defaultIterations = 10_000;
const defaultConfidenceLevel = 0.95;
const defaultSeed = 20_260_727;
const maximumUint32 = 0xffff_ffff;

const coreMetricDefinitions: MetricDefinition[] = [
  { name: "query-pass-rate", direction: "higher-is-better" },
  { name: "macro-recall-at-k", direction: "higher-is-better" },
  { name: "macro-precision-at-k", direction: "higher-is-better" },
  { name: "mean-reciprocal-rank", direction: "higher-is-better" },
  { name: "forbidden-hit-rate", direction: "lower-is-better" },
  { name: "abstention-accuracy", direction: "higher-is-better" },
];
const agentMetricDefinitions: MetricDefinition[] = [
  { name: "qa-accuracy", direction: "higher-is-better" },
  { name: "macro-recall-at-k", direction: "higher-is-better" },
  { name: "mean-reciprocal-rank", direction: "higher-is-better" },
  {
    name: "cleanup-verification-rate",
    direction: "higher-is-better",
  },
];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(
    values.reduce((sum, value) => sum + value, 0) / values.length
  );
}

function readBoundedFile(file: string, label: string): Buffer {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (stat.size < 1) throw new Error(`${label} must not be empty`);
  if (stat.size > maximumInputBytes) {
    throw new Error(
      `${label} exceeds the ${maximumInputBytes} byte input limit`
    );
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > maximumInputBytes) {
    throw new Error(
      `${label} exceeds the ${maximumInputBytes} byte input limit`
    );
  }
  return bytes;
}

function compileValidator(schemaFile: string): {
  ajv: Ajv2020;
  validate: ValidateFunction;
} {
  const require = createRequire(import.meta.url);
  const addFormats = require("ajv-formats") as FormatsPlugin;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(
    fs.readFileSync(schemaFile, "utf8")
  ) as AnySchemaObject;
  return {
    ajv,
    validate: ajv.compile(schema),
  };
}

function validateArtifact(
  validator: ReturnType<typeof compileValidator>,
  value: unknown,
  label: string
): void {
  if (validator.validate(value)) return;
  throw new Error(
    `${label} failed schema validation: ${validator.ajv.errorsText(
      validator.validate.errors,
      { separator: "; " }
    )}`
  );
}

function loadJson<T>(
  file: string,
  label: string,
  schemaFile: string
): LoadedArtifact<T> {
  const bytes = readBoundedFile(file, label);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  validateArtifact(compileValidator(schemaFile), value, label);
  return {
    file,
    bytes,
    sha256: sha256(bytes),
    value: value as T,
  };
}

function safeSibling(directory: string, file: string, label: string): string {
  if (
    file.trim() === "" ||
    path.isAbsolute(file) ||
    path.basename(file) !== file
  ) {
    throw new Error(`${label} must be a safe sibling filename`);
  }
  return path.join(directory, file);
}

function validateOptions(
  options: StatisticalComparisonOptions
): Required<Omit<StatisticalComparisonOptions, "createdAt">> & {
  createdAt: string;
} {
  if (options.comparison.trim() === "") {
    throw new Error("comparison path must not be empty");
  }
  const iterations = options.iterations ?? defaultIterations;
  if (
    !Number.isInteger(iterations) ||
    iterations < 1_000 ||
    iterations > 1_000_000
  ) {
    throw new Error(
      "iterations must be an integer from 1000 to 1000000"
    );
  }
  const confidenceLevel =
    options.confidenceLevel ?? defaultConfidenceLevel;
  if (
    !Number.isFinite(confidenceLevel) ||
    confidenceLevel < 0.8 ||
    confidenceLevel > 0.999
  ) {
    throw new Error(
      "confidence level must be a number from 0.8 to 0.999"
    );
  }
  const seed = options.seed ?? defaultSeed;
  if (
    !Number.isInteger(seed) ||
    seed < 1 ||
    seed > maximumUint32
  ) {
    throw new Error(
      `seed must be an integer from 1 to ${maximumUint32}`
    );
  }
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("createdAt must be an ISO-8601 timestamp");
  }
  return {
    comparison: path.resolve(options.comparison),
    iterations,
    confidenceLevel,
    seed,
    createdAt,
  };
}

function emptyMetricValues(): Record<
  StatisticalMetricName,
  number | null
> {
  return {
    "query-pass-rate": null,
    "qa-accuracy": null,
    "macro-recall-at-k": null,
    "macro-precision-at-k": null,
    "mean-reciprocal-rank": null,
    "forbidden-hit-rate": null,
    "abstention-accuracy": null,
    "cleanup-verification-rate": null,
  };
}

function assertUniqueObservation(
  observations: Map<string, Observation>,
  observation: Observation,
  adapter: string
): void {
  if (observations.has(observation.key)) {
    throw new Error(
      `${adapter} report contains duplicate observation ${observation.key}`
    );
  }
  observations.set(observation.key, observation);
}

function assertMetric(
  adapter: string,
  name: StatisticalMetricName,
  observed: number | null,
  reported: number | null
): void {
  if (observed !== reported) {
    throw new Error(
      `${adapter} report ${name} aggregate differs from its traces: ` +
        `expected ${String(observed)}, received ${String(reported)}`
    );
  }
}

function coreAnalysisReport(
  adapter: StatisticalAdapterName,
  loaded: LoadedArtifact<BenchmarkReport>,
  run: ComparisonManifest["runs"][number],
  manifest: ComparisonManifest
): AnalysisReport {
  const report = loaded.value;
  if (loaded.sha256 !== run.reportSha256) {
    throw new Error(`${adapter} report SHA-256 differs from the comparison`);
  }
  if (
    report.run.adapter.name !== adapter ||
    canonicalJson(report.run.adapter) !== canonicalJson(run.adapterInfo) ||
    canonicalJson(report.metrics) !== canonicalJson(run.metrics)
  ) {
    throw new Error(
      `${adapter} report identity or metrics differ from the comparison`
    );
  }
  const expectedDataset = {
    name: manifest.dataset.name,
    version: manifest.dataset.version,
    license: manifest.dataset.license,
    track: "core",
    publicationStatus: manifest.dataset.publicationStatus,
  };
  if (
    canonicalJson(report.run.dataset) !== canonicalJson(expectedDataset)
  ) {
    throw new Error(`${adapter} report dataset identity differs`);
  }
  if (
    run.queryFailures !==
    report.queries.filter((trace) => !trace.passed).length
  ) {
    throw new Error(
      `${adapter} comparison query failure count differs from the report`
    );
  }
  const observations = new Map<string, Observation>();
  for (const trace of report.queries) {
    const values = emptyMetricValues();
    values["query-pass-rate"] = trace.passed ? 1 : 0;
    values["macro-recall-at-k"] = trace.recallAtK;
    values["macro-precision-at-k"] = trace.precisionAtK;
    values["mean-reciprocal-rank"] = trace.reciprocalRank;
    values["forbidden-hit-rate"] =
      trace.forbiddenIdsFound.length > 0 ? 1 : 0;
    values["abstention-accuracy"] =
      trace.abstentionPassed === null
        ? null
        : trace.abstentionPassed
          ? 1
          : 0;
    const key = canonicalJson({
      scenarioId: trace.scenarioId,
      queryId: trace.queryId,
    });
    assertUniqueObservation(
      observations,
      {
        key,
        cluster: trace.scenarioId,
        identity: canonicalJson({
          scenarioId: trace.scenarioId,
          queryId: trace.queryId,
          ability: trace.ability,
          language: trace.language,
          difficulty: trace.difficulty,
          scope: trace.scope,
          query: trace.query,
          topK: trace.topK,
          relevantIds: trace.relevantIds,
        }),
        values,
      },
      adapter
    );
  }
  const metricValues = (
    name: StatisticalMetricName
  ): number[] =>
    [...observations.values()]
      .map((observation) => observation.values[name])
      .filter((value): value is number => value !== null);
  assertMetric(
    adapter,
    "query-pass-rate",
    mean(metricValues("query-pass-rate")),
    report.metrics.queryPassRate
  );
  assertMetric(
    adapter,
    "macro-recall-at-k",
    mean(metricValues("macro-recall-at-k")),
    report.metrics.macroRecallAtK
  );
  assertMetric(
    adapter,
    "macro-precision-at-k",
    mean(metricValues("macro-precision-at-k")),
    report.metrics.macroPrecisionAtK
  );
  assertMetric(
    adapter,
    "mean-reciprocal-rank",
    mean(metricValues("mean-reciprocal-rank")),
    report.metrics.meanReciprocalRank
  );
  assertMetric(
    adapter,
    "forbidden-hit-rate",
    mean(metricValues("forbidden-hit-rate")),
    report.metrics.forbiddenHitRate
  );
  assertMetric(
    adapter,
    "abstention-accuracy",
    mean(metricValues("abstention-accuracy")),
    report.metrics.abstentionAccuracy
  );
  return {
    adapter,
    evidence: {
      adapter,
      file: path.basename(loaded.file),
      sha256: loaded.sha256,
      clusters: new Set(
        [...observations.values()].map(
          (observation) => observation.cluster
        )
      ).size,
      observations: observations.size,
    },
    observations,
  };
}

function agentAnalysisReport(
  adapter: StatisticalAdapterName,
  loaded: LoadedArtifact<AgentBenchmarkReport>,
  run: AgentComparisonManifest["runs"][number],
  manifest: AgentComparisonManifest
): AnalysisReport {
  const report = loaded.value;
  if (loaded.sha256 !== run.reportSha256) {
    throw new Error(`${adapter} report SHA-256 differs from the comparison`);
  }
  if (
    report.run.components.adapter.name !== adapter ||
    canonicalJson(report.run.components) !== canonicalJson(run.components) ||
    canonicalJson(report.metrics) !== canonicalJson(run.metrics)
  ) {
    throw new Error(
      `${adapter} report identity or metrics differ from the comparison`
    );
  }
  if (
    report.run.status !== "completed" ||
    report.metrics.runtimeFailures !== 0 ||
    report.failures.length !== 0
  ) {
    throw new Error(`${adapter} report contains runtime failures`);
  }
  const expectedDataset = {
    name: manifest.dataset.name,
    version: manifest.dataset.version,
    license: manifest.dataset.license,
    track: manifest.dataset.track,
    language: manifest.dataset.language,
    subset: manifest.dataset.subset,
    sourceRevision: manifest.dataset.sourceRevision,
    sourceSha256: manifest.dataset.sourceSha256,
    artifactSha256: manifest.dataset.artifactSha256,
    artifactBytes: manifest.dataset.artifactBytes,
    readPasses: 2,
  };
  if (
    canonicalJson(report.run.dataset) !== canonicalJson(expectedDataset)
  ) {
    throw new Error(`${adapter} report dataset identity differs`);
  }
  if (
    report.run.topK !== manifest.evaluation.topK ||
    report.run.maxScenarios !== manifest.evaluation.maxScenarios
  ) {
    throw new Error(
      `${adapter} report evaluation bounds differ from the comparison`
    );
  }
  if (
    agentEvaluationFingerprint(report) !==
      manifest.evaluation.configurationSha256 ||
    run.evaluationSha256 !== manifest.evaluation.configurationSha256
  ) {
    throw new Error(`${adapter} report evaluation identity differs`);
  }
  const observations = new Map<string, Observation>();
  for (const trace of report.scenarios) {
    const values = emptyMetricValues();
    values["qa-accuracy"] =
      trace.qaPassed === null ? null : trace.qaPassed ? 1 : 0;
    values["macro-recall-at-k"] = trace.retrievalEvaluated
      ? (trace.recallAtK ?? 0)
      : null;
    values["mean-reciprocal-rank"] = trace.retrievalEvaluated
      ? (trace.reciprocalRank ?? 0)
      : null;
    values["cleanup-verification-rate"] = trace.cleanup.attempted
      ? trace.cleanup.verified
        ? 1
        : 0
      : null;
    const key = canonicalJson({ scenarioId: trace.scenarioId });
    assertUniqueObservation(
      observations,
      {
        key,
        cluster: trace.scenarioId,
        identity: canonicalJson({
          scenarioId: trace.scenarioId,
          sourceQuestionType: trace.sourceQuestionType,
          ability: trace.ability,
          expectedAbstention: trace.expectedAbstention,
          sessionCount: trace.sessionCount,
          turnCount: trace.turnCount,
          topK: trace.topK,
          expectedEvidenceSessionIds:
            trace.expectedEvidenceSessionIds,
          retrievalEvaluated: trace.retrievalEvaluated,
        }),
        values,
      },
      adapter
    );
  }
  const metricValues = (
    name: StatisticalMetricName
  ): number[] =>
    [...observations.values()]
      .map((observation) => observation.values[name])
      .filter((value): value is number => value !== null);
  assertMetric(
    adapter,
    "qa-accuracy",
    mean(metricValues("qa-accuracy")),
    report.metrics.qaAccuracy
  );
  assertMetric(
    adapter,
    "macro-recall-at-k",
    mean(metricValues("macro-recall-at-k")),
    report.metrics.macroRecallAtK
  );
  assertMetric(
    adapter,
    "mean-reciprocal-rank",
    mean(metricValues("mean-reciprocal-rank")),
    report.metrics.meanReciprocalRank
  );
  assertMetric(
    adapter,
    "cleanup-verification-rate",
    mean(metricValues("cleanup-verification-rate")),
    report.metrics.cleanupVerificationRate
  );
  return {
    adapter,
    evidence: {
      adapter,
      file: path.basename(loaded.file),
      sha256: loaded.sha256,
      clusters: observations.size,
      observations: observations.size,
    },
    observations,
  };
}

function loadAnalysisInputs(comparisonFile: string): AnalysisInputs {
  const bytes = readBoundedFile(
    comparisonFile,
    "comparison manifest"
  );
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("comparison manifest is not valid JSON");
  }
  const track: StatisticalComparisonTrack =
    typeof raw === "object" &&
    raw !== null &&
    "kind" in raw &&
    raw.kind === "memory-bench-agent-comparison"
      ? "agent"
      : "core";
  const directory = path.dirname(comparisonFile);
  const reports: AnalysisReport[] = [];
  if (track === "core") {
    validateArtifact(
      compileValidator(comparisonSchemaFile),
      raw,
      "core comparison manifest"
    );
    const manifest = raw as ComparisonManifest;
    if (manifest.runs.length < 2) {
      throw new Error(
        "statistical comparison requires at least two adapter runs"
      );
    }
    for (const run of manifest.runs) {
      if (
        run.status !== "completed" ||
        run.exitCode === null ||
        run.reportFile === null ||
        run.reportSha256 === null ||
        run.queryFailures === null ||
        run.metrics === null ||
        run.adapterInfo === null ||
        run.error !== null
      ) {
        throw new Error(
          `${run.adapter} comparison run is incomplete`
        );
      }
      const expectedExitCode = run.queryFailures === 0 ? 0 : 1;
      if (run.exitCode !== expectedExitCode) {
        throw new Error(
          `${run.adapter} exit code does not match the core query-failure policy`
        );
      }
      const reportFile = safeSibling(
        directory,
        run.reportFile,
        `${run.adapter} core report`
      );
      reports.push(
        coreAnalysisReport(
          run.adapter,
          loadJson<BenchmarkReport>(
            reportFile,
            `${run.adapter} core report`,
            reportSchemaFile
          ),
          run,
          manifest
        )
      );
    }
    return {
      track,
      comparison: {
        file: path.basename(comparisonFile),
        sha256: sha256(bytes),
        comparisonId: manifest.comparisonId,
        datasetSha256: manifest.dataset.sha256,
        evaluationSha256: null,
      },
      reports: validateReportPairing(reports),
    };
  }

  validateArtifact(
    compileValidator(agentComparisonSchemaFile),
    raw,
    "agent comparison manifest"
  );
  const manifest = raw as AgentComparisonManifest;
  if (!manifest.claim.comparable || manifest.runs.length < 2) {
    throw new Error(
      "agent statistical comparison requires a comparable manifest with at least two runs"
    );
  }
  if (manifest.evaluation.configurationSha256 === null) {
    throw new Error(
      "agent comparison has no evaluation fingerprint"
    );
  }
  for (const run of manifest.runs) {
    if (
      run.status !== "completed" ||
      run.exitCode !== 0 ||
      run.reportStatus !== "completed" ||
      run.reportFile === null ||
      run.reportSha256 === null ||
      run.evaluationSha256 === null ||
      run.runtimeFailures !== 0 ||
      run.metrics === null ||
      run.components === null ||
      run.error !== null
    ) {
      throw new Error(`${run.adapter} comparison run is incomplete`);
    }
    const reportFile = safeSibling(
      directory,
      run.reportFile,
      `${run.adapter} agent report`
    );
    reports.push(
      agentAnalysisReport(
        run.adapter,
        loadJson<AgentBenchmarkReport>(
          reportFile,
          `${run.adapter} agent report`,
          agentReportSchemaFile
        ),
        run,
        manifest
      )
    );
  }
  return {
    track,
    comparison: {
      file: path.basename(comparisonFile),
      sha256: sha256(bytes),
      comparisonId: manifest.comparisonId,
      datasetSha256: manifest.dataset.artifactSha256,
      evaluationSha256:
        manifest.evaluation.configurationSha256,
    },
    reports: validateReportPairing(reports),
  };
}

function validateReportPairing(
  reports: AnalysisReport[]
): AnalysisReport[] {
  reports.sort((left, right) =>
    left.adapter.localeCompare(right.adapter)
  );
  const adapterNames = reports.map((report) => report.adapter);
  if (new Set(adapterNames).size !== adapterNames.length) {
    throw new Error(
      "statistical comparison adapters must not contain duplicates"
    );
  }
  const reference = reports[0];
  if (reference === undefined) {
    throw new Error("statistical comparison has no reports");
  }
  const referenceKeys = [...reference.observations.keys()].sort();
  for (const report of reports.slice(1)) {
    const keys = [...report.observations.keys()].sort();
    if (canonicalJson(keys) !== canonicalJson(referenceKeys)) {
      throw new Error(
        `${reference.adapter} and ${report.adapter} observation identities differ`
      );
    }
    for (const key of referenceKeys) {
      const left = reference.observations.get(key)!;
      const right = report.observations.get(key)!;
      if (left.identity !== right.identity) {
        throw new Error(
          `${reference.adapter} and ${report.adapter} observation identities differ at ${key}`
        );
      }
      for (const name of Object.keys(
        left.values
      ) as StatisticalMetricName[]) {
        if (
          (left.values[name] === null) !==
          (right.values[name] === null)
        ) {
          throw new Error(
            `${reference.adapter} and ${report.adapter} metric missingness differs for ${name} at ${key}`
          );
        }
      }
    }
  }
  return reports;
}

function derivedSeed(
  seed: number,
  track: StatisticalComparisonTrack,
  adapterA: string,
  adapterB: string,
  metric: StatisticalMetricName
): number {
  const digest = createHash("sha256")
    .update(
      canonicalJson({ seed, track, adapterA, adapterB, metric })
    )
    .digest();
  const result = digest.readUInt32BE(0);
  return result === 0 ? 0x9e37_79b9 : result;
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function quantile(sorted: number[], probability: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const index = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return lower + (upper - lower) * (index - lowerIndex);
}

function pairedMetric(
  definition: MetricDefinition,
  reportA: AnalysisReport,
  reportB: AnalysisReport,
  track: StatisticalComparisonTrack,
  iterations: number,
  confidenceLevel: number,
  seed: number
): StatisticalMetricResult {
  const clusters = new Map<
    string,
    Array<{ adapterA: number; adapterB: number }>
  >();
  const keys = [...reportA.observations.keys()].sort();
  for (const key of keys) {
    const observationA = reportA.observations.get(key)!;
    const observationB = reportB.observations.get(key)!;
    const valueA = observationA.values[definition.name];
    const valueB = observationB.values[definition.name];
    if (valueA === null || valueB === null) continue;
    const values = clusters.get(observationA.cluster) ?? [];
    values.push({ adapterA: valueA, adapterB: valueB });
    clusters.set(observationA.cluster, values);
  }
  const clusterEntries = [...clusters.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const allValues = clusterEntries.flatMap(([, values]) => values);
  if (allValues.length === 0) {
    return {
      name: definition.name,
      direction: definition.direction,
      status: "not-applicable",
      eligibleClusters: 0,
      pairedObservations: 0,
      pointEstimate: null,
      confidenceInterval: null,
    };
  }
  const pointA = mean(allValues.map((value) => value.adapterA))!;
  const pointB = mean(allValues.map((value) => value.adapterB))!;
  const pointEstimate = {
    adapterA: pointA,
    adapterB: pointB,
    bMinusA: round(pointB - pointA),
  };
  if (clusterEntries.length < 2) {
    return {
      name: definition.name,
      direction: definition.direction,
      status: "insufficient-data",
      eligibleClusters: clusterEntries.length,
      pairedObservations: allValues.length,
      pointEstimate,
      confidenceInterval: null,
    };
  }

  const random = xorshift32(
    derivedSeed(
      seed,
      track,
      reportA.adapter,
      reportB.adapter,
      definition.name
    )
  );
  const deltas: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sumA = 0;
    let sumB = 0;
    let count = 0;
    for (
      let draw = 0;
      draw < clusterEntries.length;
      draw += 1
    ) {
      const selected =
        clusterEntries[
          Math.floor(random() * clusterEntries.length)
        ]![1];
      for (const value of selected) {
        sumA += value.adapterA;
        sumB += value.adapterB;
        count += 1;
      }
    }
    deltas.push(sumB / count - sumA / count);
  }
  deltas.sort((left, right) => left - right);
  const alpha = (1 - confidenceLevel) / 2;
  return {
    name: definition.name,
    direction: definition.direction,
    status: "estimated",
    eligibleClusters: clusterEntries.length,
    pairedObservations: allValues.length,
    pointEstimate,
    confidenceInterval: {
      lower: round(quantile(deltas, alpha)),
      upper: round(quantile(deltas, 1 - alpha)),
    },
  };
}

export function createStatisticalComparison(
  rawOptions: StatisticalComparisonOptions
): StatisticalComparisonArtifact {
  const options = validateOptions(rawOptions);
  const inputs = loadAnalysisInputs(options.comparison);
  const definitions =
    inputs.track === "core"
      ? coreMetricDefinitions
      : agentMetricDefinitions;
  const pairwise: StatisticalComparisonArtifact["pairwise"] = [];
  for (
    let leftIndex = 0;
    leftIndex < inputs.reports.length - 1;
    leftIndex += 1
  ) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < inputs.reports.length;
      rightIndex += 1
    ) {
      const reportA = inputs.reports[leftIndex]!;
      const reportB = inputs.reports[rightIndex]!;
      pairwise.push({
        adapterA: reportA.adapter,
        adapterB: reportB.adapter,
        sharedClusters: reportA.evidence.clusters,
        sharedObservations: reportA.evidence.observations,
        metrics: definitions.map((definition) =>
          pairedMetric(
            definition,
            reportA,
            reportB,
            inputs.track,
            options.iterations,
            options.confidenceLevel,
            options.seed
          )
        ),
      });
    }
  }
  const method: StatisticalComparisonArtifact["method"] = {
    name: "paired-scenario-cluster-bootstrap-percentile",
    resamplingUnit: "scenario",
    comparison: "adapter-b-minus-adapter-a",
    interval: "percentile",
    rng: "xorshift32",
    iterations: options.iterations,
    confidenceLevel: options.confidenceLevel,
    seed: options.seed,
    multiplicityAdjustment: "none-descriptive-only",
  };
  const reports = inputs.reports.map((report) => report.evidence);
  const blockers = pairwise.flatMap((pair) =>
    pair.metrics
      .filter((result) => result.status === "insufficient-data")
      .map(
        (result) =>
          `${pair.adapterA}/${pair.adapterB} ${result.name} has fewer than two eligible scenario clusters`
      )
  );
  const identity = {
    track: inputs.track,
    comparison: inputs.comparison,
    method,
    reports,
    pairwise,
  };
  const artifact: StatisticalComparisonArtifact = {
    schemaVersion: 1,
    kind: "memory-bench-statistical-comparison",
    analysisId: `mbs-${sha256(canonicalJson(identity)).slice(0, 32)}`,
    createdAt: options.createdAt,
    track: inputs.track,
    comparison: inputs.comparison,
    method,
    reports,
    coverage: {
      adapters: reports.length,
      pairs: pairwise.length,
      clusterIdentityExact: true,
      observationIdentityExact: true,
      metricMissingnessExact: true,
    },
    pairwise,
    policy: {
      descriptiveOnly: true,
      rankingClaimed: false,
      statisticalSignificanceClaimed: false,
      rawQueriesIncluded: false,
      rawExpectedAnswersIncluded: false,
      rawHypothesesIncluded: false,
      rawEvidenceIncluded: false,
    },
    claim: {
      allIntervalsAvailable: blockers.length === 0,
      blockers: [...new Set(blockers)],
    },
  };
  validateArtifact(
    compileValidator(statisticalComparisonSchemaFile),
    artifact,
    "statistical comparison artifact"
  );
  return artifact;
}

export function loadStatisticalComparison(
  file: string
): LoadedArtifact<StatisticalComparisonArtifact> {
  return loadJson<StatisticalComparisonArtifact>(
    file,
    "statistical comparison artifact",
    statisticalComparisonSchemaFile
  );
}

export function assessStatisticalComparison(
  artifact: StatisticalComparisonArtifact,
  comparison: string
): StatisticalComparisonAssessment {
  const issues: string[] = [];
  try {
    validateArtifact(
      compileValidator(statisticalComparisonSchemaFile),
      artifact,
      "statistical comparison artifact"
    );
    const expected = createStatisticalComparison({
      comparison,
      iterations: artifact.method.iterations,
      confidenceLevel: artifact.method.confidenceLevel,
      seed: artifact.method.seed,
      createdAt: artifact.createdAt,
    });
    if (canonicalJson(artifact) !== canonicalJson(expected)) {
      issues.push(
        "statistical comparison differs from the supplied comparison and reports"
      );
    }
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : String(error)
    );
  }
  return {
    valid: issues.length === 0,
    issues: [...new Set(issues)],
  };
}
