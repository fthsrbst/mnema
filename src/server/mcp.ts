import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addDocument,
  addSessionLog,
  appendToProject,
  deleteMemory,
  getProject,
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

const memoryType = z.enum(["fact", "preference", "decision", "howto", "context"]);

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "ai-hub", version: "0.1.0" });

  server.registerTool(
    "memory_save",
    {
      title: "Hafızaya kaydet",
      description:
        "Kalıcı olması gereken bilgiyi ortak hafızaya yazar: kararlar (gerekçesiyle), kullanıcı tercihleri, öğrenilen how-to'lar, proje bağlamı. Oturum bitince kaybolmaması gereken her şey buraya.",
      inputSchema: {
        title: z.string().describe("Kısa başlık"),
        body: z.string().describe("İçerik (markdown). Kararlar için gerekçeyi de yaz."),
        type: memoryType.optional().describe("fact | preference | decision | howto | context"),
        project: z.string().optional().describe("İlgili proje adı"),
        tags: z.array(z.string()).optional(),
        source: z.string().optional().describe("Hangi agent/cihaz yazıyor"),
      },
    },
    async (args) => json(await saveMemory(args))
  );

  server.registerTool(
    "memory_search",
    {
      title: "Hafızada ara",
      description:
        "Ortak hafızada hibrit arama (anahtar kelime + anlamsal). Bir işe başlamadan önce ilgili karar/tercih/how-to var mı diye bak.",
      inputSchema: {
        query: z.string(),
        type: memoryType.optional(),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ query, ...filters }) => json(await searchMemories(query, filters))
  );

  server.registerTool(
    "memory_update",
    {
      title: "Hafıza kaydını güncelle",
      description: "Var olan hafıza kaydını günceller (eskiyen/yanlışlanan bilgiyi düzelt).",
      inputSchema: {
        id: z.number().int(),
        title: z.string().optional(),
        body: z.string().optional(),
        type: memoryType.optional(),
        project: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ id, ...patch }) => {
      const updated = await updateMemory(id, patch);
      return updated ? json(updated) : json({ error: `memory #${id} bulunamadı` });
    }
  );

  server.registerTool(
    "memory_delete",
    {
      title: "Hafıza kaydını sil",
      description: "Yanlış veya artık geçersiz hafıza kaydını siler.",
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => json({ deleted: deleteMemory(id) })
  );

  server.registerTool(
    "rag_search",
    {
      title: "Doküman arşivinde ara",
      description:
        "İndekslenmiş dokümanlarda (notlar, öğrenme notları, README'ler, araştırmalar) hibrit arama. Kaynak referanslı parçalar döner.",
      inputSchema: {
        query: z.string(),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ query, ...opts }) => json(await searchChunks(query, opts))
  );

  server.registerTool(
    "rag_add",
    {
      title: "Doküman indeksle",
      description:
        "Bir metni/dokümanı RAG arşivine ekler (otomatik chunk + embed). Öğrenme notları, araştırma özetleri, önemli dokümanlar için. Aynı uri ile tekrar çağrılırsa re-index eder.",
      inputSchema: {
        title: z.string(),
        text: z.string().describe("Markdown içerik"),
        uri: z.string().optional().describe("Tekil kimlik (dosya yolu/URL) — re-index için"),
        project: z.string().optional(),
        source: z.string().optional(),
      },
    },
    async (args) => json(await addDocument(args))
  );

  server.registerTool(
    "project_list",
    {
      title: "Projeleri listele",
      description: "Tüm proje maplerini durumlarıyla listeler.",
      inputSchema: {},
    },
    async () => json(listProjects().map(({ name, status, summary, current_focus, updated_at }) => ({ name, status, summary, current_focus, updated_at })))
  );

  server.registerTool(
    "project_get",
    {
      title: "Proje map'ini getir",
      description:
        "Bir projenin tam bağlamı: özet, stack, alınan kararlar, mevcut odak, sıradaki adımlar. Bir projede çalışmaya başlarken önce bunu çek.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const proj = getProject(name);
      return proj ? json(proj) : json({ error: `proje '${name}' yok`, mevcut: listProjects().map((p) => p.name) });
    }
  );

  server.registerTool(
    "project_update",
    {
      title: "Proje map'ini güncelle",
      description:
        "Proje map'ini oluşturur/günceller (merge eder, silmez). Odak değişince, karar alınınca, adım tamamlanınca çağır.",
      inputSchema: {
        name: z.string(),
        status: z.enum(["active", "paused", "done", "idea"]).optional(),
        summary: z.string().optional(),
        stack: z.array(z.string()).optional(),
        repo: z.string().optional(),
        current_focus: z.string().optional(),
        decisions: z.array(z.string()).optional().describe("TAM liste (üzerine yazar); tek karar eklemek için add_decision kullan"),
        next_steps: z.array(z.string()).optional().describe("TAM liste (üzerine yazar)"),
        notes: z.string().optional(),
      },
    },
    async (args) => json(upsertProject(args as ProjectMap))
  );

  server.registerTool(
    "project_add_decision",
    {
      title: "Projeye karar ekle",
      description: "Proje karar geçmişine tek satır ekler. Format önerisi: 'YYYY-MM: karar — gerekçe'.",
      inputSchema: { name: z.string(), decision: z.string() },
    },
    async ({ name, decision }) => {
      const proj = appendToProject(name, "decisions", decision);
      return proj ? json(proj) : json({ error: `proje '${name}' yok` });
    }
  );

  server.registerTool(
    "session_log",
    {
      title: "Oturum özeti kaydet",
      description:
        "Oturum sonunda ne yapıldığını kaydeder: bitirilenler, yarım kalanlar, sıradaki adım. Bir sonraki oturum (hangi cihazda olursa olsun) buradan devam eder.",
      inputSchema: {
        summary: z.string().describe("Markdown özet: yapılanlar, yarım kalanlar, sıradaki adım"),
        project: z.string().optional(),
        source: z.string().optional(),
      },
    },
    async ({ summary, project, source }) => json(addSessionLog(summary, project, source))
  );

  server.registerTool(
    "recall",
    {
      title: "İlgili hafızayı çek",
      description:
        "Bir mesaj/görev için ilgili hafıza kayıtlarını ve doküman parçalarını tek çağrıda döner (hibrit arama). Göreve başlarken çağır.",
      inputSchema: { query: z.string(), project: z.string().optional() },
    },
    async ({ query, project }) => json(await recall(query, project))
  );

  server.registerTool(
    "session_recent",
    {
      title: "Son oturum özetleri",
      description: "'Nerede kalmıştım?' — son oturum loglarını döner.",
      inputSchema: { project: z.string().optional(), limit: z.number().int().min(1).max(30).optional() },
    },
    async ({ project, limit }) => json(recentSessionLogs({ project, limit }))
  );

  return server;
}
