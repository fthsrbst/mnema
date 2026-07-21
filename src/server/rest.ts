import { Router, raw } from "express";
import { ZodError } from "zod";
import fs from "node:fs";
import path from "node:path";
import {
  addDocument,
  addRecallFeedback,
  addSessionLog,
  agentActive,
  agentCheckin,
  agentCheckout,
  agentRecent,
  feedbackSummary,
  feedbackQualityBreakdown,
  listRecallFeedback,
  listAuditEvents,
  extractFileText,
  applyChanges,
  collectChanges,
  config,
  syncWithPrimary,
  deleteMachine,
  generateImage,
  listMachines,
  listWorkflows,
  localLlm,
  machinesStatus,
  upsertMachine,
  appendToProject,
  bridge,
  deleteDocument,
  deleteMemory,
  deleteMemoryRelation,
  formatRecall,
  composePrompt,
  consolidateMemories,
  contextGet,
  graphNeighbors,
  graphNode,
  graphSeed,
  type GraphNodeKind,
  deleteProject,
  detachProjectReferences,
  deleteSessionLog,
  deleteSkill,
  getDocument,
  getMemory,
  getMemoryRelation,
  getPromptRaw,
  growthStats,
  knowledgeIntegrity,
  verifyAuditChain,
  flushVectorOutbox,
  queueFullVectorProjection,
  vectorStore,
  verifyVectorProjectionParity,
  listPrompts,
  listSkills,
  ragStats,
  reindex,
  runDigest,
  timeline,
  usageStats,
  savePrompt,
  saveSkill,
  updateDocumentMeta,
  getProject,
  getProfessionalProfile,
  listDocuments,
  listMemories,
  listMemoryRelations,
  listProjects,
  migrateProjectReferences,
  recall,
  recentSessionLogs,
  saveMemory,
  saveMemoryRelation,
  searchChunks,
  searchMemories,
  updateMemory,
  updateMemoryRelation,
  upsertProfessionalProfile,
  upsertProject,
  type FeedbackVerdict,
  type MemoryType,
  type ProjectMap,
  contextGetSchema,
  professionalProfileInputSchema,
  documentMetaPatchSchema,
  memoryRelationInputSchema,
  memoryConsolidateSchema,
  memoryRelationPatchSchema,
  memoryRelationTypeSchema,
  sessionInputSchema,
  // Agent Intelligence Platform
  createTask,
  claimTask,
  updateTask,
  completeTask,
  cancelTask,
  listTasks,
  getTask,
  taskQueue,
  registerAgent,
  findCapableAgents,
  listAgents,
  agentHeartbeat,
  sendMessage,
  inbox,
  sentMessages,
  recentMessages,
  markRead,
  markAllRead,
  createHandoff,
  hygieneReport,
  runHygiene,
  compactSessions,
  distillProject,
  recordTaskFeedback,
  projectLessons,
  suggestForTask,
  transferableKnowledge,
  registerWebhook,
  listWebhooks,
  removeWebhook,
  enqueueJob,
  getJob,
  listJobs,
  jobStats,
  getMetricsSnapshot,
  prometheusMetrics,
  getEventLogDb,
} from "../core/index.js";

function wrap(fn: (req: any, res: any) => Promise<void> | void) {
  return async (req: any, res: any) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ZodError) {
        return void res.status(400).json({
          error: "validation_error",
          issues: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  };
}

export function buildRestRouter(): Router {
  const r = Router();

  r.get("/integrity", wrap((_req, res) => res.json(knowledgeIntegrity())));
  r.get("/vector-projection", wrap((_req, res) => res.json(vectorStore.status())));
  r.get("/vector-projection/verify", wrap(async (_req, res) => res.json(await verifyVectorProjectionParity())));
  r.post("/vector-projection/rebuild", wrap((_req, res) => {
    res.json({ queued: queueFullVectorProjection(), status: vectorStore.status() });
  }));
  r.post("/vector-projection/flush", wrap(async (req, res) => {
    const limit = req.body?.limit === undefined ? undefined : Number(req.body.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
      return void res.status(400).json({ error: "validation_error", issues: [{ path: "limit", message: "must be an integer from 1 to 1000" }] });
    }
    res.json({ result: await flushVectorOutbox(limit), status: vectorStore.status() });
  }));
  r.get("/audit", wrap((req, res) => res.json(listAuditEvents({
    actor: req.query.actor as string | undefined,
    action: req.query.action as string | undefined,
    project: req.query.project as string | undefined,
    before: req.query.before as string | undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  }))));
  r.get("/audit/verify", wrap((_req, res) => res.json(verifyAuditChain())));

  // Preferred agent context entry point. Retrieved content is returned with
  // provenance and an explicit data-not-instructions trust policy.
  r.post("/context", wrap(async (req, res) => {
    const input = contextGetSchema.omit({ record_usage: true }).parse(req.body);
    res.json(await contextGet(input));
  }));

  // --- memory ---
  r.post("/memory", wrap(async (req, res) => res.json(await saveMemory(req.body))));
  r.get("/memory/search", wrap(async (req, res) => {
    const { q, type, project, tag, limit } = req.query;
    res.json(await searchMemories(String(q ?? ""), {
      type: type as MemoryType | undefined,
      project: project as string | undefined,
      tag: tag as string | undefined,
      limit: limit ? Number(limit) : undefined,
    }));
  }));
  r.get("/memory", wrap((req, res) => {
    const { type, project, limit } = req.query;
    res.json(listMemories({
      type: type as MemoryType | undefined,
      project: project as string | undefined,
      limit: limit ? Number(limit) : undefined,
    }));
  }));
  r.get("/memory/:id", wrap((req, res) => {
    const mem = getMemory(Number(req.params.id));
    mem ? res.json(mem) : res.status(404).json({ error: "bulunamadı" });
  }));
  r.patch("/memory/:id", wrap(async (req, res) => {
    const mem = await updateMemory(Number(req.params.id), req.body);
    mem ? res.json(mem) : res.status(404).json({ error: "bulunamadı" });
  }));
  r.delete("/memory/:id", wrap((req, res) => res.json({ deleted: deleteMemory(Number(req.params.id)) })));
  r.post("/memory/consolidate", wrap(async (req, res) => {
    res.json(await consolidateMemories(memoryConsolidateSchema.parse(req.body)));
  }));

  r.post("/memory-relations", wrap((req, res) => {
    res.json(saveMemoryRelation(memoryRelationInputSchema.parse(req.body)));
  }));
  r.get("/memory-relations", wrap((req, res) => {
    const relationType = req.query.relation_type
      ? memoryRelationTypeSchema.parse(req.query.relation_type)
      : undefined;
    res.json(listMemoryRelations({
      memory_id: req.query.memory_id ? Number(req.query.memory_id) : undefined,
      relation_type: relationType,
      active_at: req.query.active_at as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  }));
  r.get("/memory-relations/:id", wrap((req, res) => {
    const relation = getMemoryRelation(req.params.id);
    relation ? res.json(relation) : res.status(404).json({ error: "bulunamadı" });
  }));
  r.patch("/memory-relations/:id", wrap((req, res) => {
    const relation = updateMemoryRelation(req.params.id, memoryRelationPatchSchema.parse(req.body));
    relation ? res.json(relation) : res.status(404).json({ error: "bulunamadı" });
  }));
  r.delete("/memory-relations/:id", wrap((req, res) => {
    res.json({ deleted: deleteMemoryRelation(req.params.id) });
  }));

  // --- rag ---
  r.post("/rag/documents", wrap(async (req, res) => res.json(await addDocument(req.body))));
  // Ham dosya yükleme (PDF/DOCX/metin): gövde binary, meta query-string'de.
  // curl -X POST -H "Authorization: Bearer $HUB_TOKEN" --data-binary @dosya.pdf \
  //   "$HUB_URL/api/rag/upload?filename=dosya.pdf&title=Başlık&project=learning"
  r.post(
    "/rag/upload",
    raw({ type: () => true, limit: "50mb" }),
    wrap(async (req, res) => {
      const { filename, title, project, uri } = req.query as Record<string, string | undefined>;
      if (!filename) return res.status(400).json({ error: "filename query parametresi zorunlu" });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0)
        return res.status(400).json({ error: "boş gövde — dosyayı --data-binary ile gönder" });
      const text = await extractFileText(req.body, filename);
      res.json(
        await addDocument({
          title: title || filename,
          text,
          uri: uri || `upload/${filename}`,
          project,
          source: `upload:${filename}`,
        })
      );
    })
  );
  r.get("/rag/documents", wrap((req, res) => res.json(listDocuments(req.query.project as string | undefined))));
  r.get("/rag/documents/:id", wrap((req, res) => {
    const doc = getDocument(Number(req.params.id));
    doc ? res.json(doc) : res.status(404).json({ error: "bulunamadı" });
  }));
  r.patch("/rag/documents/:id", wrap((req, res) => {
    const patch = documentMetaPatchSchema.parse(req.body);
    const ok = updateDocumentMeta(Number(req.params.id), patch);
    ok ? res.json({ ok: true, ...patch }) : res.status(404).json({ error: "bulunamadı" });
  }));
  r.delete("/rag/documents/:id", wrap((req, res) => res.json({ deleted: deleteDocument(Number(req.params.id)) })));
  r.get("/rag/stats", wrap((_req, res) => res.json(ragStats())));
  r.get("/timeline", wrap((req, res) => {
    const { limit, before } = req.query;
    res.json(timeline({ limit: limit ? Number(limit) : undefined, before: before as string | undefined }));
  }));
  r.get("/stats/growth", wrap((req, res) => res.json(growthStats(req.query.days ? Number(req.query.days) : undefined))));
  r.get("/stats/usage", wrap((_req, res) => res.json(usageStats())));
  r.post("/rag/reindex", wrap(async (req, res) => res.json(await reindex(Boolean(req.body?.force)))));
  r.get("/rag/search", wrap(async (req, res) => {
    const { q, project, limit, include_archived, kind } = req.query;
    res.json(await searchChunks(String(q ?? ""), {
      project: project as string | undefined,
      limit: limit ? Number(limit) : undefined,
      include_archived: include_archived === "1" || include_archived === "true",
      kind: kind as "reference" | "status" | "decision" | "runbook" | "research" | "learning" | "source" | undefined,
    }));
  }));

  // --- professional profile (global identity domain, deliberately not a project) ---
  r.get("/profile", wrap((_req, res) => res.json(getProfessionalProfile())));
  r.put("/profile", wrap(async (req, res) => {
    res.json(await upsertProfessionalProfile(professionalProfileInputSchema.parse(req.body)));
  }));

  // --- projects ---
  r.post("/projects/migrate-references", wrap((req, res) => {
    res.json(migrateProjectReferences(String(req.body.from ?? ""), String(req.body.to ?? "")));
  }));
  r.post("/projects/:name/detach-references", wrap((req, res) => {
    res.json(detachProjectReferences(req.params.name));
  }));
  r.get("/projects", wrap((_req, res) => res.json(listProjects())));
  r.get("/projects/:name", wrap((req, res) => {
    const proj = getProject(req.params.name);
    proj ? res.json(proj) : res.status(404).json({ error: "bulunamadı" });
  }));
  r.put("/projects/:name", wrap((req, res) =>
    res.json(upsertProject({ ...(req.body as ProjectMap), name: req.params.name }))
  ));
  r.post("/projects/:name/decisions", wrap((req, res) => {
    const proj = appendToProject(req.params.name, "decisions", String(req.body.decision ?? ""));
    proj ? res.json(proj) : res.status(404).json({ error: "bulunamadı" });
  }));
  r.delete("/projects/:name", wrap((req, res) => res.json({ deleted: deleteProject(req.params.name) })));

  // --- graph (ilişki grafiği) ---
  r.get("/graph/seed", wrap((req, res) => {
    const tagLimit = req.query.tags ? Number(req.query.tags) : undefined;
    res.json(graphSeed(tagLimit));
  }));
  r.get("/graph/node", wrap((req, res) => {
    const { kind, key } = req.query as Record<string, string | undefined>;
    if (!kind || !key) return void res.status(400).json({ error: "kind ve key zorunlu" });
    const node = graphNode(kind as GraphNodeKind, key);
    node ? res.json(node) : res.status(404).json({ error: "bulunamadı" });
  }));
  r.get("/graph/neighbors", wrap((req, res) => {
    const { kind, key, offset, limit } = req.query as Record<string, string | undefined>;
    if (!kind || !key) return void res.status(400).json({ error: "kind ve key zorunlu" });
    res.json(
      graphNeighbors(
        kind as GraphNodeKind,
        key,
        offset ? Number(offset) : undefined,
        limit ? Math.min(Number(limit), 100) : undefined
      )
    );
  }));

  // --- sessions ---
  r.post("/sessions", wrap((req, res) =>
    res.json((() => {
      const input = sessionInputSchema.parse(req.body);
      return addSessionLog(input.summary, input.project, input.source, input.origin_machine);
    })())
  ));
  r.get("/sessions", wrap((req, res) => {
    const { project, limit } = req.query;
    res.json(recentSessionLogs({
      project: project as string | undefined,
      limit: limit ? Number(limit) : undefined,
    }));
  }));
  r.delete("/sessions/:id", wrap((req, res) => res.json({ deleted: deleteSessionLog(Number(req.params.id)) })));

  // --- agent presence (advisory koordinasyon — kilit DEĞİL, bkz. presence.ts) ---
  r.post("/agents/checkin", wrap((req, res) => res.json(agentCheckin(req.body))));
  r.post("/agents/checkout", wrap((req, res) => {
    const result = agentCheckout(req.body);
    result ? res.json(result) : res.status(404).json({ error: "bulunamadı" });
  }));
  r.get("/agents/active", wrap((req, res) => res.json(agentActive(req.query.project as string | undefined))));
  r.get("/agents/recent", wrap((req, res) => {
    const { hours } = req.query;
    res.json(agentRecent(hours !== undefined ? Number(hours) : undefined));
  }));

  // --- compute (yerel AI orkestrasyonu) ---
  r.get("/machines", wrap((_req, res) => res.json(listMachines())));
  r.get("/machines/status", wrap(async (_req, res) => res.json(await machinesStatus())));
  r.put("/machines/:name", wrap((req, res) =>
    res.json(upsertMachine({ ...req.body, name: req.params.name }))
  ));
  r.delete("/machines/:name", wrap((req, res) => res.json({ deleted: deleteMachine(req.params.name) })));
  r.post("/llm", wrap(async (req, res) => res.json(await localLlm(req.body))));
  r.get("/workflows", wrap((_req, res) => res.json(listWorkflows())));
  r.post("/image", wrap(async (req, res) => res.json(await generateImage(req.body))));
  r.post("/media", wrap(async (req, res) => res.json(await generateImage(req.body))));

  // --- üretilen medya listesi (galeri için) ---
  r.get("/outputs", wrap((_req, res) => {
    const dir = "./data/outputs";
    if (!fs.existsSync(dir)) return res.json([]);
    const files = fs.readdirSync(dir)
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return { name, url: `/outputs/${name}`, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 200);
    res.json(files);
  }));

  // --- skills (DB authority, assets tablosu — bkz. assets.ts/skills.ts. Kalıcılık ve
  // cihazlar arası dağıtım sync ile otomatik; git commit/push GEREKMEZ.) ---
  r.get("/skills", wrap((_req, res) => res.json(listSkills())));
  r.put("/skills/:name", wrap((req, res) => {
    saveSkill(req.params.name, String(req.body.content ?? ""));
    res.json({ ok: true, note: "DB'ye yazıldı, diğer cihazlara sync ile otomatik yayılır. Yerel dosyaya materyalize etmek için o cihazda: hub sync" });
  }));
  r.delete("/skills/:name", wrap((req, res) => res.json({ deleted: deleteSkill(req.params.name) })));

  // --- prompts (rol bazlı master prompt kütüphanesi; DB authority — bkz. assets.ts/prompts.ts) ---
  r.get("/prompts", wrap((_req, res) => res.json(listPrompts())));
  r.get("/prompts/:name", wrap((req, res) => {
    const raw = req.query.raw === "1";
    const out = raw ? getPromptRaw(req.params.name) : composePrompt(req.params.name);
    out !== null
      ? res.json({ name: req.params.name, content: out })
      : res.status(404).json({ error: "bulunamadı" });
  }));
  r.put("/prompts/:name", wrap((req, res) => {
    savePrompt(req.params.name, String(req.body.content ?? ""));
    res.json({ ok: true, note: "DB'ye yazıldı, diğer cihazlara sync ile otomatik yayılır." });
  }));

  // --- sync (cihazlar arası eşitleme) ---
  r.get("/sync/changes", wrap((req, res) => {
    res.json(collectChanges(String(req.query.since ?? "1970-01-01 00:00:00")));
  }));
  r.post("/sync/apply", wrap((req, res) => res.json(applyChanges(req.body))));
  r.post("/sync/run", wrap(async (_req, res) => {
    if (config.primaryUrls.length === 0) return res.json({ ok: false, error: "HUB_PRIMARY_URL tanımlı değil" });
    res.json(await syncWithPrimary(config.primaryUrls, config.primaryToken));
  }));

  // --- digest (gece özeti + otomatik hafıza çıkarımı) ---
  r.post("/digest/run", wrap(async (req, res) => {
    const period = req.body?.period === "weekly" ? "weekly" : "daily";
    res.json(await runDigest(period));
  }));

  // --- recall (hook'ların kullandığı uç) ---
  r.get("/recall", wrap(async (req, res) => {
    const { q, project, cwd, format } = req.query;
    const result = await recall(
      String(q ?? ""),
      project as string | undefined,
      cwd as string | undefined
    );
    if (format === "text") {
      res.type("text/plain").send(formatRecall(result));
    } else {
      res.json(result);
    }
  }));

  // --- bridge (SessionStart hook'u: proje map'i + son oturum köprüsü) ---
  r.get("/bridge", wrap(async (req, res) => {
    const { cwd, project } = req.query;
    res
      .type("text/plain")
      .send(bridge(cwd as string | undefined, project as string | undefined));
  }));

  // --- recall geri bildirimi (eşik kalibrasyonu verisi) ---
  r.post("/recall/feedback", wrap((req, res) => res.json(addRecallFeedback(req.body))));
  r.get("/recall/feedback", wrap((req, res) => {
    const { verdict, limit } = req.query;
    res.json({
      summary: feedbackSummary(),
      quality: feedbackQualityBreakdown(),
      items: listRecallFeedback({
        verdict: verdict as FeedbackVerdict | undefined,
        limit: limit ? Number(limit) : undefined,
      }),
    });
  }));

  // === Agent Coordination ===

  // Tasks
  r.post("/tasks", wrap((req, res) => res.json(createTask(req.body))));
  r.get("/tasks", wrap((req, res) => {
    const { project, status, claimed_by, created_by, tag, limit } = req.query;
    res.json(listTasks({
      project: project as string | undefined,
      status: status as "pending" | "claimed" | "in_progress" | "blocked" | "done" | "cancelled" | undefined,
      claimed_by: claimed_by as string | undefined,
      created_by: created_by as string | undefined,
      tag: tag as string | undefined,
      limit: limit ? Number(limit) : undefined,
    }));
  }));
  r.get("/tasks/queue", wrap((req, res) => {
    const { project, limit } = req.query;
    res.json(taskQueue(project as string | undefined, limit ? Number(limit) : undefined));
  }));
  r.get("/tasks/:uid", wrap((req, res) => {
    const task = getTask(req.params.uid);
    task ? res.json(task) : res.status(404).json({ error: "not found" });
  }));
  r.patch("/tasks/:uid", wrap((req, res) => {
    const task = updateTask(req.params.uid, req.body);
    task ? res.json(task) : res.status(404).json({ error: "not found" });
  }));
  r.post("/tasks/:uid/claim", wrap((req, res) => {
    const { agent } = req.body;
    if (!agent) return res.status(400).json({ error: "agent required" });
    const task = claimTask(req.params.uid, agent);
    task ? res.json(task) : res.status(404).json({ error: "not found or not claimable" });
  }));
  r.post("/tasks/:uid/complete", wrap((req, res) => {
    const task = completeTask(req.params.uid, req.body?.result);
    task ? res.json(task) : res.status(404).json({ error: "not found" });
  }));
  r.post("/tasks/:uid/cancel", wrap((req, res) => {
    const task = cancelTask(req.params.uid, req.body?.error);
    task ? res.json(task) : res.status(404).json({ error: "not found" });
  }));

  // Agent capabilities
  r.post("/agents/register", wrap((req, res) => res.json(registerAgent(req.body))));
  r.get("/agents", wrap((req, res) => {
    const { status } = req.query;
    res.json(listAgents(status ? { status: status as "available" | "busy" | "offline" } : {}));
  }));
  r.get("/agents/find", wrap((req, res) => {
    const { capability, project } = req.query;
    if (!capability) return res.status(400).json({ error: "capability required" });
    res.json(findCapableAgents(capability as string, project as string | undefined));
  }));
  r.post("/agents/:uid/heartbeat", wrap((req, res) => {
    const status = req.body?.status as "available" | "busy" | "offline" | undefined;
    const result = agentHeartbeat(req.params.uid, status);
    result ? res.json(result) : res.status(404).json({ error: "not found" });
  }));

  // Agent messaging
  r.post("/messages", wrap((req, res) => res.json(sendMessage(req.body))));
  r.get("/messages/inbox", wrap((req, res) => {
    const { agent, limit, include_read } = req.query;
    if (!agent) return res.status(400).json({ error: "agent required" });
    res.json(inbox(agent as string, {
      limit: limit ? Number(limit) : undefined,
      includeRead: include_read === "1" || include_read === "true",
    }));
  }));
  r.get("/messages/sent", wrap((req, res) => {
    const { agent, limit } = req.query;
    if (!agent) return res.status(400).json({ error: "agent required" });
    res.json(sentMessages(agent as string, { limit: limit ? Number(limit) : undefined }));
  }));
  r.get("/messages/recent", wrap((req, res) => {
    const { limit } = req.query;
    res.json(recentMessages(limit ? Number(limit) : undefined));
  }));
  r.post("/messages/:uid/read", wrap((req, res) => {
    const agent = req.body?.agent as string | undefined;
    const result = markRead(req.params.uid, agent);
    result ? res.json(result) : res.status(404).json({ error: "not found" });
  }));
  r.post("/messages/read-all", wrap((req, res) => {
    const { agent } = req.body;
    if (!agent) return res.status(400).json({ error: "agent required" });
    res.json({ marked: markAllRead(agent) });
  }));

  // Handoff
  r.post("/handoff", wrap(async (req, res) => {
    const { from_agent, to_agent, project, notes } = req.body;
    if (!from_agent || !to_agent || !project) {
      return res.status(400).json({ error: "from_agent, to_agent, project required" });
    }
    res.json(await createHandoff(from_agent, to_agent, project, notes ?? ""));
  }));

  // === Context Intelligence ===

  r.get("/hygiene", wrap((req, res) => {
    res.json(hygieneReport(req.query.project as string | undefined));
  }));
  r.post("/hygiene/run", wrap((req, res) => {
    res.json(runHygiene(req.body?.project));
  }));
  r.post("/compact", wrap(async (req, res) => {
    const { project, mode } = req.body;
    if (!project) return res.status(400).json({ error: "project required" });
    if (mode === "sessions") return res.json(await compactSessions(project));
    res.json(await distillProject(project));
  }));
  r.post("/task-feedback", wrap((req, res) => res.json(recordTaskFeedback(req.body))));
  r.get("/lessons/:project", wrap((req, res) => {
    const { limit } = req.query;
    res.json(projectLessons(req.params.project, limit ? Number(limit) : undefined));
  }));
  r.get("/knowledge-transfer/:project", wrap(async (req, res) => {
    const { limit } = req.query;
    res.json(await transferableKnowledge(req.params.project, limit ? Number(limit) : undefined));
  }));

  // === Extensibility ===

  // Webhooks
  r.post("/webhooks", wrap((req, res) => res.json(registerWebhook(req.body))));
  r.get("/webhooks", wrap((_req, res) => res.json(listWebhooks())));
  r.delete("/webhooks/:uid", wrap((req, res) => res.json({ removed: removeWebhook(req.params.uid) })));

  // Jobs
  r.post("/jobs", wrap((req, res) => {
    const { kind, payload } = req.body;
    if (!kind) return res.status(400).json({ error: "kind required" });
    res.json(enqueueJob(kind, payload ?? {}));
  }));
  r.get("/jobs", wrap((req, res) => {
    const { status, kind, limit } = req.query;
    res.json(listJobs({
      status: status as "queued" | "running" | "done" | "failed" | undefined,
      kind: kind as "embed" | "compact" | "hygiene" | "webhook" | "sync" | "reindex" | undefined,
      limit: limit ? Number(limit) : undefined,
    }));
  }));
  r.get("/jobs/stats", wrap((_req, res) => res.json(jobStats())));
  r.get("/jobs/:uid", wrap((req, res) => {
    const job = getJob(req.params.uid);
    job ? res.json(job) : res.status(404).json({ error: "not found" });
  }));

  // Metrics & events
  r.get("/metrics", wrap((_req, res) => {
    res.type("text/plain").send(prometheusMetrics());
  }));
  r.get("/stats/overview", wrap((_req, res) => res.json(getMetricsSnapshot())));
  r.get("/events", wrap((req, res) => {
    const { limit, type } = req.query;
    res.json(getEventLogDb(limit ? Number(limit) : undefined, type as never));
  }));

  return r;
}
