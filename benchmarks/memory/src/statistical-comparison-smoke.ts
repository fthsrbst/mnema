import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FixtureEvidenceReader,
  FixtureJudge,
  LiteralAgentMemoryAdapter,
} from "./agent-components.js";
import {
  agentEvaluationFingerprint,
} from "./agent-comparison.js";
import { openAgentDataset } from "./agent-dataset.js";
import { runAgentBenchmark } from "./agent-runner.js";
import type {
  AgentBenchmarkReport,
  AgentComparisonManifest,
} from "./agent-types.js";
import { LiteralAdapter } from "./adapters/literal.js";
import { loadDataset } from "./dataset.js";
import { importLongMemEval } from "./longmemeval.js";
import { runBenchmark } from "./runner.js";
import {
  assessStatisticalComparison,
  createStatisticalComparison,
} from "./statistical-comparison.js";
import type {
  StatisticalMetricResult,
} from "./statistical-comparison-types.js";
import type {
  BenchmarkReport,
  ComparisonManifest,
} from "./types.js";

const coreDatasetFile = fileURLToPath(
  new URL("../datasets/core-draft-v0.1.json", import.meta.url)
);
const longMemEvalFixture = fileURLToPath(
  new URL("../fixtures/longmemeval-contract.json", import.meta.url)
);
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "memory-bench-statistics-")
);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function reportSha256(file: string): string {
  return sha256(fs.readFileSync(file));
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function metric(
  metrics: StatisticalMetricResult[],
  name: StatisticalMetricResult["name"]
): StatisticalMetricResult {
  const result = metrics.find((item) => item.name === name);
  assert(result, `missing statistical metric: ${name}`);
  return result;
}

async function runCli(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "benchmarks/memory/src/statistical-comparison-cli.ts",
      ...args,
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  return { exitCode, stdout, stderr };
}

try {
  const dataset = loadDataset(coreDatasetFile);
  const literalReport = await runBenchmark(
    dataset,
    new LiteralAdapter(),
    "statistics-core-literal"
  );
  const literalReportFile = path.join(
    temporaryDirectory,
    "literal-core-report.json"
  );
  writeJson(literalReportFile, literalReport);

  const mnemaReport = structuredClone(literalReport) as BenchmarkReport;
  mnemaReport.run.runId = "statistics-core-mnema";
  mnemaReport.run.adapter = {
    ...mnemaReport.run.adapter,
    name: "mnema",
    mode: "statistics-smoke-degraded-clone",
  };
  for (const trace of mnemaReport.queries.slice(0, 12)) {
    trace.passed = false;
  }
  mnemaReport.metrics.queryPassRate = round(
    mnemaReport.queries.filter((trace) => trace.passed).length /
      mnemaReport.queries.length
  );
  const mnemaReportFile = path.join(
    temporaryDirectory,
    "mnema-core-report.json"
  );
  writeJson(mnemaReportFile, mnemaReport);

  const coreComparison: ComparisonManifest = {
    schemaVersion: 1,
    comparisonId: "statistics-core-comparison",
    createdAt: "2026-07-27T13:00:00.000Z",
    dataset: {
      name: dataset.name,
      version: dataset.version,
      license: dataset.license,
      publicationStatus: dataset.publicationStatus,
      file: path.basename(coreDatasetFile),
      sha256: sha256(fs.readFileSync(coreDatasetFile)),
    },
    source: {
      gitCommit: "0".repeat(40),
      gitDirty: true,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpuModel: os.cpus()[0]?.model ?? null,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    policy: {
      processIsolation: "one-process-per-adapter",
      runtimeFailureAffectsCommandExit: true,
      queryFailureAffectsCommandExit: false,
    },
    runs: [
      {
        adapter: "literal",
        status: "completed",
        exitCode: 0,
        durationMs: literalReport.run.durationMs,
        reportFile: path.basename(literalReportFile),
        reportSha256: reportSha256(literalReportFile),
        queryFailures: literalReport.queries.filter((trace) => !trace.passed)
          .length,
        metrics: literalReport.metrics,
        adapterInfo: literalReport.run.adapter,
        adapterTelemetry: literalReport.run.adapterTelemetry,
        error: null,
      },
      {
        adapter: "mnema",
        status: "completed",
        exitCode: 1,
        durationMs: mnemaReport.run.durationMs,
        reportFile: path.basename(mnemaReportFile),
        reportSha256: reportSha256(mnemaReportFile),
        queryFailures: mnemaReport.queries.filter((trace) => !trace.passed)
          .length,
        metrics: mnemaReport.metrics,
        adapterInfo: mnemaReport.run.adapter,
        adapterTelemetry: mnemaReport.run.adapterTelemetry,
        error: null,
      },
    ],
  };
  const coreComparisonFile = path.join(
    temporaryDirectory,
    "core-comparison.json"
  );
  writeJson(coreComparisonFile, coreComparison);

  const coreOptions = {
    comparison: coreComparisonFile,
    iterations: 2_000,
    confidenceLevel: 0.95,
    seed: 20_260_727,
  };
  const firstCoreArtifact = createStatisticalComparison({
    ...coreOptions,
    createdAt: "2026-07-27T13:01:00.000Z",
  });
  const secondCoreArtifact = createStatisticalComparison({
    ...coreOptions,
    createdAt: "2026-07-27T13:02:00.000Z",
  });
  assert.equal(firstCoreArtifact.track, "core");
  assert.equal(firstCoreArtifact.pairwise.length, 1);
  assert.equal(
    firstCoreArtifact.analysisId,
    secondCoreArtifact.analysisId,
    "analysis identity must not depend on wall-clock time"
  );
  assert.deepEqual(
    firstCoreArtifact.pairwise,
    secondCoreArtifact.pairwise,
    "the same seed and evidence must reproduce byte-equivalent estimates"
  );
  const corePassRate = metric(
    firstCoreArtifact.pairwise[0]!.metrics,
    "query-pass-rate"
  );
  assert.equal(corePassRate.status, "estimated");
  assert.equal(corePassRate.pairedObservations, 120);
  assert.equal(corePassRate.eligibleClusters, 120);
  assert.equal(corePassRate.pointEstimate?.adapterB, 0.9);
  assert.equal(corePassRate.pointEstimate?.bMinusA, -0.1);
  assert(corePassRate.confidenceInterval);
  assert(corePassRate.confidenceInterval.upper < 0);
  assert.equal(firstCoreArtifact.claim.allIntervalsAvailable, true);

  const coreAssessment = assessStatisticalComparison(
    firstCoreArtifact,
    coreComparisonFile
  );
  assert.equal(
    coreAssessment.valid,
    true,
    coreAssessment.issues.join("\n")
  );

  const originalMnemaBytes = fs.readFileSync(mnemaReportFile);
  const tamperedMnema = structuredClone(mnemaReport);
  tamperedMnema.queries[0]!.query = "tampered after statistical analysis";
  writeJson(mnemaReportFile, tamperedMnema);
  const tamperedAssessment = assessStatisticalComparison(
    firstCoreArtifact,
    coreComparisonFile
  );
  assert.equal(tamperedAssessment.valid, false);
  assert.match(tamperedAssessment.issues.join("\n"), /SHA-256/i);
  fs.writeFileSync(mnemaReportFile, originalMnemaBytes);

  const mismatchedReport = structuredClone(mnemaReport);
  mismatchedReport.queries[0]!.queryId = "mismatched-query-id";
  writeJson(mnemaReportFile, mismatchedReport);
  const mismatchedComparison = structuredClone(coreComparison);
  mismatchedComparison.runs[1]!.reportSha256 =
    reportSha256(mnemaReportFile);
  writeJson(coreComparisonFile, mismatchedComparison);
  assert.throws(
    () =>
      createStatisticalComparison({
        ...coreOptions,
        comparison: coreComparisonFile,
      }),
    /observation identities differ/i,
    "unpaired query sets must never produce confidence intervals"
  );
  writeJson(mnemaReportFile, mnemaReport);
  writeJson(coreComparisonFile, coreComparison);

  const cliArtifactFile = path.join(
    temporaryDirectory,
    "core-statistical-comparison.json"
  );
  const cliCreate = await runCli([
    "create",
    `--comparison=${coreComparisonFile}`,
    `--output=${cliArtifactFile}`,
    "--iterations=2000",
    "--confidence-level=0.95",
    "--seed=20260727",
  ]);
  assert.equal(cliCreate.exitCode, 0, cliCreate.stderr);
  assert.match(cliCreate.stdout, /"allIntervalsAvailable": true/);
  assert.equal(fs.existsSync(cliArtifactFile), true);
  const cliCheck = await runCli([
    "check",
    `--artifact=${cliArtifactFile}`,
    `--comparison=${coreComparisonFile}`,
  ]);
  assert.equal(cliCheck.exitCode, 0, cliCheck.stderr);
  assert.match(cliCheck.stdout, /"valid": true/);

  const agentDatasetFile = path.join(
    temporaryDirectory,
    "agent-dataset.json"
  );
  await importLongMemEval({
    input: longMemEvalFixture,
    output: agentDatasetFile,
    source: {
      revision: "statistics-smoke-fixture-v1",
      subset: "oracle",
      uri: "https://example.invalid/longmemeval-contract.json",
      license: "MIT",
    },
  });
  const literalAgentReport = await runAgentBenchmark(
    await openAgentDataset(agentDatasetFile),
    new LiteralAgentMemoryAdapter(),
    new FixtureEvidenceReader(),
    new FixtureJudge(),
    {
      runId: "statistics-agent-literal",
      topK: 1,
    }
  );
  const literalAgentFile = path.join(
    temporaryDirectory,
    "literal-agent-report.json"
  );
  writeJson(literalAgentFile, literalAgentReport);

  const mnemaAgentReport = structuredClone(
    literalAgentReport
  ) as AgentBenchmarkReport;
  mnemaAgentReport.run.runId = "statistics-agent-mnema";
  mnemaAgentReport.run.components.adapter = {
    ...mnemaAgentReport.run.components.adapter,
    name: "mnema",
  };
  mnemaAgentReport.scenarios[0]!.qaPassed = false;
  mnemaAgentReport.metrics.qaAccuracy = round(
    mnemaAgentReport.scenarios.filter(
      (trace) => trace.qaPassed !== null
    ).filter((trace) => trace.qaPassed).length /
      mnemaAgentReport.scenarios.filter(
        (trace) => trace.qaPassed !== null
      ).length
  );
  const mnemaAgentFile = path.join(
    temporaryDirectory,
    "mnema-agent-report.json"
  );
  writeJson(mnemaAgentFile, mnemaAgentReport);

  const evaluationSha256 =
    agentEvaluationFingerprint(literalAgentReport);
  assert.equal(
    agentEvaluationFingerprint(mnemaAgentReport),
    evaluationSha256
  );
  const agentComparison: AgentComparisonManifest = {
    schemaVersion: 1,
    kind: "memory-bench-agent-comparison",
    comparisonId: "statistics-agent-comparison",
    createdAt: "2026-07-27T13:10:00.000Z",
    dataset: {
      name: literalAgentReport.run.dataset.name,
      version: literalAgentReport.run.dataset.version,
      license: literalAgentReport.run.dataset.license,
      track: literalAgentReport.run.dataset.track,
      language: literalAgentReport.run.dataset.language,
      subset: literalAgentReport.run.dataset.subset,
      sourceRevision: literalAgentReport.run.dataset.sourceRevision,
      sourceSha256: literalAgentReport.run.dataset.sourceSha256,
      artifactFile: path.basename(agentDatasetFile),
      artifactSha256:
        literalAgentReport.run.dataset.artifactSha256,
      artifactBytes: literalAgentReport.run.dataset.artifactBytes,
    },
    source: {
      gitCommit: "0".repeat(40),
      gitDirty: true,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpuModel: os.cpus()[0]?.model ?? null,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    evaluation: {
      reader: "fixture",
      readerModel: null,
      judge: "fixture",
      judgeModel: null,
      topK: literalAgentReport.run.topK,
      maxScenarios: literalAgentReport.run.maxScenarios,
      configurationSha256: evaluationSha256,
    },
    policy: {
      processIsolation: "one-process-per-adapter",
      executionOrder: "sequential",
      runtimeFailureAffectsCommandExit: true,
      qaFailureAffectsCommandExit: false,
    },
    claim: {
      resultClass: "harness",
      comparable: true,
      publicationEligible: false,
      blockers: [
        "fixture components are harness-only statistical contract evidence",
      ],
    },
    runs: [
      {
        adapter: "literal",
        status: "completed",
        processId: process.pid,
        exitCode: 0,
        durationMs: literalAgentReport.run.durationMs,
        reportStatus: "completed",
        reportFile: path.basename(literalAgentFile),
        reportSha256: reportSha256(literalAgentFile),
        evaluationSha256,
        resultClass: "harness",
        runtimeFailures: 0,
        metrics: literalAgentReport.metrics,
        components: literalAgentReport.run.components,
        telemetry: literalAgentReport.run.telemetry,
        error: null,
      },
      {
        adapter: "mnema",
        status: "completed",
        processId: process.pid + 1,
        exitCode: 0,
        durationMs: mnemaAgentReport.run.durationMs,
        reportStatus: "completed",
        reportFile: path.basename(mnemaAgentFile),
        reportSha256: reportSha256(mnemaAgentFile),
        evaluationSha256,
        resultClass: "harness",
        runtimeFailures: 0,
        metrics: mnemaAgentReport.metrics,
        components: mnemaAgentReport.run.components,
        telemetry: mnemaAgentReport.run.telemetry,
        error: null,
      },
    ],
  };
  const agentComparisonFile = path.join(
    temporaryDirectory,
    "agent-comparison.json"
  );
  writeJson(agentComparisonFile, agentComparison);
  const agentArtifact = createStatisticalComparison({
    comparison: agentComparisonFile,
    iterations: 2_000,
    confidenceLevel: 0.95,
    seed: 20_260_727,
    createdAt: "2026-07-27T13:11:00.000Z",
  });
  assert.equal(agentArtifact.track, "agent");
  assert.equal(agentArtifact.pairwise.length, 1);
  const qaAccuracy = metric(
    agentArtifact.pairwise[0]!.metrics,
    "qa-accuracy"
  );
  assert.equal(qaAccuracy.status, "estimated");
  assert.equal(qaAccuracy.eligibleClusters, 2);
  assert.equal(qaAccuracy.pairedObservations, 2);
  assert.equal(qaAccuracy.pointEstimate?.bMinusA, -0.5);
  assert(qaAccuracy.confidenceInterval);
  assert.equal(
    assessStatisticalComparison(
      agentArtifact,
      agentComparisonFile
    ).valid,
    true
  );
  const mismatchedAgentDataset = structuredClone(agentComparison);
  mismatchedAgentDataset.dataset.version = "tampered-version";
  writeJson(agentComparisonFile, mismatchedAgentDataset);
  assert.throws(
    () =>
      createStatisticalComparison({
        comparison: agentComparisonFile,
        iterations: 2_000,
        confidenceLevel: 0.95,
        seed: 20_260_727,
      }),
    /dataset identity differs/i
  );
  writeJson(agentComparisonFile, agentComparison);

  assert.throws(
    () =>
      createStatisticalComparison({
        comparison: coreComparisonFile,
        iterations: 999,
        confidenceLevel: 0.95,
        seed: 20_260_727,
      }),
    /iterations/i
  );
  assert.throws(
    () =>
      createStatisticalComparison({
        comparison: coreComparisonFile,
        iterations: 2_000,
        confidenceLevel: 1,
        seed: 20_260_727,
      }),
    /confidence level/i
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        tracks: ["core", "agent"],
        method: "paired-scenario-cluster-bootstrap-percentile",
        deterministicSeedVerified: true,
        cliRoundTripVerified: true,
        reportTamperingRejected: true,
        unpairedObservationsRejected: true,
        significanceClaimed: false,
      },
      null,
      2
    )
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
