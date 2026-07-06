import { Router } from "express";
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
  getMemory,
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
  r.get("/rag/documents", wrap((_req, res) => res.json(listDocuments())));
  r.delete("/rag/documents/:id", wrap((req, res) => res.json({ deleted: deleteDocument(Number(req.params.id)) })));
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

  // --- sync (cihazlar arası eşitleme) ---
  r.get("/sync/changes", wrap((req, res) => {
    res.json(collectChanges(String(req.query.since ?? "1970-01-01 00:00:00")));
  }));
  r.post("/sync/apply", wrap((req, res) => res.json(applyChanges(req.body))));
  r.post("/sync/run", wrap(async (_req, res) => {
    if (!config.primaryUrl) return res.json({ ok: false, error: "HUB_PRIMARY_URL tanımlı değil" });
    res.json(await syncWithPrimary(config.primaryUrl, config.primaryToken));
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
