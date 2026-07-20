#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { api, apiUpload, loadCliConfig, saveCliConfig } from "./client.js";
import { sync } from "./sync.js";
import { connectAgents, detectAgents, printAgentsTable } from "./agents.js";
import type { Memory, ProjectMap, ScoredChunk, ScoredMemory, SessionLog } from "../core/types.js";

const program = new Command();
program.name("hub").description("AI Hub — ortak hafıza, RAG ve proje mapleri").version("0.1.0");

function fail(err: unknown): never {
  console.error(`hata: ${(err as Error).message}`);
  process.exit(1);
}

program
  .command("config")
  .description("İstemci ayarları: hub config set <key> <value> | hub config show")
  .argument("[action]", "set | show", "show")
  .argument("[key]")
  .argument("[value]")
  .action((action: string, key?: string, value?: string) => {
    if (action === "set" && key && value !== undefined) {
      console.log(JSON.stringify(saveCliConfig({ [key]: value }), null, 2));
    } else {
      console.log(JSON.stringify(loadCliConfig(), null, 2));
    }
  });

program
  .command("search <query...>")
  .description("Hafıza + doküman arşivinde hibrit arama")
  .option("-p, --project <name>")
  .option("-n, --limit <n>", "sonuç sayısı", "8")
  .action(async (words: string[], opts: { project?: string; limit: string }) => {
    const q = encodeURIComponent(words.join(" "));
    const proj = opts.project ? `&project=${encodeURIComponent(opts.project)}` : "";
    try {
      const [mems, chunks] = await Promise.all([
        api<ScoredMemory[]>("GET", `/api/memory/search?q=${q}${proj}&limit=${opts.limit}`),
        api<ScoredChunk[]>("GET", `/api/rag/search?q=${q}${proj}&limit=${opts.limit}`),
      ]);
      if (mems.length === 0 && chunks.length === 0) return console.log("sonuç yok");
      for (const m of mems)
        console.log(`[memory #${m.id} | ${m.type}${m.project ? ` | ${m.project}` : ""}] ${m.title}\n  ${m.body.slice(0, 200).replaceAll("\n", " ")}\n`);
      for (const c of chunks)
        console.log(`[doc "${c.document_title}"${c.heading ? ` > ${c.heading}` : ""}]\n  ${c.text.slice(0, 200).replaceAll("\n", " ")}\n`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("remember <text...>")
  .description("Hızlı not → hafıza")
  .option("-t, --title <title>")
  .option("--type <type>", "fact|preference|decision|howto|context", "fact")
  .option("-p, --project <name>")
  .action(async (words: string[], opts: { title?: string; type: string; project?: string }) => {
    const body = words.join(" ");
    try {
      const mem = await api<Memory>("POST", "/api/memory", {
        title: opts.title ?? body.slice(0, 60),
        body,
        type: opts.type,
        project: opts.project,
        source: "hub-cli",
      });
      console.log(`kaydedildi: memory #${mem.id}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("recall [text...]")
  .description("Bir metin için ilgili hafızayı döner. --hook: UserPromptSubmit için stdin JSON okur")
  .option("--hook", "Claude Code hook modu (stdin JSON, sessiz hata)")
  .option("-p, --project <name>")
  .action(async (words: string[] | undefined, opts: { hook?: boolean; project?: string }) => {
    let query = (words ?? []).join(" ");
    if (opts.hook) {
      let cwd = "";
      try {
        const stdin = fs.readFileSync(0, "utf8");
        const parsed = JSON.parse(stdin) as { prompt?: string; cwd?: string };
        query = parsed.prompt ?? "";
        cwd = parsed.cwd ?? "";
      } catch {
        process.exit(0);
      }
      // Kısa mesajlar ve slash komutları için arama yapma
      if (query.trim().length < 8 || query.trim().startsWith("/")) process.exit(0);
      try {
        const cwdParam = cwd ? `&cwd=${encodeURIComponent(cwd)}` : "";
        const text = await api<string>(
          "GET",
          `/api/recall?q=${encodeURIComponent(query)}${cwdParam}&format=text`,
          undefined,
          { timeoutMs: 2500 }
        );
        if (text.trim()) console.log(text);
      } catch {
        /* hub kapalıysa prompt'u bloklama */
      }
      process.exit(0);
    }
    if (!query) return console.log("kullanım: hub recall <metin>");
    try {
      const proj = opts.project ? `&project=${encodeURIComponent(opts.project)}` : "";
      console.log(await api<string>("GET", `/api/recall?q=${encodeURIComponent(query)}${proj}&format=text`));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("bridge")
  .description("Oturum köprüsü: aktif projenin map'i + son oturum özeti. --hook: SessionStart için stdin JSON okur")
  .option("--hook", "Claude Code hook modu (stdin JSON, sessiz hata)")
  .option("-p, --project <name>")
  .action(async (opts: { hook?: boolean; project?: string }) => {
    let cwd = process.cwd();
    let project = opts.project ?? "";
    if (opts.hook) {
      try {
        const stdin = fs.readFileSync(0, "utf8");
        const parsed = JSON.parse(stdin) as { cwd?: string };
        cwd = parsed.cwd ?? cwd;
      } catch {
        process.exit(0);
      }
      try {
        const proj = project ? `&project=${encodeURIComponent(project)}` : "";
        const text = await api<string>(
          "GET",
          `/api/bridge?cwd=${encodeURIComponent(cwd)}${proj}`,
          undefined,
          { timeoutMs: 2500 }
        );
        if (text.trim()) console.log(text);
      } catch {
        /* hub kapalıysa oturumu bloklama */
      }
      process.exit(0);
    }
    try {
      const proj = project ? `&project=${encodeURIComponent(project)}` : "";
      console.log(await api<string>("GET", `/api/bridge?cwd=${encodeURIComponent(cwd)}${proj}`) || "(köprü boş: cwd bir proje map'ine çözülemedi)");
    } catch (err) {
      fail(err);
    }
  });

program
  .command("projects")
  .description("Proje durum tablosu")
  .action(async () => {
    try {
      const projects = await api<ProjectMap[]>("GET", "/api/projects");
      if (projects.length === 0) return console.log("kayıtlı proje yok");
      for (const p of projects)
        console.log(`${(p.status ?? "?").padEnd(7)} ${p.name.padEnd(24)} ${p.current_focus ?? p.summary ?? ""}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("project <name>")
  .description("Tek projenin tam map'i")
  .action(async (name: string) => {
    try {
      console.log(JSON.stringify(await api("GET", `/api/projects/${encodeURIComponent(name)}`), null, 2));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("log <summary...>")
  .description("Oturum özeti kaydet")
  .option("-p, --project <name>")
  .action(async (words: string[], opts: { project?: string }) => {
    try {
      const log = await api<SessionLog>("POST", "/api/sessions", {
        summary: words.join(" "),
        project: opts.project,
        source: "hub-cli",
      });
      console.log(`kaydedildi: session #${log.id}`);
    } catch (err) {
      fail(err);
    }
  });

const INDEXABLE = new Set([".md", ".txt", ".mdx", ".rst", ".adoc"]);
// Binary formatlar sunucuda parse edilir (/api/rag/upload) — metin dosyaları JSON ile gider.
const BINARY_INDEXABLE = new Set([".pdf", ".docx"]);

function collectFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const out: string[] = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (
      INDEXABLE.has(path.extname(entry.name).toLowerCase()) ||
      BINARY_INDEXABLE.has(path.extname(entry.name).toLowerCase())
    )
      out.push(full);
  }
  return out;
}

program
  .command("index <paths...>")
  .description("Dosya/klasörleri RAG'e indeksle (.md .txt .mdx .rst .adoc + .pdf .docx)")
  .option("-p, --project <name>")
  .action(async (paths: string[], opts: { project?: string }) => {
    try {
      const files = paths.flatMap((p) => collectFiles(path.resolve(p)));
      if (files.length === 0) return console.log("indekslenecek dosya yok");
      for (const file of files) {
        const name = path.basename(file);
        let res: { document_id: number; chunk_count: number; embedded: boolean };
        if (BINARY_INDEXABLE.has(path.extname(file).toLowerCase())) {
          const q = new URLSearchParams({ filename: name, title: name, uri: file });
          if (opts.project) q.set("project", opts.project);
          res = await apiUpload(`/api/rag/upload?${q}`, fs.readFileSync(file));
        } else {
          const text = fs.readFileSync(file, "utf8");
          res = await api(
            "POST",
            "/api/rag/documents",
            { title: name, text, uri: file, project: opts.project, source: "hub-cli" }
          );
        }
        console.log(`${file} → doc #${res.document_id} (${res.chunk_count} chunk${res.embedded ? ", embed edildi" : ", FTS-only"})`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("sync")
  .description("~/.claude/skills materyalizasyonu (hub DB'den) + CLAUDE.md yönetilen blok senkronu")
  .action(async () => {
    try {
      const res = await sync();
      console.log(`skiller yazıldı: ${res.skillsCopied.join(", ") || "(yok)"}`);
      if (res.skillsRemoved.length) console.log(`skiller kaldırıldı (hub'dan silinmiş): ${res.skillsRemoved.join(", ")}`);
      if (res.skillsSyncError) console.log(`uyarı: skill materyalizasyonu atlandı (sunucuya ulaşılamadı): ${res.skillsSyncError}`);
      console.log(`CLAUDE.md güncellendi: ${res.claudeMdUpdated}`);
      console.log(`MCP konfigleri: ${res.mcpUpdated.length ? res.mcpUpdated.join(", ") + " güncellendi" : "değişiklik yok"}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("agents [action]")
  .description("Kurulu AI agent uygulamalarını tespit et / hub'a bağla: hub agents [detect|connect]")
  .action(async (action: string = "detect") => {
    try {
      if (action === "connect") {
        const res = await connectAgents();
        printAgentsTable(detectAgents());
        if (res.syncResult) {
          console.log(`\nskiller yazıldı: ${res.syncResult.skillsCopied.join(", ") || "(yok)"}`);
          if (res.syncResult.skillsRemoved.length) console.log(`skiller kaldırıldı: ${res.syncResult.skillsRemoved.join(", ")}`);
          if (res.syncResult.skillsSyncError) console.log(`uyarı: skill materyalizasyonu atlandı: ${res.syncResult.skillsSyncError}`);
          console.log(`CLAUDE.md güncellendi: ${res.syncResult.claudeMdUpdated}`);
          console.log(
            `MCP konfigleri (sync): ${res.syncResult.mcpUpdated.length ? res.syncResult.mcpUpdated.join(", ") + " güncellendi" : "değişiklik yok"}`
          );
        }
        console.log(
          `MCP konfigleri (ek): ${res.extrasUpdated.length ? res.extrasUpdated.join(", ") + " güncellendi" : "değişiklik yok"}`
        );
        return;
      }
      if (action !== "detect") return console.log("kullanım: hub agents [detect|connect]");
      printAgentsTable(detectAgents());
    } catch (err) {
      fail(err);
    }
  });

program
  .command("ask <question...>")
  .description("Hafıza + RAG bağlamıyla yerel LLM'den cevap (tamamen ücretsiz, lokal)")
  .option("-m, --model <model>")
  .option("-p, --project <name>")
  .action(async (words: string[], opts: { model?: string; project?: string }) => {
    const question = words.join(" ");
    try {
      const proj = opts.project ? `&project=${encodeURIComponent(opts.project)}` : "";
      const ctx = await api<{ memories: ScoredMemory[]; chunks: ScoredChunk[] }>(
        "GET", `/api/recall?q=${encodeURIComponent(question)}${proj}`
      );
      const ctxText = [
        ...ctx.memories.map((m) => `[hafıza/${m.type}] ${m.title}: ${m.body}`),
        ...ctx.chunks.map((c) => `[doküman "${c.document_title}"] ${c.text}`),
      ].join("\n\n");
      const res = await api<{ machine: string; model: string; content: string }>(
        "POST", "/api/llm",
        {
          model: opts.model,
          messages: [
            {
              role: "system",
              content:
                "Kullanıcının kişisel bilgi asistanısın. Aşağıdaki bağlam onun ortak hafızasından geliyor; cevabını öncelikle buna dayandır, bağlamda yoksa bunu belirt. Türkçe ve öz cevap ver.\n\nBAĞLAM:\n" +
                (ctxText || "(ilgili kayıt bulunamadı)"),
            },
            { role: "user", content: question },
          ],
          max_tokens: 2048,
        },
        { timeoutMs: 180000 }
      );
      console.log(`[${res.machine} / ${res.model}]\n${res.content}`);
      if (ctx.memories.length || ctx.chunks.length) {
        console.log(`\n(bağlam: ${ctx.memories.length} hafıza + ${ctx.chunks.length} doküman parçası)`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("machines")
  .description("Kayıtlı makineler ve yerel AI servislerinin canlı durumu")
  .action(async () => {
    try {
      const machines = await api<{ name: string; host: string; lmstudio: { online: boolean; models: string[] }; ollama: { online: boolean; models: string[] }; comfyui: { online: boolean } }[]>("GET", "/api/machines/status");
      if (machines.length === 0) return console.log("kayıtlı makine yok");
      for (const m of machines) {
        console.log(`${m.name} (${m.host})`);
        console.log(`  LM Studio: ${m.lmstudio.online ? `açık — ${m.lmstudio.models.length} model` : "kapalı/tanımsız"}`);
        if (m.lmstudio.models.length) console.log(`    ${m.lmstudio.models.join("\n    ")}`);
        console.log(`  Ollama:    ${m.ollama?.online ? `açık — ${m.ollama.models.length} model` : "kapalı/tanımsız"}`);
        if (m.ollama?.models.length) console.log(`    ${m.ollama.models.join("\n    ")}`);
        console.log(`  ComfyUI:   ${m.comfyui.online ? "açık" : "kapalı/tanımsız"}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("llm <prompt...>")
  .description("Yerel modelle üretim — LM Studio veya Ollama (API maliyeti yok)")
  .option("-m, --model <model>")
  .option("--machine <name>")
  .option("--backend <backend>", "lmstudio | ollama (boşsa LM Studio öncelikli)")
  .action(async (words: string[], opts: { model?: string; machine?: string; backend?: string }) => {
    try {
      const res = await api<{ machine: string; model: string; content: string }>(
        "POST", "/api/llm",
        { prompt: words.join(" "), model: opts.model, machine: opts.machine, backend: opts.backend },
        { timeoutMs: 180000 }
      );
      console.log(`[${res.machine} / ${res.model}]\n${res.content}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("status")
  .description("Sunucu sağlığı")
  .action(async () => {
    try {
      console.log(JSON.stringify(await api("GET", "/health"), null, 2));
    } catch (err) {
      fail(err);
    }
  });

// --- Agent Intelligence Platform CLI ---

program
  .command("tasks [project]")
  .description("Görev kuyruğunu listele")
  .option("-s, --status <status>", "pending|claimed|in_progress|blocked|done|cancelled")
  .action(async (project: string | undefined, opts: { status?: string }) => {
    try {
      const params = new URLSearchParams();
      if (project) params.set("project", project);
      if (opts.status) params.set("status", opts.status);
      const qs = params.toString();
      const tasks = await api<{ uid: string; title: string; status: string; priority: number; claimed_by: string | null; project: string | null }[]>(
        "GET", `/api/tasks${qs ? `?${qs}` : ""}`
      );
      if (tasks.length === 0) return console.log("görev yok");
      for (const t of tasks) {
        const status = t.status.padEnd(12);
        const prio = String(t.priority).padStart(2);
        const agent = t.claimed_by ?? "—";
        const proj = t.project ?? "";
        console.log(`[${status}] P${prio} ${t.title} ${proj ? `(${proj})` : ""} → ${agent}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("task <action> [title...]")
  .description("Görev oluştur/tamamla: hub task create \"başlık\" | hub task done <uid>")
  .option("-p, --project <name>")
  .option("--priority <n>", "öncelik", "0")
  .option("--agent <name>", "claim eden agent")
  .action(async (action: string, words: string[] | undefined, opts: { project?: string; priority: string; agent?: string }) => {
    try {
      if (action === "create") {
        const title = (words ?? []).join(" ");
        if (!title) return console.log("kullanım: hub task create \"başlık\" --project X");
        const task = await api<{ uid: string }>("POST", "/api/tasks", {
          title,
          project: opts.project,
          priority: Number(opts.priority) || 0,
          created_by: "hub-cli",
        });
        console.log(`oluşturuldu: ${task.uid}`);
      } else if (action === "done" || action === "complete") {
        const uid = (words ?? [])[0];
        if (!uid) return console.log("kullanım: hub task done <uid>");
        await api("POST", `/api/tasks/${uid}/complete`, {});
        console.log(`tamamlandı: ${uid}`);
      } else if (action === "claim") {
        const uid = (words ?? [])[0];
        if (!uid) return console.log("kullanım: hub task claim <uid> --agent X");
        await api("POST", `/api/tasks/${uid}/claim`, { agent: opts.agent ?? "hub-cli" });
        console.log(`claim edildi: ${uid}`);
      } else {
        console.log("kullanım: hub task <create|done|claim> ...");
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("hygiene")
  .description("Bellek hijyen raporu")
  .option("--run", "otomatik temizlik çalıştır")
  .action(async (opts: { run?: boolean }) => {
    try {
      if (opts.run) {
        const res = await api<{ archived: number; consolidated: number }>("POST", "/api/hygiene/run");
        console.log(`arşivlenen: ${res.archived}, birleştirilen: ${res.consolidated}`);
      } else {
        const report = await api<{ duplicates: { count: number }; stale: { count: number }; contradictions: { count: number }; suggestions: string[] }>("GET", "/api/hygiene");
        console.log(`Tekrarlar: ${report.duplicates.count}`);
        console.log(`Eskiler: ${report.stale.count}`);
        console.log(`Çelişkiler: ${report.contradictions.count}`);
        if (report.suggestions.length) {
          console.log("\nÖneriler:");
          for (const s of report.suggestions) console.log(`  • ${s}`);
        }
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("compact <project>")
  .description("Proje bilgisini sıkıştır (oturumlar + kararlar → özet doküman)")
  .option("--full", "tam distill (hafızalar dahil)")
  .action(async (project: string, opts: { full?: boolean }) => {
    try {
      const endpoint = opts.full ? "/api/compact" : "/api/compact";
      const res = await api<{ document_uid: string; sessions_compacted?: number }>("POST", endpoint, {
        project,
        mode: opts.full ? "distill" : "sessions",
      });
      console.log(`sıkıştırıldı: ${res.document_uid}${res.sessions_compacted ? ` (${res.sessions_compacted} oturum)` : ""}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("registered-agents")
  .description("Kayıtlı agent yetenekleri")
  .action(async () => {
    try {
      const agents = await api<{ agent: string; machine: string | null; capabilities: string[]; status: string; last_seen_at: string | null }[]>("GET", "/api/agents");
      if (agents.length === 0) return console.log("kayıtlı agent yok");
      for (const a of agents) {
        const caps = a.capabilities.join(", ") || "—";
        console.log(`${a.agent} (${a.machine ?? "?"}) [${a.status}] — ${caps}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync(process.argv);
