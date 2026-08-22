import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fragmentAgentSession } from "./agent-session.js";
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

interface MnemaMemory {
  id: number;
  body: string;
  tags: string[];
  score?: number;
}

interface MnemaCore {
  saveMemory(input: {
    type: "fact";
    title: string;
    body: string;
    tags: string[];
    source: string;
    verified_at: string;
  }): Promise<{ id: number }>;
  deleteMemory(id: number): boolean;
  searchMemories(
    query: string,
    filters: { tag: string; limit: number }
  ): Promise<MnemaMemory[]>;
  listMemories(filters: { limit: number }): MnemaMemory[];
  closeDb(): void;
}

const maxMemoryBodyCharacters = 20_000;

function scenarioTag(runId: string, scenarioId: string): string {
  const digest = createHash("sha256")
    .update(`${runId}\0${scenarioId}`)
    .digest("hex")
    .slice(0, 24);
  return `memory-bench-agent-${digest}`;
}

function sessionBody(session: AgentIngestSession): string {
  return [
    `Session Date: ${session.date}`,
    "Session Content:",
    JSON.stringify(session.messages),
  ].join("\n");
}

export class MnemaAgentMemoryAdapter implements AgentMemoryAdapter {
  readonly info: AgentComponentInfo = {
    name: "mnema",
    version: "0.1.0-workspace",
    mode: "local-core-agent-session-fts-only",
    classification: "candidate",
    config: {
      embeddings: false,
      vectorBackend: "sqlite-vec",
      granularity: "bounded-session-fragments",
      maxBodyCharacters: maxMemoryBodyCharacters,
      scopeFilter: "exact-tag",
      scenarioIsolation: "delete-and-verify",
      remoteSync: false,
      processIsolation: "required",
    },
  };

  private static readonly managedEnvironmentKeys = [
    "HUB_DB_PATH",
    "HUB_DEPLOYMENT_PROFILE",
    "HUB_VECTOR_BACKEND",
    "HUB_PRIMARY_URL",
    "HUB_PRIMARY_TOKEN",
    "HUB_STRICT_PROJECTS",
    "HUB_MACHINE_NAME",
    "GEMINI_API_KEY",
  ] as const;

  private core: MnemaCore | null = null;
  private tempDir: string | null = null;
  private runId: string | null = null;
  private activeScenarioTag: string | null = null;
  private readonly previousEnvironment = new Map<
    string,
    string | undefined
  >();
  private readonly sessionByMemoryId = new Map<number, AgentIngestSession>();
  private readonly memoryIds = new Set<number>();
  private readonly ingestedSessionIds = new Set<string>();

  async setup(context: AgentRunContext): Promise<void> {
    if (this.core !== null || this.tempDir !== null) {
      throw new Error("Mnema agent adapter is already set up");
    }
    this.runId = context.runId;
    this.tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mnema-memory-bench-agent-")
    );
    try {
      for (const key of MnemaAgentMemoryAdapter.managedEnvironmentKeys) {
        this.previousEnvironment.set(key, process.env[key]);
      }
      process.env.HUB_DB_PATH = path.join(this.tempDir, "hub.db");
      process.env.HUB_DEPLOYMENT_PROFILE = "personal";
      process.env.HUB_VECTOR_BACKEND = "sqlite-vec";
      process.env.HUB_PRIMARY_URL = "";
      process.env.HUB_PRIMARY_TOKEN = "";
      process.env.HUB_STRICT_PROJECTS = "false";
      process.env.HUB_MACHINE_NAME = "memory-bench-agent";
      process.env.GEMINI_API_KEY = "";
      const coreModulePath = "../../../src/core/index.js";
      this.core = (await import(coreModulePath)) as MnemaCore;
    } catch (error) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = null;
      this.runId = null;
      this.restoreEnvironment();
      throw error;
    }
  }

  async beginScenario(context: AgentScenarioContext): Promise<void> {
    this.requireCore();
    if (this.runId === null) {
      throw new Error("Mnema agent adapter has no run context");
    }
    if (
      this.activeScenarioTag !== null ||
      this.memoryIds.size > 0 ||
      this.sessionByMemoryId.size > 0 ||
      this.ingestedSessionIds.size > 0
    ) {
      throw new Error("Mnema agent adapter contains uncleared scenario state");
    }
    this.activeScenarioTag = scenarioTag(this.runId, context.scenarioId);
  }

  async ingest(session: AgentIngestSession): Promise<void> {
    const core = this.requireCore();
    const tag = this.requireScenarioTag();
    if (this.ingestedSessionIds.has(session.id)) {
      throw new Error(`Mnema agent adapter duplicate session: ${session.id}`);
    }
    this.ingestedSessionIds.add(session.id);
    const fragments = fragmentAgentSession(
      session,
      maxMemoryBodyCharacters,
      sessionBody
    );
    for (const [index, fragment] of fragments.entries()) {
      const saved = await core.saveMemory({
        type: "fact",
        title: `LongMemEval session ${session.id} fragment ${index + 1}/${fragments.length}`,
        body: sessionBody(fragment),
        tags: [tag, "memory-bench-agent"],
        source: "memory-bench-agent",
        verified_at: session.date,
      });
      this.memoryIds.add(saved.id);
      this.sessionByMemoryId.set(saved.id, structuredClone(fragment));
    }
  }

  async query(input: AgentMemoryQuery): Promise<AgentContextItem[]> {
    const hits = await this.requireCore().searchMemories(input.question, {
      tag: this.requireScenarioTag(),
      limit: input.topK,
    });
    return hits.map((hit) => {
      const session = this.sessionByMemoryId.get(hit.id);
      if (session === undefined) {
        throw new Error(
          `Mnema returned an unmapped memory from another scenario: ${hit.id}`
        );
      }
      return {
        type: "text" as const,
        value: JSON.stringify(session.messages),
        observedAt: session.date,
        sourceSessionId: session.id,
        score: hit.score ?? null,
      };
    });
  }

  async endScenario(): Promise<AgentCleanupResult> {
    const core = this.requireCore();
    const tag = this.activeScenarioTag;
    let succeeded = true;
    for (const memoryId of this.memoryIds) {
      try {
        if (!core.deleteMemory(memoryId)) succeeded = false;
      } catch {
        succeeded = false;
      }
    }
    const remaining =
      tag === null
        ? []
        : core
            .listMemories({ limit: this.memoryIds.size + 100 })
            .filter((memory) => memory.tags.includes(tag));
    const verified = remaining.length === 0;
    this.memoryIds.clear();
    this.sessionByMemoryId.clear();
    this.ingestedSessionIds.clear();
    this.activeScenarioTag = null;
    return {
      attempted: true,
      succeeded,
      verified,
    };
  }

  async teardown(): Promise<void> {
    const tempDir = this.tempDir;
    try {
      this.core?.closeDb();
    } finally {
      if (tempDir !== null) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      this.core = null;
      this.tempDir = null;
      this.runId = null;
      this.activeScenarioTag = null;
      this.memoryIds.clear();
      this.sessionByMemoryId.clear();
      this.ingestedSessionIds.clear();
      this.restoreEnvironment();
    }
  }

  getTelemetry(): AgentComponentTelemetry {
    return {
      requestCount: 0,
      retryCount: 0,
      requestBytes: 0,
      responseBytes: 0,
      inputTokens: 0,
      outputTokens: 0,
      providerProcessingMs: null,
      providerCostUsd: 0,
      costSource: "not-applicable",
    };
  }

  private requireCore(): MnemaCore {
    if (this.core === null) {
      throw new Error("Mnema agent adapter is not set up");
    }
    return this.core;
  }

  private requireScenarioTag(): string {
    if (this.activeScenarioTag === null) {
      throw new Error("Mnema agent adapter has no active scenario");
    }
    return this.activeScenarioTag;
  }

  private restoreEnvironment(): void {
    for (const [key, value] of this.previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    this.previousEnvironment.clear();
  }
}
