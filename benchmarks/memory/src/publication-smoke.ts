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
} from "./agent-components.js";
import {
  agentEvaluationFingerprint,
} from "./agent-comparison.js";
import { openAgentDataset } from "./agent-dataset.js";
import {
  longMemEvalJudgePromptRevision,
  officialLongMemEvalJudgeModel,
} from "./agent-openai.js";
import { MnemaAgentMemoryAdapter } from "./agent-mnema.js";
import { runAgentBenchmark } from "./agent-runner.js";
import type {
  AgentBenchmarkReport,
  AgentComparisonManifest,
} from "./agent-types.js";
import { MnemaAdapter } from "./adapters/mnema.js";
import { loadDataset } from "./dataset.js";
import {
  createEvaluatorParity,
  type OfficialEvaluatorResult,
} from "./evaluator-parity.js";
import {
  assessAgentPublication,
  createAgentPublicationTemplate,
  finalizeAgentPublication,
  type AgentPublicationManifest,
} from "./publication.js";
import {
  createComponentQualificationTemplate,
  type ComponentQualification,
  type QualificationAttestation,
  type QualificationRole,
} from "./qualification.js";
import { runBenchmark } from "./runner.js";
import {
  createStatisticalComparison,
} from "./statistical-comparison.js";
import type { AdapterInfo, BenchmarkReport } from "./types.js";
import { importLongMemEval } from "./longmemeval.js";

const coreDatasetFile = fileURLToPath(
  new URL("../datasets/core-smoke-v1.json", import.meta.url)
);
const longMemEvalFixture = fileURLToPath(
  new URL("../fixtures/longmemeval-contract.json", import.meta.url)
);
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "memory-bench-publication-")
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

function writeOfficialResults(
  file: string,
  report: AgentBenchmarkReport
): void {
  const rows: OfficialEvaluatorResult[] = report.scenarios.map(
    (scenario) => ({
      question_id: scenario.scenarioId,
      hypothesis: scenario.hypothesis!,
      autoeval_label: {
        model: officialLongMemEvalJudgeModel,
        label: scenario.qaPassed!,
      },
    })
  );
  fs.writeFileSync(
    file,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
  );
}

function attestation(role: QualificationRole): QualificationAttestation {
  return {
    evidenceAuthentic: true,
    realServiceOrImplementation: true,
    noContractOrFakeServer: true,
    configurationPinned: true,
    credentialsExcluded: true,
    evidencePublished: true,
    independentReproduction: true,
    authenticationFailureObserved: role === "adapter" ? true : null,
    lifecycleOperationsObserved: role === "adapter" ? true : null,
    disposableIsolationObserved: role === "adapter" ? true : null,
    cleanupVerified: role === "adapter" ? true : null,
    apiContractObserved: role === "adapter" ? null : true,
    requestPolicyVerified: role === "adapter" ? null : true,
    officialEvaluatorParityVerified: role === "judge" ? true : null,
  };
}

function completeQualification(
  template: ComponentQualification,
  suffix: string
): ComponentQualification {
  return {
    ...structuredClone(template),
    submitter: {
      id: `submitter-${suffix}`,
      type: "human",
      affiliation: "publication-smoke-submitters",
    },
    reviewer: {
      id: `reviewer-${suffix}`,
      type: "human",
      affiliation: "publication-smoke-reviewers",
      conflicts: [],
      reviewedAt: "2026-07-27T12:00:00.000Z",
    },
    maintainer: {
      id: `maintainer-${suffix}`,
      type: "human",
      verifiedAt: "2026-07-27T12:05:00.000Z",
      reviewerIdentityVerified: true,
      conflictsReviewed: true,
      disposition: "No disqualifying conflict was identified.",
    },
    attestation: attestation(template.subject.role),
    decision: "qualified",
    decisionNote:
      "Synthetic smoke metadata exercises the evidence contract only.",
  };
}

function withModelComponents(
  report: AgentBenchmarkReport
): AgentBenchmarkReport {
  const result = structuredClone(report);
  result.run.resultClass = "candidate";
  result.run.components.reader = {
    name: "openai-responses-reader",
    version: "1",
    mode: "chronological-evidence-qa",
    classification: "candidate",
    config: {
      model: officialLongMemEvalJudgeModel,
      apiSurface: "responses",
      baseUrlOrigin: "https://api.openai.com",
      baseUrlPath: "/v1",
      promptRevision: "memory-bench-agent-reader-v1",
      temperature: 0,
      store: false,
    },
  };
  result.run.components.judge = {
    name: "longmemeval-openai-judge",
    version: "1",
    mode: "category-specific-yes-no-port",
    classification: "candidate",
    config: {
      model: officialLongMemEvalJudgeModel,
      apiSurface: "responses",
      baseUrlOrigin: "https://api.openai.com",
      baseUrlPath: "/v1",
      promptRevision: longMemEvalJudgePromptRevision,
      decisionRule: "official-case-insensitive-yes-substring",
      temperature: 0,
      store: false,
    },
  };
  return result;
}

function mem0CoreInfo(): AdapterInfo {
  return {
    name: "mem0",
    version: "platform-rest-smoke-v1",
    mode: "managed-core-explicit",
    config: {
      baseUrl: "https://api.mem0.ai",
      apiKeyConfigured: true,
      infer: false,
      searchThreshold: 0,
      rerank: false,
      requestTimeoutMs: 15_000,
      settleTimeoutMs: 60_000,
      pollIntervalMs: 500,
      maxRetries: 2,
      retryBaseDelayMs: 250,
      scopeIsolation: "hashed-user-id+run-id",
    },
  };
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
      "benchmarks/memory/src/publication-cli.ts",
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
  const coreMnema = await runBenchmark(
    loadDataset(coreDatasetFile),
    new MnemaAdapter(),
    "publication-core-mnema"
  );
  const coreMnemaFile = path.join(temporaryDirectory, "core-mnema.json");
  writeJson(coreMnemaFile, coreMnema);

  const coreMem0 = structuredClone(coreMnema) as BenchmarkReport;
  coreMem0.run.runId = "publication-core-mem0";
  coreMem0.run.adapter = mem0CoreInfo();
  coreMem0.run.adapterTelemetry.requestCount = 20;
  const coreMem0File = path.join(temporaryDirectory, "core-mem0.json");
  writeJson(coreMem0File, coreMem0);

  const fixtureRows = JSON.parse(
    fs.readFileSync(longMemEvalFixture, "utf8")
  ) as Array<
    Record<string, unknown> & {
      question_id: string;
      haystack_session_ids: string[];
      answer_session_ids: string[];
    }
  >;
  const clonedFixtureRows = fixtureRows.map((row) => {
    const sessionIds = new Map(
      row.haystack_session_ids.map((id) => [id, `${id}_copy`])
    );
    const questionId = row.question_id.endsWith("_abs")
      ? `${row.question_id.slice(0, -4)}_copy_abs`
      : `${row.question_id}_copy`;
    return {
      ...structuredClone(row),
      question_id: questionId,
      haystack_session_ids: row.haystack_session_ids.map(
        (id) => sessionIds.get(id)!
      ),
      answer_session_ids: row.answer_session_ids.map(
        (id) => sessionIds.get(id)!
      ),
    };
  });
  const expandedFixtureFile = path.join(
    temporaryDirectory,
    "longmemeval-publication-fixture.json"
  );
  writeJson(expandedFixtureFile, [
    ...fixtureRows,
    ...clonedFixtureRows,
  ]);
  const datasetFile = path.join(temporaryDirectory, "agent-dataset.json");
  await importLongMemEval({
    input: expandedFixtureFile,
    output: datasetFile,
    source: {
      revision: "publication-smoke-fixture-v1",
      subset: "oracle",
      uri: "https://example.invalid/longmemeval-contract.json",
      license: "MIT",
    },
  });
  const baseAgentReport = await runAgentBenchmark(
    await openAgentDataset(datasetFile),
    new MnemaAgentMemoryAdapter(),
    new FixtureEvidenceReader(),
    new FixtureJudge(),
    {
      runId: "publication-agent-mnema",
      topK: 1,
    }
  );
  const mnemaReport = withModelComponents(baseAgentReport);
  const mnemaReportFile = path.join(
    temporaryDirectory,
    "mnema-agent-report.json"
  );
  writeJson(mnemaReportFile, mnemaReport);

  const mem0Report = structuredClone(mnemaReport);
  mem0Report.run.runId = "publication-agent-mem0";
  const coreInfo = mem0CoreInfo();
  mem0Report.run.components.adapter = {
    name: coreInfo.name,
    version: `${coreInfo.version}+agent-session-v1`,
    mode: `${coreInfo.mode}+agent-memory`,
    classification: "candidate",
    config: {
      ...coreInfo.config,
      track: "agent-memory",
      scenarioIsolation: "one-disposable-core-run-per-scenario",
      providerRecordIds: "sha256-local-map",
    },
  };
  mem0Report.run.telemetry.adapter.requestCount = 20;
  const mem0ReportFile = path.join(
    temporaryDirectory,
    "mem0-agent-report.json"
  );
  writeJson(mem0ReportFile, mem0Report);

  const parityFiles: string[] = [];
  for (const [name, report, reportFile] of [
    ["mnema", mnemaReport, mnemaReportFile],
    ["mem0", mem0Report, mem0ReportFile],
  ] as const) {
    const officialFile = path.join(
      temporaryDirectory,
      `${name}-official.jsonl`
    );
    writeOfficialResults(officialFile, report);
    const parityFile = path.join(
      temporaryDirectory,
      `${name}-parity.json`
    );
    await createEvaluatorParity({
      report: reportFile,
      officialResults: officialFile,
      output: parityFile,
    });
    parityFiles.push(parityFile);
  }

  const qualificationFiles: string[] = [];
  const qualificationInputs = [
    {
      suffix: "mnema-adapter",
      template: await createComponentQualificationTemplate({
        role: "adapter",
        agentReport: mnemaReportFile,
        coreReport: coreMnemaFile,
      }),
    },
    {
      suffix: "mem0-adapter",
      template: await createComponentQualificationTemplate({
        role: "adapter",
        agentReport: mem0ReportFile,
        coreReport: coreMem0File,
      }),
    },
    {
      suffix: "reader",
      template: await createComponentQualificationTemplate({
        role: "reader",
        agentReport: mnemaReportFile,
      }),
    },
    {
      suffix: "judge",
      template: await createComponentQualificationTemplate({
        role: "judge",
        agentReport: mnemaReportFile,
        evaluatorParity: parityFiles[0]!,
      }),
    },
  ];
  for (const input of qualificationInputs) {
    const file = path.join(
      temporaryDirectory,
      `${input.suffix}-qualification.json`
    );
    writeJson(
      file,
      completeQualification(input.template, input.suffix)
    );
    qualificationFiles.push(file);
  }

  const evaluationSha256 = agentEvaluationFingerprint(mnemaReport);
  assert.equal(
    agentEvaluationFingerprint(mem0Report),
    evaluationSha256
  );
  const comparison: AgentComparisonManifest = {
    schemaVersion: 1,
    kind: "memory-bench-agent-comparison",
    comparisonId: "publication-smoke-comparison",
    createdAt: "2026-07-27T12:10:00.000Z",
    dataset: {
      name: mnemaReport.run.dataset.name,
      version: mnemaReport.run.dataset.version,
      license: mnemaReport.run.dataset.license,
      track: mnemaReport.run.dataset.track,
      language: mnemaReport.run.dataset.language,
      subset: mnemaReport.run.dataset.subset,
      sourceRevision: mnemaReport.run.dataset.sourceRevision,
      sourceSha256: mnemaReport.run.dataset.sourceSha256,
      artifactFile: path.basename(datasetFile),
      artifactSha256: mnemaReport.run.dataset.artifactSha256,
      artifactBytes: mnemaReport.run.dataset.artifactBytes,
    },
    source: {
      gitCommit: "0".repeat(40),
      gitDirty: false,
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
      reader: "openai",
      readerModel: officialLongMemEvalJudgeModel,
      judge: "openai",
      judgeModel: officialLongMemEvalJudgeModel,
      topK: mnemaReport.run.topK,
      maxScenarios: mnemaReport.run.maxScenarios,
      configurationSha256: evaluationSha256,
    },
    policy: {
      processIsolation: "one-process-per-adapter",
      executionOrder: "sequential",
      runtimeFailureAffectsCommandExit: true,
      qaFailureAffectsCommandExit: false,
    },
    claim: {
      resultClass: "candidate",
      comparable: true,
      publicationEligible: false,
      blockers: [
        "candidate components require external qualification evidence",
      ],
    },
    runs: [
      {
        adapter: "mnema",
        status: "completed",
        processId: process.pid,
        exitCode: 0,
        durationMs: mnemaReport.run.durationMs,
        reportStatus: "completed",
        reportFile: path.basename(mnemaReportFile),
        reportSha256: reportSha256(mnemaReportFile),
        evaluationSha256,
        resultClass: "candidate",
        runtimeFailures: 0,
        metrics: mnemaReport.metrics,
        components: mnemaReport.run.components,
        telemetry: mnemaReport.run.telemetry,
        error: null,
      },
      {
        adapter: "mem0",
        status: "completed",
        processId: process.pid + 1,
        exitCode: 0,
        durationMs: mem0Report.run.durationMs,
        reportStatus: "completed",
        reportFile: path.basename(mem0ReportFile),
        reportSha256: reportSha256(mem0ReportFile),
        evaluationSha256,
        resultClass: "candidate",
        runtimeFailures: 0,
        metrics: mem0Report.metrics,
        components: mem0Report.run.components,
        telemetry: mem0Report.run.telemetry,
        error: null,
      },
    ],
  };
  const comparisonFile = path.join(
    temporaryDirectory,
    "agent-comparison.json"
  );
  writeJson(comparisonFile, comparison);

  const statisticsFile = path.join(
    temporaryDirectory,
    "agent-statistical-comparison.json"
  );
  const statistics = createStatisticalComparison({
    comparison: comparisonFile,
    iterations: 2_000,
    confidenceLevel: 0.95,
    seed: 20_260_727,
    createdAt: "2026-07-27T12:11:00.000Z",
  });
  writeJson(statisticsFile, statistics);

  const sourceOptions = {
    comparison: comparisonFile,
    qualifications: qualificationFiles,
    evaluatorParities: parityFiles,
    statistics: statisticsFile,
  };
  const template = await createAgentPublicationTemplate(sourceOptions);
  assert.equal(template.status, "draft");
  assert.equal(template.claim.mechanicallyVerified, true);
  assert.equal(template.claim.publicationEligible, false);
  assert.match(template.claim.blockers.join("\n"), /release attestation/i);
  assert.equal(template.runs.length, 2);
  assert.equal(template.qualifications.length, 4);
  assert.equal(
    template.statistics?.analysisId,
    statistics.analysisId
  );

  const completedDraft: AgentPublicationManifest = {
    ...structuredClone(template),
    release: {
      version: "1.0.0-smoke",
      releasedAt: "2026-07-27T12:20:00.000Z",
      publisher: {
        id: "publisher-gh",
        type: "human",
        affiliation: "publication-smoke",
      },
      maintainer: {
        id: "release-maintainer-gh",
        type: "human",
        affiliation: "publication-smoke",
      },
      evidenceBundleUri:
        "https://example.invalid/memory-bench/releases/1.0.0-smoke",
      releaseNotesUri:
        "https://example.invalid/memory-bench/releases/1.0.0-smoke/notes",
      correctionsUri:
        "https://example.invalid/memory-bench/corrections",
      providerAffiliations: [],
      sponsorships: [],
      knownLimitations: [
        "This is synthetic contract evidence and is never published.",
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
    },
  };
  const assessment = await assessAgentPublication(
    completedDraft,
    sourceOptions
  );
  assert.equal(
    assessment.readyToFinalize,
    true,
    assessment.issues.join("\n")
  );
  const finalized = await finalizeAgentPublication(
    completedDraft,
    sourceOptions
  );
  assert.equal(finalized.status, "final");
  assert.equal(finalized.claim.resultClass, "benchmark");
  assert.equal(finalized.claim.publicationEligible, true);
  assert.deepEqual(finalized.claim.blockers, []);

  const missingParityAssessment = await assessAgentPublication(
    completedDraft,
    {
      ...sourceOptions,
      evaluatorParities: parityFiles.slice(0, 1),
    }
  );
  assert.equal(missingParityAssessment.readyToFinalize, false);
  assert.match(
    missingParityAssessment.issues.join("\n"),
    /parity/i
  );

  const missingStatisticsAssessment = await assessAgentPublication(
    completedDraft,
    {
      ...sourceOptions,
      statistics: undefined,
    }
  );
  assert.equal(
    missingStatisticsAssessment.readyToFinalize,
    false
  );
  assert.match(
    missingStatisticsAssessment.issues.join("\n"),
    /statistical comparison/i
  );

  const dirtyComparison = structuredClone(comparison);
  dirtyComparison.source.gitDirty = true;
  const dirtyComparisonFile = path.join(
    temporaryDirectory,
    "dirty-comparison.json"
  );
  writeJson(dirtyComparisonFile, dirtyComparison);
  const dirtyTemplate = await createAgentPublicationTemplate({
    ...sourceOptions,
    comparison: dirtyComparisonFile,
  });
  assert.equal(dirtyTemplate.claim.mechanicallyVerified, false);
  assert.match(dirtyTemplate.claim.blockers.join("\n"), /dirty/i);

  const completedDraftFile = path.join(
    temporaryDirectory,
    "publication-draft.json"
  );
  writeJson(completedDraftFile, completedDraft);
  const finalizedFile = path.join(
    temporaryDirectory,
    "publication-final.json"
  );
  const cli = await runCli([
    "finalize",
    `--manifest=${completedDraftFile}`,
    `--comparison=${comparisonFile}`,
    ...qualificationFiles.map((file) => `--qualification=${file}`),
    ...parityFiles.map((file) => `--evaluator-parity=${file}`),
    `--statistics=${statisticsFile}`,
    `--output=${finalizedFile}`,
  ]);
  assert.equal(cli.exitCode, 0, cli.stderr);
  assert.match(cli.stdout, /"publicationEligible": true/);
  assert.equal(fs.existsSync(finalizedFile), true);

  console.log(
    JSON.stringify(
      {
        ok: true,
        adapters: ["mnema", "mem0"],
        immutableCandidateReportsPreserved: true,
        componentQualificationsResolved: true,
        perReportParityResolved: true,
        statisticalComparisonBound: true,
        dirtySourceRejected: true,
        missingParityRejected: true,
        missingStatisticsRejected: true,
        releaseAttestationRequired: true,
        finalPublicationPromotionVerified: true,
        livePublicationClaimed: false,
      },
      null,
      2
    )
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
