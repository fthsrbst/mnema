import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FixtureEvidenceReader,
  LiteralAgentMemoryAdapter,
} from "./agent-components.js";
import { openAgentDataset } from "./agent-dataset.js";
import {
  LongMemEvalOpenAIJudge,
  officialLongMemEvalEvaluatorRevision,
  officialLongMemEvalEvaluatorScriptSha256,
  officialLongMemEvalJudgeModel,
} from "./agent-openai.js";
import { runAgentBenchmark } from "./agent-runner.js";
import {
  createEvaluatorParity,
  type OfficialEvaluatorResult,
} from "./evaluator-parity.js";
import type {
  AgentBenchmarkReport,
  EvaluatorParityArtifact,
} from "./agent-types.js";
import { FakeOpenAIResponsesServer } from "./testing/fake-openai-responses-server.js";
import { importLongMemEval } from "./longmemeval.js";

const fixture = fileURLToPath(
  new URL("../fixtures/longmemeval-contract.json", import.meta.url)
);
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "memory-bench-evaluator-parity-")
);
const apiKey = "evaluator-parity-contract-key";
const server = new FakeOpenAIResponsesServer({ apiKey });

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLines(
  file: string,
  values: OfficialEvaluatorResult[]
): void {
  fs.writeFileSync(
    file,
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n`
  );
}

function officialResults(
  report: AgentBenchmarkReport
): OfficialEvaluatorResult[] {
  return report.scenarios.map((scenario) => {
    assert.equal(scenario.status, "completed");
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
  });
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
      "benchmarks/memory/src/evaluator-parity-cli.ts",
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
  await server.start();
  const datasetFile = path.join(temporaryDirectory, "agent-dataset.json");
  await importLongMemEval({
    input: fixture,
    output: datasetFile,
    source: {
      revision: "evaluator-parity-fixture-v1",
      subset: "oracle",
      uri: "https://example.invalid/longmemeval-contract.json",
      license: "MIT",
    },
  });
  const report = await runAgentBenchmark(
    await openAgentDataset(datasetFile),
    new LiteralAgentMemoryAdapter(),
    new FixtureEvidenceReader(),
    new LongMemEvalOpenAIJudge({
      apiKey,
      baseUrl: server.baseUrl,
      model: officialLongMemEvalJudgeModel,
      maxRetries: 0,
      timeoutMs: 5_000,
    }),
    {
      runId: "evaluator-parity-smoke",
      topK: 1,
    }
  );
  assert.equal(report.run.status, "completed");
  const reportFile = path.join(temporaryDirectory, "agent-report.json");
  writeJson(reportFile, report);

  const exactOfficialFile = path.join(
    temporaryDirectory,
    "official-exact.jsonl"
  );
  const exactResults = officialResults(report);
  writeJsonLines(exactOfficialFile, exactResults);
  const exactOutput = path.join(temporaryDirectory, "parity-exact.json");
  const exact = await createEvaluatorParity({
    report: reportFile,
    officialResults: exactOfficialFile,
    output: exactOutput,
  });
  assert.equal(exact.compatibility.comparable, true);
  assert.equal(exact.metrics.exactAgreement, true);
  assert.equal(exact.metrics.agreementRate, 1);
  assert.equal(exact.metrics.compared, report.scenarios.length);
  assert.deepEqual(exact.metrics.confusion, {
    bothPass: report.scenarios.length,
    candidateOnlyPass: 0,
    officialOnlyPass: 0,
    bothFail: 0,
  });
  assert.equal(exact.claim.evidenceClass, "harness");
  assert.equal(exact.claim.publicationEligible, false);
  assert.match(
    exact.claim.blockers.join("\n"),
    /independent live-run provenance/
  );
  assert.equal(
    exact.candidate.reportSha256,
    sha256(fs.readFileSync(reportFile))
  );
  assert.equal(
    exact.official.resultsSha256,
    sha256(fs.readFileSync(exactOfficialFile))
  );
  assert.equal(
    exact.official.evaluatorRevision,
    officialLongMemEvalEvaluatorRevision
  );
  assert.equal(
    exact.official.scriptSha256,
    officialLongMemEvalEvaluatorScriptSha256
  );
  assert.equal(exact.mismatches.length, 0);
  assert.equal(
    JSON.stringify(exact).includes(report.scenarios[0]!.hypothesis!),
    false,
    "parity artifacts must not copy raw hypotheses"
  );

  const mismatchResults = structuredClone(exactResults);
  mismatchResults[0]!.autoeval_label.label =
    !mismatchResults[0]!.autoeval_label.label;
  const mismatchOfficialFile = path.join(
    temporaryDirectory,
    "official-mismatch.jsonl"
  );
  writeJsonLines(mismatchOfficialFile, mismatchResults);
  const mismatchOutput = path.join(temporaryDirectory, "parity-mismatch.json");
  const mismatchCli = await runCli([
    `--report=${reportFile}`,
    `--official-results=${mismatchOfficialFile}`,
    `--output=${mismatchOutput}`,
    "--require-exact",
  ]);
  assert.equal(mismatchCli.exitCode, 1);
  assert.match(mismatchCli.stdout, /exactAgreement=false/);
  assert.equal(mismatchCli.stderr, "");
  assert.equal(fs.existsSync(mismatchOutput), true);
  const mismatch = JSON.parse(
    fs.readFileSync(mismatchOutput, "utf8")
  ) as EvaluatorParityArtifact;
  assert.equal(mismatch.compatibility.comparable, true);
  assert.equal(mismatch.metrics.exactAgreement, false);
  assert.equal(mismatch.metrics.labelMismatches, 1);
  assert.equal(mismatch.mismatches.length, 1);
  assert.equal(
    mismatch.mismatches[0]!.hypothesisSha256,
    sha256(report.scenarios[0]!.hypothesis!)
  );

  const hypothesisResults = structuredClone(exactResults);
  hypothesisResults[0]!.hypothesis = "different normalized hypothesis";
  const hypothesisOfficialFile = path.join(
    temporaryDirectory,
    "official-hypothesis-mismatch.jsonl"
  );
  writeJsonLines(hypothesisOfficialFile, hypothesisResults);
  const hypothesisOutput = path.join(
    temporaryDirectory,
    "parity-hypothesis-mismatch.json"
  );
  const hypothesisMismatch = await createEvaluatorParity({
    report: reportFile,
    officialResults: hypothesisOfficialFile,
    output: hypothesisOutput,
  });
  assert.equal(hypothesisMismatch.compatibility.hypothesesExact, false);
  assert.equal(hypothesisMismatch.compatibility.comparable, false);
  assert.deepEqual(hypothesisMismatch.coverage.hypothesisMismatchIds, [
    report.scenarios[0]!.scenarioId,
  ]);
  assert.equal(hypothesisMismatch.metrics.compared, 1);

  const duplicateOfficialFile = path.join(
    temporaryDirectory,
    "official-duplicate.jsonl"
  );
  writeJsonLines(duplicateOfficialFile, [
    ...exactResults,
    structuredClone(exactResults[0]!),
  ]);
  const duplicateOutput = path.join(
    temporaryDirectory,
    "parity-duplicate.json"
  );
  await assert.rejects(
    createEvaluatorParity({
      report: reportFile,
      officialResults: duplicateOfficialFile,
      output: duplicateOutput,
    }),
    /duplicate question_id/
  );
  assert.equal(fs.existsSync(duplicateOutput), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        exactAgreementVerified: true,
        mismatchRemainedResult: true,
        requireExactGateVerified: true,
        hypothesisIdentityGuardVerified: true,
        duplicateIdentityRejected: true,
        sourceRevisionPinned: true,
        rawHypothesesOmitted: true,
      },
      null,
      2
    )
  );
} finally {
  await server.stop();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
