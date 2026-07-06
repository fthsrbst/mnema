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

/** skills/ → ~/.claude/skills/ kopyalar, ~/.claude/CLAUDE.md yönetilen bloğu günceller. */
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

  return { skillsCopied: copied, claudeMdUpdated: claudeMd };
}
