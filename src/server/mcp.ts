import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addDocument,
  addSessionLog,
  generateImage,
  listWorkflows,
  localLlm,
  machinesStatus,
  upsertMachine,
  appendToProject,
  composePrompt,
  deleteMemory,
  deleteProject,
  listPrompts,
  listSkills,
  saveSkill,
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
    "prompt_list",
    {
      title: "Rol promptlarını listele",
      description:
        "Hub'daki rol bazlı sistem promptlarını listeler (senior-software-architect, senior-code-reviewer, debugging-specialist, security-engineer, frontend-engineer, devops-sre, ml-engineer). Bir işe uygun rol seçmek için önce bunu çağır.",
      inputSchema: {},
    },
    async () => json(listPrompts())
  );

  server.registerTool(
    "prompt_get",
    {
      title: "Rol promptu getir",
      description:
        "Seçilen rolün sistem promptunu döner; mühendis zihniyeti çekirdeği (master: objektif, yaltaklanmasız, kanıta dayalı disiplin) otomatik başa eklenir. Göreve başlarken uygun rolü çek; alt modellere (local_llm dahil) görev verirken bu içeriği system prompt olarak kullan.",
      inputSchema: {
        role: z.string().describe("Rol adı (prompt_list'ten) veya 'master' (sadece çekirdek)"),
      },
    },
    async ({ role }) => {
      const content = composePrompt(role);
      return content !== null
        ? { content: [{ type: "text" as const, text: content }] }
        : json({ error: `rol bulunamadı: ${role}` });
    }
  );

  server.registerTool(
    "memory_save",
    {
      title: "Hafızaya kaydet",
      description:
        "Kalıcı olması gereken bilgiyi ortak hafızaya yazar: kararlar (gerekçesiyle), kullanıcı tercihleri, öğrenilen how-to'lar, proje bağlamı. Oturum bitince kaybolmaması gereken her şey buraya. SINIR: uzun doküman/talimat/prompt/araştırma notu memory DEĞİLDİR — rag_add kullan; memory 'bir bakışta okunur tek bilgi'dir.",
      inputSchema: {
        title: z.string().describe("Kısa başlık"),
        body: z.string().describe("İçerik (markdown). Kararlar için gerekçeyi de yaz."),
        type: memoryType.optional().describe("fact | preference | decision | howto | context"),
        project: z
          .string()
          .optional()
          .describe("project_list'teki KANONİK proje adı. Makine/cihaz/etiket proje değildir — onlar için tags kullan."),
        tags: z.array(z.string()).optional(),
        source: z.string().optional().describe("Hangi agent/cihaz yazıyor"),
        importance: z
          .number()
          .min(0.5)
          .max(2)
          .optional()
          .describe(
            "önem çarpanı; varsayılan 1 çoğu kayıt için doğrudur. 2'yi NADİR kullan (aylar sonra bile her recall'da öne geçmesi gereken kritik karar/tercih); 0.5=önemsiz detay"
          ),
      },
    },
    async (args) => {
      const mem = await saveMemory(args);
      const content = [{ type: "text" as const, text: JSON.stringify(mem, null, 2) }];
      if (mem.similar && mem.similar.length > 0) {
        const warning = mem.similar
          .map((s) => `⚠ Benzer kayıt(lar) var: #${s.id} ${s.title} (${s.distance.toFixed(3)})`)
          .join("\n");
        content.push({
          type: "text" as const,
          text: warning + "\nYenisi bunlardan birini güncelliyorsa memory_update ile birleştir, bu kaydı memory_delete ile geri al.",
        });
      }
      if (args.body.length > 1500) {
        content.push({
          type: "text" as const,
          text: "ℹ Gövde 1500 karakteri aşıyor — bu bir doküman/talimat ise rag_add daha uygun (memory kısa ve öz kalmalı).",
        });
      }
      return { content };
    }
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
        importance: z
          .number()
          .min(0.5)
          .max(2)
          .optional()
          .describe("önem çarpanı; 2=kritik karar, 1=normal, 0.5=önemsiz detay"),
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
        "Bir metni/dokümanı RAG arşivine ekler (otomatik chunk + embed). Öğrenme notları, araştırma özetleri, önemli dokümanlar için. Aynı uri ile tekrar çağrılırsa re-index eder. Öğrenme notlarında project='learning' ve uri 'learning/<slug>' ver — web arayüzü Öğrenme sekmesinde bu projeyi listeler (uri 'learning/' ile başlayıp project verilmezse otomatik 'learning' atanır). PDF/DOCX gibi binary dosyaları buraya elle taşıma: `curl -X POST -H 'Authorization: Bearer <token>' --data-binary @dosya.pdf '<hub-url>/api/rag/upload?filename=dosya.pdf&title=...&project=...'` ile yükle veya `hub index dosya.pdf` kullan — sunucu parse edip indeksler (taranmış PDF'te metin çıkmazsa hata döner; o zaman vision/OCR ile okuyup rag_add çağır).",
      inputSchema: {
        title: z.string(),
        text: z.string().describe("Markdown içerik"),
        uri: z.string().optional().describe("Tekil kimlik (dosya yolu/URL) — re-index için; öğrenme notlarında 'learning/<slug>'"),
        project: z.string().optional().describe("İlgili proje; öğrenme notlarında 'learning'"),
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
    "project_delete",
    {
      title: "Projeyi sil",
      description: "Bir proje map'ini kalıcı siler (tombstone ile tüm cihazlara yayılır). Sadece kullanıcı isterse çağır.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => json({ deleted: deleteProject(name) })
  );

  server.registerTool(
    "skill_list",
    {
      title: "Skilleri listele",
      description: "Hub'daki agent skillerini (ad + açıklama) listeler.",
      inputSchema: {},
    },
    async () => json(listSkills().map(({ name, description }) => ({ name, description })))
  );

  server.registerTool(
    "skill_save",
    {
      title: "Skill oluştur/güncelle",
      description:
        "skills/<ad>/SKILL.md yazar — AI ile yeni skill üretmek için kullan. İçerik SKILL.md formatında olmalı: '---\\nname: <ad>\\ndescription: <ne zaman kullanılacağı>\\n---' frontmatter + markdown gövde (adımlar, kurallar, örnekler). Cihazlara dağıtım: git commit + her cihazda `hub sync`.",
      inputSchema: {
        name: z.string().describe("kebab-case skill adı"),
        content: z.string().describe("SKILL.md tam içeriği (frontmatter dahil)"),
      },
    },
    async ({ name, content }) => json(saveSkill(name, content))
  );

  server.registerTool(
    "session_log",
    {
      title: "Oturum özeti kaydet",
      description:
        "Oturum sonunda ne yapıldığını kaydeder: bitirilenler, yarım kalanlar, sıradaki adım. Bir sonraki oturum (hangi cihazda olursa olsun) buradan devam eder. Proje odağı değiştiyse project_update ile current_focus/next_steps'i de güncelle — bayat map bir sonraki agent'ı yanlış yönlendirir.",
      inputSchema: {
        summary: z.string().describe("Markdown özet: yapılanlar, yarım kalanlar, sıradaki adım"),
        project: z.string().optional().describe("project_list'teki kanonik proje adı"),
        source: z.string().optional(),
      },
    },
    async ({ summary, project, source }) => {
      const log = addSessionLog(summary, project, source);
      if (project && !getProject(project)) {
        return json({
          ...log,
          uyari: `'${project}' adında proje map'i YOK — log kaydedildi ama proje bağlamına bağlanamaz. Ad yanlışsa doğrusuyla tekrar dene; proje yeniyse project_update ile map aç. Mevcut projeler: ${listProjects()
            .map((p) => p.name)
            .join(", ")}`,
        });
      }
      return json(log);
    }
  );

  server.registerTool(
    "recall",
    {
      title: "İlgili hafızayı çek",
      description:
        "Bir mesaj/görev için ilgili hafıza kayıtlarını ve doküman parçalarını tek çağrıda döner (hibrit arama + hassasiyet filtresi: az ve isabetli). Göreve başlarken çağır; boş dönerse 'kayıt yok' demek değildir — geniş arama için memory_search/rag_search kullan.",
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

  server.registerTool(
    "machine_status",
    {
      title: "Makine/servis durumu",
      description:
        "Kayıtlı makinelerdeki yerel AI servislerinin (LM Studio, Ollama, ComfyUI) canlı durumunu ve yüklü modelleri döner. local_llm veya media_generate çağırmadan önce buradan kontrol et.",
      inputSchema: {},
    },
    async () => json(await machinesStatus())
  );

  server.registerTool(
    "machine_register",
    {
      title: "Makine kaydet",
      description: "Yerel AI servisi olan bir makineyi kaydeder/günceller (host: Tailscale IP veya 127.0.0.1).",
      inputSchema: {
        name: z.string(),
        host: z.string().describe("Tailscale IP (100.x.x.x) veya hostname"),
        lmstudio_port: z.number().int().optional().describe("LM Studio API portu (genelde 1234)"),
        ollama_port: z.number().int().optional().describe("Ollama API portu (genelde 11434)"),
        comfyui_port: z.number().int().optional().describe("ComfyUI portu (genelde 8188)"),
        notes: z.string().optional(),
      },
    },
    async (args) => json(upsertMachine({
      name: args.name,
      host: args.host,
      lmstudio_port: args.lmstudio_port ?? null,
      ollama_port: args.ollama_port ?? null,
      comfyui_port: args.comfyui_port ?? null,
      notes: args.notes ?? null,
    }))
  );

  server.registerTool(
    "local_llm",
    {
      title: "Yerel LLM çalıştır",
      description:
        "Fatih'in makinesindeki yerel modelle (LM Studio veya Ollama) üretim yapar (API maliyeti yok). Basit işler için uygun: özetleme, sınıflandırma, taslak, veri dönüştürme. Model belirtilmezse yüklü ilk model, backend belirtilmezse LM Studio öncelikli kullanılır.",
      inputSchema: {
        prompt: z.string().describe("Kullanıcı mesajı (messages yerine kısayol)"),
        machine: z.string().optional(),
        backend: z.enum(["lmstudio", "ollama"]).optional().describe("Yerel LLM backend'i; boşsa LM Studio öncelikli"),
        model: z.string().optional(),
        system: z.string().optional().describe("System prompt"),
        temperature: z.number().min(0).max(2).optional(),
        max_tokens: z.number().int().optional(),
      },
    },
    async ({ prompt, system, ...rest }) =>
      json(await localLlm({
        ...rest,
        messages: system
          ? [{ role: "system", content: system }, { role: "user", content: prompt }]
          : [{ role: "user", content: prompt }],
      }))
  );

  server.registerTool(
    "workflow_list",
    {
      title: "ComfyUI workflow listesi",
      description: "Kullanılabilir görsel üretim workflowlarını listeler (repo'daki workflows/*.json).",
      inputSchema: {},
    },
    async () => json(listWorkflows())
  );

  server.registerTool(
    "media_generate",
    {
      title: "Medya üret (ComfyUI): görsel/video/ses/3D",
      description:
        "Fatih'in PC'sindeki ComfyUI ile görsel, video, ses veya 3D üretir. workflow: workflows/ klasöründeki isim (workflow_list ile gör; isim türü söyler: *-t2i görsel, *-t2v/*-i2v video, *-audio ses); inputs: workflow'daki {{placeholder}} değerleri (örn. prompt, negative, width, height, seed). Üretilen dosya yolları ve /outputs URL'leri döner. Video/3D dakikalar sürebilir — timeoutSec'i yüksek tut (600+).",
      inputSchema: {
        workflow: z.string(),
        inputs: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        machine: z.string().optional(),
        timeoutSec: z.number().int().optional(),
      },
    },
    async (args) => json(await generateImage(args))
  );

  return server;
}
