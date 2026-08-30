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

export interface LettaAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  projectId?: string;
  model?: string;
  embedding?: string;
  agentType?: string;
  requestTimeoutMs?: number;
  settleTimeoutMs?: number;
  pollIntervalMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

interface LettaAgent {
  id: string;
  name?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface LettaPassage {
  id: string;
  text: string;
  tags?: string[];
}

interface LettaSearchResult {
  id: string;
  content: string;
  score: number;
  tags?: string[];
}

const metadataRunId = "memory_bench_run_id";

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
    throw new Error("MEMORY_BENCH_LETTA_BASE_URL must be an absolute http(s) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    !["", "/"].includes(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("MEMORY_BENCH_LETTA_BASE_URL must be a credential-free http(s) origin");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Letta ${label} response must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Letta ${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Letta ${label} must be an array of strings`);
  }
  return value as string[];
}

function queryPath(pathname: string, params: Record<string, string | number | boolean | string[]>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else {
      query.set(key, String(value));
    }
  }
  return `${pathname}?${query.toString()}`;
}

export class LettaAdapter implements MemoryBenchAdapter {
  readonly info: AdapterInfo;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly model: string;
  private readonly embedding: string;
  private readonly agentType: string;
  private readonly requestTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly http: BenchmarkHttpClient;
  private runNamespace: string | null = null;
  private runTag: string | null = null;
  private agentId: string | null = null;
  private datasetName = "";
  private readonly providerIdsByRecordId = new Map<string, Set<string>>();
  private readonly recordIdByProviderId = new Map<string, string>();
  private readonly scopeByRecordId = new Map<string, string>();
  private telemetry: AdapterTelemetry;

  constructor(options: LettaAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.LETTA_API_KEY ?? "";
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ??
        process.env.MEMORY_BENCH_LETTA_BASE_URL ??
        process.env.LETTA_BASE_URL ??
        "https://api.letta.com"
    );
    this.projectId =
      options.projectId ??
      process.env.MEMORY_BENCH_LETTA_PROJECT_ID ??
      process.env.LETTA_PROJECT_ID ??
      "";
    this.model =
      options.model ??
      process.env.MEMORY_BENCH_LETTA_MODEL ??
      process.env.LETTA_MODEL ??
      "openai/gpt-4o-mini";
    this.embedding =
      options.embedding ??
      process.env.MEMORY_BENCH_LETTA_EMBEDDING ??
      process.env.LETTA_EMBEDDING ??
      "openai/text-embedding-3-small";
    this.agentType =
      options.agentType ??
      process.env.MEMORY_BENCH_LETTA_AGENT_TYPE ??
      "letta_v1_agent";
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
      provider: "Letta",
      baseUrl: this.baseUrl,
      headers: {
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...(this.projectId ? { "X-Project": this.projectId } : {}),
      },
      requestTimeoutMs: this.requestTimeoutMs,
      maxRetries: this.maxRetries,
      retryBaseDelayMs: this.retryBaseDelayMs,
      telemetry: () => this.telemetry,
      redactValues: [this.apiKey, this.projectId],
    });
    this.info = {
      name: "letta",
      version: "rest-v1-agent-archival-memory+passages-search",
      mode: "agent-archival-explicit",
      config: {
        baseUrl: this.baseUrl,
        apiKeyConfigured: this.apiKey.length > 0,
        projectConfigured: this.projectId.length > 0,
        model: this.model,
        embedding: this.embedding,
        agentType: this.agentType,
        updateStrategy: "create-replacement+delete-old-passages",
        scopeIsolation: "one-run-agent+hashed-passage-tags",
        searchEndpoint: "POST /v1/passages/search",
        searchResultUnit: "logical-record-after-passage-consolidation",
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
      throw new Error("Letta adapter is already set up or has an incomplete cleanup");
    }
    this.telemetry = this.emptyTelemetry();
    if (this.baseUrl === "https://api.letta.com" && !this.apiKey) {
      throw new Error("LETTA_API_KEY is required for the managed Letta API");
    }
    if (!this.model.trim()) throw new Error("MEMORY_BENCH_LETTA_MODEL must be a non-empty model handle");
    if (!this.embedding.trim()) {
      throw new Error("MEMORY_BENCH_LETTA_EMBEDDING must be a non-empty embedding handle");
    }
    this.datasetName = context.datasetName;
    const hash = createHash("sha256")
      .update(`${context.datasetName}:${context.datasetVersion}:${context.runId}`)
      .digest("hex")
      .slice(0, 32);
    this.runNamespace = `memory-bench-${hash}`;
    this.runTag = `memory-bench-run-${hash}`;
    await this.deleteAgentsForRun();
    await this.waitForRunToBeEmpty();
    this.telemetry.cleanup = { attempted: false, succeeded: false, verified: false };

    const response = await this.http.request<Record<string, unknown>>("POST", "/v1/agents/", {
      body: {
        name: this.runNamespace,
        description: `Memory Bench disposable agent for ${context.datasetName}@${context.datasetVersion}`,
        model: this.model,
        embedding: this.embedding,
        agent_type: this.agentType,
        include_base_tools: false,
        tags: [this.runTag],
        metadata: {
          [metadataRunId]: this.runNamespace,
          memory_bench_dataset: context.datasetName,
          memory_bench_dataset_version: context.datasetVersion,
        },
      },
      expectedStatuses: [200, 201],
    });
    const agent = this.parseAgent(response.data, "create agent");
    this.agentId = agent.id;
    await this.waitUntil(
      async () => ((await this.getAgent(agent.id)) === null ? null : true),
      `agent ${agent.id}`
    );
  }

  async write(record: BenchmarkMemoryRecord): Promise<void> {
    this.requireSetup();
    if (this.providerIdsByRecordId.has(record.id)) {
      throw new Error(`Letta record already exists: ${record.id}`);
    }
    const passages = await this.createPassages(record);
    await this.waitForPassageIds(passages.map((passage) => passage.id), true);
    this.mapRecord(record, passages.map((passage) => passage.id));
  }

  async update(targetId: string, record: BenchmarkMemoryRecord): Promise<void> {
    this.requireSetup();
    const oldProviderIds = this.providerIdsByRecordId.get(targetId);
    if (!oldProviderIds) throw new Error(`Letta update target not found: ${targetId}`);
    if (record.id !== targetId && this.providerIdsByRecordId.has(record.id)) {
      throw new Error(`Letta replacement record already exists: ${record.id}`);
    }
    const replacement = await this.createPassages(record);
    const replacementIds = replacement.map((passage) => passage.id);
    await this.waitForPassageIds(replacementIds, true);
    for (const providerId of oldProviderIds) await this.deletePassage(providerId);
    await this.waitForPassageIds([...oldProviderIds], false);
    this.unmapRecord(targetId);
    this.mapRecord(record, replacementIds);
  }

  async delete(targetId: string, scope: string): Promise<void> {
    this.requireSetup();
    const providerIds = this.providerIdsByRecordId.get(targetId);
    if (!providerIds || this.scopeByRecordId.get(targetId) !== scope) {
      throw new Error(`Letta delete target not found in scope: ${targetId}`);
    }
    for (const providerId of providerIds) await this.deletePassage(providerId);
    await this.waitForPassageIds([...providerIds], false);
    this.unmapRecord(targetId);
  }

  async search(input: SearchInput): Promise<NormalizedMemoryHit[]> {
    const agentId = this.requireSetup();
    const maximumPassagesPerRecord = Math.max(
      1,
      ...[...this.providerIdsByRecordId.values()].map(
        (providerIds) => providerIds.size
      )
    );
    const response = await this.http.request<unknown[]>(
      "POST",
      "/v1/passages/search",
      {
        body: {
          agent_id: agentId,
          query: input.query,
          limit: Math.min(
            100,
            input.topK * maximumPassagesPerRecord
          ),
          tag_match_mode: "all",
          tags: [this.runTag!, this.scopeTag(input.scope)],
        },
        expectedStatuses: [200],
        safeToRetry: true,
      }
    );
    if (!Array.isArray(response.data)) {
      throw new Error(
        "Letta passage search response must be an array"
      );
    }

    const normalized: NormalizedMemoryHit[] = [];
    const logicalHitByRecordId = new Map<string, NormalizedMemoryHit>();
    for (let index = 0; index < response.data.length; index++) {
      const result = this.parseSearchResult(
        response.data[index],
        `search results[${index}]`
      );
      const recordId = this.recordIdByProviderId.get(result.id) ?? null;
      if (recordId !== null) {
        const existing = logicalHitByRecordId.get(recordId);
        if (existing) {
          if (!existing.content.includes(result.content)) {
            existing.content = `${existing.content}\n${result.content}`;
          }
          continue;
        }
      }
      const hit: NormalizedMemoryHit = {
        recordId,
        content: result.content,
        score: result.score,
        providerId: result.id,
      };
      normalized.push(hit);
      if (recordId !== null) logicalHitByRecordId.set(recordId, hit);
      if (normalized.length >= input.topK) break;
    }
    return normalized;
  }

  async teardown(): Promise<void> {
    if (!this.runNamespace) return;
    this.telemetry.cleanup.attempted = true;
    try {
      await this.deleteAgentsForRun();
      await this.waitForRunToBeEmpty();
      this.telemetry.cleanup.succeeded = true;
      this.telemetry.cleanup.verified = true;
      this.runNamespace = null;
      this.runTag = null;
      this.agentId = null;
      this.datasetName = "";
    } finally {
      this.providerIdsByRecordId.clear();
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

  private requireSetup(): string {
    if (!this.runNamespace || !this.runTag || !this.agentId) {
      throw new Error("Letta adapter is not set up");
    }
    return this.agentId;
  }

  private scopeTag(scope: string): string {
    return `memory-bench-scope-${createHash("sha256").update(scope).digest("hex").slice(0, 24)}`;
  }

  private recordTag(recordId: string): string {
    return `memory-bench-record-${createHash("sha256").update(recordId).digest("hex").slice(0, 24)}`;
  }

  private async createPassages(record: BenchmarkMemoryRecord): Promise<LettaPassage[]> {
    const agentId = this.requireSetup();
    const response = await this.http.request<unknown[]>(
      "POST",
      `/v1/agents/${encodeURIComponent(agentId)}/archival-memory`,
      {
        body: {
          text: record.content,
          created_at: record.observedAt,
          tags: [this.runTag!, this.scopeTag(record.scope), this.recordTag(record.id)],
        },
        expectedStatuses: [200, 201],
      }
    );
    if (!Array.isArray(response.data) || response.data.length === 0) {
      throw new Error("Letta create passage response must be a non-empty array");
    }
    return response.data.map((value, index) => this.parsePassage(value, `create passages[${index}]`));
  }

  private async deletePassage(providerId: string): Promise<void> {
    const agentId = this.requireSetup();
    await this.http.request<never>(
      "DELETE",
      `/v1/agents/${encodeURIComponent(agentId)}/archival-memory/${encodeURIComponent(providerId)}`,
      {
        expectedStatuses: [200, 204, 404],
        safeToRetry: true,
      }
    );
  }

  private mapRecord(record: BenchmarkMemoryRecord, providerIds: string[]): void {
    const ids = new Set(providerIds);
    this.providerIdsByRecordId.set(record.id, ids);
    this.scopeByRecordId.set(record.id, record.scope);
    for (const providerId of ids) this.recordIdByProviderId.set(providerId, record.id);
  }

  private unmapRecord(recordId: string): void {
    for (const providerId of this.providerIdsByRecordId.get(recordId) ?? []) {
      this.recordIdByProviderId.delete(providerId);
    }
    this.providerIdsByRecordId.delete(recordId);
    this.scopeByRecordId.delete(recordId);
  }

  private async waitForPassageIds(providerIds: string[], present: boolean): Promise<void> {
    const expected = new Set(providerIds);
    await this.waitUntil(
      async () => {
        this.telemetry.pollRequestCount++;
        const currentIds = new Set((await this.listPassages()).map((passage) => passage.id));
        const matches = [...expected].every((id) => currentIds.has(id) === present);
        return matches ? true : null;
      },
      `${present ? "indexed" : "deleted"} passages`
    );
  }

  private async listPassages(): Promise<LettaPassage[]> {
    const agentId = this.requireSetup();
    const passages: LettaPassage[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const response = await this.http.request<unknown[]>(
        "GET",
        queryPath(`/v1/agents/${encodeURIComponent(agentId)}/archival-memory`, {
          limit: 200,
          ...(after ? { after } : {}),
        }),
        {
          expectedStatuses: [200],
          safeToRetry: true,
        }
      );
      if (!Array.isArray(response.data)) throw new Error("Letta list passages response must be an array");
      const pageRows = response.data.map((value, index) =>
        this.parsePassage(value, `list passages[${index}]`)
      );
      passages.push(...pageRows);
      if (pageRows.length < 200) return passages;
      after = pageRows.at(-1)!.id;
    }
    throw new Error("Letta passage pagination exceeded 100 pages");
  }

  private async deleteAgentsForRun(): Promise<void> {
    if (!this.runNamespace || !this.runTag) return;
    const agents = await this.listRunAgents();
    const ids = new Set(agents.map((agent) => agent.id));
    if (this.agentId) ids.add(this.agentId);
    for (const id of ids) {
      await this.http.request<never>("DELETE", `/v1/agents/${encodeURIComponent(id)}`, {
        expectedStatuses: [200, 204, 404],
        safeToRetry: true,
      });
    }
  }

  private async listRunAgents(): Promise<LettaAgent[]> {
    if (!this.runNamespace || !this.runTag) return [];
    const response = await this.http.request<unknown[]>(
      "GET",
      queryPath("/v1/agents/", {
        tags: [this.runTag],
        match_all_tags: true,
        limit: 200,
      }),
      {
        expectedStatuses: [200],
        safeToRetry: true,
      }
    );
    if (!Array.isArray(response.data)) throw new Error("Letta list agents response must be an array");
    return response.data
      .map((value, index) => this.parseAgent(value, `list agents[${index}]`))
      .filter(
        (agent) =>
          agent.name === this.runNamespace &&
          agent.metadata?.[metadataRunId] === this.runNamespace
      );
  }

  private async waitForRunToBeEmpty(): Promise<void> {
    if (!this.runNamespace) return;
    await this.waitUntil(
      async () => {
        this.telemetry.pollRequestCount++;
        const agents = await this.listRunAgents();
        if (agents.length > 0) return null;
        if (this.agentId && (await this.getAgent(this.agentId)) !== null) return null;
        return true;
      },
      `run cleanup ${this.runNamespace}`
    );
  }

  private async getAgent(agentId: string): Promise<LettaAgent | null> {
    this.telemetry.pollRequestCount++;
    const response = await this.http.request<Record<string, unknown>>(
      "GET",
      `/v1/agents/${encodeURIComponent(agentId)}`,
      {
        expectedStatuses: [200, 404],
        safeToRetry: true,
      }
    );
    return response.status === 404 ? null : this.parseAgent(response.data, "get agent");
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
    throw new Error(`Letta timed out waiting for ${label} after ${this.settleTimeoutMs}ms${detail}`);
  }

  private parseAgent(value: unknown, label: string): LettaAgent {
    const row = objectValue(value, label);
    if (
      row.metadata !== undefined &&
      (row.metadata === null || typeof row.metadata !== "object" || Array.isArray(row.metadata))
    ) {
      throw new Error(`Letta ${label}.metadata must be an object`);
    }
    return {
      id: stringValue(row.id, `${label}.id`),
      ...(typeof row.name === "string" ? { name: row.name } : {}),
      ...(row.tags === undefined ? {} : { tags: stringArray(row.tags, `${label}.tags`) }),
      ...(row.metadata === undefined
        ? {}
        : { metadata: row.metadata as Record<string, unknown> }),
    };
  }

  private parsePassage(value: unknown, label: string): LettaPassage {
    const row = objectValue(value, label);
    return {
      id: stringValue(row.id, `${label}.id`),
      text: stringValue(row.text, `${label}.text`),
      ...(row.tags === undefined ? {} : { tags: stringArray(row.tags, `${label}.tags`) }),
    };
  }

  private parseSearchResult(value: unknown, label: string): LettaSearchResult {
    const row = objectValue(value, label);
    const passage = this.parsePassage(
      row.passage,
      `${label}.passage`
    );
    if (
      typeof row.score !== "number" ||
      !Number.isFinite(row.score)
    ) {
      throw new Error(`Letta ${label}.score must be finite`);
    }
    return {
      id: passage.id,
      content: passage.text,
      score: row.score,
      ...(passage.tags === undefined ? {} : { tags: passage.tags }),
    };
  }
}
