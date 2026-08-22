import assert from "node:assert/strict";
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
import { openAgentDataset } from "./agent-dataset.js";
import { runAgentBenchmark } from "./agent-runner.js";
import type {
  AgentCleanupResult,
  AgentComponentInfo,
  AgentComponentTelemetry,
  AgentIngestSession,
  AgentMemoryReader,
  AgentMemoryQuery,
  AgentContextItem,
  AgentReaderInput,
} from "./agent-types.js";
import { importLongMemEval } from "./longmemeval.js";

const fixture = fileURLToPath(
  new URL("../fixtures/longmemeval-contract.json", import.meta.url)
);

class LabelLeakProbeAdapter extends LiteralAgentMemoryAdapter {
  sawOnlyPublicMessageFields = true;

  override async ingest(session: AgentIngestSession): Promise<void> {
    for (const message of session.messages) {
      const keys = Object.keys(message).sort();
      if (keys.join(",") !== "content,role") {
        this.sawOnlyPublicMessageFields = false;
      }
    }
    await super.ingest(session);
  }
}

class FirstCallFailingReader implements AgentMemoryReader {
  readonly info: AgentComponentInfo = {
    name: "first-call-failing-reader",
    version: "1",
    mode: "failure-injection",
    classification: "harness",
    config: {},
  };

  private calls = 0;
  private readonly delegate = new FixtureEvidenceReader();

  async answer(input: AgentReaderInput): Promise<string> {
    this.calls += 1;
    if (this.calls === 1) throw new Error("injected reader failure");
    return this.delegate.answer(input);
  }

  getTelemetry(): AgentComponentTelemetry {
    return this.delegate.getTelemetry();
  }
}

class FirstCleanupFailingAdapter extends LiteralAgentMemoryAdapter {
  private cleanupCalls = 0;

  override async endScenario(): Promise<AgentCleanupResult> {
    this.cleanupCalls += 1;
    const result = await super.endScenario();
    if (this.cleanupCalls === 1) {
      return { ...result, verified: false };
    }
    return result;
  }
}

class InvalidContextAdapter extends LiteralAgentMemoryAdapter {
  override async query(_input: AgentMemoryQuery): Promise<AgentContextItem[]> {
    return [
      {
        type: "text",
        value: "invalid score",
        observedAt: null,
        sourceSessionId: "invalid",
        score: Number.NaN,
      },
    ];
  }
}

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "memory-bench-agent-smoke-")
);

try {
  const importedFile = path.join(temporaryDirectory, "agent-dataset.json");
  await importLongMemEval({
    input: fixture,
    output: importedFile,
    source: {
      revision: "agent-smoke-fixture-v1",
      subset: "oracle",
      uri: "https://example.invalid/longmemeval-contract.json",
      license: "MIT",
    },
  });
  const dataset = await openAgentDataset(importedFile);
  assert.equal(dataset.readPasses, 2);
  assert.equal(dataset.metadata.source.subset, "oracle");
  assert.equal(
    dataset.artifactSha256,
    createHash("sha256").update(fs.readFileSync(importedFile)).digest("hex")
  );

  const probeAdapter = new LabelLeakProbeAdapter();
  const report = await runAgentBenchmark(
    dataset,
    probeAdapter,
    new FixtureEvidenceReader(),
    new FixtureJudge(),
    {
      runId: "agent-smoke-happy",
      topK: 1,
    }
  );
  assert.equal(report.run.status, "completed");
  assert.equal(report.run.resultClass, "harness");
  assert.equal(report.metrics.scenarios, 2);
  assert.equal(report.metrics.completed, 2);
  assert.equal(report.metrics.qaAccuracy, 1);
  assert.equal(report.metrics.retrievalQueries, 1);
  assert.equal(report.metrics.macroRecallAtK, 1);
  assert.equal(report.metrics.meanReciprocalRank, 1);
  assert.equal(report.metrics.cleanupVerificationRate, 1);
  assert.equal(report.scenarios[1]!.retrievalEvaluated, false);
  assert.equal(report.scenarios[1]!.recallAtK, null);
  assert.equal(probeAdapter.sawOnlyPublicMessageFields, true);
  assert.equal("value" in report.scenarios[0]!.evidence[0]!, false);
  assert.match(report.scenarios[0]!.evidence[0]!.valueSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    JSON.stringify(report).includes("Use green for the synthetic fixture."),
    false,
    "reports must not copy raw retrieved evidence"
  );
  assert.equal(
    JSON.stringify(report).includes('"expectedAnswer"'),
    false,
    "reports must not expose answer labels"
  );

  const readerFailureReport = await runAgentBenchmark(
    dataset,
    new LiteralAgentMemoryAdapter(),
    new FirstCallFailingReader(),
    new FixtureJudge(),
    {
      runId: "agent-smoke-reader-failure",
      topK: 1,
    }
  );
  assert.equal(readerFailureReport.run.status, "completed-with-errors");
  assert.equal(readerFailureReport.scenarios.length, 2);
  assert.equal(readerFailureReport.scenarios[0]!.status, "failed");
  assert.equal(readerFailureReport.scenarios[0]!.cleanup.verified, true);
  assert.equal(readerFailureReport.scenarios[1]!.status, "completed");
  assert.equal(readerFailureReport.scenarios[1]!.qaPassed, true);
  assert.equal(readerFailureReport.failures[0]!.stage, "reader");

  const cleanupFailureReport = await runAgentBenchmark(
    dataset,
    new FirstCleanupFailingAdapter(),
    new FixtureEvidenceReader(),
    new FixtureJudge(),
    {
      runId: "agent-smoke-cleanup-failure",
      topK: 1,
    }
  );
  assert.equal(cleanupFailureReport.run.status, "completed-with-errors");
  assert.equal(cleanupFailureReport.scenarios.length, 1);
  assert.equal(cleanupFailureReport.scenarios[0]!.status, "failed");
  assert.equal(cleanupFailureReport.scenarios[0]!.cleanup.verified, false);
  assert.equal(cleanupFailureReport.failures[0]!.stage, "cleanup");

  const invalidContextReport = await runAgentBenchmark(
    dataset,
    new InvalidContextAdapter(),
    new FixtureEvidenceReader(),
    new FixtureJudge(),
    {
      runId: "agent-smoke-invalid-context",
      topK: 1,
      maxScenarios: 1,
    }
  );
  assert.equal(invalidContextReport.run.status, "completed-with-errors");
  assert.equal(invalidContextReport.scenarios[0]!.status, "failed");
  assert.equal(invalidContextReport.failures[0]!.stage, "query");
  assert.equal(invalidContextReport.scenarios[0]!.cleanup.verified, true);

  console.log(
    JSON.stringify(
      {
        ok: true,
        scenarios: report.metrics.scenarios,
        qaAccuracy: report.metrics.qaAccuracy,
        retrievalQueries: report.metrics.retrievalQueries,
        labelLeakPrevented: probeAdapter.sawOnlyPublicMessageFields,
        readerFailureRecovered: true,
        cleanupFailureStoppedRun: true,
        invalidContextRejected: true,
        rawEvidenceOmitted: true,
      },
      null,
      2
    )
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
