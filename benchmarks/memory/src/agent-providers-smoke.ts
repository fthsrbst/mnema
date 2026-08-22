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
  LettaAgentMemoryAdapter,
  Mem0AgentMemoryAdapter,
  ZepAgentMemoryAdapter,
} from "./agent-providers.js";
import { runAgentBenchmark } from "./agent-runner.js";
import type {
  AgentBenchmarkReport,
  AgentMemoryAdapter,
} from "./agent-types.js";
import { startFakeLettaServer } from "./testing/fake-letta-server.js";
import { startFakeMem0Server } from "./testing/fake-mem0-server.js";
import { startFakeZepServer } from "./testing/fake-zep-server.js";
import { importLongMemEval } from "./longmemeval.js";

const fixture = fileURLToPath(
  new URL("../fixtures/longmemeval-contract.json", import.meta.url)
);
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "memory-bench-agent-providers-smoke-")
);
const apiKey = "agent-provider-contract-key";

function assertCompleted(
  report: AgentBenchmarkReport,
  provider: "mem0" | "letta" | "zep"
): void {
  assert.equal(report.run.status, "completed", `${provider} agent run failed`);
  assert.equal(report.run.resultClass, "harness");
  assert.equal(report.run.components.adapter.name, provider);
  assert.equal(report.run.components.adapter.classification, "candidate");
  assert.equal(
    report.run.components.adapter.config.scenarioIsolation,
    "one-disposable-core-run-per-scenario"
  );
  assert.equal(report.metrics.scenarios, 2);
  assert.equal(report.metrics.completed, 2);
  assert.equal(report.metrics.qaAccuracy, 1);
  assert.equal(report.metrics.macroRecallAtK, 1);
  assert.equal(report.metrics.cleanupVerificationRate, 1);
  assert.equal(
    report.scenarios.every((scenario) => scenario.cleanup.verified),
    true
  );
  assert.equal(report.run.telemetry.adapter.retryCount, 1);
  assert.equal(report.run.telemetry.adapter.requestCount > 0, true);
}

async function runProvider(
  datasetFile: string,
  adapter: AgentMemoryAdapter
): Promise<AgentBenchmarkReport> {
  return runAgentBenchmark(
    await openAgentDataset(datasetFile),
    adapter,
    new FixtureEvidenceReader(),
    new FixtureJudge(),
    {
      runId: `agent-provider-${adapter.info.name}-smoke`,
      topK: 1,
    }
  );
}

async function runCli(
  datasetFile: string,
  adapter: "mem0" | "letta" | "zep",
  environment: NodeJS.ProcessEnv
): Promise<AgentBenchmarkReport> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "benchmarks/memory/src/agent-cli.ts",
      `--dataset=${datasetFile}`,
      `--adapter=${adapter}`,
      "--reader=fixture",
      "--judge=fixture",
      "--top-k=1",
      "--max-scenarios=1",
      "--json",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...environment,
        MEMORY_BENCH_HTTP_TIMEOUT_MS: "500",
        MEMORY_BENCH_SETTLE_TIMEOUT_MS: "500",
        MEMORY_BENCH_POLL_INTERVAL_MS: "1",
        MEMORY_BENCH_HTTP_MAX_RETRIES: "1",
        MEMORY_BENCH_RETRY_BASE_DELAY_MS: "0",
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
  assert.equal(
    exitCode,
    0,
    `${adapter} agent CLI failed\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );
  return JSON.parse(stdout) as AgentBenchmarkReport;
}

const mem0 = await startFakeMem0Server(apiKey);
const letta = await startFakeLettaServer(apiKey);
const zep = await startFakeZepServer(apiKey);

try {
  const datasetFile = path.join(temporaryDirectory, "agent-dataset.json");
  await importLongMemEval({
    input: fixture,
    output: datasetFile,
    source: {
      revision: "agent-providers-fixture-v1",
      subset: "oracle",
      uri: "https://example.invalid/longmemeval-contract.json",
      license: "MIT",
    },
  });

  mem0.failNextSearch();
  const mem0Report = await runProvider(
    datasetFile,
    new Mem0AgentMemoryAdapter({
      apiKey,
      baseUrl: mem0.baseUrl,
      requestTimeoutMs: 500,
      settleTimeoutMs: 500,
      pollIntervalMs: 1,
      maxRetries: 1,
      retryBaseDelayMs: 0,
    })
  );
  assertCompleted(mem0Report, "mem0");
  assert.equal(mem0.snapshot().memories, 0);
  assert.equal(mem0.snapshot().authFailures, 0);

  letta.failNextSearch();
  const lettaReport = await runProvider(
    datasetFile,
    new LettaAgentMemoryAdapter({
      apiKey,
      baseUrl: letta.baseUrl,
      requestTimeoutMs: 500,
      settleTimeoutMs: 500,
      pollIntervalMs: 1,
      maxRetries: 1,
      retryBaseDelayMs: 0,
    })
  );
  assertCompleted(lettaReport, "letta");
  assert.equal(letta.snapshot().agents, 0);
  assert.equal(letta.snapshot().passages, 0);
  assert.equal(letta.snapshot().authFailures, 0);

  zep.failNextSearch();
  const zepReport = await runProvider(
    datasetFile,
    new ZepAgentMemoryAdapter({
      apiKey,
      baseUrl: zep.baseUrl,
      requestTimeoutMs: 500,
      settleTimeoutMs: 500,
      pollIntervalMs: 1,
      maxRetries: 1,
      retryBaseDelayMs: 0,
    })
  );
  assertCompleted(zepReport, "zep");
  assert.equal(zep.snapshot().graphs, 0);
  assert.equal(zep.snapshot().episodes, 0);
  assert.equal(zep.snapshot().authFailures, 0);

  const requestsBeforeMissingCredential = mem0.snapshot().requests;
  const missingCredentialReport = await runAgentBenchmark(
    await openAgentDataset(datasetFile),
    new Mem0AgentMemoryAdapter({
      apiKey: "",
      baseUrl: mem0.baseUrl,
    }),
    new FixtureEvidenceReader(),
    new FixtureJudge(),
    {
      runId: "agent-mem0-missing-credential",
      topK: 1,
      maxScenarios: 1,
    }
  );
  assert.equal(missingCredentialReport.run.status, "failed");
  assert.equal(missingCredentialReport.failures[0]!.stage, "setup");
  assert.equal(
    mem0.snapshot().requests,
    requestsBeforeMissingCredential,
    "missing credentials must fail before an agent provider request"
  );

  const cliReports = await Promise.all([
    runCli(datasetFile, "mem0", {
      MEM0_API_KEY: apiKey,
      MEMORY_BENCH_MEM0_BASE_URL: mem0.baseUrl,
    }),
    runCli(datasetFile, "letta", {
      LETTA_API_KEY: apiKey,
      MEMORY_BENCH_LETTA_BASE_URL: letta.baseUrl,
    }),
    runCli(datasetFile, "zep", {
      ZEP_API_KEY: apiKey,
      MEMORY_BENCH_ZEP_BASE_URL: zep.baseUrl,
    }),
  ]);
  assert.deepEqual(
    cliReports.map((report) => report.run.components.adapter.name),
    ["mem0", "letta", "zep"]
  );
  assert.equal(
    cliReports.every(
      (report) =>
        report.run.status === "completed" &&
        report.metrics.scenarios === 1 &&
        report.metrics.cleanupVerificationRate === 1
    ),
    true
  );
  assert.equal(mem0.snapshot().memories, 0);
  assert.equal(letta.snapshot().agents, 0);
  assert.equal(zep.snapshot().graphs, 0);

  const oversizedZep = new ZepAgentMemoryAdapter({
    apiKey,
    baseUrl: zep.baseUrl,
    requestTimeoutMs: 500,
    settleTimeoutMs: 500,
    pollIntervalMs: 1,
    maxRetries: 0,
    retryBaseDelayMs: 0,
  });
  await oversizedZep.setup({
    runId: "agent-zep-oversized",
    datasetName: "agent-zep-oversized",
    datasetVersion: "1.0.0",
    datasetSubset: "oracle",
  });
  await oversizedZep.beginScenario({
    scenarioId: "oversized",
    sessionCount: 1,
  });
  await oversizedZep.ingest({
    id: "oversized-session",
    date: "2026/07/01 (Wed) 10:00",
    messages: [
      {
        role: "user",
        content: `zep-fragment-needle ${"🧠".repeat(6_000)}`,
      },
    ],
  });
  assert.equal(
    zep.snapshot().episodeCreates >= 2,
    true,
    "Zep agent sessions must be split below its documented 10k limit"
  );
  const oversizedHits = await oversizedZep.query({
    question: "zep fragment needle",
    questionDate: "2026/07/02 (Thu) 10:00",
    topK: 5,
  });
  assert.equal(
    oversizedHits.some(
      (item) => item.sourceSessionId === "oversized-session"
    ),
    true
  );
  const requestsBeforeInvalidZepSearch = zep.snapshot().requests;
  await assert.rejects(
    oversizedZep.query({
      question: "q".repeat(401),
      questionDate: "2026/07/02 (Thu) 10:00",
      topK: 5,
    }),
    /query exceeds the provider limit of 400 characters/
  );
  await assert.rejects(
    oversizedZep.query({
      question: "zep fragment needle",
      questionDate: "2026/07/02 (Thu) 10:00",
      topK: 51,
    }),
    /topK exceeds the provider limit of 50/
  );
  assert.equal(
    zep.snapshot().requests,
    requestsBeforeInvalidZepSearch,
    "invalid Zep searches must fail before a provider request"
  );
  assert.deepEqual(await oversizedZep.endScenario(), {
    attempted: true,
    succeeded: true,
    verified: true,
  });
  await oversizedZep.teardown();
  assert.equal(zep.snapshot().graphs, 0);
  assert.equal(zep.snapshot().episodes, 0);

  const invalidDate = new ZepAgentMemoryAdapter({
    apiKey,
    baseUrl: zep.baseUrl,
    requestTimeoutMs: 500,
    settleTimeoutMs: 500,
    pollIntervalMs: 1,
    maxRetries: 0,
    retryBaseDelayMs: 0,
  });
  await invalidDate.setup({
    runId: "agent-zep-invalid-date",
    datasetName: "agent-zep-invalid-date",
    datasetVersion: "1.0.0",
    datasetSubset: "oracle",
  });
  await invalidDate.beginScenario({
    scenarioId: "invalid-date",
    sessionCount: 1,
  });
  const episodeCreatesBeforeInvalidDate = zep.snapshot().episodeCreates;
  await assert.rejects(
    invalidDate.ingest({
      id: "invalid-date-session",
      date: "not-a-date",
      messages: [{ role: "user", content: "must not be sent" }],
    }),
    /session date must be/
  );
  assert.equal(
    zep.snapshot().episodeCreates,
    episodeCreatesBeforeInvalidDate
  );
  assert.deepEqual(await invalidDate.endScenario(), {
    attempted: true,
    succeeded: true,
    verified: true,
  });
  await invalidDate.teardown();

  const cleanupRecovery = new ZepAgentMemoryAdapter({
    apiKey,
    baseUrl: zep.baseUrl,
    requestTimeoutMs: 500,
    settleTimeoutMs: 500,
    pollIntervalMs: 1,
    maxRetries: 0,
    retryBaseDelayMs: 0,
  });
  await cleanupRecovery.setup({
    runId: "agent-zep-cleanup-recovery",
    datasetName: "agent-zep-cleanup-recovery",
    datasetVersion: "1.0.0",
    datasetSubset: "oracle",
  });
  await cleanupRecovery.beginScenario({
    scenarioId: "cleanup-recovery",
    sessionCount: 1,
  });
  await cleanupRecovery.ingest({
    id: "cleanup-session",
    date: "2026/07/01 (Wed) 10:00",
    messages: [{ role: "user", content: "cleanup recovery evidence" }],
  });
  zep.failNextGraphDelete();
  await assert.rejects(
    cleanupRecovery.endScenario(),
    /temporary graph cleanup failure/
  );
  assert.equal(zep.snapshot().graphs, 1);
  await cleanupRecovery.teardown();
  assert.equal(zep.snapshot().graphs, 0);
  assert.equal(zep.snapshot().episodes, 0);

  console.log(
    JSON.stringify(
      {
        ok: true,
        providers: ["mem0", "letta", "zep"],
        scenariosPerProvider: 2,
        searchRetryVerified: true,
        cliAdaptersVerified: true,
        missingCredentialFailedBeforeNetwork: true,
        cleanupVerified: true,
        zepTenThousandCharacterBoundary: true,
        unicodeFragmentationVerified: true,
        invalidDateFailedBeforeWrite: true,
        zepSearchLimitsFailedBeforeNetwork: true,
        cleanupRecoveryVerified: true,
      },
      null,
      2
    )
  );
} finally {
  await Promise.all([mem0.close(), letta.close(), zep.close()]);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
