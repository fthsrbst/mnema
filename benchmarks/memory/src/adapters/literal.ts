import type {
  AdapterInfo,
  AdapterTelemetry,
  BenchmarkMemoryRecord,
  BenchmarkRunContext,
  MemoryBenchAdapter,
  NormalizedMemoryHit,
  SearchInput,
} from "../types.js";

const stopwords = new Set([
  "a",
  "an",
  "and",
  "did",
  "does",
  "for",
  "her",
  "his",
  "in",
  "is",
  "it",
  "of",
  "on",
  "the",
  "to",
  "use",
  "what",
  "where",
  "which",
]);

function tokens(value: string): Set<string> {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US");
  return new Set(
    (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length > 1 && !stopwords.has(token))
  );
}

function overlapScore(query: Set<string>, content: Set<string>): number {
  let overlap = 0;
  for (const token of query) if (content.has(token)) overlap++;
  if (overlap === 0) return 0;
  return overlap / Math.sqrt(query.size * content.size);
}

export class LiteralAdapter implements MemoryBenchAdapter {
  readonly info: AdapterInfo = {
    name: "literal",
    version: "1",
    mode: "token-overlap-reference",
    config: {
      scopeFilter: "exact",
      threshold: "score>0",
    },
  };

  private readonly records = new Map<string, BenchmarkMemoryRecord>();

  async setup(_context: BenchmarkRunContext): Promise<void> {
    this.records.clear();
  }

  async write(record: BenchmarkMemoryRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error(`literal adapter record already exists: ${record.id}`);
    this.records.set(record.id, structuredClone(record));
  }

  async update(targetId: string, record: BenchmarkMemoryRecord): Promise<void> {
    if (!this.records.delete(targetId)) throw new Error(`literal adapter update target not found: ${targetId}`);
    if (this.records.has(record.id)) throw new Error(`literal adapter update creates duplicate: ${record.id}`);
    this.records.set(record.id, structuredClone(record));
  }

  async delete(targetId: string, scope: string): Promise<void> {
    const record = this.records.get(targetId);
    if (!record || record.scope !== scope) throw new Error(`literal adapter delete target not found in scope: ${targetId}`);
    this.records.delete(targetId);
  }

  async search(input: SearchInput): Promise<NormalizedMemoryHit[]> {
    const queryTokens = tokens(input.query);
    return [...this.records.values()]
      .filter((record) => record.scope === input.scope)
      .map((record) => ({ record, score: overlapScore(queryTokens, tokens(record.content)) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .slice(0, input.topK)
      .map(({ record, score }) => ({
        recordId: record.id,
        content: record.content,
        score,
        providerId: record.id,
      }));
  }

  async teardown(): Promise<void> {
    this.records.clear();
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
        attempted: true,
        succeeded: true,
        verified: this.records.size === 0,
      },
    };
  }
}
