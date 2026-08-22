import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { aggregateMetrics } from "./metrics.js";
import type {
  BenchmarkDataset,
  BenchmarkOperation,
  BenchmarkReport,
  BenchmarkScenario,
  MemoryBenchAdapter,
  QueryOperation,
  QueryTrace,
} from "./types.js";

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function scoreQuery(
  scenario: BenchmarkScenario,
  operation: QueryOperation,
  latencyMs: number,
  hits: QueryTrace["hits"]
): QueryTrace {
  const boundedHits = hits.slice(0, operation.topK);
  const retrievedIds = boundedHits
    .map((hit) => hit.recordId)
    .filter((id): id is string => id !== null);
  const retrievedSet = new Set(retrievedIds);
  const missingRelevantIds = operation.relevantIds.filter((id) => !retrievedSet.has(id));
  const forbiddenIdsFound = (operation.forbiddenIds ?? []).filter((id) => retrievedSet.has(id));
  const firstRelevantIndex = boundedHits.findIndex(
    (hit) => hit.recordId !== null && operation.relevantIds.includes(hit.recordId)
  );
  const combinedContent = normalizeText(boundedHits.map((hit) => hit.content).join("\n"));
  const containsRequired = (operation.mustContain ?? []).every((needle) =>
    combinedContent.includes(normalizeText(needle))
  );
  const excludesForbidden = (operation.mustNotContain ?? []).every(
    (needle) => !combinedContent.includes(normalizeText(needle))
  );
  const contentChecksPassed = containsRequired && excludesForbidden;
  const abstentionPassed = operation.expectEmpty === undefined ? null : boundedHits.length === 0;
  const hasRelevant = operation.relevantIds.length > 0;
  const recallAtK = hasRelevant
    ? (operation.relevantIds.length - missingRelevantIds.length) / operation.relevantIds.length
    : null;
  const precisionAtK = hasRelevant
    ? boundedHits.filter((hit) => hit.recordId !== null && operation.relevantIds.includes(hit.recordId)).length /
      operation.topK
    : null;
  const reciprocalRank = hasRelevant ? (firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1)) : null;
  const feedback: QueryTrace["feedback"] = boundedHits.map((hit, index) => ({
    queryId: operation.id,
    verdict: hit.recordId !== null && operation.relevantIds.includes(hit.recordId) ? "helpful" : "noisy",
    recordId: hit.recordId,
    rank: index + 1,
  }));
  for (const recordId of missingRelevantIds) {
    feedback.push({
      queryId: operation.id,
      verdict: "missing",
      recordId,
      rank: null,
    });
  }
  const passed =
    missingRelevantIds.length === 0 &&
    forbiddenIdsFound.length === 0 &&
    contentChecksPassed &&
    abstentionPassed !== false;
  return {
    scenarioId: scenario.id,
    queryId: operation.id,
    ability: operation.ability,
    language: scenario.language,
    difficulty: scenario.difficulty,
    scope: operation.scope,
    query: operation.query,
    topK: operation.topK,
    latencyMs: Number(latencyMs.toFixed(6)),
    relevantIds: operation.relevantIds,
    retrievedIds,
    missingRelevantIds,
    forbiddenIdsFound,
    recallAtK,
    precisionAtK,
    reciprocalRank,
    contentChecksPassed,
    abstentionPassed,
    passed,
    hits: boundedHits,
    feedback,
  };
}

export async function runBenchmark(
  dataset: BenchmarkDataset,
  adapter: MemoryBenchAdapter,
  requestedRunId?: string
): Promise<BenchmarkReport> {
  const runId = requestedRunId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const queries: QueryTrace[] = [];
  const operationLatencies: Record<BenchmarkOperation["op"], number[]> = {
    write: [],
    update: [],
    delete: [],
    query: [],
  };
  const scopes = [
    ...new Set(
      dataset.scenarios.flatMap((scenario) =>
        scenario.operations.map((operation) =>
          operation.op === "write" || operation.op === "update"
            ? operation.record.scope
            : operation.scope
        )
      )
    ),
  ].sort();

  let runError: unknown;
  try {
    await adapter.setup({
      runId,
      datasetName: dataset.name,
      datasetVersion: dataset.version,
      scopes,
    });
    for (const scenario of dataset.scenarios) {
      for (const operation of scenario.operations) {
        const operationStarted = performance.now();
        if (operation.op === "write") {
          await adapter.write(operation.record);
        } else if (operation.op === "update") {
          await adapter.update(operation.targetId, operation.record);
        } else if (operation.op === "delete") {
          await adapter.delete(operation.targetId, operation.scope);
        } else {
          const hits = await adapter.search({
            scope: operation.scope,
            query: operation.query,
            topK: operation.topK,
          });
          const latencyMs = performance.now() - operationStarted;
          operationLatencies.query.push(latencyMs);
          queries.push(scoreQuery(scenario, operation, latencyMs, hits));
          continue;
        }
        operationLatencies[operation.op].push(performance.now() - operationStarted);
      }
    }
  } catch (error) {
    runError = error;
  }

  let teardownError: unknown;
  try {
    await adapter.teardown();
  } catch (error) {
    teardownError = error;
  }
  if (runError !== undefined && teardownError !== undefined) {
    throw new AggregateError([runError, teardownError], "benchmark execution and adapter cleanup both failed");
  }
  if (runError !== undefined) throw runError;
  if (teardownError !== undefined) throw teardownError;

  return {
    schemaVersion: 1,
    run: {
      runId,
      startedAt,
      durationMs: Number((performance.now() - started).toFixed(6)),
      dataset: {
        name: dataset.name,
        version: dataset.version,
        license: dataset.license,
        track: dataset.track,
        publicationStatus: dataset.publicationStatus,
      },
      adapter: adapter.info,
      adapterTelemetry: adapter.getTelemetry(),
    },
    metrics: aggregateMetrics(queries, operationLatencies),
    queries,
  };
}
