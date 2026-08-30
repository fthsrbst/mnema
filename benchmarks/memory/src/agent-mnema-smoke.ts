import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FixtureEvidenceReader,
  FixtureJudge,
} from "./agent-components.js";
import { openAgentDataset } from "./agent-dataset.js";
import { MnemaAgentMemoryAdapter } from "./agent-mnema.js";
import { runAgentBenchmark } from "./agent-runner.js";
import { importLongMemEval } from "./longmemeval.js";

const fixture = fileURLToPath(
  new URL("../fixtures/longmemeval-contract.json", import.meta.url)
);
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "memory-bench-agent-mnema-smoke-")
);
const previousHubDbPath = process.env.HUB_DB_PATH;
const configuredDatabaseSentinel = path.join(
  temporaryDirectory,
  "configured-production-sentinel.db"
);
process.env.HUB_DB_PATH = configuredDatabaseSentinel;

try {
  const datasetFile = path.join(temporaryDirectory, "agent-dataset.json");
  await importLongMemEval({
    input: fixture,
    output: datasetFile,
    source: {
      revision: "agent-mnema-fixture-v1",
      subset: "oracle",
      uri: "https://example.invalid/longmemeval-contract.json",
      license: "MIT",
    },
  });
  const report = await runAgentBenchmark(
    await openAgentDataset(datasetFile),
    new MnemaAgentMemoryAdapter(),
    new FixtureEvidenceReader(),
    new FixtureJudge(),
    {
      runId: "agent-mnema-smoke",
      topK: 1,
    }
  );
  assert.equal(report.run.status, "completed");
  assert.equal(report.run.resultClass, "harness");
  assert.equal(report.run.components.adapter.name, "mnema");
  assert.equal(report.run.components.adapter.classification, "candidate");
  assert.equal(report.metrics.scenarios, 2);
  assert.equal(report.metrics.completed, 2);
  assert.equal(report.metrics.qaAccuracy, 1);
  assert.equal(report.metrics.retrievalQueries, 1);
  assert.equal(report.metrics.macroRecallAtK, 1);
  assert.equal(report.metrics.cleanupVerificationRate, 1);
  assert.equal(
    report.scenarios.every((scenario) => scenario.cleanup.verified),
    true
  );
  assert.equal(process.env.HUB_DB_PATH, configuredDatabaseSentinel);
  assert.equal(fs.existsSync(configuredDatabaseSentinel), false);

  const oversizedAdapter = new MnemaAgentMemoryAdapter();
  await oversizedAdapter.setup({
    runId: "agent-mnema-oversized-smoke",
    datasetName: "memory-bench-oversized-smoke",
    datasetVersion: "1.0.0",
    datasetSubset: "oracle",
  });
  let oversizedCleanupVerified = false;
  try {
    await oversizedAdapter.beginScenario({
      scenarioId: "oversized-session",
      sessionCount: 1,
    });
    await oversizedAdapter.ingest({
      id: "oversized-session-1",
      date: "2025-01-01",
      messages: [
        {
          role: "user",
          content: `oversized-memory-needle ${"x".repeat(25_000)}`,
        },
      ],
    });
    const oversizedHits = await oversizedAdapter.query({
      question: "oversized memory needle",
      questionDate: "2025-01-02",
      topK: 5,
    });
    assert.equal(
      oversizedHits.some(
        (item) => item.sourceSessionId === "oversized-session-1"
      ),
      true
    );
    const cleanup = await oversizedAdapter.endScenario();
    assert.equal(cleanup.succeeded, true);
    assert.equal(cleanup.verified, true);
    oversizedCleanupVerified = true;
  } finally {
    await oversizedAdapter.teardown();
  }
  assert.equal(process.env.HUB_DB_PATH, configuredDatabaseSentinel);
  assert.equal(fs.existsSync(configuredDatabaseSentinel), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        adapter: report.run.components.adapter.name,
        scenarios: report.metrics.scenarios,
        qaAccuracy: report.metrics.qaAccuracy,
        recallAtK: report.metrics.macroRecallAtK,
        cleanupVerified: report.metrics.cleanupVerificationRate,
        configuredDatabaseUntouched: true,
        environmentRestored: true,
        oversizedSessionChunked: true,
        oversizedCleanupVerified,
      },
      null,
      2
    )
  );
} finally {
  if (previousHubDbPath === undefined) delete process.env.HUB_DB_PATH;
  else process.env.HUB_DB_PATH = previousHubDbPath;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
