import { z } from "zod";

// Unicode doğrulama .refine() ile: .regex() olsaydı üretilen JSON şemasına \p{L} kalıbı
// yazılır, claude.ai/ChatGPT gibi istemcilerin şema doğrulayıcıları (Python re, \p desteklemez)
// tool'u "invalid schema" diye reddederdi. refine JSON şemasına pattern yazmaz.
export const projectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(value), {
    message: "project name may contain letters, numbers, dot, underscore, and dash",
  });

export const memoryTypeSchema = z.enum(["fact", "preference", "decision", "howto", "context"]);
export const documentKindSchema = z.enum([
  "reference",
  "status",
  "decision",
  "runbook",
  "research",
  "learning",
  "source",
]);
export const contextIntentSchema = z.enum([
  "auto",
  "current_status",
  "decision",
  "technical_history",
  "documentation",
  "preference",
  "general",
]);
export const memoryRelationTypeSchema = z.enum([
  "related",
  "supports",
  "contradicts",
  "supersedes",
  "caused_by",
  "derived_from",
  "applies_to",
]);

const titleSchema = z.string().trim().min(1).max(300);
const projectOptional = projectNameSchema.optional();
const tagsSchema = z.array(z.string().trim().min(1).max(100)).max(32);
const sourceSchema = z.string().trim().min(1).max(200);
const nullableTimestamp = z.string().trim().min(1).max(64).nullable();

export const memoryInputBaseSchema = z
  .object({
    title: titleSchema,
    body: z.string().trim().min(1).max(20_000),
    type: memoryTypeSchema.optional(),
    project: projectOptional,
    tags: tagsSchema.optional(),
    source: sourceSchema.optional(),
    language: z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/).optional(),
    canonical_summary: z.string().trim().min(1).max(1200).optional(),
    normalizer_generation: z.string().trim().min(1).max(200).optional(),
    importance: z.number().finite().min(0.5).max(2).optional(),
    related_ids: z.array(z.number().int().positive()).max(100).optional(),
    origin_machine: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export const memoryInputSchema = memoryInputBaseSchema.refine(
  (value) => !value.canonical_summary || Boolean(value.normalizer_generation), {
    message: "normalizer_generation is required with canonical_summary",
    path: ["normalizer_generation"],
  }
);

export const memoryPatchBaseSchema = z
  .object({
    title: titleSchema.optional(),
    body: z.string().trim().min(1).max(20_000).optional(),
    type: memoryTypeSchema.optional(),
    project: projectOptional,
    tags: tagsSchema.optional(),
    language: z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/).optional(),
    canonical_summary: z.string().trim().min(1).max(1200).nullable().optional(),
    normalizer_generation: z.string().trim().min(1).max(200).nullable().optional(),
    importance: z.number().finite().min(0.5).max(2).optional(),
    related_ids: z.array(z.number().int().positive()).max(100).optional(),
  })
  .strict();
export const memoryPatchSchema = memoryPatchBaseSchema
  .refine((value) => Object.keys(value).length > 0, { message: "memory patch must contain at least one field" })
  .refine((value) => value.canonical_summary === undefined || value.canonical_summary === null || Boolean(value.normalizer_generation), {
    message: "normalizer_generation is required when canonical_summary is updated",
    path: ["normalizer_generation"],
  });

export const memoryConsolidateBaseSchema = z.object({
  target_id: z.number().int().positive(),
  source_ids: z.array(z.number().int().positive()).min(1).max(100),
  /** Explicit merged content prevents silent information loss. */
  body: z.string().trim().min(1).max(20_000),
  title: titleSchema.optional(),
  tags: tagsSchema.optional(),
  language: z.string().trim().min(2).max(35).optional(),
  canonical_summary: z.string().trim().min(1).max(1200).optional(),
  normalizer_generation: z.string().trim().min(1).max(200).optional(),
  source: sourceSchema.optional(),
}).strict();
export const memoryConsolidateSchema = memoryConsolidateBaseSchema
  .refine((value) => !value.source_ids.includes(value.target_id), {
    message: "source_ids must not include target_id",
    path: ["source_ids"],
  })
  .refine((value) => !value.canonical_summary || Boolean(value.normalizer_generation), {
    message: "normalizer_generation is required with canonical_summary",
    path: ["normalizer_generation"],
  });

export const documentInputSchema = z
  .object({
    title: titleSchema,
    text: z.string().min(1).max(8_000_000),
    source: sourceSchema.optional(),
    uri: z.string().trim().min(1).max(2048).optional(),
    project: projectOptional,
    kind: documentKindSchema.optional(),
    version: z.string().trim().min(1).max(100).optional(),
    is_current: z.boolean().optional(),
    supersedes_uid: z.string().regex(/^[a-f0-9]{32}$/i).optional(),
    valid_from: z.string().trim().min(1).max(64).optional(),
    valid_to: z.string().trim().min(1).max(64).optional(),
    archived_at: z.string().trim().min(1).max(64).optional(),
    language: z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/).optional(),
  })
  .strict();

export const documentMetaPatchBaseSchema = z
  .object({
    enabled: z.boolean().optional(),
    project: projectNameSchema.nullable().optional(),
    kind: documentKindSchema.optional(),
    version: z.string().trim().min(1).max(100).nullable().optional(),
    is_current: z.boolean().optional(),
    supersedes_uid: z.string().regex(/^[a-f0-9]{32}$/i).nullable().optional(),
    valid_from: nullableTimestamp.optional(),
    valid_to: nullableTimestamp.optional(),
    archived_at: nullableTimestamp.optional(),
    language: z
      .string()
      .trim()
      .min(2)
      .max(35)
      .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/)
      .nullable()
      .optional(),
  })
  .strict();
export const documentMetaPatchSchema = documentMetaPatchBaseSchema.refine(
  (value) => Object.keys(value).length > 0,
  { message: "document patch must contain at least one field" }
);

export const contextGetSchema = z
  .object({
    query: z.string().trim().min(1).max(10_000),
    project: projectOptional,
    cwd: z.string().max(4096).optional(),
    intent: contextIntentSchema.optional(),
    max_tokens: z.number().int().min(384).max(4000).optional(),
    include_global: z.boolean().optional(),
    record_usage: z.boolean().optional(),
    level: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  })
  .strict();

export const sessionInputSchema = z
  .object({
    summary: z.string().trim().min(1).max(50_000),
    project: projectOptional,
    source: sourceSchema.optional(),
    origin_machine: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const presenceUid = z.string().trim().regex(/^[a-f0-9]{32}$/i);

export const agentCheckinSchema = z
  .object({
    project: projectNameSchema,
    task: z.string().trim().min(1).max(300),
    branch: z.string().trim().min(1).max(200).nullable().optional(),
    machine: z.string().trim().min(1).max(100).optional(),
    agent: z.string().trim().min(1).max(100).optional(),
    /** Verilmezse yeni kayıt açılır ve uid dönülür; verilirse heartbeat/task/branch günceller. */
    uid: presenceUid.optional(),
  })
  .strict();

export const agentCheckoutSchema = z
  .object({
    uid: presenceUid,
    status: z.enum(["done", "abandoned"]).optional(),
  })
  .strict();

export const feedbackInputBaseSchema = z
  .object({
    query: z.string().trim().min(1).max(10_000),
    verdict: z.enum(["noisy", "missing", "helpful"]),
    target_kind: z.enum(["memory", "chunk", "document", "context"]).optional(),
    target_id: z.number().int().positive().optional(),
    project: projectOptional,
    intent: contextIntentSchema.exclude(["auto"]).optional(),
    rank: z.number().int().positive().max(10_000).optional(),
    channels: z.array(z.enum(["fts", "vec", "authority", "graph"])).max(8).optional(),
    delivery_id: z.string().trim().min(8).max(100).optional(),
    /** Deprecated compatibility alias; normalized to target_kind=memory. */
    memory_id: z.number().int().positive().optional(),
    note: z.string().trim().min(1).max(2000).optional(),
    source: sourceSchema.optional(),
  })
  .strict();

export const feedbackInputSchema = feedbackInputBaseSchema.superRefine((value, ctx) => {
    if (value.memory_id && value.target_kind && value.target_kind !== "memory") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["memory_id"], message: "memory_id can only target a memory" });
    }
    if (value.memory_id && value.target_id && value.memory_id !== value.target_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target_id"], message: "memory_id and target_id must match" });
    }
    const kind = value.target_kind ?? (value.memory_id ? "memory" : undefined);
    const id = value.target_id ?? value.memory_id;
    if (kind && kind !== "context" && !id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target_id"], message: "target_id is required for this target_kind" });
    }
    if (kind === "context" && id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target_id"], message: "context feedback must not include target_id" });
    }
    if (kind === "context" && !value.delivery_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["delivery_id"], message: "context feedback requires delivery_id" });
    }
  });

const relationTimestamp = z.string().datetime({ offset: true });
export const memoryRelationInputBaseSchema = z
  .object({
    from_id: z.number().int().positive(),
    to_id: z.number().int().positive(),
    relation_type: memoryRelationTypeSchema,
    confidence: z.number().finite().min(0).max(1).optional(),
    valid_from: relationTimestamp.optional(),
    valid_to: relationTimestamp.optional(),
    source: sourceSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
export const memoryRelationInputSchema = memoryRelationInputBaseSchema.superRefine((value, ctx) => {
    if (value.from_id === value.to_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to_id"], message: "a memory cannot relate to itself" });
    }
    if (value.valid_from && value.valid_to && Date.parse(value.valid_to) < Date.parse(value.valid_from)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["valid_to"], message: "valid_to must not precede valid_from" });
    }
  });

export const memoryRelationPatchBaseSchema = z
  .object({
    confidence: z.number().finite().min(0).max(1).optional(),
    valid_from: relationTimestamp.nullable().optional(),
    valid_to: relationTimestamp.nullable().optional(),
    source: sourceSchema.nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
export const memoryRelationPatchSchema = memoryRelationPatchBaseSchema
  .refine((value) => Object.keys(value).length > 0, { message: "relation patch must contain at least one field" })
  .superRefine((value, ctx) => {
    if (value.valid_from && value.valid_to && Date.parse(value.valid_to) < Date.parse(value.valid_from)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["valid_to"], message: "valid_to must not precede valid_from" });
    }
  });

const projectModuleSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1).max(2048),
    purpose: z.string().trim().min(1).max(2000),
    key_files: z.array(z.string().max(2048)).max(100).optional(),
    depends_on: z.array(z.string().max(200)).max(100).optional(),
  })
  .strict();

export const projectMapSchema = z
  .object({
    name: projectNameSchema,
    status: z.enum(["active", "paused", "done", "idea"]).optional(),
    summary: z.string().max(10_000).optional(),
    stack: z.array(z.string().max(100)).max(100).optional(),
    repo: z.string().max(2048).optional(),
    paths: z.record(z.string().max(2048)).optional(),
    current_focus: z.string().max(20_000).optional(),
    decisions: z.array(z.string().max(5000)).max(500).optional(),
    next_steps: z.array(z.string().max(5000)).max(500).optional(),
    links: z.array(z.string().max(2048)).max(500).optional(),
    notes: z.string().max(50_000).optional(),
    architecture: z.string().max(20_000).optional(),
    modules: z.array(projectModuleSchema).max(500).optional(),
    entry_points: z.record(z.string().max(2048)).optional(),
    commands: z.record(z.string().max(5000)).optional(),
    conventions: z.array(z.string().max(5000)).max(500).optional(),
    data_model: z.string().max(20_000).optional(),
  })
  .strict();

const syncTimestamp = z.string().trim().min(1).max(64);
const syncUid = z.string().trim().min(1).max(200);
const syncVector = z.string().max(2_000_000).optional();
const syncChunkSchema = z.object({
  seq: z.number().int().nonnegative(),
  heading: z.string().max(5000).nullable(),
  text: z.string().max(2_000_000),
  embedding: syncVector,
}).strict();

export const syncPayloadSchema = z.object({
  now: syncTimestamp,
  // Eski peer'lar bu alani gondermez; gonderildiginde istemci seq moduna gecebilir (ADR-005).
  max_seq: z.number().int().nonnegative().optional(),
  embedding_generation: z.string().max(128).optional(),
  memories: z.array(z.object({
    uid: syncUid,
    type: memoryTypeSchema,
    title: z.string().min(1).max(300),
    body: z.string().min(1).max(20_000),
    project: projectNameSchema.nullable(),
    tags: z.string().max(20_000),
    source: z.string().max(200).nullable(),
    language: z.string().max(35).nullable().optional(),
    canonical_summary: z.string().max(1200).nullable().optional(),
    normalizer_generation: z.string().max(200).nullable().optional(),
    created_at: syncTimestamp,
    updated_at: syncTimestamp,
    importance: z.number().finite().min(0.5).max(2).optional(),
    related: z.string().max(50_000).optional(),
    origin_machine: z.string().max(100).nullable().optional(),
    embedding: syncVector,
  }).strict()).max(100_000),
  documents: z.array(z.object({
    uid: syncUid,
    title: z.string().min(1).max(300),
    source: z.string().max(200).nullable(),
    uri: z.string().max(2048).nullable(),
    project: projectNameSchema.nullable(),
    enabled: z.number().int().min(0).max(1).optional(),
    kind: documentKindSchema.optional(),
    version: z.string().max(100).nullable().optional(),
    is_current: z.number().int().min(0).max(1).optional(),
    supersedes_uid: syncUid.nullable().optional(),
    valid_from: syncTimestamp.nullable().optional(),
    valid_to: syncTimestamp.nullable().optional(),
    archived_at: syncTimestamp.nullable().optional(),
    content_hash: z.string().max(128).nullable().optional(),
    language: z.string().max(35).nullable().optional(),
    created_at: syncTimestamp,
    updated_at: syncTimestamp,
    chunks: z.array(syncChunkSchema).max(100_000),
  }).strict()).max(100_000),
  relations: z.array(z.object({
    uid: syncUid,
    from_uid: syncUid,
    to_uid: syncUid,
    relation_type: memoryRelationTypeSchema,
    confidence: z.number().finite().min(0).max(1),
    valid_from: syncTimestamp.nullable(),
    valid_to: syncTimestamp.nullable(),
    source: z.string().max(200).nullable(),
    metadata: z.string().max(50_000),
    created_at: syncTimestamp,
    updated_at: syncTimestamp,
  }).strict()).max(500_000).optional(),
  projects: z.array(z.object({
    name: projectNameSchema,
    data: z.string().max(2_000_000),
    updated_at: syncTimestamp,
  }).strict()).max(100_000),
  sessions: z.array(z.object({
    uid: syncUid,
    project: projectNameSchema.nullable(),
    summary: z.string().min(1).max(50_000),
    source: z.string().max(200).nullable(),
    origin_machine: z.string().max(100).nullable().optional(),
    created_at: syncTimestamp,
    updated_at: syncTimestamp.optional(),
  }).strict()).max(100_000),
  machines: z.array(z.object({
    name: z.string().min(1).max(100),
    host: z.string().min(1).max(500),
    lmstudio_port: z.number().int().min(1).max(65535).nullable(),
    ollama_port: z.number().int().min(1).max(65535).nullable().optional(),
    comfyui_port: z.number().int().min(1).max(65535).nullable(),
    notes: z.string().max(20_000).nullable(),
    updated_at: syncTimestamp,
  }).strict()).max(10_000),
  // Eski peer'lar bu alanı hiç göndermez → applyChanges yokluğunu boş dizi sayar.
  assets: z.array(z.object({
    uid: syncUid,
    kind: z.enum(["skill", "prompt"]),
    name: z.string().min(1).max(300),
    content: z.string().min(1).max(2_000_000),
    created_at: syncTimestamp,
    updated_at: syncTimestamp,
  }).strict()).max(100_000).optional(),
  agent_presence: z.array(z.object({
    uid: syncUid,
    machine: z.string().min(1).max(100),
    agent: z.string().min(1).max(100),
    project: z.string().min(1).max(100),
    branch: z.string().max(200).nullable(),
    task: z.string().min(1).max(300),
    status: z.enum(["active", "done", "abandoned"]),
    started_at: syncTimestamp,
    heartbeat_at: syncTimestamp,
    finished_at: syncTimestamp.nullable(),
    created_at: syncTimestamp,
    updated_at: syncTimestamp,
  }).strict()).max(100_000).optional(),
  // Agent Intelligence Platform tables
  tasks: z.array(z.object({
    uid: syncUid,
    project: z.string().max(100).nullable(),
    title: z.string().min(1).max(300),
    description: z.string().max(10000).nullable(),
    status: z.string().max(20),
    priority: z.number().int(),
    created_by: z.string().max(100).nullable(),
    claimed_by: z.string().max(100).nullable(),
    claimed_at: syncTimestamp.nullable(),
    depends_on: z.string().max(10000),
    tags: z.string().max(5000),
    result: z.string().max(50000).nullable(),
    error: z.string().max(5000).nullable(),
    due_at: syncTimestamp.nullable(),
    started_at: syncTimestamp.nullable(),
    finished_at: syncTimestamp.nullable(),
    created_at: syncTimestamp,
    updated_at: syncTimestamp,
  }).strict()).max(100_000).optional(),
  agent_capabilities: z.array(z.object({
    uid: syncUid,
    agent: z.string().min(1).max(100),
    machine: z.string().max(100).nullable(),
    capabilities: z.string().max(10000),
    models: z.string().max(5000),
    max_concurrent: z.number().int(),
    status: z.string().max(20),
    last_seen_at: syncTimestamp.nullable(),
    metadata: z.string().max(50000),
    created_at: syncTimestamp,
    updated_at: syncTimestamp,
  }).strict()).max(100_000).optional(),
  agent_messages: z.array(z.object({
    uid: syncUid,
    from_agent: z.string().min(1).max(100),
    to_agent: z.string().max(100).nullable(),
    project: z.string().max(100).nullable(),
    task_uid: syncUid.nullable(),
    kind: z.string().max(20),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(50000),
    payload: z.string().max(100000),
    read_at: syncTimestamp.nullable(),
    created_at: syncTimestamp,
  }).strict()).max(100_000).optional(),
  deletions: z.array(z.object({
    uid: syncUid,
    tbl: z.enum([
      "memories", "documents", "memory_relations", "projects", "session_logs",
      "machines", "assets", "agent_presence", "tasks", "agent_capabilities", "agent_messages",
    ]),
    deleted_at: syncTimestamp,
  }).strict()).max(500_000),
}).strict();
