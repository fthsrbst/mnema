import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { aggregateAgentMetrics } from "./agent-metrics.js";
import type {
  AgentBenchmarkReport,
  AgentCleanupResult,
  AgentComponentInfo,
  AgentComponentTelemetry,
  AgentContextItem,
  AgentEvidenceDescriptor,
  AgentMemoryAdapter,
  AgentMemoryDatasetSource,
  AgentMemoryJudge,
  AgentMemoryReader,
  AgentMemoryScenario,
  AgentRuntimeFailure,
  AgentRunStage,
  AgentScenarioTrace,
} from "./agent-types.js";

export interface AgentBenchmarkRunOptions {
  topK?: number;
  maxScenarios?: number;
  runId?: string;
}

const noCleanup: AgentCleanupResult = {
  attempted: false,
  succeeded: false,
  verified: false,
};

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function sanitizedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(authorization|api[-_ ]?key|token)\s*[:=]\s*\S+/giu, "$1=[redacted]")
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gu, "[redacted]")
    .slice(0, 1_000);
}

function failure(
  failures: AgentRuntimeFailure[],
  stage: AgentRunStage,
  component: AgentRuntimeFailure["component"],
  error: unknown,
  scenario: {
    id: string;
    ability: AgentRuntimeFailure["ability"];
  } | null
): void {
  failures.push({
    scenarioId: scenario?.id ?? null,
    ability: scenario?.ability ?? null,
    stage,
    component,
    message: sanitizedError(error),
  });
}

function classification(
  components: AgentComponentInfo[]
): "harness" | "candidate" | "benchmark" {
  if (components.some((component) => component.classification === "harness")) {
    return "harness";
  }
  if (
    components.some((component) => component.classification === "candidate")
  ) {
    return "candidate";
  }
  return "benchmark";
}

function evidenceDescriptors(
  context: AgentContextItem[]
): AgentEvidenceDescriptor[] {
  return context.map((item) => ({
    type: item.type,
    observedAt: item.observedAt,
    sourceSessionId: item.sourceSessionId,
    score: item.score,
    valueSha256: createHash("sha256").update(item.value).digest("hex"),
    valueBytes: Buffer.byteLength(item.value),
  }));
}

function contextItems(value: unknown, topK: number): AgentContextItem[] {
  if (!Array.isArray(value)) {
    throw new Error("adapter query result must be an array");
  }
  return value.slice(0, topK).map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`adapter context[${index}] must be an object`);
    }
    const raw = item as Record<string, unknown>;
    if (raw.type !== "text" && raw.type !== "image") {
      throw new Error(`adapter context[${index}].type is unsupported`);
    }
    if (typeof raw.value !== "string" || raw.value === "") {
      throw new Error(`adapter context[${index}].value must be non-empty`);
    }
    if (
      raw.observedAt !== null &&
      (typeof raw.observedAt !== "string" || raw.observedAt.trim() === "")
    ) {
      throw new Error(
        `adapter context[${index}].observedAt must be null or non-empty`
      );
    }
    if (
      raw.sourceSessionId !== null &&
      (typeof raw.sourceSessionId !== "string" ||
        raw.sourceSessionId.trim() === "")
    ) {
      throw new Error(
        `adapter context[${index}].sourceSessionId must be null or non-empty`
      );
    }
    if (
      raw.score !== null &&
      (typeof raw.score !== "number" || !Number.isFinite(raw.score))
    ) {
      throw new Error(
        `adapter context[${index}].score must be null or finite`
      );
    }
    return {
      type: raw.type,
      value: raw.value,
      observedAt: raw.observedAt,
      sourceSessionId: raw.sourceSessionId,
      score: raw.score,
    };
  });
}

function cleanupResult(value: unknown): AgentCleanupResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("adapter cleanup result must be an object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of ["attempted", "succeeded", "verified"] as const) {
    if (typeof raw[key] !== "boolean") {
      throw new Error(`adapter cleanup result ${key} must be a boolean`);
    }
  }
  return {
    attempted: raw.attempted as boolean,
    succeeded: raw.succeeded as boolean,
    verified: raw.verified as boolean,
  };
}

function telemetryFallback(): AgentComponentTelemetry {
  return {
    requestCount: 0,
    retryCount: 0,
    requestBytes: 0,
    responseBytes: 0,
    inputTokens: null,
    outputTokens: null,
    providerProcessingMs: null,
    providerCostUsd: null,
    costSource: "not-exposed",
  };
}

function componentTelemetry(value: unknown): AgentComponentTelemetry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("component telemetry must be an object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of [
    "requestCount",
    "retryCount",
    "requestBytes",
    "responseBytes",
  ] as const) {
    if (
      !Number.isInteger(raw[key]) ||
      (raw[key] as number) < 0
    ) {
      throw new Error(`component telemetry ${key} must be non-negative`);
    }
  }
  for (const key of ["inputTokens", "outputTokens"] as const) {
    if (
      raw[key] !== null &&
      (!Number.isInteger(raw[key]) || (raw[key] as number) < 0)
    ) {
      throw new Error(
        `component telemetry ${key} must be null or non-negative`
      );
    }
  }
  for (const key of [
    "providerProcessingMs",
    "providerCostUsd",
  ] as const) {
    if (
      raw[key] !== null &&
      (typeof raw[key] !== "number" ||
        !Number.isFinite(raw[key]) ||
        raw[key] < 0)
    ) {
      throw new Error(
        `component telemetry ${key} must be null or non-negative`
      );
    }
  }
  const allowedCostSources = new Set([
    "not-applicable",
    "not-exposed",
    "provider-reported",
    "estimated",
  ]);
  if (
    typeof raw.costSource !== "string" ||
    !allowedCostSources.has(raw.costSource)
  ) {
    throw new Error("component telemetry costSource is unsupported");
  }
  return {
    requestCount: raw.requestCount as number,
    retryCount: raw.retryCount as number,
    requestBytes: raw.requestBytes as number,
    responseBytes: raw.responseBytes as number,
    inputTokens: raw.inputTokens as number | null,
    outputTokens: raw.outputTokens as number | null,
    providerProcessingMs: raw.providerProcessingMs as number | null,
    providerCostUsd: raw.providerCostUsd as number | null,
    costSource: raw.costSource as AgentComponentTelemetry["costSource"],
  };
}

function retrievalScore(
  expectedEvidenceSessionIds: string[],
  context: AgentContextItem[],
  expectedAbstention: boolean
): Pick<
  AgentScenarioTrace,
  | "retrievedSessionIds"
  | "missingEvidenceSessionIds"
  | "retrievalEvaluated"
  | "recallAtK"
  | "reciprocalRank"
> {
  const retrievedSessionIds = context
    .map((item) => item.sourceSessionId)
    .filter((sessionId): sessionId is string => sessionId !== null);
  const retrieved = new Set(retrievedSessionIds);
  const missingEvidenceSessionIds = expectedEvidenceSessionIds.filter(
    (sessionId) => !retrieved.has(sessionId)
  );
  if (expectedAbstention) {
    return {
      retrievedSessionIds,
      missingEvidenceSessionIds,
      retrievalEvaluated: false,
      recallAtK: null,
      reciprocalRank: null,
    };
  }
  const firstRelevant = retrievedSessionIds.findIndex((sessionId) =>
    expectedEvidenceSessionIds.includes(sessionId)
  );
  return {
    retrievedSessionIds,
    missingEvidenceSessionIds,
    retrievalEvaluated: true,
    recallAtK:
      (expectedEvidenceSessionIds.length -
        missingEvidenceSessionIds.length) /
      expectedEvidenceSessionIds.length,
    reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
  };
}

export async function runAgentBenchmark(
  dataset: AgentMemoryDatasetSource,
  adapter: AgentMemoryAdapter,
  reader: AgentMemoryReader,
  judge: AgentMemoryJudge,
  options: AgentBenchmarkRunOptions = {}
): Promise<AgentBenchmarkReport> {
  const topK = options.topK ?? 5;
  if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
    throw new Error("agent benchmark topK must be an integer from 1 to 100");
  }
  const maxScenarios = options.maxScenarios ?? null;
  if (
    maxScenarios !== null &&
    (!Number.isInteger(maxScenarios) || maxScenarios < 1)
  ) {
    throw new Error("agent benchmark maxScenarios must be a positive integer");
  }
  const runId = options.runId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const runStarted = performance.now();
  const failures: AgentRuntimeFailure[] = [];
  const traces: AgentScenarioTrace[] = [];
  let setupSucceeded = false;
  let runFailed = false;

  try {
    await adapter.setup({
      runId,
      datasetName: dataset.metadata.name,
      datasetVersion: dataset.metadata.version,
      datasetSubset: dataset.metadata.source.subset,
    });
    setupSucceeded = true;
  } catch (error) {
    runFailed = true;
    failure(failures, "setup", "adapter", error, null);
  }

  if (setupSucceeded) {
    const iterator = dataset.scenarios();
    let processed = 0;
    let stopAfterCleanupFailure = false;
    try {
      while (
        !stopAfterCleanupFailure &&
        (maxScenarios === null || processed < maxScenarios)
      ) {
        let next: IteratorResult<AgentMemoryScenario>;
        try {
          next = await iterator.next();
        } catch (error) {
          runFailed = true;
          failure(failures, "dataset", "runner", error, null);
          break;
        }
        if (next.done) break;
        const scenario = next.value;
        processed += 1;
        const scenarioRef = {
          id: scenario.id,
          ability: scenario.ability,
        };
        const scenarioStarted = performance.now();
        const trace: AgentScenarioTrace = {
          scenarioId: scenario.id,
          sourceQuestionType: scenario.sourceQuestionType,
          ability: scenario.ability,
          expectedAbstention: scenario.expectedAbstention,
          status: "failed",
          sessionCount: scenario.sessions.length,
          turnCount: scenario.sessions.reduce(
            (total, session) => total + session.messages.length,
            0
          ),
          topK,
          expectedEvidenceSessionIds: [...scenario.evidenceSessionIds],
          retrievedSessionIds: [],
          missingEvidenceSessionIds: [...scenario.evidenceSessionIds],
          retrievalEvaluated: false,
          recallAtK: null,
          reciprocalRank: null,
          hypothesis: null,
          judgeLabel: null,
          qaPassed: null,
          latencyMs: {
            ingestion: 0,
            query: 0,
            reader: 0,
            judge: 0,
            total: 0,
          },
          cleanup: { ...noCleanup },
          evidence: [],
        };
        let lifecycleAttempted = false;
        let currentStage: AgentRunStage = "begin-scenario";
        try {
          lifecycleAttempted = true;
          await adapter.beginScenario({
            scenarioId: scenario.id,
            sessionCount: scenario.sessions.length,
          });

          currentStage = "ingest";
          const ingestionStarted = performance.now();
          try {
            for (const session of scenario.sessions) {
              await adapter.ingest({
                id: session.id,
                date: session.date,
                messages: session.messages.map((message) => ({
                  role: message.role,
                  content: message.content,
                })),
              });
            }
          } finally {
            trace.latencyMs.ingestion = rounded(
              performance.now() - ingestionStarted
            );
          }

          currentStage = "query";
          const queryStarted = performance.now();
          let context: AgentContextItem[];
          try {
            context = contextItems(
              await adapter.query({
                question: scenario.question,
                questionDate: scenario.questionDate,
                topK,
              }),
              topK
            );
          } finally {
            trace.latencyMs.query = rounded(
              performance.now() - queryStarted
            );
          }
          Object.assign(
            trace,
            retrievalScore(
              scenario.evidenceSessionIds,
              context,
              scenario.expectedAbstention
            )
          );
          trace.evidence = evidenceDescriptors(context);

          currentStage = "reader";
          const readerStarted = performance.now();
          try {
            trace.hypothesis = await reader.answer({
              question: scenario.question,
              questionDate: scenario.questionDate,
              context,
            });
          } finally {
            trace.latencyMs.reader = rounded(
              performance.now() - readerStarted
            );
          }
          if (trace.hypothesis.trim() === "") {
            throw new Error("reader returned an empty hypothesis");
          }

          currentStage = "judge";
          const judgeStarted = performance.now();
          try {
            const decision = await judge.evaluate({
              question: scenario.question,
              expectedAnswer: scenario.expectedAnswer,
              expectedAbstention: scenario.expectedAbstention,
              sourceQuestionType: scenario.sourceQuestionType,
              ability: scenario.ability,
              hypothesis: trace.hypothesis,
            });
            if (
              typeof decision !== "object" ||
              decision === null ||
              typeof decision.passed !== "boolean" ||
              (decision.score !== 0 && decision.score !== 1) ||
              decision.score !== (decision.passed ? 1 : 0) ||
              typeof decision.label !== "string" ||
              decision.label.trim() === ""
            ) {
              throw new Error("judge returned an invalid or inconsistent decision");
            }
            trace.judgeLabel = decision.label;
            trace.qaPassed = decision.passed;
          } finally {
            trace.latencyMs.judge = rounded(
              performance.now() - judgeStarted
            );
          }
          trace.status = "completed";
        } catch (error) {
          const component =
            currentStage === "reader"
              ? "reader"
              : currentStage === "judge"
                ? "judge"
                : "adapter";
          failure(failures, currentStage, component, error, scenarioRef);
        } finally {
          if (lifecycleAttempted) {
            try {
              trace.cleanup = cleanupResult(await adapter.endScenario());
              if (
                !trace.cleanup.attempted ||
                !trace.cleanup.succeeded ||
                !trace.cleanup.verified
              ) {
                trace.status = "failed";
                stopAfterCleanupFailure = true;
                failure(
                  failures,
                  "cleanup",
                  "adapter",
                  new Error("scenario cleanup was not attempted, successful, and verified"),
                  scenarioRef
                );
              }
            } catch (error) {
              trace.cleanup = {
                attempted: true,
                succeeded: false,
                verified: false,
              };
              trace.status = "failed";
              stopAfterCleanupFailure = true;
              failure(failures, "cleanup", "adapter", error, scenarioRef);
            }
          }
          trace.latencyMs.total = rounded(
            performance.now() - scenarioStarted
          );
          traces.push(trace);
        }
      }
    } finally {
      try {
        await iterator.return?.(undefined);
      } catch (error) {
        runFailed = true;
        failure(failures, "dataset", "runner", error, null);
      }
    }
  }

  try {
    await adapter.teardown();
  } catch (error) {
    runFailed = true;
    failure(failures, "teardown", "adapter", error, null);
  }
  const telemetry = {
    adapter: telemetryFallback(),
    reader: telemetryFallback(),
    judge: telemetryFallback(),
  };
  const telemetrySources = [
    ["adapter", () => adapter.getTelemetry()],
    ["reader", () => reader.getTelemetry()],
    ["judge", () => judge.getTelemetry()],
  ] as const;
  for (const [component, getTelemetry] of telemetrySources) {
    try {
      telemetry[component] = componentTelemetry(getTelemetry());
    } catch (error) {
      runFailed = true;
      failure(failures, "telemetry", component, error, null);
    }
  }
  const status =
    runFailed || (!setupSucceeded && failures.length > 0)
      ? "failed"
      : failures.length > 0
        ? "completed-with-errors"
        : "completed";
  const components = [adapter.info, reader.info, judge.info];
  return {
    schemaVersion: 1,
    run: {
      runId,
      startedAt,
      durationMs: rounded(performance.now() - runStarted),
      status,
      resultClass: classification(components),
      dataset: {
        name: dataset.metadata.name,
        version: dataset.metadata.version,
        license: dataset.metadata.license,
        track: dataset.metadata.track,
        language: dataset.metadata.language,
        subset: dataset.metadata.source.subset,
        sourceRevision: dataset.metadata.source.revision,
        sourceSha256: dataset.metadata.source.sha256,
        artifactSha256: dataset.artifactSha256,
        artifactBytes: dataset.artifactBytes,
        readPasses: dataset.readPasses,
      },
      topK,
      maxScenarios,
      components: {
        adapter: adapter.info,
        reader: reader.info,
        judge: judge.info,
      },
      telemetry: {
        adapter: telemetry.adapter,
        reader: telemetry.reader,
        judge: telemetry.judge,
      },
    },
    metrics: aggregateAgentMetrics(traces, failures.length),
    scenarios: traces,
    failures,
  };
}
