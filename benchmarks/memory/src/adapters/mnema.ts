import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AdapterInfo,
  AdapterTelemetry,
  BenchmarkMemoryRecord,
  BenchmarkRunContext,
  MemoryBenchAdapter,
  NormalizedMemoryHit,
  SearchInput,
} from "../types.js";

interface MnemaMemory {
  id: number;
  body: string;
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
  updateMemory(
    id: number,
    patch: {
      title: string;
      body: string;
      tags: string[];
      verified_at: string;
    }
  ): Promise<MnemaMemory | null>;
  deleteMemory(id: number): boolean;
  searchMemories(query: string, filters: { tag: string; limit: number }): Promise<MnemaMemory[]>;
  closeDb(): void;
}

function scopeTag(scope: string): string {
  return `memory-bench-scope-${createHash("sha256").update(scope).digest("hex").slice(0, 20)}`;
}

function titleFor(record: BenchmarkMemoryRecord): string {
  return `${record.id}: ${record.content.slice(0, 96)}`;
}

export class MnemaAdapter implements MemoryBenchAdapter {
  readonly info: AdapterInfo = {
    name: "mnema",
    version: "0.1.0-workspace",
    mode: "local-core-fts-only",
    config: {
      embeddings: false,
      vectorBackend: "sqlite-vec",
      scopeFilter: "exact-tag",
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
  private previousEnvironment = new Map<string, string | undefined>();
  private cleanupTelemetry: AdapterTelemetry["cleanup"] = {
    attempted: false,
    succeeded: false,
    verified: false,
  };
  private readonly providerIdByRecordId = new Map<string, number>();
  private readonly recordIdByProviderId = new Map<number, string>();
  private readonly scopeByRecordId = new Map<string, string>();

  async setup(_context: BenchmarkRunContext): Promise<void> {
    this.cleanupTelemetry = { attempted: false, succeeded: false, verified: false };
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnema-memory-bench-"));
    try {
      for (const key of MnemaAdapter.managedEnvironmentKeys) {
        this.previousEnvironment.set(key, process.env[key]);
      }
      process.env.HUB_DB_PATH = path.join(this.tempDir, "hub.db");
      process.env.HUB_DEPLOYMENT_PROFILE = "personal";
      process.env.HUB_VECTOR_BACKEND = "sqlite-vec";
      process.env.HUB_PRIMARY_URL = "";
      process.env.HUB_PRIMARY_TOKEN = "";
      process.env.HUB_STRICT_PROJECTS = "false";
      process.env.HUB_MACHINE_NAME = "memory-bench";
      process.env.GEMINI_API_KEY = "";
      const coreModulePath = "../../../../src/core/index.js";
      this.core = (await import(coreModulePath)) as MnemaCore;
    } catch (error) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = null;
      this.restoreEnvironment();
      throw error;
    }
  }

  async write(record: BenchmarkMemoryRecord): Promise<void> {
    const core = this.requireCore();
    if (this.providerIdByRecordId.has(record.id)) throw new Error(`Mnema record already exists: ${record.id}`);
    const saved = await core.saveMemory({
      type: "fact",
      title: titleFor(record),
      body: record.content,
      tags: [scopeTag(record.scope), "memory-bench"],
      source: "memory-bench",
      verified_at: record.observedAt,
    });
    this.providerIdByRecordId.set(record.id, saved.id);
    this.recordIdByProviderId.set(saved.id, record.id);
    this.scopeByRecordId.set(record.id, record.scope);
  }

  async update(targetId: string, record: BenchmarkMemoryRecord): Promise<void> {
    const core = this.requireCore();
    const providerId = this.providerIdByRecordId.get(targetId);
    if (providerId === undefined) throw new Error(`Mnema update target not found: ${targetId}`);
    const updated = await core.updateMemory(providerId, {
      title: titleFor(record),
      body: record.content,
      tags: [scopeTag(record.scope), "memory-bench"],
      verified_at: record.observedAt,
    });
    if (!updated) throw new Error(`Mnema update failed: ${targetId}`);
    this.providerIdByRecordId.delete(targetId);
    this.scopeByRecordId.delete(targetId);
    this.providerIdByRecordId.set(record.id, providerId);
    this.recordIdByProviderId.set(providerId, record.id);
    this.scopeByRecordId.set(record.id, record.scope);
  }

  async delete(targetId: string, scope: string): Promise<void> {
    const core = this.requireCore();
    const providerId = this.providerIdByRecordId.get(targetId);
    if (providerId === undefined || this.scopeByRecordId.get(targetId) !== scope) {
      throw new Error(`Mnema delete target not found in scope: ${targetId}`);
    }
    if (!core.deleteMemory(providerId)) throw new Error(`Mnema delete failed: ${targetId}`);
    this.providerIdByRecordId.delete(targetId);
    this.recordIdByProviderId.delete(providerId);
    this.scopeByRecordId.delete(targetId);
  }

  async search(input: SearchInput): Promise<NormalizedMemoryHit[]> {
    const hits = await this.requireCore().searchMemories(input.query, {
      tag: scopeTag(input.scope),
      limit: input.topK,
    });
    return hits.map((hit) => ({
      recordId: this.recordIdByProviderId.get(hit.id) ?? null,
      content: hit.body,
      score: hit.score ?? null,
      providerId: String(hit.id),
    }));
  }

  async teardown(): Promise<void> {
    this.cleanupTelemetry.attempted = true;
    const tempDir = this.tempDir;
    try {
      this.core?.closeDb();
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      this.core = null;
      this.tempDir = null;
      this.providerIdByRecordId.clear();
      this.recordIdByProviderId.clear();
      this.scopeByRecordId.clear();
      this.restoreEnvironment();
      this.cleanupTelemetry.succeeded = true;
      this.cleanupTelemetry.verified = tempDir === null || !fs.existsSync(tempDir);
    }
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
      cleanup: { ...this.cleanupTelemetry },
    };
  }

  private requireCore(): MnemaCore {
    if (!this.core) throw new Error("Mnema adapter is not set up");
    return this.core;
  }

  private restoreEnvironment(): void {
    for (const [key, value] of this.previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    this.previousEnvironment.clear();
  }
}
