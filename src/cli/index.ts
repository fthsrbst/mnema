#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { api, loadCliConfig, saveCliConfig } from "./client.js";
import { sync } from "./sync.js";
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
      try {
        const stdin = fs.readFileSync(0, "utf8");
        const parsed = JSON.parse(stdin) as { prompt?: string };
        query = parsed.prompt ?? "";
      } catch {
        process.exit(0);
      }
      // Kısa mesajlar ve slash komutları için arama yapma
      if (query.trim().length < 8 || query.trim().startsWith("/")) process.exit(0);
      try {
        const text = await api<string>(
          "GET",
          `/api/recall?q=${encodeURIComponent(query)}&format=text`,
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

function collectFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const out: string[] = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (INDEXABLE.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

program
  .command("index <paths...>")
  .description("Dosya/klasörleri RAG'e indeksle (.md .txt .mdx .rst .adoc)")
  .option("-p, --project <name>")
  .action(async (paths: string[], opts: { project?: string }) => {
    try {
      const files = paths.flatMap((p) => collectFiles(path.resolve(p)));
      if (files.length === 0) return console.log("indekslenecek dosya yok");
      for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        const res = await api<{ document_id: number; chunk_count: number; embedded: boolean }>(
          "POST",
          "/api/rag/documents",
          { title: path.basename(file), text, uri: file, project: opts.project, source: "hub-cli" }
        );
        console.log(`${file} → doc #${res.document_id} (${res.chunk_count} chunk${res.embedded ? ", embed edildi" : ", FTS-only"})`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("sync")
  .description("skills/ → ~/.claude/skills + CLAUDE.md yönetilen blok senkronu")
  .action(() => {
    try {
      const res = sync();
      console.log(`skiller kopyalandı: ${res.skillsCopied.join(", ") || "(yok)"}`);
      console.log(`CLAUDE.md güncellendi: ${res.claudeMdUpdated}`);
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

program.parseAsync(process.argv);
