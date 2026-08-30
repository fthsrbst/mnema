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

export interface Mem0AdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  settleTimeoutMs?: number;
  pollIntervalMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  searchThreshold?: number;
  rerank?: boolean;
}

interface Mem0Memory {
  id: string;
  memory?: string;
  text?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

interface Mem0ListResponse {
  count: number;
  next: string | null;
  results: Mem0Memory[];
}

interface Mem0Event {
  id?: string;
  status: "PENDING" | "RUNNING" | "FAILED" | "SUCCEEDED";
  latency?: number;
  results?: unknown[];
  metadata?: Record<string, unknown> | null;
}

const metadataRecordId = "memory_bench_record_id";
const metadataRunId = "memory_bench_run_id";

function envNumber(name: string, fallback: number, min: number, max: number, integer = false): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a finite number from ${min} to ${max}`);
  }
  return value;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLocaleLowerCase("en-US"))) return true;
  if (["0", "false", "no", "off"].includes(value.toLocaleLowerCase("en-US"))) return false;
  throw new Error(`${name} must be true/false, 1/0, yes/no, or on/off`);
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MEMORY_BENCH_MEM0_BASE_URL must be an absolute http(s) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    !["", "/"].includes(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("MEMORY_BENCH_MEM0_BASE_URL must be a credential-free http(s) origin");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Mem0 ${label} response must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Mem0 ${label} must be a non-empty string`);
  return value;
}

function memoryContent(memory: Mem0Memory): string {
  const value = memory.memory ?? memory.text;
  return typeof value === "string" ? value : "";
}

export class Mem0Adapter implements MemoryBenchAdapter {
  readonly info: AdapterInfo;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly searchThreshold: number;
  private readonly rerank: boolean;
  private readonly http: BenchmarkHttpClient;
  private runNamespace: string | null = null;
  private datasetName = "";
  private readonly providerIdByRecordId = new Map<string, string>();
  private readonly recordIdByProviderId = new Map<string, string>();
  private readonly scopeByRecordId = new Map<string, string>();
  private telemetry: AdapterTelemetry;

  constructor(options: Mem0AdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.MEM0_API_KEY ?? "";
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ??
        process.env.MEMORY_BENCH_MEM0_BASE_URL ??
        process.env.MEM0_BASE_URL ??
        "https://api.mem0.ai"
    );
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
    this.searchThreshold =
      options.searchThreshold ??
      envNumber("MEMORY_BENCH_MEM0_SEARCH_THRESHOLD", 0, 0, 1);
    this.rerank = options.rerank ?? envBool("MEMORY_BENCH_MEM0_RERANK", false);
    this.info = {
      name: "mem0",
      version: "platform-rest-v3-add-search-list+v1-lifecycle",
      mode: "managed-core-explicit",
      config: {
        baseUrl: this.baseUrl,
        apiKeyConfigured: this.apiKey.length > 0,
        infer: false,
        searchThreshold: this.searchThreshold,
        rerank: this.rerank,
        requestTimeoutMs: this.requestTimeoutMs,
        settleTimeoutMs: this.settleTimeoutMs,
        pollIntervalMs: this.pollIntervalMs,
        maxRetries: this.maxRetries,
        retryBaseDelayMs: this.retryBaseDelayMs,
        scopeIsolation: "hashed-user-id+run-id",
      },
    };
    this.telemetry = this.emptyTelemetry();
    this.http = new BenchmarkHttpClient({
      provider: "Mem0",
      baseUrl: this.baseUrl,
      headers: { Authorization: `Token ${this.apiKey}` },
      requestTimeoutMs: this.requestTimeoutMs,
      maxRetries: this.maxRetries,
      retryBaseDelayMs: this.retryBaseDelayMs,
      telemetry: () => this.telemetry,
      redactValues: [this.apiKey],
    });
  }

  async setup(context: BenchmarkRunContext): Promise<void> {
    if (this.runNamespace) {
      throw new Error("Mem0 adapter is already set up or has an incomplete cleanup");
    }
    this.telemetry = this.emptyTelemetry();
    if (!this.apiKey) {
      throw new Error("MEM0_API_KEY is required for the mem0 adapter");
    }
    this.datasetName = context.datasetName;
    this.runNamespace = `memory-bench-${createHash("sha256")
      .update(`${context.datasetName}:${context.datasetVersion}:${context.runId}`)
      .digest("hex")
      .slice(0, 32)}`;
    await this.deleteRunNamespace();
    await this.waitForRunToBeEmpty();
    this.telemetry.cleanup = { attempted: false, succeeded: false, verified: false };
  }

  async write(record: BenchmarkMemoryRecord): Promise<void> {
    this.requireSetup();
    if (this.providerIdByRecordId.has(record.id)) throw new Error(`Mem0 record already exists: ${record.id}`);
    const response = await this.http.request<Record<string, unknown>>("POST", "/v3/memories/add/", {
      body: {
        messages: [{ role: "user", content: record.content }],
        user_id: this.userIdForScope(record.scope),
        run_id: this.runNamespace,
        metadata: this.metadataFor(record),
        infer: false,
      },
      expectedStatuses: [200],
    });
    const payload = objectValue(response.data, "add");
    const eventId = stringValue(payload.event_id, "add event_id");
    await this.waitForEvent(eventId);
    const memory = await this.waitForRecord(record);
    this.mapRecord(record, memory.id);
  }

  async update(targetId: string, record: BenchmarkMemoryRecord): Promise<void> {
    this.requireSetup();
    const providerId = this.providerIdByRecordId.get(targetId);
    if (!providerId) throw new Error(`Mem0 update target not found: ${targetId}`);
    await this.http.request<Record<string, unknown>>("PUT", `/v1/memories/${encodeURIComponent(providerId)}/`, {
      body: {
        text: record.content,
        metadata: this.metadataFor(record),
      },
      expectedStatuses: [200],
    });
    await this.waitUntil(
      async () => {
        const current = await this.getMemory(providerId);
        return current !== null &&
          memoryContent(current) === record.content &&
          current.metadata?.[metadataRecordId] === record.id
          ? current
          : null;
      },
      `updated memory ${record.id}`
    );
    this.providerIdByRecordId.delete(targetId);
    this.scopeByRecordId.delete(targetId);
    this.mapRecord(record, providerId);
  }

  async delete(targetId: string, scope: string): Promise<void> {
    this.requireSetup();
    const providerId = this.providerIdByRecordId.get(targetId);
    if (!providerId || this.scopeByRecordId.get(targetId) !== scope) {
      throw new Error(`Mem0 delete target not found in scope: ${targetId}`);
    }
    await this.http.request<never>("DELETE", `/v1/memories/${encodeURIComponent(providerId)}/`, {
      expectedStatuses: [200, 204],
    });
    await this.waitUntil(
      async () => ((await this.getMemory(providerId)) === null ? true : null),
      `deleted memory ${targetId}`
    );
    this.providerIdByRecordId.delete(targetId);
    this.recordIdByProviderId.delete(providerId);
    this.scopeByRecordId.delete(targetId);
  }

  async search(input: SearchInput): Promise<NormalizedMemoryHit[]> {
    this.requireSetup();
    const response = await this.http.request<{ results?: unknown[] }>("POST", "/v3/memories/search/", {
      body: {
        query: input.query,
        filters: this.scopeFilters(input.scope),
        top_k: input.topK,
        threshold: this.searchThreshold,
        rerank: this.rerank,
      },
      expectedStatuses: [200],
      safeToRetry: true,
    });
    const payload = objectValue(response.data, "search");
    if (!Array.isArray(payload.results)) throw new Error("Mem0 search response.results must be an array");
    return payload.results.slice(0, input.topK).map((value, index) => {
      const memory = this.parseMemory(value, `search results[${index}]`);
      const metadataId = memory.metadata?.[metadataRecordId];
      return {
        recordId:
          typeof metadataId === "string"
            ? metadataId
            : this.recordIdByProviderId.get(memory.id) ?? null,
        content: memoryContent(memory),
        score: typeof memory.score === "number" && Number.isFinite(memory.score) ? memory.score : null,
        providerId: memory.id,
      };
    });
  }

  async teardown(): Promise<void> {
    if (!this.runNamespace) return;
    this.telemetry.cleanup.attempted = true;
    try {
      await this.deleteRunNamespace();
      await this.waitForRunToBeEmpty();
      this.telemetry.cleanup.succeeded = true;
      this.telemetry.cleanup.verified = true;
      this.runNamespace = null;
      this.datasetName = "";
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

  private requireSetup(): void {
    if (!this.runNamespace) throw new Error("Mem0 adapter is not set up");
  }

  private userIdForScope(scope: string): string {
    this.requireSetup();
    return `memory-bench-user-${createHash("sha256")
      .update(`${this.runNamespace}:${scope}`)
      .digest("hex")
      .slice(0, 32)}`;
  }

  private metadataFor(record: BenchmarkMemoryRecord): Record<string, unknown> {
    return {
      ...record.metadata,
      [metadataRecordId]: record.id,
      [metadataRunId]: this.runNamespace,
      memory_bench_scope_hash: createHash("sha256").update(record.scope).digest("hex").slice(0, 24),
      memory_bench_observed_at: record.observedAt,
      memory_bench_dataset: this.datasetName,
    };
  }

  private scopeFilters(scope: string): Record<string, unknown> {
    return {
      AND: [
        { user_id: this.userIdForScope(scope) },
        { run_id: this.runNamespace },
      ],
    };
  }

  private mapRecord(record: BenchmarkMemoryRecord, providerId: string): void {
    this.providerIdByRecordId.set(record.id, providerId);
    this.recordIdByProviderId.set(providerId, record.id);
    this.scopeByRecordId.set(record.id, record.scope);
  }

  private async waitForEvent(eventId: string): Promise<void> {
    const event = await this.waitUntil(
      async () => {
        this.telemetry.pollRequestCount++;
        const response = await this.http.request<Mem0Event>("GET", `/v1/event/${encodeURIComponent(eventId)}/`, {
          expectedStatuses: [200],
          safeToRetry: true,
        });
        const payload = objectValue(response.data, "event") as unknown as Mem0Event;
        if (!["PENDING", "RUNNING", "FAILED", "SUCCEEDED"].includes(payload.status)) {
          throw new Error(`Mem0 event ${eventId} returned unknown status`);
        }
        if (payload.status === "FAILED") throw new Error(`Mem0 event ${eventId} failed`);
        return payload.status === "SUCCEEDED" ? payload : null;
      },
      `event ${eventId}`
    );
    if (typeof event.latency === "number" && Number.isFinite(event.latency)) {
      this.telemetry.providerProcessingMs =
        (this.telemetry.providerProcessingMs ?? 0) + event.latency;
    }
  }

  private async waitForRecord(record: BenchmarkMemoryRecord): Promise<Mem0Memory> {
    return this.waitUntil(
      async () => {
        this.telemetry.pollRequestCount++;
        const memories = await this.listMemories(this.scopeFilters(record.scope));
        return (
          memories.find((memory) => memory.metadata?.[metadataRecordId] === record.id) ??
          memories.find((memory) => memoryContent(memory) === record.content) ??
          null
        );
      },
      `memory ${record.id}`
    );
  }

  private async waitForRunToBeEmpty(): Promise<void> {
    if (!this.runNamespace) return;
    await this.waitUntil(
      async () => {
        this.telemetry.pollRequestCount++;
        const memories = await this.listMemories({ run_id: this.runNamespace });
        return memories.length === 0 ? true : null;
      },
      `run cleanup ${this.runNamespace}`
    );
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
    throw new Error(`Mem0 timed out waiting for ${label} after ${this.settleTimeoutMs}ms${detail}`);
  }

  private async listMemories(filters: Record<string, unknown>): Promise<Mem0Memory[]> {
    const memories: Mem0Memory[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.http.request<Mem0ListResponse>(
        "POST",
        `/v3/memories/?page=${page}&page_size=200`,
        {
          body: { filters },
          expectedStatuses: [200],
          safeToRetry: true,
        }
      );
      const payload = objectValue(response.data, "list");
      if (!Array.isArray(payload.results)) throw new Error("Mem0 list response.results must be an array");
      for (let index = 0; index < payload.results.length; index++) {
        memories.push(this.parseMemory(payload.results[index], `list results[${index}]`));
      }
      const count = typeof payload.count === "number" && Number.isFinite(payload.count) ? payload.count : memories.length;
      const next = typeof payload.next === "string" && payload.next.length > 0 ? payload.next : null;
      if (!next || memories.length >= count) return memories;
    }
    throw new Error("Mem0 list pagination exceeded 100 pages");
  }

  private parseMemory(value: unknown, label: string): Mem0Memory {
    const row = objectValue(value, label);
    const id = stringValue(row.id, `${label}.id`);
    if (row.metadata !== undefined && (row.metadata === null || typeof row.metadata !== "object" || Array.isArray(row.metadata))) {
      throw new Error(`Mem0 ${label}.metadata must be an object`);
    }
    return {
      id,
      ...(typeof row.memory === "string" ? { memory: row.memory } : {}),
      ...(typeof row.text === "string" ? { text: row.text } : {}),
      ...(typeof row.score === "number" ? { score: row.score } : {}),
      ...(row.metadata === undefined ? {} : { metadata: row.metadata as Record<string, unknown> }),
    };
  }

  private async getMemory(providerId: string): Promise<Mem0Memory | null> {
    this.telemetry.pollRequestCount++;
    const response = await this.http.request<Record<string, unknown>>(
      "GET",
      `/v1/memories/${encodeURIComponent(providerId)}/`,
      {
        expectedStatuses: [200, 404],
        safeToRetry: true,
      }
    );
    return response.status === 404 ? null : this.parseMemory(response.data, "get memory");
  }

  private async deleteRunNamespace(): Promise<void> {
    if (!this.runNamespace) return;
    await this.http.request<never>(
      "DELETE",
      `/v1/memories/?run_id=${encodeURIComponent(this.runNamespace)}`,
      {
        expectedStatuses: [200, 204],
        safeToRetry: true,
      }
    );
  }

}
