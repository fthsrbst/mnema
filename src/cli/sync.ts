import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCliConfig } from "./client.js";

const BLOCK_START = "<!-- hub:start -->";
const BLOCK_END = "<!-- hub:end -->";

const CLAUDE_MD_BLOCK = `${BLOCK_START}
## AI Hub — ortak hafıza (otomatik yönetilen blok, elle düzenleme)

Tüm cihazlarda ortak bir hafıza/RAG/proje sunucusu var: **hub** MCP server'ı. Bağlam üç katmandır — otomatik gelen, görev başında çekilen, çalışırken yazılan:

**1. Otomatik gelen (okuman yeter):**
- \`<hub-bridge>\` (oturum başı): aktif projenin map'i + son oturum özeti. Kaldığın yeri buradan al; map bayatsa \`project_update\` ile düzelt.
- \`<hub-recall>\` (mesaj başı): mesajla yüksek benzerlikli az sayıda kayıt. Bilinçli dar tutulur; BOŞ olması "hafızada yok" demek değildir.

**2. Görev başında sen çek:**
- Bir projede çalışıyorsan ve bridge gelmediyse \`project_get(name)\` — özet, kararlar, odak, sıradaki adımlar.
- "Bunu daha önce nasıl çözmüştük / neden X kullanıyoruz" → \`memory_search\`; doküman/not arşivi → \`rag_search\`; "nerede kalmıştım" → \`session_recent\`.
- Ciddi mühendislik işinde \`prompt_get\` ile role uygun promptu çek (\`prompt_list\`: architect, code-reviewer, debugging, security, frontend, devops, ml). Alt modele iş devrederken (\`local_llm\` dahil) bunu system prompt yap.

**3. Çalışırken yaz (kalite kuralları):**
- Kaydet: teknik karar + GEREKÇE (\`memory_save\` type=decision), zor bug'ın kök nedeni (type=howto), kullanıcı tercihi (type=preference). Ölçüt: "başka cihazdaki agent 2 hafta sonra bundan faydalanır mı?"
- Kaydetme: oturuma özel detay, koddan/git'ten okunabilen şey, geçici durum. Uzun doküman/talimat/araştırma → memory değil \`rag_add\` (öğrenme notları: project='learning', uri='learning/<slug>').
- \`project\` alanı = \`project_list\`'teki kanonik ad; makine/cihaz adı proje DEĞİLDİR (tags kullan). importance=2 nadirdir; varsayılan 1 doğrudur.
- Yanlışlanan bilgiyi gördüğün an \`memory_update\`/\`memory_delete\` — çelişkili hafıza, hafızasızlıktan kötüdür.

**Oturum sonunda:** \`session_log\` (yapılanlar, yarım kalanlar, sıradaki adım) + odak değiştiyse \`project_update\` ile current_focus/next_steps. Map'i güncellemeden kapatma: bayat map bir sonraki agent'ı aktif olarak yanıltır (kanıt: jobpilot vakası).
${BLOCK_END}`;

export interface SyncResult {
  skillsCopied: string[];
  claudeMdUpdated: string;
  mcpUpdated: string[];
}

function upsertManagedBlock(filePath: string, block: string): void {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    /* dosya yok, oluşturulacak */
  }
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1) {
    content = content.slice(0, start) + block + content.slice(end + BLOCK_END.length);
  } else {
    content = content.trimEnd() + (content.trim() ? "\n\n" : "") + block + "\n";
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

interface McpEntry {
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
}

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * mcp-servers.json'daki kayıtları istemci konfiglerine dağıtır (merge — mevcut
 * diğer sunuculara dokunmaz). $HUB_URL/$HUB_TOKEN cihaz config'inden çözülür.
 */
function syncMcpServers(repoPath: string): string[] {
  const registryFile = path.join(repoPath, "mcp-servers.json");
  const registry = readJson(registryFile)?.servers as Record<string, McpEntry> | undefined;
  if (!registry) return [];

  const cfg = loadCliConfig();
  const resolve = (s: string) => s.replaceAll("$HUB_URL", cfg.url).replaceAll("$HUB_TOKEN", cfg.token);
  const servers = new Map<string, McpEntry>();
  for (const [name, entry] of Object.entries(registry)) {
    if (entry.command) {
      servers.set(name, { command: entry.command, args: entry.args ?? [] });
      continue;
    }
    if (!entry.url) continue;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.headers ?? {})) {
      const rv = resolve(v);
      // Token boşsa Authorization header'ı hiç koyma ("Bearer " tek başına 401 üretir)
      if (!/\$|Bearer\s*$/.test(rv)) headers[k] = rv;
    }
    servers.set(name, { url: resolve(entry.url), ...(Object.keys(headers).length ? { headers } : {}) });
  }

  const home = os.homedir();
  const updated: string[] = [];

  // Codex: ~/.codex/config.toml — [mcp_servers.*] yönetilen blok (# hub:start/end).
  // Codex remote HTTP MCP'yi doğrudan desteklemediği için mcp-remote stdio köprüsü kullanılır.
  const codexDir = path.join(home, ".codex");
  if (fs.existsSync(codexDir)) {
    const codexFile = path.join(codexDir, "config.toml");
    let toml = "";
    try {
      toml = fs.readFileSync(codexFile, "utf8");
    } catch {
      /* dosya yok, oluşturulacak */
    }
    const lines: string[] = ["# hub:start (otomatik yönetilen blok — hub sync)"];
    for (const [name, entry] of servers) {
      const args: string[] = entry.command
        ? [...(entry.args ?? [])]
        : ["-y", "mcp-remote", entry.url ?? ""];
      const cmd = entry.command ?? "npx";
      if (!entry.command) {
        const auth = entry.headers?.Authorization;
        if (auth) args.push("--header", `Authorization: ${auth}`);
      }
      lines.push(
        `[mcp_servers.${name.replace(/[^a-zA-Z0-9_-]/g, "_")}]`,
        `command = ${JSON.stringify(cmd)}`,
        `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`,
        ""
      );
    }
    lines.push("# hub:end");
    const block = lines.join("\n");
    const start = toml.indexOf("# hub:start");
    const end = toml.indexOf("# hub:end");
    const next =
      start !== -1 && end !== -1
        ? toml.slice(0, start) + block + toml.slice(end + "# hub:end".length)
        : toml.trimEnd() + (toml.trim() ? "\n\n" : "") + block + "\n";
    if (next !== toml) {
      fs.writeFileSync(codexFile, next);
      updated.push("codex");
    }
  }

  // Claude Code (user scope): ~/.claude.json → mcpServers
  const claudeFile = path.join(home, ".claude.json");
  const claude = readJson(claudeFile);
  if (claude) {
    let changed = false;
    claude.mcpServers ??= {};
    for (const [name, entry] of servers) {
      const desired = entry.command
        ? { type: "stdio", command: entry.command, args: entry.args, env: {} }
        : { type: "http", ...entry };
      if (JSON.stringify(claude.mcpServers[name]) !== JSON.stringify(desired)) {
        claude.mcpServers[name] = desired;
        changed = true;
      }
    }
    if (changed) {
      writeJson(claudeFile, claude);
      updated.push("claude-code");
    }
  }

  // Cursor: ~/.cursor/mcp.json
  const cursorFile = path.join(home, ".cursor", "mcp.json");
  if (fs.existsSync(path.join(home, ".cursor")) || fs.existsSync(cursorFile)) {
    const cursor = readJson(cursorFile) ?? {};
    cursor.mcpServers ??= {};
    let changed = false;
    for (const [name, entry] of servers) {
      const desired = entry.command ? { command: entry.command, args: entry.args } : entry;
      if (JSON.stringify(cursor.mcpServers[name]) !== JSON.stringify(desired)) {
        cursor.mcpServers[name] = desired;
        changed = true;
      }
    }
    if (changed) {
      writeJson(cursorFile, cursor);
      updated.push("cursor");
    }
  }

  // opencode: ~/.config/opencode/opencode.json
  const opencodeFile = path.join(home, ".config", "opencode", "opencode.json");
  if (fs.existsSync(path.join(home, ".config", "opencode")) || fs.existsSync(opencodeFile)) {
    const oc = readJson(opencodeFile) ?? { $schema: "https://opencode.ai/config.json" };
    oc.mcp ??= {};
    let changed = false;
    for (const [name, entry] of servers) {
      const desired = entry.command
        ? { type: "local", command: [entry.command, ...(entry.args ?? [])], enabled: true }
        : { type: "remote", url: entry.url, enabled: true, ...(entry.headers ? { headers: entry.headers } : {}) };
      if (JSON.stringify(oc.mcp[name]) !== JSON.stringify(desired)) {
        oc.mcp[name] = desired;
        changed = true;
      }
    }
    if (changed) {
      writeJson(opencodeFile, oc);
      updated.push("opencode");
    }
  }

  return updated;
}

/** skills/ → ~/.claude/skills/ kopyalar, CLAUDE.md yönetilen bloğu ve MCP konfiglerini günceller. */
export function sync(): SyncResult {
  const cfg = loadCliConfig();
  if (!cfg.repoPath) {
    throw new Error(
      "repoPath ayarlı değil. Önce: hub config set repoPath <ai-hub repo klasörü>"
    );
  }
  const skillsSrc = path.join(cfg.repoPath, "skills");
  const skillsDest = path.join(os.homedir(), ".claude", "skills");
  const copied: string[] = [];
  if (fs.existsSync(skillsSrc)) {
    for (const entry of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      copyDir(path.join(skillsSrc, entry.name), path.join(skillsDest, entry.name));
      copied.push(entry.name);
    }
  }

  const claudeMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
  upsertManagedBlock(claudeMd, CLAUDE_MD_BLOCK);

  // Aynı kurallar diğer istemcilerin kural dosyalarına — session_log/memory_save
  // disiplini sadece Claude Code'da kalmasın (opencode AGENTS.md, Codex AGENTS.md)
  const home = os.homedir();
  for (const rulesFile of [
    path.join(home, ".config", "opencode", "AGENTS.md"),
    path.join(home, ".codex", "AGENTS.md"),
  ]) {
    if (fs.existsSync(path.dirname(rulesFile))) upsertManagedBlock(rulesFile, CLAUDE_MD_BLOCK);
  }

  const mcpUpdated = syncMcpServers(cfg.repoPath);

  return { skillsCopied: copied, claudeMdUpdated: claudeMd, mcpUpdated };
}
