import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCliConfig } from "./client.js";

const BLOCK_START = "<!-- hub:start -->";
const BLOCK_END = "<!-- hub:end -->";

const CLAUDE_MD_BLOCK = `${BLOCK_START}
## AI Hub — ortak hafıza (otomatik yönetilen blok, elle düzenleme)

Tüm cihazlarda ortak bir hafıza/RAG/proje sunucusu var: **hub** MCP server'ı.

Kurallar:
- **Göreve başlarken:** kullanıcının mesajına \`<hub-recall>\` bloğu eklendiyse önce onu oku; ek bağlam gerekirse \`recall\` veya \`memory_search\` çağır. Bir projede çalışıyorsan \`project_get\` ile proje map'ini çek.
- **Çalışırken:** kalıcı olması gereken her şeyi kaydet — alınan teknik kararlar gerekçesiyle (\`memory_save\`, type=decision), çözülen zor bug'ların kök nedeni (\`memory_save\`, type=howto), kullanıcı tercihleri (type=preference).
- **Öğrenme:** kullanıcı bir konu öğreniyorsa çıkan notları \`rag_add\` ile indeksle — sonraki oturumlarda aranabilir olsun.
- **Oturum sonunda:** \`session_log\` ile özet bırak (yapılanlar, yarım kalanlar, sıradaki adım) ve gerekiyorsa \`project_update\` ile current_focus/next_steps güncelle.
- Yanlışlanan bilgiyi \`memory_update\`/\`memory_delete\` ile düzelt; hafızayı çöplüğe çevirme — oturuma özel detayları kaydetme.
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
  url: string;
  headers?: Record<string, string>;
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

  // Claude Code (user scope): ~/.claude.json → mcpServers
  const claudeFile = path.join(home, ".claude.json");
  const claude = readJson(claudeFile);
  if (claude) {
    let changed = false;
    claude.mcpServers ??= {};
    for (const [name, entry] of servers) {
      const desired = { type: "http", ...entry };
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
      if (JSON.stringify(cursor.mcpServers[name]) !== JSON.stringify(entry)) {
        cursor.mcpServers[name] = entry;
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
      const desired = { type: "remote", url: entry.url, enabled: true, ...(entry.headers ? { headers: entry.headers } : {}) };
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

  const mcpUpdated = syncMcpServers(cfg.repoPath);

  return { skillsCopied: copied, claudeMdUpdated: claudeMd, mcpUpdated };
}
