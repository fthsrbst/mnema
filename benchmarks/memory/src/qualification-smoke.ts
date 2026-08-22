import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FixtureEvidenceReader,
  FixtureJudge,
} from "./agent-components.js";
import { openAgentDataset } from "./agent-dataset.js";
import {
  longMemEvalJudgePromptRevision,
  officialLongMemEvalJudgeModel,
} from "./agent-openai.js";
import { MnemaAgentMemoryAdapter } from "./agent-mnema.js";
import { runAgentBenchmark } from "./agent-runner.js";
import type { AgentBenchmarkReport } from "./agent-types.js";
import { MnemaAdapter } from "./adapters/mnema.js";
import { loadDataset } from "./dataset.js";
import {
  createEvaluatorParity,
  type OfficialEvaluatorResult,
} from "./evaluator-parity.js";
import {
  assessComponentQualification,
  createComponentQualificationTemplate,
  type ComponentQualification,
  type QualificationAttestation,
  type QualificationRole,
} from "./qualification.js";
import { runBenchmark } from "./runner.js";
import { importLongMemEval } from "./longmemeval.js";

const coreDatasetFile = fileURLToPath(
  new URL("../datasets/core-smoke-v1.json", import.meta.url)
);
const longMemEvalFixture = fileURLToPath(
  new URL("../fixtures/longmemeval-contract.json", import.meta.url)
);
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "memory-bench-qualification-")
);

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeOfficialResults(
  file: string,
  report: AgentBenchmarkReport
): void {
  const rows: OfficialEvaluatorResult[] = report.scenarios.map(
    (scenario) => {
      assert.notEqual(scenario.hypothesis, null);
      assert.notEqual(scenario.qaPassed, null);
      return {
        question_id: scenario.scenarioId,
        hypothesis: scenario.hypothesis!,
        autoeval_label: {
          model: officialLongMemEvalJudgeModel,
          label: scenario.qaPassed!,
        },
      };
    }
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

function complete(
  template: ComponentQualification
): ComponentQualification {
  return {
    ...structuredClone(template),
    submitter: {
      id: "submitter-gh",
      type: "human",
      affiliation: "independent-submitters",
    },
    reviewer: {
      id: "reviewer-gh",
      type: "human",
      affiliation: "independent-reviewers",
      conflicts: [],
      reviewedAt: "2026-07-27T12:00:00.000Z",
    },
    maintainer: {
      id: "maintainer-gh",
      type: "human",
      verifiedAt: "2026-07-27T12:05:00.000Z",
      reviewerIdentityVerified: true,
      conflictsReviewed: true,
      disposition: "No disqualifying conflict was identified.",
    },
    attestation: attestation(template.subject.role),
    decision: "qualified",
    decisionNote:
      "The complete evidence bundle was independently replayed and audited.",
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
      "benchmarks/memory/src/qualification-cli.ts",
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
  const coreReport = await runBenchmark(
    loadDataset(coreDatasetFile),
    new MnemaAdapter(),
    "qualification-core-mnema"
  );
  const coreReportFile = path.join(temporaryDirectory, "core-report.json");
  writeJson(coreReportFile, coreReport);

  const normalizedDatasetFile = path.join(
    temporaryDirectory,
    "agent-dataset.json"
  );
  await importLongMemEval({
    input: longMemEvalFixture,
    output: normalizedDatasetFile,
    source: {
      revision: "qualification-fixture-v1",
      subset: "oracle",
      uri: "https://example.invalid/longmemeval-contract.json",
      license: "MIT",
    },
  });
  const adapterReport = await runAgentBenchmark(
    await openAgentDataset(normalizedDatasetFile),
    new MnemaAgentMemoryAdapter(),
    new FixtureEvidenceReader(),
    new FixtureJudge(),
    {
      runId: "qualification-agent-mnema",
      topK: 1,
    }
  );
  const adapterReportFile = path.join(
    temporaryDirectory,
    "adapter-agent-report.json"
  );
  writeJson(adapterReportFile, adapterReport);

  const adapterTemplate = await createComponentQualificationTemplate({
    role: "adapter",
    agentReport: adapterReportFile,
    coreReport: coreReportFile,
  });
  assert.equal(adapterTemplate.subject.component.name, "mnema");
  assert.equal(adapterTemplate.subject.role, "adapter");
  assert.equal(adapterTemplate.decision, "pending");
  assert.notEqual(adapterTemplate.evidence.coreReport, null);
  assert.equal(adapterTemplate.evidence.evaluatorParity, null);
  const adapterQualification = complete(adapterTemplate);
  const adapterAssessment = await assessComponentQualification(
    adapterQualification,
    {
      role: "adapter",
      agentReport: adapterReportFile,
      coreReport: coreReportFile,
    }
  );
  assert.equal(
    adapterAssessment.qualified,
    true,
    adapterAssessment.issues.join("\n")
  );

  const selfReviewed = structuredClone(adapterQualification);
  selfReviewed.reviewer!.id = selfReviewed.submitter!.id.toUpperCase();
  const selfReviewAssessment = await assessComponentQualification(
    selfReviewed,
    {
      role: "adapter",
      agentReport: adapterReportFile,
      coreReport: coreReportFile,
    }
  );
  assert.equal(selfReviewAssessment.qualified, false);
  assert.match(selfReviewAssessment.issues.join("\n"), /submitter/i);

  const submitterMaintained = structuredClone(adapterQualification);
  submitterMaintained.maintainer!.id =
    submitterMaintained.submitter!.id.toUpperCase();
  const submitterMaintainerAssessment =
    await assessComponentQualification(submitterMaintained, {
      role: "adapter",
      agentReport: adapterReportFile,
      coreReport: coreReportFile,
    });
  assert.equal(submitterMaintainerAssessment.qualified, false);
  assert.match(
    submitterMaintainerAssessment.issues.join("\n"),
    /submitter/i
  );

  const tampered = structuredClone(adapterQualification);
  tampered.subject.component.config.embeddings = true;
  const tamperedAssessment = await assessComponentQualification(tampered, {
    role: "adapter",
    agentReport: adapterReportFile,
    coreReport: coreReportFile,
  });
  assert.equal(tamperedAssessment.qualified, false);
  assert.match(tamperedAssessment.issues.join("\n"), /subject|component/i);

  await assert.rejects(
    createComponentQualificationTemplate({
      role: "adapter",
      agentReport: adapterReportFile,
    }),
    /core report/i
  );

  const modelReport = structuredClone(adapterReport);
  modelReport.run.resultClass = "candidate";
  modelReport.run.components.reader = {
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
  modelReport.run.components.judge = {
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
  const modelReportFile = path.join(
    temporaryDirectory,
    "model-agent-report.json"
  );
  writeJson(modelReportFile, modelReport);
  const officialResultsFile = path.join(
    temporaryDirectory,
    "official-results.jsonl"
  );
  writeOfficialResults(officialResultsFile, modelReport);
  const parityFile = path.join(temporaryDirectory, "evaluator-parity.json");
  const parity = await createEvaluatorParity({
    report: modelReportFile,
    officialResults: officialResultsFile,
    output: parityFile,
  });
  assert.equal(parity.metrics.exactAgreement, true);

  const readerTemplate = await createComponentQualificationTemplate({
    role: "reader",
    agentReport: modelReportFile,
  });
  const readerAssessment = await assessComponentQualification(
    complete(readerTemplate),
    {
      role: "reader",
      agentReport: modelReportFile,
    }
  );
  assert.equal(
    readerAssessment.qualified,
    true,
    readerAssessment.issues.join("\n")
  );

  const judgeTemplate = await createComponentQualificationTemplate({
    role: "judge",
    agentReport: modelReportFile,
    evaluatorParity: parityFile,
  });
  const judgeQualification = complete(judgeTemplate);
  const judgeAssessment = await assessComponentQualification(
    judgeQualification,
    {
      role: "judge",
      agentReport: modelReportFile,
      evaluatorParity: parityFile,
    }
  );
  assert.equal(
    judgeAssessment.qualified,
    true,
    judgeAssessment.issues.join("\n")
  );
  await assert.rejects(
    createComponentQualificationTemplate({
      role: "judge",
      agentReport: modelReportFile,
    }),
    /evaluator parity/i
  );

  const localEndpointReport = structuredClone(modelReport);
  localEndpointReport.run.components.reader.config.baseUrlOrigin =
    "http://127.0.0.1:43123";
  const localEndpointReportFile = path.join(
    temporaryDirectory,
    "local-endpoint-agent-report.json"
  );
  writeJson(localEndpointReportFile, localEndpointReport);
  const localTemplate = await createComponentQualificationTemplate({
    role: "reader",
    agentReport: localEndpointReportFile,
  });
  const localAssessment = await assessComponentQualification(
    complete(localTemplate),
    {
      role: "reader",
      agentReport: localEndpointReportFile,
    }
  );
  assert.equal(localAssessment.qualified, false);
  assert.match(localAssessment.issues.join("\n"), /local|contract/i);

  const reservedEndpointReport = structuredClone(modelReport);
  reservedEndpointReport.run.components.reader.config.baseUrlOrigin =
    "https://reader.memory-bench.invalid";
  const reservedEndpointReportFile = path.join(
    temporaryDirectory,
    "reserved-endpoint-agent-report.json"
  );
  writeJson(reservedEndpointReportFile, reservedEndpointReport);
  const reservedTemplate = await createComponentQualificationTemplate({
    role: "reader",
    agentReport: reservedEndpointReportFile,
  });
  const reservedAssessment = await assessComponentQualification(
    complete(reservedTemplate),
    {
      role: "reader",
      agentReport: reservedEndpointReportFile,
    }
  );
  assert.equal(reservedAssessment.qualified, false);
  assert.match(
    reservedAssessment.issues.join("\n"),
    /local|contract|reserved/i
  );

  const privateEndpointReport = structuredClone(modelReport);
  privateEndpointReport.run.components.reader.config.baseUrlOrigin =
    "https://10.0.0.8";
  const privateEndpointReportFile = path.join(
    temporaryDirectory,
    "private-endpoint-agent-report.json"
  );
  writeJson(privateEndpointReportFile, privateEndpointReport);
  const privateTemplate = await createComponentQualificationTemplate({
    role: "reader",
    agentReport: privateEndpointReportFile,
  });
  const privateAssessment = await assessComponentQualification(
    complete(privateTemplate),
    {
      role: "reader",
      agentReport: privateEndpointReportFile,
    }
  );
  assert.equal(privateAssessment.qualified, false);

  const publicPrefixReport = structuredClone(modelReport);
  publicPrefixReport.run.components.reader.config.baseUrlOrigin =
    "https://fdocs.net";
  const publicPrefixReportFile = path.join(
    temporaryDirectory,
    "public-prefix-agent-report.json"
  );
  writeJson(publicPrefixReportFile, publicPrefixReport);
  const publicPrefixTemplate = await createComponentQualificationTemplate({
    role: "reader",
    agentReport: publicPrefixReportFile,
  });
  const publicPrefixAssessment = await assessComponentQualification(
    complete(publicPrefixTemplate),
    {
      role: "reader",
      agentReport: publicPrefixReportFile,
    }
  );
  assert.equal(
    publicPrefixAssessment.qualified,
    true,
    publicPrefixAssessment.issues.join("\n")
  );

  const credentialEndpointReport = structuredClone(modelReport);
  credentialEndpointReport.run.components.reader.config.baseUrlOrigin =
    "https://benchmark-secret@api.openai.com";
  const credentialEndpointReportFile = path.join(
    temporaryDirectory,
    "credential-endpoint-agent-report.json"
  );
  writeJson(credentialEndpointReportFile, credentialEndpointReport);
  const credentialTemplate = await createComponentQualificationTemplate({
    role: "reader",
    agentReport: credentialEndpointReportFile,
  });
  const credentialAssessment = await assessComponentQualification(
    complete(credentialTemplate),
    {
      role: "reader",
      agentReport: credentialEndpointReportFile,
    }
  );
  assert.equal(credentialAssessment.qualified, false);
  assert.match(
    credentialAssessment.issues.join("\n"),
    /credential|secret|unsafe/i
  );

  const qualificationFile = path.join(
    temporaryDirectory,
    "adapter-qualification.json"
  );
  writeJson(qualificationFile, adapterQualification);
  const cli = await runCli([
    "check",
    `--qualification=${qualificationFile}`,
    `--agent-report=${adapterReportFile}`,
    `--core-report=${coreReportFile}`,
  ]);
  assert.equal(cli.exitCode, 0, cli.stderr);
  assert.match(cli.stdout, /"qualified": true/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        roles: ["adapter", "reader", "judge"],
        componentIdentityBound: true,
        reportHashesBound: true,
        selfReviewRejected: true,
        submitterMaintainerSeparationEnforced: true,
        tamperRejected: true,
        roleEvidenceEnforced: true,
        localContractEndpointRejected: true,
        reservedEndpointRejected: true,
        privateNetworkEndpointRejected: true,
        publicHostnamePrefixAccepted: true,
        embeddedEndpointCredentialRejected: true,
        cliVerified: true,
        liveQualificationClaimed: false,
      },
      null,
      2
    )
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
