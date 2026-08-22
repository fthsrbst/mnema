import type {
  BenchmarkMetrics,
  BenchmarkOperation,
  BenchmarkQueryMetrics,
  LatencySummary,
  MemoryAbility,
  QueryTrace,
  ScenarioDifficulty,
} from "./types.js";

const abilityOrder: MemoryAbility[] = [
  "single-memory-recall",
  "multi-memory-recall",
  "knowledge-update",
  "temporal-recall",
  "abstention",
  "scope-isolation",
];
const difficultyOrder: ScenarioDifficulty[] = ["basic", "intermediate", "advanced"];

function round(value: number): number {
  return Number(value.toFixed(6));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function latencySummary(values: number[]): LatencySummary {
  if (values.length === 0) return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
  return {
    count: values.length,
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

function queryMetrics(queries: QueryTrace[]): BenchmarkQueryMetrics {
  const relevanceQueries = queries.filter((query) => query.recallAtK !== null);
  const abstentionQueries = queries.filter((query) => query.abstentionPassed !== null);
  return {
    queries: queries.length,
    queryPassRate:
      queries.length === 0
        ? 0
        : round(queries.filter((query) => query.passed).length / queries.length),
    macroRecallAtK: average(relevanceQueries.map((query) => query.recallAtK!)),
    macroPrecisionAtK: average(relevanceQueries.map((query) => query.precisionAtK!)),
    meanReciprocalRank: average(relevanceQueries.map((query) => query.reciprocalRank!)),
    forbiddenHitRate:
      queries.length === 0
        ? 0
        : round(
            queries.filter((query) => query.forbiddenIdsFound.length > 0).length /
              queries.length
          ),
    abstentionAccuracy: average(
      abstentionQueries.map((query) => (query.abstentionPassed ? 1 : 0))
    ),
    queryLatency: latencySummary(queries.map((query) => query.latencyMs)),
  };
}

function groupMetrics<T extends string>(
  queries: QueryTrace[],
  keys: readonly T[],
  select: (query: QueryTrace) => T
): Record<T, BenchmarkQueryMetrics> {
  return Object.fromEntries(
    keys.map((key) => [key, queryMetrics(queries.filter((query) => select(query) === key))])
  ) as Record<T, BenchmarkQueryMetrics>;
}

export function aggregateMetrics(
  queries: QueryTrace[],
  operationLatencies: Record<BenchmarkOperation["op"], number[]>
): BenchmarkMetrics {
  const totals = queryMetrics(queries);
  const languages = [...new Set(queries.map((query) => query.language))].sort();
  return {
    ...totals,
    operationLatency: {
      write: latencySummary(operationLatencies.write),
      update: latencySummary(operationLatencies.update),
      delete: latencySummary(operationLatencies.delete),
      query: latencySummary(operationLatencies.query),
    },
    slices: {
      byAbility: groupMetrics(
        queries,
        abilityOrder,
        (query) => query.ability
      ),
      byLanguage: groupMetrics(
        queries,
        languages,
        (query) => query.language
      ),
      byDifficulty: groupMetrics(
        queries,
        difficultyOrder,
        (query) => query.difficulty
      ),
    },
  };
}
