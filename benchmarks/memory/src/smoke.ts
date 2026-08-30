import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { LettaAdapter } from "./adapters/letta.js";
import { LiteralAdapter } from "./adapters/literal.js";
import { Mem0Adapter } from "./adapters/mem0.js";
import { MnemaAdapter } from "./adapters/mnema.js";
import { ZepAdapter } from "./adapters/zep.js";
import { analyzeCorpus } from "./corpus.js";
import { assessPublicationReadiness, loadDataset, parseDataset } from "./dataset.js";
import { runBenchmark } from "./runner.js";
import { startFakeLettaServer } from "./testing/fake-letta-server.js";
import { startFakeMem0Server } from "./testing/fake-mem0-server.js";
import { startFakeZepServer } from "./testing/fake-zep-server.js";
import type {
  AdapterInfo,
  AdapterTelemetry,
  BenchmarkMemoryRecord,
  BenchmarkReport,
  BenchmarkRunContext,
  MemoryBenchAdapter,
  NormalizedMemoryHit,
  SearchInput,
} from "./types.js";

const dataset = loadDataset(fileURLToPath(new URL("../datasets/core-smoke-v1.json", import.meta.url)));
const draftDataset = loadDataset(
  fileURLToPath(new URL("../datasets/core-draft-v0.1.json", import.meta.url))
);
assert.equal(dataset.scenarios.length, 7);
const smokeReadiness = assessPublicationReadiness(dataset);
assert.equal(smokeReadiness.ready, false);
assert.equal(smokeReadiness.queryCount, 7);
assert(
  smokeReadiness.issues.some((issue) => issue.includes("expected at least 100")),
  "the harness dataset must fail the public corpus size gate"
);
assert(
  smokeReadiness.issues.some((issue) => issue.includes("review status is harness")),
  "harness scenarios must not be mistaken for independently reviewed cases"
);
assert(
  assessPublicationReadiness({ ...dataset, license: "TBD" }).issues.some((issue) =>
    issue.includes("license is unresolved")
  ),
  "placeholder licenses must fail the public corpus gate"
);
assert(
  assessPublicationReadiness({
    ...dataset,
    license: "LicenseRef-Research-Only",
  }).issues.some((issue) => issue.includes("not approved for public release")),
  "custom research-only terms must fail the open corpus gate"
);
const datasetScopes = new Set(
  dataset.scenarios.flatMap((scenario) =>
    scenario.operations.map((operation) =>
      operation.op === "write" || operation.op === "update" ? operation.record.scope : operation.scope
    )
  )
);
const draftAnalysis = analyzeCorpus(draftDataset);
assert.equal(draftAnalysis.scenarioCount, 120);
assert.equal(draftAnalysis.queryCount, 120);
assert.equal(draftAnalysis.counts.languages.en, 60);
assert.equal(draftAnalysis.counts.languages.tr, 60);
assert.deepEqual(
  Object.values(draftAnalysis.counts.abilities),
  [20, 20, 20, 20, 20, 20],
  "draft corpus must balance all six core abilities"
);
assert.deepEqual(draftAnalysis.blockingIssues, []);
assert.equal(draftAnalysis.duplicateQueries.length, 0);
assert.equal(draftAnalysis.duplicateQueriesWithinScope.length, 0);
assert.equal(draftAnalysis.duplicateRecordContents.length, 0);
assert.equal(draftAnalysis.duplicateRecordContentsWithinScope.length, 0);
assert(draftAnalysis.maximumTemplateShare <= 0.02);
const duplicateScopeDataset = structuredClone(draftDataset);
const firstDuplicateQuery = duplicateScopeDataset.scenarios
  .find((scenario) => scenario.id === "draft-en-01-single")!
  .operations.find((operation) => operation.op === "query")!;
const secondDuplicateQuery = duplicateScopeDataset.scenarios
  .find((scenario) => scenario.id === "draft-en-02-single")!
  .operations.find((operation) => operation.op === "query")!;
secondDuplicateQuery.query = firstDuplicateQuery.query;
const crossScopeDuplicates = analyzeCorpus(duplicateScopeDataset);
assert.equal(crossScopeDuplicates.duplicateQueries.length, 1);
assert.equal(crossScopeDuplicates.duplicateQueriesWithinScope.length, 0);
assert.equal(crossScopeDuplicates.blockingIssues.length, 0);
secondDuplicateQuery.scope = firstDuplicateQuery.scope;
const sameScopeDuplicates = analyzeCorpus(duplicateScopeDataset);
assert.equal(sameScopeDuplicates.duplicateQueriesWithinScope.length, 1);
assert(
  sameScopeDuplicates.blockingIssues.some((issue) => issue.includes("within a scope")),
  "same-scope duplicate queries must block corpus release"
);
const draftReadiness = assessPublicationReadiness(draftDataset);
assert.equal(draftReadiness.queryCount, 120);
assert.equal(draftReadiness.ready, false);
assert(
  draftReadiness.issues.every(
    (issue) =>
      issue.includes("publicationStatus is draft") ||
      issue.includes("review status is draft")
  ),
  `draft corpus should be blocked only by human review gates: ${draftReadiness.issues.join("; ")}`
);
assert.throws(
  () =>
    parseDataset({
      schemaVersion: 1,
      name: "invalid",
      version: "1",
      license: "MIT",
      track: "core",
      publicationStatus: "draft",
      description: "Invalid empty expectation",
      scenarios: [
        {
          id: "invalid",
          description: "Invalid empty expectation",
          language: "en",
          difficulty: "basic",
          provenance: {
            origin: "synthetic",
            author: "smoke-test",
            authorType: "human",
          },
          review: {
            status: "draft",
            entries: [],
          },
          operations: [
            {
              op: "query",
              id: "invalid-query",
              scope: "user:test",
              query: "What is missing?",
              ability: "abstention",
              topK: 1,
              relevantIds: [],
            },
          ],
        },
      ],
    }),
  /must set expectEmpty=true/,
  "empty ground truth must be explicit so false positives cannot pass silently"
);
assert.throws(
  () =>
    parseDataset({
      schemaVersion: 1,
      name: "invalid-review",
      version: "1",
      license: "MIT",
      track: "core",
      publicationStatus: "reviewed",
      description: "Invalid self review",
      scenarios: [
        {
          id: "invalid-review",
          description: "Reviewer identity differs only by case",
          language: "en",
          difficulty: "basic",
          provenance: {
            origin: "synthetic",
            author: "Reviewer-One",
            authorType: "human",
          },
          review: {
            status: "reviewed",
            entries: [
              {
                reviewer: {
                  id: "reviewer-one",
                  type: "human",
                },
                reviewedAt: "2026-07-27T00:00:00Z",
                evidence: {
                  kind: "review-overlay",
                  sha256: "0".repeat(64),
                },
              },
            ],
          },
          operations: [
            {
              op: "query",
              id: "invalid-review-query",
              scope: "user:test",
              query: "What is missing?",
              ability: "abstention",
              topK: 1,
              relevantIds: [],
              expectEmpty: true,
            },
          ],
        },
      ],
    }),
  /independent from the provenance author/,
  "reviewer identity checks must be case-insensitive"
);
assert.throws(
  () =>
    parseDataset({
      schemaVersion: 1,
      name: "invalid-scope-move",
      version: "1",
      license: "MIT",
      track: "core",
      publicationStatus: "draft",
      description: "Invalid cross-scope update",
      scenarios: [
        {
          id: "invalid-scope-move",
          description: "Updates must preserve provider-neutral scope identity",
          language: "en",
          difficulty: "intermediate",
          provenance: {
            origin: "synthetic",
            author: "smoke-test",
            authorType: "human",
          },
          review: {
            status: "draft",
            entries: [],
          },
          operations: [
            {
              op: "write",
              record: {
                id: "record-v1",
                scope: "user:one",
                content: "Original",
                observedAt: "2026-07-27T00:00:00Z",
              },
            },
            {
              op: "update",
              targetId: "record-v1",
              record: {
                id: "record-v2",
                scope: "user:two",
                content: "Moved",
                observedAt: "2026-07-27T00:01:00Z",
              },
            },
          ],
        },
      ],
    }),
  /update cannot move/,
  "updates must not change scope because providers model namespace identity differently"
);

const literalReport = await runBenchmark(dataset, new LiteralAdapter(), "smoke-literal");
assert.equal(literalReport.metrics.queries, 7);
assert.equal(literalReport.metrics.queryPassRate, 1);
assert.equal(literalReport.metrics.forbiddenHitRate, 0);
assert.equal(literalReport.metrics.abstentionAccuracy, 1);
assert(
  literalReport.queries.some((query) => query.feedback.some((feedback) => feedback.verdict === "helpful")),
  "normalized feedback should include helpful hits"
);
assert(
  literalReport.queries.some((query) => query.feedback.some((feedback) => feedback.verdict === "noisy")),
  "normalized feedback should include noisy hits"
);
assert.equal(literalReport.metrics.slices.byLanguage.tr.queries, 1);
assert.equal(literalReport.metrics.slices.byDifficulty.advanced.queries, 1);

const draftLiteralReport = await runBenchmark(
  draftDataset,
  new LiteralAdapter(),
  "smoke-draft-literal"
);
assert.equal(draftLiteralReport.metrics.queries, 120);
assert.equal(draftLiteralReport.metrics.queryPassRate, 1);
assert.equal(draftLiteralReport.metrics.slices.byLanguage.en.queries, 60);
assert.equal(draftLiteralReport.metrics.slices.byLanguage.tr.queries, 60);
assert.equal(
  draftLiteralReport.metrics.slices.byAbility["abstention"].abstentionAccuracy,
  1
);

const previousDbPath = process.env.HUB_DB_PATH;
const mnemaReport = await runBenchmark(dataset, new MnemaAdapter(), "smoke-mnema");
assert.equal(mnemaReport.metrics.queries, 7);
assert.equal(mnemaReport.metrics.queryPassRate, 1);
assert.equal(mnemaReport.metrics.forbiddenHitRate, 0);
assert.equal(mnemaReport.metrics.abstentionAccuracy, 1);
assert.equal(process.env.HUB_DB_PATH, previousDbPath, "Mnema adapter must restore the caller environment");

class SetupFailureAdapter implements MemoryBenchAdapter {
  readonly info: AdapterInfo = {
    name: "setup-failure",
    version: "1",
    mode: "test",
    config: {},
  };

  teardownCalled = false;

  async setup(_context: BenchmarkRunContext): Promise<void> {
    throw new Error("intentional setup failure");
  }

  async write(_record: BenchmarkMemoryRecord): Promise<void> {}
  async update(_targetId: string, _record: BenchmarkMemoryRecord): Promise<void> {}
  async delete(_targetId: string, _scope: string): Promise<void> {}
  async search(_input: SearchInput): Promise<NormalizedMemoryHit[]> {
    return [];
  }

  async teardown(): Promise<void> {
    this.teardownCalled = true;
  }

  getTelemetry(): AdapterTelemetry {
    return {
      requestCount: 0,
      retryCount: 0,
      pollRequestCount: 0,
      requestBytes: 0,
      responseBytes: 0,
      providerProcessingMs: null,
      providerCostUsd: 0,
      costSource: "not-applicable",
      cleanup: {
        attempted: this.teardownCalled,
        succeeded: this.teardownCalled,
        verified: this.teardownCalled,
      },
    };
  }
}

const setupFailureAdapter = new SetupFailureAdapter();
await assert.rejects(
  runBenchmark(dataset, setupFailureAdapter, "smoke-setup-failure"),
  /intentional setup failure/
);
assert.equal(setupFailureAdapter.teardownCalled, true, "teardown must run after partial setup");

class SetupAndCleanupFailureAdapter extends SetupFailureAdapter {
  override async teardown(): Promise<void> {
    throw new Error("intentional cleanup failure");
  }
}

const dualFailure = await runBenchmark(
  dataset,
  new SetupAndCleanupFailureAdapter(),
  "smoke-dual-failure"
).catch((error: unknown) => error);
assert(dualFailure instanceof AggregateError, "runner must preserve execution and cleanup failures");
assert.equal(dualFailure.errors.length, 2, "aggregate error must contain both failures");

assert.throws(
  () => new Mem0Adapter({ apiKey: "test-key", baseUrl: "https://api.mem0.ai/not-an-origin" }),
  /credential-free http\(s\) origin/,
  "Mem0 base URL must not accept paths that would be discarded by absolute API routes"
);

const fakeMem0 = await startFakeMem0Server();
let mem0Report: BenchmarkReport;
try {
  await assert.rejects(
    runBenchmark(
      dataset,
      new Mem0Adapter({ apiKey: "", baseUrl: fakeMem0.baseUrl }),
      "smoke-mem0-missing-key"
    ),
    /MEM0_API_KEY is required/
  );
  assert.equal(fakeMem0.snapshot().requests, 0, "missing credentials must fail before any network request");

  fakeMem0.failNextSearch();
  mem0Report = await runBenchmark(
    dataset,
    new Mem0Adapter({
      apiKey: "test-key",
      baseUrl: fakeMem0.baseUrl,
      requestTimeoutMs: 1_000,
      settleTimeoutMs: 2_000,
      pollIntervalMs: 1,
      retryBaseDelayMs: 1,
      maxRetries: 1,
    }),
    "smoke-mem0"
  );
  assert.equal(mem0Report.metrics.queries, 7);
  assert.equal(mem0Report.metrics.queryPassRate, 1);
  assert.equal(mem0Report.metrics.forbiddenHitRate, 0);
  assert.equal(mem0Report.metrics.abstentionAccuracy, 1);
  assert.equal(mem0Report.run.adapterTelemetry.retryCount, 1, "safe search should retry one transient 503");
  assert(mem0Report.run.adapterTelemetry.pollRequestCount > 0, "async adds should emit polling telemetry");
  assert.equal(mem0Report.run.adapterTelemetry.providerProcessingMs, 156, "13 add events × 12ms");
  assert.equal(mem0Report.run.adapterTelemetry.providerCostUsd, null);
  assert.equal(mem0Report.run.adapterTelemetry.costSource, "not-exposed");
  assert.deepEqual(mem0Report.run.adapterTelemetry.cleanup, {
    attempted: true,
    succeeded: true,
    verified: true,
  });
  assert.equal(fakeMem0.snapshot().memories, 0, "run-scoped teardown must remove every fake Mem0 memory");
  assert.equal(fakeMem0.snapshot().cleanupCalls, 2, "setup pre-clean and final teardown should both be scoped");
  assert.equal(fakeMem0.snapshot().authFailures, 0, "adapter must send Token authentication");

  fakeMem0.failNextEvent();
  const failedEventDataset = {
    ...dataset,
    name: "memory-bench-failed-event",
    scenarios: [
      {
        id: "failed-event",
        description: "Provider event failure must fail the run and still clean up.",
        language: "en",
        difficulty: "basic" as const,
        provenance: {
          origin: "synthetic" as const,
          author: "smoke-test",
          authorType: "human" as const,
        },
        review: {
          status: "draft" as const,
          entries: [],
        },
        operations: [
          {
            op: "write" as const,
            record: {
              id: "failed-event-record",
              scope: "user:failure",
              content: "This write is expected to fail.",
              observedAt: "2026-07-27T00:00:00Z",
            },
          },
        ],
      },
    ],
  };
  await assert.rejects(
    runBenchmark(
      failedEventDataset,
      new Mem0Adapter({
        apiKey: "test-key",
        baseUrl: fakeMem0.baseUrl,
        requestTimeoutMs: 1_000,
        settleTimeoutMs: 1_000,
        pollIntervalMs: 1,
        maxRetries: 0,
      }),
      "smoke-mem0-failed-event"
    ),
    /event .* failed/
  );
  assert.equal(fakeMem0.snapshot().memories, 0, "failed async writes must be removed by teardown");

  const timeoutAdapter = new Mem0Adapter({
    apiKey: "test-key",
    baseUrl: fakeMem0.baseUrl,
    requestTimeoutMs: 25,
    settleTimeoutMs: 250,
    pollIntervalMs: 1,
    maxRetries: 0,
  });
  await timeoutAdapter.setup({
    runId: "smoke-mem0-timeout",
    datasetName: dataset.name,
    datasetVersion: dataset.version,
    scopes: [],
  });
  try {
    fakeMem0.setSearchDelay(100);
    await assert.rejects(
      timeoutAdapter.search({
        scope: "user:timeout",
        query: "This request should time out",
        topK: 1,
      }),
      /timed out after 25ms/
    );
  } finally {
    fakeMem0.setSearchDelay(0);
    await timeoutAdapter.teardown();
  }
  assert.equal(fakeMem0.snapshot().memories, 0, "timeout path must leave no provider data");

  const cleanupRetryAdapter = new Mem0Adapter({
    apiKey: "test-key",
    baseUrl: fakeMem0.baseUrl,
    requestTimeoutMs: 1_000,
    settleTimeoutMs: 250,
    pollIntervalMs: 1,
    maxRetries: 0,
  });
  await cleanupRetryAdapter.setup({
    runId: "smoke-mem0-cleanup-retry",
    datasetName: dataset.name,
    datasetVersion: dataset.version,
    scopes: ["user:cleanup-retry"],
  });
  await cleanupRetryAdapter.write({
    id: "cleanup-retry-record",
    scope: "user:cleanup-retry",
    content: "Cleanup should be recoverable after a provider failure.",
    observedAt: "2026-07-27T00:00:00Z",
  });
  fakeMem0.failNextCleanup();
  await assert.rejects(
    cleanupRetryAdapter.teardown(),
    /temporary cleanup failure/,
    "a provider cleanup failure must be visible"
  );
  assert.equal(fakeMem0.snapshot().memories, 1, "failed cleanup should leave an observable record");
  assert.deepEqual(cleanupRetryAdapter.getTelemetry().cleanup, {
    attempted: true,
    succeeded: false,
    verified: false,
  });
  await cleanupRetryAdapter.teardown();
  assert.equal(fakeMem0.snapshot().memories, 0, "a second teardown must recover the same run namespace");
  assert.deepEqual(cleanupRetryAdapter.getTelemetry().cleanup, {
    attempted: true,
    succeeded: true,
    verified: true,
  });
} finally {
  await fakeMem0.close();
}

assert.throws(
  () => new LettaAdapter({ apiKey: "test-key", baseUrl: "https://api.letta.com/not-an-origin" }),
  /credential-free http\(s\) origin/,
  "Letta base URL must not accept paths that would be discarded by absolute API routes"
);

await assert.rejects(
  runBenchmark(
    dataset,
    new LettaAdapter({ apiKey: "", baseUrl: "https://api.letta.com" }),
    "smoke-letta-missing-key"
  ),
  /LETTA_API_KEY is required/,
  "managed Letta must fail before attempting an unauthenticated network request"
);

const fakeLetta = await startFakeLettaServer();
let lettaReport: BenchmarkReport;
try {
  fakeLetta.failNextSearch();
  lettaReport = await runBenchmark(
    dataset,
    new LettaAdapter({
      apiKey: "test-key",
      baseUrl: fakeLetta.baseUrl,
      requestTimeoutMs: 1_000,
      settleTimeoutMs: 2_000,
      pollIntervalMs: 1,
      retryBaseDelayMs: 1,
      maxRetries: 1,
    }),
    "smoke-letta"
  );
  assert.equal(lettaReport.metrics.queries, 7);
  assert.equal(lettaReport.metrics.queryPassRate, 1);
  assert.equal(lettaReport.metrics.forbiddenHitRate, 0);
  assert.equal(lettaReport.metrics.abstentionAccuracy, 1);
  assert.equal(lettaReport.run.adapterTelemetry.retryCount, 1, "safe Letta search should retry one 503");
  assert(lettaReport.run.adapterTelemetry.pollRequestCount > 0, "Letta settling should emit poll telemetry");
  assert.equal(lettaReport.run.adapterTelemetry.providerProcessingMs, null);
  assert.equal(lettaReport.run.adapterTelemetry.providerCostUsd, null);
  assert.equal(lettaReport.run.adapterTelemetry.costSource, "not-exposed");
  assert.equal(
    lettaReport.run.adapter.config.updateStrategy,
    "create-replacement+delete-old-passages"
  );
  assert.deepEqual(lettaReport.run.adapterTelemetry.cleanup, {
    attempted: true,
    succeeded: true,
    verified: true,
  });
  assert.equal(fakeLetta.snapshot().agents, 0, "Letta teardown must remove its disposable agent");
  assert.equal(fakeLetta.snapshot().passages, 0, "agent cleanup must remove all archival passages");
  assert.equal(fakeLetta.snapshot().agentDeleteCalls, 1, "teardown should delete exactly one run agent");
  assert.equal(fakeLetta.snapshot().passageCreates, 14, "13 writes plus one replacement update");
  assert.equal(fakeLetta.snapshot().passageDeletes, 2, "one update replacement and one dataset delete");
  assert.equal(fakeLetta.snapshot().authFailures, 0, "adapter must send Bearer authentication");

  const timeoutAdapter = new LettaAdapter({
    apiKey: "test-key",
    baseUrl: fakeLetta.baseUrl,
    requestTimeoutMs: 25,
    settleTimeoutMs: 250,
    pollIntervalMs: 1,
    maxRetries: 0,
  });
  await timeoutAdapter.setup({
    runId: "smoke-letta-timeout",
    datasetName: dataset.name,
    datasetVersion: dataset.version,
    scopes: [],
  });
  try {
    fakeLetta.setSearchDelay(100);
    await assert.rejects(
      timeoutAdapter.search({
        scope: "user:timeout",
        query: "This request should time out",
        topK: 1,
      }),
      /timed out after 25ms/
    );
  } finally {
    fakeLetta.setSearchDelay(0);
    await timeoutAdapter.teardown();
  }
  assert.equal(fakeLetta.snapshot().agents, 0, "Letta timeout path must leave no agent");

  const cleanupRetryAdapter = new LettaAdapter({
    apiKey: "test-key",
    baseUrl: fakeLetta.baseUrl,
    requestTimeoutMs: 1_000,
    settleTimeoutMs: 250,
    pollIntervalMs: 1,
    maxRetries: 0,
  });
  await cleanupRetryAdapter.setup({
    runId: "smoke-letta-cleanup-retry",
    datasetName: dataset.name,
    datasetVersion: dataset.version,
    scopes: ["user:cleanup-retry"],
  });
  await cleanupRetryAdapter.write({
    id: "letta-cleanup-retry-record",
    scope: "user:cleanup-retry",
    content: "Letta cleanup should be recoverable after a provider failure.",
    observedAt: "2026-07-27T00:00:00Z",
  });
  fakeLetta.failNextAgentDelete();
  await assert.rejects(
    cleanupRetryAdapter.teardown(),
    /temporary agent cleanup failure/,
    "a Letta cleanup failure must be visible"
  );
  assert.equal(fakeLetta.snapshot().agents, 1, "failed Letta cleanup should leave an observable agent");
  assert.deepEqual(cleanupRetryAdapter.getTelemetry().cleanup, {
    attempted: true,
    succeeded: false,
    verified: false,
  });
  await cleanupRetryAdapter.teardown();
  assert.equal(fakeLetta.snapshot().agents, 0, "a second Letta teardown must recover the same run agent");
  assert.deepEqual(cleanupRetryAdapter.getTelemetry().cleanup, {
    attempted: true,
    succeeded: true,
    verified: true,
  });
} finally {
  await fakeLetta.close();
}

assert.throws(
  () => new ZepAdapter({ apiKey: "test-key", baseUrl: "https://api.getzep.com/not-an-origin" }),
  /credential-free http\(s\) origin/,
  "Zep base URL must not accept paths that would be discarded by absolute API routes"
);

await assert.rejects(
  runBenchmark(
    dataset,
    new ZepAdapter({ apiKey: "", baseUrl: "https://api.getzep.com" }),
    "smoke-zep-missing-key"
  ),
  /ZEP_API_KEY is required/,
  "managed Zep must fail before attempting an unauthenticated network request"
);

const fakeZep = await startFakeZepServer();
let zepReport: BenchmarkReport;
try {
  fakeZep.failNextSearch();
  zepReport = await runBenchmark(
    dataset,
    new ZepAdapter({
      apiKey: "test-key",
      baseUrl: fakeZep.baseUrl,
      requestTimeoutMs: 1_000,
      settleTimeoutMs: 2_000,
      pollIntervalMs: 1,
      retryBaseDelayMs: 1,
      maxRetries: 1,
    }),
    "smoke-zep"
  );
  assert.equal(zepReport.metrics.queries, 7);
  assert.equal(zepReport.metrics.queryPassRate, 1);
  assert.equal(zepReport.metrics.forbiddenHitRate, 0);
  assert.equal(zepReport.metrics.abstentionAccuracy, 1);
  assert.equal(zepReport.run.adapterTelemetry.retryCount, 1, "safe Zep search should retry one 503");
  assert(zepReport.run.adapterTelemetry.pollRequestCount > 0, "Zep episode settling should emit polls");
  assert.equal(zepReport.run.adapterTelemetry.providerProcessingMs, 49, "7 searches × 7ms");
  assert.equal(zepReport.run.adapterTelemetry.providerCostUsd, null);
  assert.equal(zepReport.run.adapterTelemetry.costSource, "not-exposed");
  assert.equal(zepReport.run.adapter.config.searchScope, "episodes");
  assert.equal(
    zepReport.run.adapter.config.updateStrategy,
    "create-replacement+delete-old-episode"
  );
  assert.deepEqual(zepReport.run.adapterTelemetry.cleanup, {
    attempted: true,
    succeeded: true,
    verified: true,
  });
  assert.equal(fakeZep.snapshot().graphs, 0, "Zep teardown must remove every scope graph");
  assert.equal(fakeZep.snapshot().episodes, 0, "scope graph cleanup must remove all episodes");
  assert.equal(fakeZep.snapshot().graphCreates, datasetScopes.size);
  assert.equal(
    fakeZep.snapshot().graphDeleteCalls,
    datasetScopes.size * 2,
    "setup pre-clean and teardown should target every deterministic graph"
  );
  assert.equal(fakeZep.snapshot().episodeCreates, 14, "13 writes plus one replacement update");
  assert.equal(fakeZep.snapshot().episodeDeletes, 2, "one update replacement and one dataset delete");
  assert.equal(fakeZep.snapshot().authFailures, 0, "adapter must send Api-Key authentication");

  fakeZep.stallNextEpisode();
  const stalledDataset = {
    ...dataset,
    name: "memory-bench-stalled-zep-episode",
    scenarios: [
      {
        id: "stalled-episode",
        description: "An episode that never processes must fail and still clean up.",
        language: "en",
        difficulty: "basic" as const,
        provenance: {
          origin: "synthetic" as const,
          author: "smoke-test",
          authorType: "human" as const,
        },
        review: {
          status: "draft" as const,
          entries: [],
        },
        operations: [
          {
            op: "write" as const,
            record: {
              id: "stalled-zep-record",
              scope: "user:stalled-zep",
              content: "This episode is expected to remain unprocessed.",
              observedAt: "2026-07-27T00:00:00Z",
            },
          },
        ],
      },
    ],
  };
  await assert.rejects(
    runBenchmark(
      stalledDataset,
      new ZepAdapter({
        apiKey: "test-key",
        baseUrl: fakeZep.baseUrl,
        requestTimeoutMs: 1_000,
        settleTimeoutMs: 40,
        pollIntervalMs: 1,
        maxRetries: 0,
      }),
      "smoke-zep-stalled-episode"
    ),
    /timed out waiting for episode/
  );
  assert.equal(fakeZep.snapshot().graphs, 0, "stalled Zep episodes must be removed with their graph");

  const timeoutAdapter = new ZepAdapter({
    apiKey: "test-key",
    baseUrl: fakeZep.baseUrl,
    requestTimeoutMs: 25,
    settleTimeoutMs: 250,
    pollIntervalMs: 1,
    maxRetries: 0,
  });
  await timeoutAdapter.setup({
    runId: "smoke-zep-timeout",
    datasetName: dataset.name,
    datasetVersion: dataset.version,
    scopes: ["user:timeout"],
  });
  try {
    fakeZep.setSearchDelay(100);
    await assert.rejects(
      timeoutAdapter.search({
        scope: "user:timeout",
        query: "This request should time out",
        topK: 1,
      }),
      /timed out after 25ms/
    );
  } finally {
    fakeZep.setSearchDelay(0);
    await timeoutAdapter.teardown();
  }
  assert.equal(fakeZep.snapshot().graphs, 0, "Zep timeout path must leave no scope graph");

  const cleanupRetryAdapter = new ZepAdapter({
    apiKey: "test-key",
    baseUrl: fakeZep.baseUrl,
    requestTimeoutMs: 1_000,
    settleTimeoutMs: 250,
    pollIntervalMs: 1,
    maxRetries: 0,
  });
  await cleanupRetryAdapter.setup({
    runId: "smoke-zep-cleanup-retry",
    datasetName: dataset.name,
    datasetVersion: dataset.version,
    scopes: ["user:cleanup-retry"],
  });
  await cleanupRetryAdapter.write({
    id: "zep-cleanup-retry-record",
    scope: "user:cleanup-retry",
    content: "Zep cleanup should be recoverable after a provider failure.",
    observedAt: "2026-07-27T00:00:00Z",
  });
  fakeZep.failNextGraphDelete();
  await assert.rejects(
    cleanupRetryAdapter.teardown(),
    /temporary graph cleanup failure/,
    "a Zep graph cleanup failure must be visible"
  );
  assert.equal(fakeZep.snapshot().graphs, 1, "failed Zep cleanup should leave an observable graph");
  assert.deepEqual(cleanupRetryAdapter.getTelemetry().cleanup, {
    attempted: true,
    succeeded: false,
    verified: false,
  });
  await cleanupRetryAdapter.teardown();
  assert.equal(fakeZep.snapshot().graphs, 0, "a second Zep teardown must recover the same scope graph");
  assert.deepEqual(cleanupRetryAdapter.getTelemetry().cleanup, {
    attempted: true,
    succeeded: true,
    verified: true,
  });
} finally {
  await fakeZep.close();
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dataset: `${dataset.name}@${dataset.version}`,
      adapters: {
        literal: literalReport.metrics,
        mnema: mnemaReport.metrics,
        mem0: {
          metrics: mem0Report!.metrics,
          telemetry: mem0Report!.run.adapterTelemetry,
        },
        letta: {
          metrics: lettaReport!.metrics,
          telemetry: lettaReport!.run.adapterTelemetry,
        },
        zep: {
          metrics: zepReport!.metrics,
          telemetry: zepReport!.run.adapterTelemetry,
        },
      },
    },
    null,
    2
  )
);
