import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addDocument,
  addRecallFeedback,
  addSessionLog,
  generateImage,
  listWorkflows,
  localLlm,
  machinesStatus,
  upsertMachine,
  appendToProject,
  composePrompt,
  consolidateMemories,
  contextGet,
  graphNeighbors,
  graphNode,
  deleteMemory,
  deleteMemoryRelation,
  deleteProject,
  detachProjectReferences,
  listPrompts,
  knowledgeIntegrity,
  listAuditEvents,
  listSkills,
  saveSkill,
  getProject,
  getProfessionalProfile,
  listProjects,
  listMemoryRelations,
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
  type MemoryType,
  type ProjectMap,
  type GraphNodeKind,
  migrateProjectReferences,
  verifyAuditChain,
  flushVectorOutbox,
  queueFullVectorProjection,
  vectorStore,
  verifyVectorProjectionParity,
  contextGetSchema,
  professionalProfileInputSchema,
  documentInputSchema,
  feedbackInputBaseSchema,
  memoryInputBaseSchema,
  memoryConsolidateBaseSchema,
  memoryPatchBaseSchema,
  memoryTypeSchema,
  memoryRelationInputBaseSchema,
  memoryRelationPatchBaseSchema,
  memoryRelationTypeSchema,
  sessionInputSchema,
} from "../core/index.js";

const memoryType = memoryTypeSchema;

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "ai-hub", version: "0.1.0" });

  server.registerTool(
    "integrity_check",
    {
      title: "Check knowledge-base integrity",
      description:
        "Read-only operational audit for unknown project references, document lifecycle conflicts, missing/orphan vectors, duplicate URIs, invalid JSON metadata, and dangling relations. Run before strict-project enforcement, migrations, reindexing, or deployment.",
      inputSchema: {},
    },
    async () => json(knowledgeIntegrity())
  );

  server.registerTool(
    "vector_projection_status",
    {
      title: "Inspect vector projection health",
      description: "Read the active vector backend, local generation readiness, and durable external-projection outbox depth.",
      inputSchema: {},
    },
    async () => json(vectorStore.status())
  );

  server.registerTool(
    "vector_projection_rebuild",
    {
      title: "Queue a full external vector projection rebuild",
      description:
        "Administrative recovery/migration operation. Queue every authoritative local memory and chunk vector for idempotent delivery to the configured external backend. This does not delete SQLite data.",
      inputSchema: {},
    },
    async () => json({ queued: queueFullVectorProjection(), status: vectorStore.status() })
  );

  server.registerTool(
    "vector_projection_verify",
    {
      title: "Verify external vector projection parity",
      description: "Compare exact authoritative sqlite-vec counts with the active Qdrant generation and require a ready, empty outbox. Run before/after cutover and restore drills.",
      inputSchema: {},
    },
    async () => json(await verifyVectorProjectionParity())
  );

  server.registerTool(
    "vector_projection_flush",
    {
      title: "Flush external vector projection outbox",
      description: "Attempt one bounded delivery batch now. Failed rows remain durable and receive exponential backoff.",
      inputSchema: { limit: z.number().int().min(1).max(1000).optional() },
    },
    async ({ limit }) => json({ result: await flushVectorOutbox(limit), status: vectorStore.status() })
  );

  server.registerTool(
    "audit_list",
    {
      title: "List security audit events",
      description:
        "Read redacted, node-local request audit events. Prompts, tokens, request bodies, and document text are never stored in this log.",
      inputSchema: {
        actor: z.string().max(100).optional(),
        action: z.string().max(500).optional(),
        project: z.string().max(100).optional(),
        before: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async (args) => json(listAuditEvents(args))
  );

  server.registerTool(
    "audit_verify",
    {
      title: "Verify the audit hash chain",
      description: "Verify that the node-local audit event chain has not been modified or reordered.",
      inputSchema: {},
    },
    async () => json(verifyAuditChain())
  );

  server.registerTool(
    "context_get",
    {
      title: "Get authoritative agent context",
      description:
        "Preferred context entry point for a task. The server combines the current project map, latest session, durable memories, and RAG evidence with intent-aware authority ordering, provenance, an explicit untrusted-evidence policy, and a token budget. Use this instead of manually concatenating recall/project/session results. For current status or 'where did we leave off', pass the canonical project and use intent='current_status'; project map and latest session outrank semantic matches.",
      inputSchema: contextGetSchema.omit({ cwd: true, record_usage: true }).shape,
    },
    async (args) => json(await contextGet(args))
  );

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
      inputSchema: memoryInputBaseSchema.shape,
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
      inputSchema: { id: z.number().int().positive(), ...memoryPatchBaseSchema.shape },
    },
    async ({ id, ...patch }) => {
      const updated = await updateMemory(id, patch);
      return updated ? json(updated) : json({ error: `memory #${id} bulunamadı` });
    }
  );

  server.registerTool(
    "recall_feedback",
    {
      title: "Recall geri bildirimi",
      description:
        "context_get veya otomatik recall sonucunun isabetini ölçer. Memory, RAG chunk, document ya da tüm context hedeflenebilir; context_get çıktısındaki delivery_id, rank ve channels alanlarını geri gönder. Alakasız için noisy, eksik kanıt için missing, özellikle isabetli kanıt için helpful kullan. memory_id yalnızca eski istemciler için uyumluluk alanıdır.",
      inputSchema: feedbackInputBaseSchema.shape,
    },
    async (args) => json(addRecallFeedback(args))
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
        include_archived: z.boolean().optional().describe("Search archived/superseded documents too; defaults to false"),
        kind: z.enum(["reference", "status", "decision", "runbook", "research", "learning", "source"]).optional(),
      },
    },
    async ({ query, ...opts }) => json(await searchChunks(query, opts))
  );

  server.registerTool(
    "rag_add",
    {
      title: "Doküman indeksle",
      description:
        "Bir metni/dokümanı RAG arşivine ekler (otomatik chunk + embed). Öğrenme notları, araştırma özetleri, önemli dokümanlar için. Aynı uri ile tekrar çağrılırsa re-index eder — güncelleme İÇİN AYNI uri'yi kullan, v2/v3 diye yeni uri açıp eski sürümü arşivde bırakma. Proje dokümanlarında kanonik uri deseni: '<proje>/<kategori>/<ad>' (örn. voiceweb/architecture/system) ve project alanına project_list'teki adı ver. Öğrenme notlarında project='learning' ve uri 'learning/<slug>' ver — web arayüzü Öğrenme sekmesinde bu projeyi listeler (uri 'learning/' ile başlayıp project verilmezse otomatik 'learning' atanır). PDF/DOCX gibi binary dosyaları buraya elle taşıma: `curl -X POST -H 'Authorization: Bearer <token>' --data-binary @dosya.pdf '<hub-url>/api/rag/upload?filename=dosya.pdf&title=...&project=...'` ile yükle veya `hub index dosya.pdf` kullan — sunucu parse edip indeksler (taranmış PDF'te metin çıkmazsa hata döner; o zaman vision/OCR ile okuyup rag_add çağır).",
      inputSchema: documentInputSchema.shape,
    },
    async (args) => json(await addDocument(args))
  );

  server.registerTool(
    "project_migrate_references",
    {
      title: "Migrate project references",
      description:
        "Administrative integrity repair: atomically move memory, document, and session references from a stale/alias project name to an existing canonical project map, including vector partition metadata. Does not delete either project map.",
      inputSchema: {
        from: z.string().min(1).max(100),
        to: z.string().min(1).max(100),
      },
    },
    async ({ from, to }) => json(migrateProjectReferences(from, to))
  );

  server.registerTool(
    "memory_relation_add",
    {
      title: "Add a typed memory relation",
      description:
        "Create or upsert a directional, temporal knowledge-graph edge between two memories. Use related for a symmetric loose link; use supports, contradicts, supersedes, caused_by, derived_from, or applies_to when the semantics are known. valid_from/valid_to must be ISO timestamps. Do not invent relationships without evidence.",
      inputSchema: memoryRelationInputBaseSchema.shape,
    },
    async (args) => json(saveMemoryRelation(args))
  );

  server.registerTool(
    "memory_consolidate",
    {
      title: "Consolidate duplicate memories",
      description:
        "Explicitly merge duplicate source memories into a chosen target. You must provide a complete merged body; Mnema rewires typed/legacy relations and tombstones sources but never asks an LLM to destructively summarize them automatically. Review every source first.",
      inputSchema: memoryConsolidateBaseSchema.shape,
    },
    async (args) => json(await consolidateMemories(args))
  );

  server.registerTool(
    "memory_relation_list",
    {
      title: "List typed memory relations",
      description:
        "Inspect typed knowledge-graph edges, optionally around one local memory ID, by relation type, or active at a specific ISO timestamp.",
      inputSchema: {
        memory_id: z.number().int().positive().optional(),
        relation_type: memoryRelationTypeSchema.optional(),
        active_at: z.string().datetime({ offset: true }).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async (args) => json(listMemoryRelations(args))
  );

  server.registerTool(
    "memory_relation_update",
    {
      title: "Update a typed memory relation",
      description:
        "Update confidence, temporal validity, source, or metadata on a relation. To retire a fact without erasing history, set valid_to instead of deleting it.",
      inputSchema: { id: z.string().regex(/^[a-f0-9]{32}$/i), ...memoryRelationPatchBaseSchema.shape },
    },
    async ({ id, ...patch }) => {
      const relation = updateMemoryRelation(id, patch);
      return relation ? json(relation) : json({ error: `relation ${id} not found` });
    }
  );

  server.registerTool(
    "memory_relation_delete",
    {
      title: "Delete a typed memory relation",
      description: "Delete a provably incorrect relation. Prefer valid_to for relations that were historically true.",
      inputSchema: { id: z.string().regex(/^[a-f0-9]{32}$/i) },
    },
    async ({ id }) => json({ deleted: deleteMemoryRelation(id) })
  );

  const graphKind = z.enum(["project", "memory", "document", "session", "tag"]);
  server.registerTool(
    "graph_node",
    {
      title: "Get one knowledge-graph node",
      description: "Resolve a project, memory, document, session, or tag node and its degree without loading the graph.",
      inputSchema: { kind: graphKind, key: z.string().min(1).max(300) },
    },
    async ({ kind, key }) => json(graphNode(kind as GraphNodeKind, key))
  );

  server.registerTool(
    "graph_neighbors",
    {
      title: "Traverse knowledge-graph neighbors",
      description:
        "Page through immediate graph neighbors. Typed memory edges preserve direction, confidence, and validity; project/tag membership edges are navigational.",
      inputSchema: {
        kind: graphKind,
        key: z.string().min(1).max(300),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ kind, key, offset, limit }) => json(graphNeighbors(kind as GraphNodeKind, key, offset, limit))
  );

  server.registerTool(
    "profile_get",
    {
      title: "Get the canonical professional profile",
      description:
        "Return Fatih Serbest's global professional profile and its source-document metadata. This identity domain is not a project map. Use it for CV tailoring, introductions, job-fit analysis, and evidence-backed career claims.",
      inputSchema: {},
    },
    async () => json(getProfessionalProfile())
  );

  server.registerTool(
    "profile_update",
    {
      title: "Update the canonical professional profile",
      description:
        "Replace the canonical profile document while keeping source CVs unchanged. User-confirmed corrections outrank conflicting source fields; include provenance in the markdown.",
      inputSchema: professionalProfileInputSchema.shape,
    },
    async (args) => json(await upsertProfessionalProfile(args))
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
        "Bir projenin tam bağlamı: özet, stack, kararlar, mevcut odak, sıradaki adımlar + kod haritası (architecture, modules, entry_points, commands, conventions, data_model). Bir projede çalışmaya başlarken önce bunu çek; kod haritası boş/bayatsa keşfettiğini project_update ile yaz.",
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
        "Proje map'ini oluşturur/günceller (merge eder, silmez). Odak değişince, karar alınınca, adım tamamlanınca çağır. Kod haritasını da burada tut: bir projeyi keşfettiğinde (modül sınırları, giriş noktaları, komutlar) modules/architecture/entry_points alanlarını doldur — sonraki agent kodu yeniden keşfetmek zorunda kalmasın.",
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
        architecture: z.string().optional().describe("Mimarinin 3-5 cümlelik özeti: katmanlar, veri akışı, sınırlar"),
        modules: z
          .array(
            z.object({
              name: z.string().describe("Kısa modül adı, ör. 'core/search'"),
              path: z.string().describe("Repo köküne göre yol"),
              purpose: z.string().describe("Tek cümle: ne yapar, sınırı ne"),
              key_files: z.array(z.string()).optional().describe("Değişiklikte ilk bakılacak dosyalar"),
              depends_on: z.array(z.string()).optional().describe("Bağımlı olduğu modül adları"),
            })
          )
          .optional()
          .describe("Kod haritası modül dökümü — TAM liste (üzerine yazar)"),
        entry_points: z.record(z.string(), z.string()).optional().describe("Rol → dosya, ör. { server: 'src/server/index.ts' }"),
        commands: z.record(z.string(), z.string()).optional().describe("Ad → komut, ör. { dev: 'npm run dev' }"),
        conventions: z.array(z.string()).optional().describe("Koddan okunamayan yazılı kurallar (kısa maddeler)"),
        data_model: z.string().optional().describe("Ana tablolar/varlıklar ve ilişkilerinin kısa özeti"),
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
    "project_detach_references",
    {
      title: "Detach knowledge from a pseudo-project",
      description:
        "Administrative migration for a namespace that was incorrectly modeled as a project. Rewrites its memories, documents, sessions, and vector partitions to global scope; the project map remains until explicitly deleted.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => json(detachProjectReferences(name))
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
      inputSchema: sessionInputSchema.shape,
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
