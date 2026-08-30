import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Ajv2020,
  type AnySchemaObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import {
  FixtureEvidenceReader,
  FixtureJudge,
  LiteralAgentMemoryAdapter,
} from "./agent-components.js";
import {
  officialLongMemEvalEvaluatorRevision,
  officialLongMemEvalEvaluatorScriptSha256,
  officialLongMemEvalEvaluatorScriptUri,
} from "./agent-openai.js";
import { openAgentDataset } from "./agent-dataset.js";
import { runAgentBenchmark } from "./agent-runner.js";
import { LiteralAdapter } from "./adapters/literal.js";
import { loadDataset, parseDataset } from "./dataset.js";
import { importLongMemEval } from "./longmemeval.js";
import {
  createReviewOverlayTemplate,
  createReviewPacket,
  reviewArtifactSha256,
} from "./review.js";
import { runBenchmark } from "./runner.js";
import type { ComparisonManifest } from "./types.js";
import type {
  AgentComparisonManifest,
  AgentIngestSession,
  EvaluatorParityArtifact,
} from "./agent-types.js";
import type { ComponentQualification } from "./qualification.js";
import type { AgentPublicationManifest } from "./publication.js";
import type {
  StatisticalComparisonArtifact,
} from "./statistical-comparison.js";
import {
  agentMemoryAbilities,
  longMemEvalQuestionTypes,
} from "./agent-types.js";

class FirstIngestFailingAdapter extends LiteralAgentMemoryAdapter {
  private failed = false;

  override async ingest(session: AgentIngestSession): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("schema-smoke injected ingestion failure");
    }
    await super.ingest(session);
  }
}

const schemaDirectory = fileURLToPath(
  new URL("../schemas/v1", import.meta.url)
);
const datasetFile = fileURLToPath(
  new URL("../datasets/core-smoke-v1.json", import.meta.url)
);
const draftFile = fileURLToPath(
  new URL("../datasets/core-draft-v0.1.json", import.meta.url)
);
const longMemEvalFixture = fileURLToPath(
  new URL("../fixtures/longmemeval-contract.json", import.meta.url)
);
const schemaFiles = [
  "dataset.schema.json",
  "agent-dataset.schema.json",
  "report.schema.json",
  "agent-report.schema.json",
  "comparison-manifest.schema.json",
  "agent-comparison-manifest.schema.json",
  "statistical-comparison.schema.json",
  "evaluator-parity.schema.json",
  "component-qualification.schema.json",
  "agent-publication.schema.json",
  "review-packet.schema.json",
  "review-overlay.schema.json",
] as const;

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;
const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
});
addFormats(ajv);

const validators = new Map<string, ValidateFunction>();
for (const name of schemaFiles) {
  const schema = JSON.parse(
    fs.readFileSync(`${schemaDirectory}/${name}`, "utf8")
  ) as AnySchemaObject;
  validators.set(name, ajv.compile(schema));
}

function validate(name: (typeof schemaFiles)[number], value: unknown): void {
  const validator = validators.get(name)!;
  assert(
    validator(value),
    `${name} rejected a valid artifact: ${ajv.errorsText(validator.errors, {
      separator: "\n",
    })}`
  );
}

function rejects(name: (typeof schemaFiles)[number], value: unknown): void {
  const validator = validators.get(name)!;
  assert.equal(
    validator(value),
    false,
    `${name} accepted an invalid artifact`
  );
}

const dataset = loadDataset(datasetFile);
const draftDataset = loadDataset(draftFile);
validate(
  "dataset.schema.json",
  JSON.parse(fs.readFileSync(datasetFile, "utf8")) as unknown
);
validate(
  "dataset.schema.json",
  JSON.parse(fs.readFileSync(draftFile, "utf8")) as unknown
);

const packet = createReviewPacket(
  draftDataset,
  reviewArtifactSha256(fs.readFileSync(draftFile))
);
const overlay = createReviewOverlayTemplate(packet);
validate("review-packet.schema.json", packet);
validate("review-overlay.schema.json", overlay);
const verifiedOverlay = structuredClone(overlay);
verifiedOverlay.reviewer = {
  id: "schema-smoke-reviewer",
  type: "human",
  affiliation: "independent-reviewers",
  conflicts: [],
};
verifiedOverlay.maintainer = {
  id: "schema-smoke-maintainer",
  type: "human",
  affiliation: "memory-bench-maintainers",
  verifiedAt: "2026-07-27T12:31:00.000Z",
  reviewerIdentityVerified: true,
  conflictsReviewed: true,
  disposition: "No disqualifying reviewer conflict was identified.",
};
verifiedOverlay.attestation = {
  independentFromScenarioAuthors: true,
  rightsToPublish: true,
  noPrivateOrSecretData: true,
};
verifiedOverlay.reviewedAt = "2026-07-27T12:30:00.000Z";
verifiedOverlay.decisions[0] = {
  ...verifiedOverlay.decisions[0]!,
  decision: "approve",
  note: "Schema smoke review evidence.",
};
validate("review-overlay.schema.json", verifiedOverlay);
const invalidMaintainerOverlay = structuredClone(verifiedOverlay);
(
  invalidMaintainerOverlay.maintainer as {
    type: string;
  }
).type = "ai";
rejects("review-overlay.schema.json", invalidMaintainerOverlay);

const report = await runBenchmark(
  dataset,
  new LiteralAdapter(),
  "schema-smoke-literal"
);
validate("report.schema.json", report);

const comparison: ComparisonManifest = {
  schemaVersion: 1,
  comparisonId: "schema-smoke-comparison",
  createdAt: "2026-07-27T12:30:00.000Z",
  dataset: {
    name: dataset.name,
    version: dataset.version,
    license: dataset.license,
    publicationStatus: dataset.publicationStatus,
    file: "benchmarks/memory/datasets/core-smoke-v1.json",
    sha256: reviewArtifactSha256(fs.readFileSync(datasetFile)),
  },
  source: {
    gitCommit: "0".repeat(40),
    gitDirty: true,
  },
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: "schema-smoke",
    cpuModel: null,
    logicalCpuCount: 1,
    totalMemoryBytes: 1,
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
      durationMs: report.run.durationMs,
      reportFile: "schema-smoke-literal.json",
      reportSha256: "1".repeat(64),
      queryFailures: 0,
      metrics: report.metrics,
      adapterInfo: report.run.adapter,
      adapterTelemetry: report.run.adapterTelemetry,
      error: null,
    },
  ],
};
validate("comparison-manifest.schema.json", comparison);

const statisticalMetric = (
  name: StatisticalComparisonArtifact["pairwise"][number]["metrics"][number]["name"],
  direction: StatisticalComparisonArtifact["pairwise"][number]["metrics"][number]["direction"]
): StatisticalComparisonArtifact["pairwise"][number]["metrics"][number] => ({
  name,
  direction,
  status: "estimated",
  eligibleClusters: 7,
  pairedObservations: 7,
  pointEstimate: {
    adapterA: 1,
    adapterB: 0.8,
    bMinusA: -0.2,
  },
  confidenceInterval: {
    lower: -0.5,
    upper: 0,
  },
});
const statisticalComparison: StatisticalComparisonArtifact = {
  schemaVersion: 1,
  kind: "memory-bench-statistical-comparison",
  analysisId: `mbs-${"a".repeat(32)}`,
  createdAt: "2026-07-27T12:20:00.000Z",
  track: "core",
  comparison: {
    file: "core-comparison.json",
    sha256: "b".repeat(64),
    comparisonId: comparison.comparisonId,
    datasetSha256: comparison.dataset.sha256,
    evaluationSha256: null,
  },
  method: {
    name: "paired-scenario-cluster-bootstrap-percentile",
    resamplingUnit: "scenario",
    comparison: "adapter-b-minus-adapter-a",
    interval: "percentile",
    rng: "xorshift32",
    iterations: 10_000,
    confidenceLevel: 0.95,
    seed: 20_260_727,
    multiplicityAdjustment: "none-descriptive-only",
  },
  reports: [
    {
      adapter: "literal",
      file: "literal-report.json",
      sha256: "c".repeat(64),
      clusters: 7,
      observations: 7,
    },
    {
      adapter: "mnema",
      file: "mnema-report.json",
      sha256: "d".repeat(64),
      clusters: 7,
      observations: 7,
    },
  ],
  coverage: {
    adapters: 2,
    pairs: 1,
    clusterIdentityExact: true,
    observationIdentityExact: true,
    metricMissingnessExact: true,
  },
  pairwise: [
    {
      adapterA: "literal",
      adapterB: "mnema",
      sharedClusters: 7,
      sharedObservations: 7,
      metrics: [
        statisticalMetric("query-pass-rate", "higher-is-better"),
        statisticalMetric("macro-recall-at-k", "higher-is-better"),
        statisticalMetric(
          "macro-precision-at-k",
          "higher-is-better"
        ),
        statisticalMetric(
          "mean-reciprocal-rank",
          "higher-is-better"
        ),
        statisticalMetric("forbidden-hit-rate", "lower-is-better"),
        statisticalMetric(
          "abstention-accuracy",
          "higher-is-better"
        ),
      ],
    },
  ],
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
    allIntervalsAvailable: true,
    blockers: [],
  },
};
validate(
  "statistical-comparison.schema.json",
  statisticalComparison
);
const invalidEstimatedStatistics = structuredClone(
  statisticalComparison
);
invalidEstimatedStatistics.pairwise[0]!.metrics[0]!.confidenceInterval =
  null;
rejects(
  "statistical-comparison.schema.json",
  invalidEstimatedStatistics
);

const importDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "memory-bench-schema-import-")
);
const importedLongMemEvalFile = path.join(
  importDirectory,
  "longmemeval-agent-dataset.json"
);
try {
  const imported = await importLongMemEval({
    input: longMemEvalFixture,
    output: importedLongMemEvalFile,
    source: {
      revision: "schema-fixture-v1",
      subset: "oracle",
      uri: "https://example.invalid/longmemeval-contract.json",
      license: "MIT",
    },
  });
  assert.equal(imported.scenarios, 2);
  const agentDataset = JSON.parse(
    fs.readFileSync(importedLongMemEvalFile, "utf8")
  ) as Record<string, unknown>;
  validate("agent-dataset.schema.json", agentDataset);
  const agentReport = await runAgentBenchmark(
    await openAgentDataset(importedLongMemEvalFile),
    new LiteralAgentMemoryAdapter(),
    new FixtureEvidenceReader(),
    new FixtureJudge(),
    {
      runId: "schema-smoke-agent",
      topK: 1,
    }
  );
  validate("agent-report.schema.json", agentReport);
  const failedAgentReport = await runAgentBenchmark(
    await openAgentDataset(importedLongMemEvalFile),
    new FirstIngestFailingAdapter(),
    new FixtureEvidenceReader(),
    new FixtureJudge(),
    {
      runId: "schema-smoke-agent-ingest-failure",
      topK: 1,
    }
  );
  assert.equal(failedAgentReport.scenarios[0]!.status, "failed");
  assert.equal(failedAgentReport.scenarios[0]!.retrievalEvaluated, false);
  validate("agent-report.schema.json", failedAgentReport);

  const evaluationSha256 = "2".repeat(64);
  const agentComparison: AgentComparisonManifest = {
    schemaVersion: 1,
    kind: "memory-bench-agent-comparison",
    comparisonId: "schema-smoke-agent-comparison",
    createdAt: "2026-07-27T12:30:00.000Z",
    dataset: {
      name: agentReport.run.dataset.name,
      version: agentReport.run.dataset.version,
      license: agentReport.run.dataset.license,
      track: agentReport.run.dataset.track,
      language: agentReport.run.dataset.language,
      subset: agentReport.run.dataset.subset,
      sourceRevision: agentReport.run.dataset.sourceRevision,
      sourceSha256: agentReport.run.dataset.sourceSha256,
      artifactFile: "artifacts/memory-bench/agent-dataset.json",
      artifactSha256: agentReport.run.dataset.artifactSha256,
      artifactBytes: agentReport.run.dataset.artifactBytes,
    },
    source: {
      gitCommit: "0".repeat(40),
      gitDirty: true,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: "schema-smoke",
      cpuModel: null,
      logicalCpuCount: 1,
      totalMemoryBytes: 1,
    },
    evaluation: {
      reader: "fixture",
      readerModel: null,
      judge: "fixture",
      judgeModel: null,
      topK: agentReport.run.topK,
      maxScenarios: agentReport.run.maxScenarios,
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
        "harness components are contract evidence only and cannot support publication claims",
      ],
    },
    runs: [
      {
        adapter: "literal",
        status: "completed",
        processId: process.pid,
        exitCode: 0,
        durationMs: agentReport.run.durationMs,
        reportStatus: "completed",
        reportFile: "literal-agent-report.json",
        reportSha256: "3".repeat(64),
        evaluationSha256,
        resultClass: "harness",
        runtimeFailures: 0,
        metrics: agentReport.metrics,
        components: agentReport.run.components,
        telemetry: agentReport.run.telemetry,
        error: null,
      },
      {
        adapter: "mnema",
        status: "completed",
        processId: process.pid + 1,
        exitCode: 0,
        durationMs: agentReport.run.durationMs,
        reportStatus: "completed",
        reportFile: "mnema-agent-report.json",
        reportSha256: "4".repeat(64),
        evaluationSha256,
        resultClass: "harness",
        runtimeFailures: 0,
        metrics: agentReport.metrics,
        components: {
          ...agentReport.run.components,
          adapter: {
            ...agentReport.run.components.adapter,
            name: "mnema",
          },
        },
        telemetry: agentReport.run.telemetry,
        error: null,
      },
    ],
  };
  validate("agent-comparison-manifest.schema.json", agentComparison);

  const invalidCompletedAgentComparison = structuredClone(agentComparison);
  invalidCompletedAgentComparison.runs[0]!.exitCode = 1;
  rejects(
    "agent-comparison-manifest.schema.json",
    invalidCompletedAgentComparison
  );

  const invalidPublishedAgentComparison = structuredClone(agentComparison);
  invalidPublishedAgentComparison.claim.publicationEligible = true;
  rejects(
    "agent-comparison-manifest.schema.json",
    invalidPublishedAgentComparison
  );

  const emptyParitySlice = {
    compared: 0,
    matches: 0,
    mismatches: 0,
    agreementRate: null,
  };
  const evaluatorParity: EvaluatorParityArtifact = {
    schemaVersion: 1,
    kind: "memory-bench-evaluator-parity",
    parityId: "schema-smoke-evaluator-parity",
    createdAt: "2026-07-27T12:30:00.000Z",
    candidate: {
      reportFile: "agent-report.json",
      reportSha256: "5".repeat(64),
      runId: agentReport.run.runId,
      reportStatus: agentReport.run.status,
      resultClass: agentReport.run.resultClass,
      dataset: {
        name: agentReport.run.dataset.name,
        version: agentReport.run.dataset.version,
        subset: agentReport.run.dataset.subset,
        sourceRevision: agentReport.run.dataset.sourceRevision,
        sourceSha256: agentReport.run.dataset.sourceSha256,
        artifactSha256: agentReport.run.dataset.artifactSha256,
      },
      judge: {
        name: agentReport.run.components.judge.name,
        model: null,
        promptRevision: null,
        apiSurface: null,
        decisionRule: null,
      },
    },
    official: {
      resultsFile: "official-results.jsonl",
      resultsSha256: "6".repeat(64),
      resultModels: ["gpt-4o-2024-08-06"],
      evaluatorRevision: officialLongMemEvalEvaluatorRevision,
      scriptUri: officialLongMemEvalEvaluatorScriptUri,
      scriptSha256: officialLongMemEvalEvaluatorScriptSha256,
      apiSurface: "chat-completions",
      decisionRule: "case-insensitive-yes-substring",
    },
    coverage: {
      reportDecisions: agentReport.scenarios.length,
      officialDecisions: agentReport.scenarios.length,
      candidateOnlyIds: [],
      officialOnlyIds: [],
      hypothesisMismatchIds: [],
    },
    compatibility: {
      reportComplete: true,
      nonEmptyDecisionSet: true,
      completeCoverage: true,
      hypothesesExact: true,
      modelExact: false,
      promptRevisionPinned: false,
      comparable: false,
    },
    metrics: {
      compared: 0,
      labelMatches: 0,
      labelMismatches: 0,
      agreementRate: null,
      exactAgreement: false,
      confusion: {
        bothPass: 0,
        candidateOnlyPass: 0,
        officialOnlyPass: 0,
        bothFail: 0,
      },
      slices: {
        byAbility: Object.fromEntries(
          agentMemoryAbilities.map((ability) => [
            ability,
            { ...emptyParitySlice },
          ])
        ) as EvaluatorParityArtifact["metrics"]["slices"]["byAbility"],
        byQuestionType: Object.fromEntries(
          longMemEvalQuestionTypes.map((questionType) => [
            questionType,
            { ...emptyParitySlice },
          ])
        ) as EvaluatorParityArtifact["metrics"]["slices"]["byQuestionType"],
      },
    },
    policy: {
      labelMismatchAffectsCommandExit: false,
      requireExactAffectsCommandExit: true,
      rawQuestionsIncluded: false,
      rawExpectedAnswersIncluded: false,
      rawHypothesesIncluded: false,
      rawEvidenceIncluded: false,
    },
    claim: {
      evidenceClass: "harness",
      exactAgreement: false,
      publicationEligible: false,
      blockers: [
        "schema smoke uses fixture components and cannot support publication",
      ],
    },
    mismatches: [],
  };
  validate("evaluator-parity.schema.json", evaluatorParity);
  const invalidExactParity = structuredClone(evaluatorParity);
  invalidExactParity.metrics.exactAgreement = true;
  invalidExactParity.claim.exactAgreement = true;
  rejects("evaluator-parity.schema.json", invalidExactParity);

  const componentQualification: ComponentQualification = {
    schemaVersion: 1,
    kind: "memory-bench-component-qualification",
    qualificationId: `mbq-adapter-${"7".repeat(32)}`,
    subject: {
      role: "adapter",
      component: {
        ...agentReport.run.components.adapter,
        classification: "candidate",
      },
      componentSha256: "7".repeat(64),
    },
    evidence: {
      agentReport: {
        file: "agent-report.json",
        sha256: "8".repeat(64),
        runId: agentReport.run.runId,
        reportStatus: agentReport.run.status,
        resultClass: agentReport.run.resultClass,
        datasetArtifactSha256:
          agentReport.run.dataset.artifactSha256,
        scenarios: agentReport.metrics.scenarios,
        runtimeFailures: agentReport.metrics.runtimeFailures,
        cleanupVerificationRate:
          agentReport.metrics.cleanupVerificationRate,
      },
      coreReport: {
        file: "core-report.json",
        sha256: "9".repeat(64),
        runId: report.run.runId,
        datasetName: report.run.dataset.name,
        datasetVersion: report.run.dataset.version,
        datasetPublicationStatus:
          report.run.dataset.publicationStatus,
        adapterName: report.run.adapter.name,
        adapterVersion: report.run.adapter.version,
        adapterInfoSha256: "a".repeat(64),
        queries: report.metrics.queries,
        queryFailures: report.queries.filter((query) => !query.passed)
          .length,
        cleanupVerified:
          report.run.adapterTelemetry.cleanup.verified,
        operationCounts: {
          write: report.metrics.operationLatency.write.count,
          update: report.metrics.operationLatency.update.count,
          delete: report.metrics.operationLatency.delete.count,
          query: report.metrics.operationLatency.query.count,
        },
      },
      evaluatorParity: null,
    },
    submitter: null,
    reviewer: null,
    maintainer: null,
    attestation: null,
    decision: "pending",
    decisionNote: null,
  };
  validate(
    "component-qualification.schema.json",
    componentQualification
  );
  const invalidQualifiedComponent = structuredClone(
    componentQualification
  );
  invalidQualifiedComponent.decision = "qualified";
  invalidQualifiedComponent.decisionNote = "Missing required review blocks.";
  rejects(
    "component-qualification.schema.json",
    invalidQualifiedComponent
  );

  assert(agentComparison.evaluation.configurationSha256);
  const publicationRuns = agentComparison.runs.map((run, index) => {
    assert(run.processId);
    assert(run.reportFile);
    assert(run.reportSha256);
    return {
      adapter: run.adapter,
      processId: run.processId,
      reportFile: run.reportFile,
      reportSha256: run.reportSha256,
      resultClass: "candidate" as const,
      componentSha256: {
        adapter: `${index + 1}`.repeat(64),
        reader: "d".repeat(64),
        judge: "e".repeat(64),
      },
      evaluatorParityFile: null,
      evaluatorParitySha256: null,
    };
  });
  const draftPublication: AgentPublicationManifest = {
    schemaVersion: 1,
    kind: "memory-bench-agent-publication",
    publicationId: `mbp-${"b".repeat(32)}`,
    status: "draft",
    assembledAt: "2026-07-27T12:30:00.000Z",
    finalizedAt: null,
    comparison: {
      file: "agent-comparison.json",
      sha256: "c".repeat(64),
      comparisonId: agentComparison.comparisonId,
      datasetArtifactSha256:
        agentComparison.dataset.artifactSha256,
      evaluationSha256:
        agentComparison.evaluation.configurationSha256,
      sourceCommit: null,
      sourceDirty: true,
    },
    runs: publicationRuns,
    qualifications: [],
    statistics: null,
    release: null,
    claim: {
      resultClass: "candidate",
      mechanicallyVerified: false,
      publicationEligible: false,
      blockers: ["publication evidence is incomplete"],
    },
  };
  validate("agent-publication.schema.json", draftPublication);

  const finalPublication = structuredClone(draftPublication);
  finalPublication.status = "final";
  finalPublication.finalizedAt = "2026-07-27T12:45:00.000Z";
  finalPublication.comparison.sourceCommit = "f".repeat(40);
  finalPublication.comparison.sourceDirty = false;
  for (const run of finalPublication.runs) {
    run.evaluatorParityFile = `${run.adapter}-parity.json`;
    run.evaluatorParitySha256 = "1".repeat(64);
  }
  finalPublication.qualifications = [
    {
      file: "adapter-qualification.json",
      sha256: "2".repeat(64),
      qualificationId: `mbq-adapter-${"3".repeat(32)}`,
      role: "adapter",
      componentName: "literal",
      componentSha256:
        finalPublication.runs[0]!.componentSha256.adapter,
      reviewerId: "independent-reviewer",
      maintainerId: "memory-bench-maintainer",
    },
  ];
  finalPublication.statistics = {
    file: "agent-statistical-comparison.json",
    sha256: "4".repeat(64),
    analysisId: `mbs-${"5".repeat(32)}`,
    comparisonSha256: finalPublication.comparison.sha256,
    iterations: 10_000,
    confidenceLevel: 0.95,
    seed: 20_260_727,
    allIntervalsAvailable: true,
  };
  finalPublication.release = {
    version: "v0.1.0",
    releasedAt: "2026-07-27T12:45:00.000Z",
    publisher: {
      id: "memory-bench-publisher",
      type: "organization",
      affiliation: "Memory Bench",
    },
    maintainer: {
      id: "memory-bench-maintainer",
      type: "human",
      affiliation: "Memory Bench",
    },
    evidenceBundleUri:
      "https://example.invalid/memory-bench/evidence/v0.1.0",
    releaseNotesUri:
      "https://example.invalid/memory-bench/releases/v0.1.0",
    correctionsUri:
      "https://example.invalid/memory-bench/corrections",
    providerAffiliations: [],
    sponsorships: [],
    knownLimitations: [
      "Schema smoke validates structure, not live provider evidence.",
    ],
    attestation: {
      datasetRightsVerified: true,
      noQuerySpecificTuning: true,
      providerDisclosuresComplete: true,
      sponsorshipDisclosuresComplete: true,
      allEvidencePublished: true,
      independentAuditComplete: true,
      secretsExcluded: true,
      correctionsPolicyAccepted: true,
    },
  };
  finalPublication.claim = {
    resultClass: "benchmark",
    mechanicallyVerified: true,
    publicationEligible: true,
    blockers: [],
  };
  validate("agent-publication.schema.json", finalPublication);

  const invalidFinalPublication = structuredClone(finalPublication);
  invalidFinalPublication.runs[0]!.evaluatorParityFile = null;
  invalidFinalPublication.runs[0]!.evaluatorParitySha256 = null;
  rejects(
    "agent-publication.schema.json",
    invalidFinalPublication
  );

  const invalidAgentDataset = structuredClone(agentDataset) as {
    scenarios: Array<{
      sessions: Array<{
        messages: Array<{
          role: string;
        }>;
      }>;
    }>;
  };
  invalidAgentDataset.scenarios[0]!.sessions[0]!.messages[0]!.role = "system";
  rejects("agent-dataset.schema.json", invalidAgentDataset);

  const invalidAgentReport = structuredClone(agentReport);
  invalidAgentReport.scenarios[1]!.retrievalEvaluated = true;
  rejects("agent-report.schema.json", invalidAgentReport);
} finally {
  fs.rmSync(importDirectory, { recursive: true, force: true });
}

const invalidDataset = JSON.parse(
  fs.readFileSync(datasetFile, "utf8")
) as Record<string, unknown>;
invalidDataset.unexpected = true;
rejects("dataset.schema.json", invalidDataset);

const duplicateExpectation = structuredClone(draftDataset);
const duplicateQuery = duplicateExpectation.scenarios[0]!.operations.find(
  (operation) => operation.op === "query"
);
assert(duplicateQuery?.op === "query");
duplicateQuery.relevantIds.push(duplicateQuery.relevantIds[0]!);
assert.throws(
  () => parseDataset(duplicateExpectation),
  /must not contain duplicates/,
  "runtime parser must reject duplicate ground-truth IDs"
);
rejects("dataset.schema.json", duplicateExpectation);

const invalidReport = structuredClone(report) as unknown as Record<string, unknown>;
(
  invalidReport.run as {
    startedAt: string;
  }
).startedAt = "not-a-date";
rejects("report.schema.json", invalidReport);

const invalidOverlay = structuredClone(overlay);
invalidOverlay.reviewer = {
  id: "schema-smoke-reviewer",
  type: "human",
  conflicts: ["provider-affiliation", "provider-affiliation"],
};
rejects("review-overlay.schema.json", invalidOverlay);

console.log(
  JSON.stringify(
    {
      ok: true,
      schemas: schemaFiles.length,
      datasets: 3,
      reportQueries: report.queries.length,
      negativeCases: 13,
    },
    null,
    2
  )
);
