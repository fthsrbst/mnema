import { createHash } from "node:crypto";
import {
  LettaAdapter,
  type LettaAdapterOptions,
} from "./adapters/letta.js";
import {
  Mem0Adapter,
  type Mem0AdapterOptions,
} from "./adapters/mem0.js";
import {
  ZepAdapter,
  type ZepAdapterOptions,
} from "./adapters/zep.js";
import {
  fragmentAgentSession,
  normalizeAgentProviderTimestamp,
  serializeAgentSessionMessages,
} from "./agent-session.js";
import type {
  AgentCleanupResult,
  AgentComponentInfo,
  AgentComponentTelemetry,
  AgentContextItem,
  AgentIngestSession,
  AgentMemoryAdapter,
  AgentMemoryQuery,
  AgentRunContext,
  AgentScenarioContext,
} from "./agent-types.js";
import type {
  AdapterInfo,
  AdapterTelemetry,
  MemoryBenchAdapter,
} from "./types.js";

interface ProviderPolicy {
  maximumRecordCharacters: number | null;
  validateConfiguration(info: AdapterInfo): void;
}

interface StoredSessionFragment {
  sourceSessionId: string;
  observedAt: string;
}

interface ActiveProviderScenario {
  core: MemoryBenchAdapter;
  scope: string;
  scenarioKey: string;
  sourceSessionIds: Set<string>;
  sessionByRecordId: Map<string, StoredSessionFragment>;
}

function emptyAgentTelemetry(): AgentComponentTelemetry {
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

function aggregateTelemetry(
  snapshots: AdapterTelemetry[]
): AgentComponentTelemetry {
  if (snapshots.length === 0) return emptyAgentTelemetry();
  const costAvailable = snapshots.every(
    (snapshot) => snapshot.providerCostUsd !== null
  );
  const processingValues = snapshots
    .map((snapshot) => snapshot.providerProcessingMs)
    .filter((value): value is number => value !== null);
  const costSources = new Set(
    snapshots.map((snapshot) => snapshot.costSource)
  );
  return {
    requestCount: snapshots.reduce(
      (sum, snapshot) => sum + snapshot.requestCount,
      0
    ),
    retryCount: snapshots.reduce(
      (sum, snapshot) => sum + snapshot.retryCount,
      0
    ),
    requestBytes: snapshots.reduce(
      (sum, snapshot) => sum + snapshot.requestBytes,
      0
    ),
    responseBytes: snapshots.reduce(
      (sum, snapshot) => sum + snapshot.responseBytes,
      0
    ),
    inputTokens: null,
    outputTokens: null,
    providerProcessingMs:
      processingValues.length === 0
        ? null
        : processingValues.reduce((sum, value) => sum + value, 0),
    providerCostUsd: costAvailable
      ? snapshots.reduce(
          (sum, snapshot) => sum + snapshot.providerCostUsd!,
          0
        )
      : null,
    costSource:
      costAvailable && costSources.size === 1
        ? snapshots[0]!.costSource
        : "not-exposed",
  };
}

function requireBooleanConfig(
  info: AdapterInfo,
  key: string
): boolean {
  const value = info.config[key];
  if (typeof value !== "boolean") {
    throw new Error(`${info.name} adapter config.${key} must be boolean`);
  }
  return value;
}

function requireStringConfig(
  info: AdapterInfo,
  key: string
): string {
  const value = info.config[key];
  if (typeof value !== "string") {
    throw new Error(`${info.name} adapter config.${key} must be string`);
  }
  return value;
}

class ProviderAgentMemoryAdapter implements AgentMemoryAdapter {
  readonly info: AgentComponentInfo;

  private readonly completedTelemetry: AdapterTelemetry[] = [];
  private runContext: AgentRunContext | null = null;
  private active: ActiveProviderScenario | null = null;

  constructor(
    private readonly createCoreAdapter: () => MemoryBenchAdapter,
    private readonly policy: ProviderPolicy
  ) {
    const coreInfo = createCoreAdapter().info;
    this.info = {
      name: coreInfo.name,
      version: `${coreInfo.version}+agent-session-v1`,
      mode: `${coreInfo.mode}+agent-memory`,
      classification: "candidate",
      config: {
        ...coreInfo.config,
        track: "agent-memory",
        ingestionGranularity: "source-session",
        scenarioIsolation: "one-disposable-core-run-per-scenario",
        providerRecordIds: "sha256-local-map",
        sourceSessionIdsSentToProvider: false,
        providerTimestampPolicy:
          "timezone-less-source-wall-clock-assumed-utc",
        maximumRecordCharacters: policy.maximumRecordCharacters,
      },
    };
  }

  async setup(context: AgentRunContext): Promise<void> {
    if (this.runContext !== null || this.active !== null) {
      throw new Error(
        `${this.info.name} agent adapter is already set up`
      );
    }
    this.policy.validateConfiguration(this.createCoreAdapter().info);
    this.completedTelemetry.length = 0;
    this.runContext = structuredClone(context);
  }

  async beginScenario(context: AgentScenarioContext): Promise<void> {
    if (this.runContext === null) {
      throw new Error(
        `${this.info.name} agent adapter has not been set up`
      );
    }
    if (this.active !== null) {
      throw new Error(
        `${this.info.name} agent adapter contains uncleared scenario state`
      );
    }
    const scenarioKey = createHash("sha256")
      .update(`${this.runContext.runId}\0${context.scenarioId}`)
      .digest("hex");
    const active: ActiveProviderScenario = {
      core: this.createCoreAdapter(),
      scope: "agent-memory-scenario",
      scenarioKey,
      sourceSessionIds: new Set(),
      sessionByRecordId: new Map(),
    };
    this.active = active;
    await active.core.setup({
      runId: scenarioKey,
      datasetName: this.runContext.datasetName,
      datasetVersion: this.runContext.datasetVersion,
      scopes: [active.scope],
    });
  }

  async ingest(session: AgentIngestSession): Promise<void> {
    const active = this.requireActive();
    if (active.sourceSessionIds.has(session.id)) {
      throw new Error(
        `${this.info.name} agent adapter duplicate session: ${session.id}`
      );
    }
    active.sourceSessionIds.add(session.id);
    const fragments =
      this.policy.maximumRecordCharacters === null
        ? [structuredClone(session)]
        : fragmentAgentSession(
            session,
            this.policy.maximumRecordCharacters,
            serializeAgentSessionMessages
          );
    const providerObservedAt = normalizeAgentProviderTimestamp(
      session.date
    );
    for (const [index, fragment] of fragments.entries()) {
      const recordId = `agent-session-${createHash("sha256")
        .update(
          `${active.scenarioKey}\0${session.id}\0${index}`
        )
        .digest("hex")
        .slice(0, 32)}`;
      active.sessionByRecordId.set(recordId, {
        sourceSessionId: session.id,
        observedAt: session.date,
      });
      await active.core.write({
        id: recordId,
        scope: active.scope,
        content: serializeAgentSessionMessages(fragment),
        observedAt: providerObservedAt,
        metadata: {
          memory_bench_agent_fragment_index: index,
          memory_bench_agent_fragment_count: fragments.length,
        },
      });
    }
  }

  async query(input: AgentMemoryQuery): Promise<AgentContextItem[]> {
    const active = this.requireActive();
    const hits = await active.core.search({
      scope: active.scope,
      query: input.question,
      topK: input.topK,
    });
    return hits.map((hit) => {
      if (hit.recordId === null) {
        throw new Error(
          `${this.info.name} returned a hit without a benchmark record ID`
        );
      }
      const source = active.sessionByRecordId.get(hit.recordId);
      if (source === undefined) {
        throw new Error(
          `${this.info.name} returned an unmapped record from another scenario`
        );
      }
      return {
        type: "text" as const,
        value: hit.content,
        observedAt: source.observedAt,
        sourceSessionId: source.sourceSessionId,
        score: hit.score,
      };
    });
  }

  async endScenario(): Promise<AgentCleanupResult> {
    if (this.active === null) {
      return {
        attempted: false,
        succeeded: false,
        verified: false,
      };
    }
    return this.closeActiveScenario();
  }

  async teardown(): Promise<void> {
    if (this.active !== null) {
      const cleanup = await this.closeActiveScenario();
      if (
        !cleanup.attempted ||
        !cleanup.succeeded ||
        !cleanup.verified
      ) {
        throw new Error(
          `${this.info.name} global teardown could not verify cleanup`
        );
      }
    }
    this.runContext = null;
  }

  getTelemetry(): AgentComponentTelemetry {
    const snapshots = [...this.completedTelemetry];
    if (this.active !== null) {
      snapshots.push(this.active.core.getTelemetry());
    }
    return aggregateTelemetry(snapshots);
  }

  private requireActive(): ActiveProviderScenario {
    if (this.active === null) {
      throw new Error(
        `${this.info.name} agent adapter has no active scenario`
      );
    }
    return this.active;
  }

  private async closeActiveScenario(): Promise<AgentCleanupResult> {
    const active = this.requireActive();
    await active.core.teardown();
    const telemetry = active.core.getTelemetry();
    const cleanup = { ...telemetry.cleanup };
    if (
      cleanup.attempted &&
      cleanup.succeeded &&
      cleanup.verified
    ) {
      this.completedTelemetry.push(telemetry);
      this.active = null;
    }
    return cleanup;
  }
}

export class Mem0AgentMemoryAdapter extends ProviderAgentMemoryAdapter {
  constructor(options: Mem0AdapterOptions = {}) {
    super(() => new Mem0Adapter(options), {
      maximumRecordCharacters: null,
      validateConfiguration(info): void {
        if (!requireBooleanConfig(info, "apiKeyConfigured")) {
          throw new Error(
            "MEM0_API_KEY is required for the mem0 agent adapter"
          );
        }
      },
    });
  }
}

export class LettaAgentMemoryAdapter extends ProviderAgentMemoryAdapter {
  constructor(options: LettaAdapterOptions = {}) {
    super(() => new LettaAdapter(options), {
      maximumRecordCharacters: null,
      validateConfiguration(info): void {
        if (
          requireStringConfig(info, "baseUrl") ===
            "https://api.letta.com" &&
          !requireBooleanConfig(info, "apiKeyConfigured")
        ) {
          throw new Error(
            "LETTA_API_KEY is required for the managed Letta agent adapter"
          );
        }
      },
    });
  }
}

export class ZepAgentMemoryAdapter extends ProviderAgentMemoryAdapter {
  constructor(options: ZepAdapterOptions = {}) {
    super(() => new ZepAdapter(options), {
      maximumRecordCharacters: 10_000,
      validateConfiguration(info): void {
        if (
          requireStringConfig(info, "baseUrl") ===
            "https://api.getzep.com" &&
          !requireBooleanConfig(info, "apiKeyConfigured")
        ) {
          throw new Error(
            "ZEP_API_KEY is required for the managed Zep agent adapter"
          );
        }
      },
    });
  }
}
