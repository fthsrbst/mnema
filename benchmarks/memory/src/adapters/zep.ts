import { createHash } from "node:crypto";
import type {
  AdapterInfo,
  AdapterTelemetry,
  BenchmarkMemoryRecord,
  BenchmarkRunContext,
  MemoryBenchAdapter,
  NormalizedMemoryHit,
  SearchInput,
} from "../types.js";
import { BenchmarkHttpClient, isTransientProviderError, sleep } from "./http.js";

export interface ZepAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  reranker?: string;
  requestTimeoutMs?: number;
  settleTimeoutMs?: number;
  pollIntervalMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

interface ZepEpisode {
  uuid: string;
  content: string;
  processed?: boolean;
  score?: number;
  relevance?: number;
  metadata?: Record<string, unknown>;
}

const metadataRecordId = "memory_bench_record_id";
const maximumSearchQueryCharacters = 400;
const maximumSearchResults = 50;

function envNumber(name: string, fallback: number, min: number, max: number, integer = false): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a finite number from ${min} to ${max}`);
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MEMORY_BENCH_ZEP_BASE_URL must be an absolute http(s) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    !["", "/"].includes(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("MEMORY_BENCH_ZEP_BASE_URL must be a credential-free http(s) origin");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Zep ${label} response must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Zep ${label} must be a non-empty string`);
  }
  return value;
}

export class ZepAdapter implements MemoryBenchAdapter {
  readonly info: AdapterInfo;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly reranker: string;
  private readonly requestTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly http: BenchmarkHttpClient;
  private runNamespace: string | null = null;
  private datasetName = "";
  private readonly graphByScope = new Map<string, string>();
  private readonly providerIdByRecordId = new Map<string, string>();
  private readonly recordIdByProviderId = new Map<string, string>();
  private readonly scopeByRecordId = new Map<string, string>();
  private telemetry: AdapterTelemetry;

  constructor(options: ZepAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ZEP_API_KEY ?? "";
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ??
        process.env.MEMORY_BENCH_ZEP_BASE_URL ??
        process.env.ZEP_API_URL ??
        "https://api.getzep.com"
    );
    this.reranker =
      options.reranker ??
      process.env.MEMORY_BENCH_ZEP_RERANKER ??
      "rrf";
    if (!["rrf", "mmr", "cross_encoder"].includes(this.reranker)) {
      throw new Error("MEMORY_BENCH_ZEP_RERANKER must be rrf, mmr, or cross_encoder");
    }
    this.requestTimeoutMs =
      options.requestTimeoutMs ??
      envNumber("MEMORY_BENCH_HTTP_TIMEOUT_MS", 15_000, 10, 300_000);
    this.settleTimeoutMs =
      options.settleTimeoutMs ??
      envNumber("MEMORY_BENCH_SETTLE_TIMEOUT_MS", 60_000, 10, 900_000);
    this.pollIntervalMs =
      options.pollIntervalMs ??
      envNumber("MEMORY_BENCH_POLL_INTERVAL_MS", 500, 1, 60_000);
    this.maxRetries =
      options.maxRetries ??
      envNumber("MEMORY_BENCH_HTTP_MAX_RETRIES", 2, 0, 10, true);
    this.retryBaseDelayMs =
      options.retryBaseDelayMs ??
      envNumber("MEMORY_BENCH_RETRY_BASE_DELAY_MS", 250, 0, 10_000);
    this.telemetry = this.emptyTelemetry();
    this.http = new BenchmarkHttpClient({
      provider: "Zep",
      baseUrl: this.baseUrl,
      headers: {
        ...(this.apiKey ? { Authorization: `Api-Key ${this.apiKey}` } : {}),
      },
      requestTimeoutMs: this.requestTimeoutMs,
      maxRetries: this.maxRetries,
      retryBaseDelayMs: this.retryBaseDelayMs,
      telemetry: () => this.telemetry,
      redactValues: [this.apiKey],
    });
    this.info = {
      name: "zep",
      version: "cloud-rest-v2-graph-episodes",
      mode: "standalone-graph-explicit-episodes",
      config: {
        baseUrl: this.baseUrl,
        apiKeyConfigured: this.apiKey.length > 0,
        searchScope: "episodes",
        searchQueryCharacterLimit: maximumSearchQueryCharacters,
        searchResultLimit: maximumSearchResults,
        reranker: this.reranker,
        updateStrategy: "create-replacement+delete-old-episode",
        scopeIsolation: "one-disposable-standalone-graph-per-scope",
        requestTimeoutMs: this.requestTimeoutMs,
        settleTimeoutMs: this.settleTimeoutMs,
        pollIntervalMs: this.pollIntervalMs,
        maxRetries: this.maxRetries,
        retryBaseDelayMs: this.retryBaseDelayMs,
      },
    };
  }

  async setup(context: BenchmarkRunContext): Promise<void> {
    if (this.runNamespace) {
      throw new Error("Zep adapter is already set up or has an incomplete cleanup");
    }
    this.telemetry = this.emptyTelemetry();
    if (this.baseUrl === "https://api.getzep.com" && !this.apiKey) {
      throw new Error("ZEP_API_KEY is required for the managed Zep API");
    }
    this.datasetName = context.datasetName;
    const runHash = createHash("sha256")
      .update(`${context.datasetName}:${context.datasetVersion}:${context.runId}`)
      .digest("hex")
      .slice(0, 24);
    this.runNamespace = `memory-bench-${runHash}`;
    for (const scope of context.scopes) {
      const scopeHash = createHash("sha256").update(scope).digest("hex").slice(0, 20);
      this.graphByScope.set(scope, `mb-${runHash}-${scopeHash}`);
    }

    await this.deleteGraphs();
    await this.waitForGraphs(false);
    this.telemetry.cleanup = { attempted: false, succeeded: false, verified: false };
    for (const graphId of this.graphByScope.values()) {
      await this.http.request<Record<string, unknown>>("POST", "/api/v2/graph/create", {
        body: {
          graph_id: graphId,
          name: this.runNamespace,
          description: `Memory Bench scope graph for ${context.datasetName}@${context.datasetVersion}`,
        },
        expectedStatuses: [200, 201],
      });
    }
    await this.waitForGraphs(true);
  }

  async write(record: BenchmarkMemoryRecord): Promise<void> {
    this.requireGraph(record.scope);
    if (this.providerIdByRecordId.has(record.id)) {
      throw new Error(`Zep record already exists: ${record.id}`);
    }
    const episode = await this.createEpisode(record);
    await this.waitForEpisode(episode.uuid, record.content);
    this.mapRecord(record, episode.uuid);
  }

  async update(targetId: string, record: BenchmarkMemoryRecord): Promise<void> {
    this.requireGraph(record.scope);
    const oldProviderId = this.providerIdByRecordId.get(targetId);
    if (!oldProviderId) throw new Error(`Zep update target not found: ${targetId}`);
    if (record.id !== targetId && this.providerIdByRecordId.has(record.id)) {
      throw new Error(`Zep replacement record already exists: ${record.id}`);
    }
    const replacement = await this.createEpisode(record);
    await this.waitForEpisode(replacement.uuid, record.content);
    await this.deleteEpisode(oldProviderId);
    await this.waitForEpisodeDeletion(oldProviderId);
    this.unmapRecord(targetId);
    this.mapRecord(record, replacement.uuid);
  }

  async delete(targetId: string, scope: string): Promise<void> {
    this.requireGraph(scope);
    const providerId = this.providerIdByRecordId.get(targetId);
    if (!providerId || this.scopeByRecordId.get(targetId) !== scope) {
      throw new Error(`Zep delete target not found in scope: ${targetId}`);
    }
    await this.deleteEpisode(providerId);
    await this.waitForEpisodeDeletion(providerId);
    this.unmapRecord(targetId);
  }

  async search(input: SearchInput): Promise<NormalizedMemoryHit[]> {
    const queryCharacters = [...input.query].length;
    if (queryCharacters > maximumSearchQueryCharacters) {
      throw new Error(
        `Zep search query exceeds the provider limit of ${maximumSearchQueryCharacters} characters`
      );
    }
    if (input.topK > maximumSearchResults) {
      throw new Error(
        `Zep search topK exceeds the provider limit of ${maximumSearchResults}`
      );
    }
    const graphId = this.requireGraph(input.scope);
    const response = await this.http.request<Record<string, unknown>>("POST", "/api/v2/graph/search", {
      body: {
        graph_id: graphId,
        query: input.query,
        scope: "episodes",
        limit: input.topK,
        reranker: this.reranker,
      },
      expectedStatuses: [200],
      safeToRetry: true,
    });
    const payload = objectValue(response.data, "search");
    if (!Array.isArray(payload.episodes)) throw new Error("Zep search response.episodes must be an array");
    const responseMetadata =
      payload.response === undefined ? undefined : objectValue(payload.response, "search.response");
    const serverLatency = responseMetadata?.server_latency_ms;
    if (typeof serverLatency === "number" && Number.isFinite(serverLatency)) {
      this.telemetry.providerProcessingMs =
        (this.telemetry.providerProcessingMs ?? 0) + serverLatency;
    }
    return payload.episodes.slice(0, input.topK).map((value, index) => {
      const episode = this.parseEpisode(value, `search episodes[${index}]`);
      const metadataId = episode.metadata?.[metadataRecordId];
      return {
        recordId:
          typeof metadataId === "string"
            ? metadataId
            : this.recordIdByProviderId.get(episode.uuid) ?? null,
        content: episode.content,
        score:
          typeof episode.score === "number" && Number.isFinite(episode.score)
            ? episode.score
            : typeof episode.relevance === "number" && Number.isFinite(episode.relevance)
              ? episode.relevance
              : null,
        providerId: episode.uuid,
      };
    });
  }

  async teardown(): Promise<void> {
    if (!this.runNamespace) return;
    this.telemetry.cleanup.attempted = true;
    try {
      await this.deleteGraphs();
      await this.waitForGraphs(false);
      this.telemetry.cleanup.succeeded = true;
      this.telemetry.cleanup.verified = true;
      this.runNamespace = null;
      this.datasetName = "";
      this.graphByScope.clear();
    } finally {
      this.providerIdByRecordId.clear();
      this.recordIdByProviderId.clear();
      this.scopeByRecordId.clear();
    }
  }

  getTelemetry(): AdapterTelemetry {
    return {
      ...this.telemetry,
      cleanup: { ...this.telemetry.cleanup },
    };
  }

  private emptyTelemetry(): AdapterTelemetry {
    return {
      requestCount: 0,
      retryCount: 0,
      pollRequestCount: 0,
      requestBytes: 0,
      responseBytes: 0,
      providerProcessingMs: null,
      providerCostUsd: null,
      costSource: "not-exposed",
      cleanup: {
        attempted: false,
        succeeded: false,
        verified: false,
      },
    };
  }

  private requireGraph(scope: string): string {
    if (!this.runNamespace) throw new Error("Zep adapter is not set up");
    const graphId = this.graphByScope.get(scope);
    if (!graphId) throw new Error(`Zep scope was not declared by the dataset: ${scope}`);
    return graphId;
  }

  private async createEpisode(record: BenchmarkMemoryRecord): Promise<ZepEpisode> {
    const response = await this.http.request<Record<string, unknown>>("POST", "/api/v2/graph", {
      body: {
        graph_id: this.requireGraph(record.scope),
        type: "text",
        data: record.content,
        created_at: record.observedAt,
        metadata: {
          [metadataRecordId]: record.id,
          memory_bench_run_id: this.runNamespace,
          memory_bench_scope_hash: createHash("sha256")
            .update(record.scope)
            .digest("hex")
            .slice(0, 24),
          memory_bench_dataset: this.datasetName,
        },
      },
      expectedStatuses: [200, 202],
    });
    return this.parseEpisode(response.data, "add episode");
  }

  private async deleteEpisode(providerId: string): Promise<void> {
    await this.http.request<never>(
      "DELETE",
      `/api/v2/graph/episodes/${encodeURIComponent(providerId)}`,
      {
        expectedStatuses: [200, 204, 404],
        safeToRetry: true,
      }
    );
  }

  private async waitForEpisode(providerId: string, content: string): Promise<void> {
    await this.waitUntil(
      async () => {
        this.telemetry.pollRequestCount++;
        const episode = await this.getEpisode(providerId);
        return episode !== null && episode.processed === true && episode.content === content
          ? true
          : null;
      },
      `episode ${providerId}`
    );
  }

  private async waitForEpisodeDeletion(providerId: string): Promise<void> {
    await this.waitUntil(
      async () => {
        this.telemetry.pollRequestCount++;
        return (await this.getEpisode(providerId)) === null ? true : null;
      },
      `deleted episode ${providerId}`
    );
  }

  private async getEpisode(providerId: string): Promise<ZepEpisode | null> {
    const response = await this.http.request<Record<string, unknown>>(
      "GET",
      `/api/v2/graph/episodes/${encodeURIComponent(providerId)}`,
      {
        expectedStatuses: [200, 404],
        safeToRetry: true,
      }
    );
    return response.status === 404 ? null : this.parseEpisode(response.data, "get episode");
  }

  private async deleteGraphs(): Promise<void> {
    for (const graphId of this.graphByScope.values()) {
      await this.http.request<never>("DELETE", `/api/v2/graph/${encodeURIComponent(graphId)}`, {
        expectedStatuses: [200, 204, 404],
        safeToRetry: true,
      });
    }
  }

  private async waitForGraphs(present: boolean): Promise<void> {
    await this.waitUntil(
      async () => {
        this.telemetry.pollRequestCount++;
        for (const graphId of this.graphByScope.values()) {
          const graph = await this.getGraph(graphId);
          if ((graph !== null) !== present) return null;
        }
        return true;
      },
      `${present ? "created" : "deleted"} scope graphs`
    );
  }

  private async getGraph(graphId: string): Promise<Record<string, unknown> | null> {
    const response = await this.http.request<Record<string, unknown>>(
      "GET",
      `/api/v2/graph/${encodeURIComponent(graphId)}`,
      {
        expectedStatuses: [200, 404],
        safeToRetry: true,
      }
    );
    return response.status === 404 ? null : objectValue(response.data, "get graph");
  }

  private mapRecord(record: BenchmarkMemoryRecord, providerId: string): void {
    this.providerIdByRecordId.set(record.id, providerId);
    this.recordIdByProviderId.set(providerId, record.id);
    this.scopeByRecordId.set(record.id, record.scope);
  }

  private unmapRecord(recordId: string): void {
    const providerId = this.providerIdByRecordId.get(recordId);
    if (providerId) this.recordIdByProviderId.delete(providerId);
    this.providerIdByRecordId.delete(recordId);
    this.scopeByRecordId.delete(recordId);
  }

  private async waitUntil<T>(check: () => Promise<T | null>, label: string): Promise<T> {
    const deadline = Date.now() + this.settleTimeoutMs;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        const result = await check();
        if (result !== null) return result;
        lastError = undefined;
      } catch (error) {
        lastError = error;
        if (!isTransientProviderError(error)) throw error;
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    const detail = lastError instanceof Error ? `; last error: ${lastError.message}` : "";
    throw new Error(`Zep timed out waiting for ${label} after ${this.settleTimeoutMs}ms${detail}`);
  }

  private parseEpisode(value: unknown, label: string): ZepEpisode {
    const row = objectValue(value, label);
    if (
      row.metadata !== undefined &&
      (row.metadata === null || typeof row.metadata !== "object" || Array.isArray(row.metadata))
    ) {
      throw new Error(`Zep ${label}.metadata must be an object`);
    }
    return {
      uuid: stringValue(row.uuid, `${label}.uuid`),
      content: stringValue(row.content, `${label}.content`),
      ...(typeof row.processed === "boolean" ? { processed: row.processed } : {}),
      ...(typeof row.score === "number" ? { score: row.score } : {}),
      ...(typeof row.relevance === "number" ? { relevance: row.relevance } : {}),
      ...(row.metadata === undefined
        ? {}
        : { metadata: row.metadata as Record<string, unknown> }),
    };
  }
}
