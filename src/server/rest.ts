import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  addDocument,
  addSessionLog,
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
  deleteDocument,
  deleteMemory,
  formatRecall,
  composePrompt,
  deleteProject,
  deleteSessionLog,
  deleteSkill,
  getDocument,
  getMemory,
  getPromptRaw,
  growthStats,
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
  listDocuments,
  listMemories,
  listProjects,
  recall,
  recentSessionLogs,
  saveMemory,
  searchChunks,
  searchMemories,
  updateMemory,
  upsertProject,
  type MemoryType,
  type ProjectMap,
} from "../core/index.js";

function wrap(fn: (req: any, res: any) => Promise<void> | void) {
  return async (req: any, res: any) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  };
}

export function buildRestRouter(): Router {
  const r = Router();

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

  // --- rag ---
  r.post("/rag/documents", wrap(async (req, res) => res.json(await addDocument(req.body))));
  r.get("/rag/documents", wrap((req, res) => res.json(listDocuments(req.query.project as string | undefined))));
  r.get("/rag/documents/:id", wrap((req, res) => {
    const doc = getDocument(Number(req.params.id));
    doc ? res.json(doc) : res.status(404).json({ error: "bulunamadı" });
  }));
  r.patch("/rag/documents/:id", wrap((req, res) => {
    const patch: { enabled?: boolean; project?: string | null } = {};
    if (req.body.enabled !== undefined) patch.enabled = Boolean(req.body.enabled);
    if (req.body.project !== undefined) patch.project = req.body.project === null ? null : String(req.body.project);
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
    const { q, project, limit } = req.query;
    res.json(await searchChunks(String(q ?? ""), {
      project: project as string | undefined,
      limit: limit ? Number(limit) : undefined,
    }));
  }));

  // --- projects ---
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

  // --- sessions ---
  r.post("/sessions", wrap((req, res) =>
    res.json(addSessionLog(String(req.body.summary ?? ""), req.body.project, req.body.source))
  ));
  r.get("/sessions", wrap((req, res) => {
    const { project, limit } = req.query;
    res.json(recentSessionLogs({
      project: project as string | undefined,
      limit: limit ? Number(limit) : undefined,
    }));
  }));
  r.delete("/sessions/:id", wrap((req, res) => res.json({ deleted: deleteSessionLog(Number(req.params.id)) })));

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

  // --- skills (repo'daki skills/ klasörü; düzenleme sonrası git commit + hub sync kullanıcıda) ---
  r.get("/skills", wrap((_req, res) => res.json(listSkills())));
  r.put("/skills/:name", wrap((req, res) => {
    saveSkill(req.params.name, String(req.body.content ?? ""));
    res.json({ ok: true, note: "Kalıcı olması için: git commit + push + her cihazda hub sync" });
  }));
  r.delete("/skills/:name", wrap((req, res) => res.json({ deleted: deleteSkill(req.params.name) })));

  // --- prompts (rol bazlı master prompt kütüphanesi) ---
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
    res.json({ ok: true, note: "Kalıcı olması için: git commit + push (Pi'de git pull)" });
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
    const { q, project, format } = req.query;
    const result = await recall(String(q ?? ""), project as string | undefined);
    if (format === "text") {
      res.type("text/plain").send(formatRecall(result));
    } else {
      res.json(result);
    }
  }));

  return r;
}
