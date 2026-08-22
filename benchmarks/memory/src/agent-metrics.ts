import {
  agentMemoryAbilities,
  type AgentBenchmarkMetrics,
  type AgentLatencyMetrics,
  type AgentMemoryAbility,
  type AgentScenarioMetrics,
  type AgentScenarioTrace,
} from "./agent-types.js";

function round(value: number): number {
  return Number(value.toFixed(6));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function latency(values: number[]): AgentLatencyMetrics {
  if (values.length === 0) {
    return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    sorted[
      Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * fraction) - 1)
      )
    ]!;
  return {
    count: sorted.length,
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    maxMs: round(sorted[sorted.length - 1]!),
  };
}

function scenarioMetrics(traces: AgentScenarioTrace[]): AgentScenarioMetrics {
  const completed = traces.filter((trace) => trace.status === "completed");
  const judged = traces.filter((trace) => trace.qaPassed !== null);
  const retrieval = traces.filter((trace) => trace.retrievalEvaluated);
  const cleanupAttempts = traces.filter((trace) => trace.cleanup.attempted);
  return {
    scenarios: traces.length,
    completed: completed.length,
    failed: traces.length - completed.length,
    qaAccuracy: average(
      judged.map((trace) => (trace.qaPassed === true ? 1 : 0))
    ),
    retrievalQueries: retrieval.length,
    macroRecallAtK: average(
      retrieval.map((trace) => trace.recallAtK ?? 0)
    ),
    meanReciprocalRank: average(
      retrieval.map((trace) => trace.reciprocalRank ?? 0)
    ),
    cleanupVerificationRate: average(
      cleanupAttempts.map((trace) => (trace.cleanup.verified ? 1 : 0))
    ),
    latency: {
      ingestion: latency(traces.map((trace) => trace.latencyMs.ingestion)),
      query: latency(traces.map((trace) => trace.latencyMs.query)),
      reader: latency(traces.map((trace) => trace.latencyMs.reader)),
      judge: latency(traces.map((trace) => trace.latencyMs.judge)),
      total: latency(traces.map((trace) => trace.latencyMs.total)),
    },
  };
}

export function aggregateAgentMetrics(
  traces: AgentScenarioTrace[],
  runtimeFailures: number
): AgentBenchmarkMetrics {
  return {
    ...scenarioMetrics(traces),
    runtimeFailures,
    slices: {
      byAbility: Object.fromEntries(
        agentMemoryAbilities.map((ability) => [
          ability,
          scenarioMetrics(
            traces.filter((trace) => trace.ability === ability)
          ),
        ])
      ) as Record<AgentMemoryAbility, AgentScenarioMetrics>,
    },
  };
}
