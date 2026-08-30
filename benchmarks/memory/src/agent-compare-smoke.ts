import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeLettaServer } from "./testing/fake-letta-server.js";
import { startFakeMem0Server } from "./testing/fake-mem0-server.js";
import { startFakeZepServer } from "./testing/fake-zep-server.js";
import { importLongMemEval } from "./longmemeval.js";

interface AgentComparisonRunSnapshot {
  adapter: string;
  status: "completed" | "failed";
  processId: number | null;
  reportStatus: "completed" | "completed-with-errors" | "failed" | null;
  reportFile: string | null;
  reportSha256: string | null;
  evaluationSha256: string | null;
  resultClass: "harness" | "candidate" | "benchmark" | null;
  runtimeFailures: number | null;
  metrics: {
    scenarios: number;
    qaAccuracy: number | null;
    cleanupVerificationRate: number | null;
  } | null;
  error: string | null;
}

interface AgentComparisonManifestSnapshot {
  schemaVersion: 1;
  kind: "memory-bench-agent-comparison";
  comparisonId: string;
  dataset: {
    artifactSha256: string;
    subset: string;
  };
  evaluation: {
    reader: "fixture" | "openai";
    readerModel: string | null;
    judge: "fixture" | "openai";
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
    resultClass: "harness" | "candidate" | "benchmark";
    comparable: boolean;
    publicationEligible: boolean;
    blockers: string[];
  };
  runs: AgentComparisonRunSnapshot[];
}

const apiKey = "agent-compare-contract-key";
const fixture = fileURLToPath(
  new URL("../fixtures/longmemeval-contract.json", import.meta.url)
);
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "memory-bench-agent-compare-smoke-")
);
const mem0 = await startFakeMem0Server(apiKey);
const letta = await startFakeLettaServer(apiKey);
const zep = await startFakeZepServer(apiKey);

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runComparison(
  args: string[],
  environment: NodeJS.ProcessEnv
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "benchmarks/memory/src/agent-compare.ts",
      ...args,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...environment,
      },
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
  const datasetFile = path.join(temporaryDirectory, "agent-dataset.json");
  await importLongMemEval({
    input: fixture,
    output: datasetFile,
    source: {
      revision: "agent-compare-fixture-v1",
      subset: "oracle",
      uri: "https://example.invalid/longmemeval-contract.json",
      license: "MIT",
    },
  });
  const sharedEnvironment = {
    MEM0_API_KEY: apiKey,
    LETTA_API_KEY: apiKey,
    ZEP_API_KEY: apiKey,
    MEMORY_BENCH_MEM0_BASE_URL: mem0.baseUrl,
    MEMORY_BENCH_LETTA_BASE_URL: letta.baseUrl,
    MEMORY_BENCH_ZEP_BASE_URL: zep.baseUrl,
    MEMORY_BENCH_HTTP_TIMEOUT_MS: "500",
    MEMORY_BENCH_SETTLE_TIMEOUT_MS: "500",
    MEMORY_BENCH_POLL_INTERVAL_MS: "1",
    MEMORY_BENCH_HTTP_MAX_RETRIES: "1",
    MEMORY_BENCH_RETRY_BASE_DELAY_MS: "0",
  };

  const successfulOutput = path.join(temporaryDirectory, "successful");
  const successful = await runComparison(
    [
      `--dataset=${datasetFile}`,
      "--adapters=literal,mnema,mem0,letta,zep",
      "--reader=fixture",
      "--judge=fixture",
      "--top-k=1",
      "--max-scenarios=2",
      "--adapter-timeout-ms=10000",
      `--output-dir=${successfulOutput}`,
      "--json",
    ],
    sharedEnvironment
  );
  assert.equal(
    successful.exitCode,
    0,
    `agent comparison failed\nstdout:\n${successful.stdout}\nstderr:\n${successful.stderr}`
  );
  const manifest = JSON.parse(
    successful.stdout
  ) as AgentComparisonManifestSnapshot;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, "memory-bench-agent-comparison");
  assert.equal(manifest.dataset.artifactSha256, sha256(fs.readFileSync(datasetFile)));
  assert.equal(manifest.dataset.subset, "oracle");
  assert.deepEqual(manifest.evaluation, {
    reader: "fixture",
    readerModel: null,
    judge: "fixture",
    judgeModel: null,
    topK: 1,
    maxScenarios: 2,
    configurationSha256: manifest.evaluation.configurationSha256,
  });
  assert.match(manifest.evaluation.configurationSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.policy, {
    processIsolation: "one-process-per-adapter",
    executionOrder: "sequential",
    runtimeFailureAffectsCommandExit: true,
    qaFailureAffectsCommandExit: false,
  });
  assert.equal(manifest.claim.resultClass, "harness");
  assert.equal(manifest.claim.comparable, true);
  assert.equal(manifest.claim.publicationEligible, false);
  assert(
    manifest.claim.blockers.some((blocker) => blocker.includes("harness")),
    "fixture comparison must disclose its harness blocker"
  );
  assert.deepEqual(
    manifest.runs.map((run) => run.adapter),
    ["literal", "mnema", "mem0", "letta", "zep"]
  );
  assert.equal(
    manifest.runs.every(
      (run) =>
        run.status === "completed" &&
        run.reportStatus === "completed" &&
        run.resultClass === "harness" &&
        run.runtimeFailures === 0 &&
        run.metrics?.scenarios === 2 &&
        run.metrics.qaAccuracy === 1 &&
        run.metrics.cleanupVerificationRate === 1 &&
        run.evaluationSha256 === manifest.evaluation.configurationSha256
    ),
    true
  );
  const processIds = manifest.runs.map((run) => run.processId);
  assert.equal(processIds.every((pid) => Number.isInteger(pid)), true);
  assert.equal(new Set(processIds).size, manifest.runs.length);
  for (const run of manifest.runs) {
    assert.notEqual(run.reportFile, null);
    assert.notEqual(run.reportSha256, null);
    const reportFile = path.join(successfulOutput, run.reportFile!);
    assert.equal(fs.existsSync(reportFile), true);
    assert.equal(sha256(fs.readFileSync(reportFile)), run.reportSha256);
  }
  const artifacts = fs.readdirSync(successfulOutput).sort();
  assert.equal(artifacts.length, 6);
  assert.equal(
    artifacts.some((file) => file.endsWith("-agent-manifest.json")),
    true
  );
  assert.equal(mem0.snapshot().memories, 0);
  assert.equal(letta.snapshot().agents, 0);
  assert.equal(zep.snapshot().graphs, 0);

  const qaFailureDatasetFile = path.join(
    temporaryDirectory,
    "agent-dataset-qa-failure.json"
  );
  const qaFailureDataset = JSON.parse(
    fs.readFileSync(datasetFile, "utf8")
  ) as {
    scenarios: Array<{ expectedAnswer: string }>;
  };
  qaFailureDataset.scenarios[0]!.expectedAnswer =
    "deliberately incorrect expected answer";
  fs.writeFileSync(
    qaFailureDatasetFile,
    `${JSON.stringify(qaFailureDataset)}\n`
  );
  const qaFailureOutput = path.join(temporaryDirectory, "qa-failure");
  const qaFailure = await runComparison(
    [
      `--dataset=${qaFailureDatasetFile}`,
      "--adapters=literal,mnema",
      "--reader=fixture",
      "--judge=fixture",
      "--top-k=1",
      "--max-scenarios=1",
      "--adapter-timeout-ms=10000",
      `--output-dir=${qaFailureOutput}`,
      "--json",
    ],
    sharedEnvironment
  );
  assert.equal(
    qaFailure.exitCode,
    0,
    "ordinary QA misses must remain results rather than runtime failures"
  );
  const qaFailureManifest = JSON.parse(
    qaFailure.stdout
  ) as AgentComparisonManifestSnapshot;
  assert.equal(qaFailureManifest.claim.comparable, true);
  assert.equal(
    qaFailureManifest.runs.every(
      (run) =>
        run.status === "completed" &&
        run.runtimeFailures === 0 &&
        run.metrics?.qaAccuracy === 0
    ),
    true
  );

  const failedOutput = path.join(temporaryDirectory, "failed");
  const failed = await runComparison(
    [
      `--dataset=${datasetFile}`,
      "--adapters=literal,mem0",
      "--reader=fixture",
      "--judge=fixture",
      "--top-k=1",
      "--max-scenarios=1",
      "--adapter-timeout-ms=10000",
      `--output-dir=${failedOutput}`,
      "--json",
    ],
    {
      ...sharedEnvironment,
      MEM0_API_KEY: "wrong-agent-compare-key",
    }
  );
  assert.equal(failed.exitCode, 1);
  const failedManifest = JSON.parse(
    failed.stdout
  ) as AgentComparisonManifestSnapshot;
  assert.equal(failedManifest.claim.comparable, false);
  assert.equal(failedManifest.claim.publicationEligible, false);
  assert.equal(failedManifest.runs[0]?.status, "completed");
  assert.equal(failedManifest.runs[1]?.adapter, "mem0");
  assert.equal(failedManifest.runs[1]?.status, "failed");
  assert.equal(failedManifest.runs[1]?.reportStatus, "failed");
  assert.equal(
    (failedManifest.runs[1]?.runtimeFailures ?? 0) > 0,
    true
  );
  assert.match(failedManifest.runs[1]?.error ?? "", /invalid token/i);
  assert.equal(
    JSON.stringify(failedManifest).includes("wrong-agent-compare-key"),
    false
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        adapters: manifest.runs.map((run) => run.adapter),
        processIsolationVerified: true,
        identicalEvaluationFingerprint: true,
        reportHashesVerified: true,
        failureIsolationVerified: true,
        qaFailureRemainedResult: true,
        providerCleanupVerified: true,
        harnessClaimGuardVerified: true,
      },
      null,
      2
    )
  );
} finally {
  await Promise.all([mem0.close(), letta.close(), zep.close()]);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
