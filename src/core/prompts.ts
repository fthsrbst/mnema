/**
 * Rol bazlı prompt kütüphanesi: prompts/master.md (mühendis zihniyeti çekirdeği)
 * + prompts/roles/<rol>.md. Agent'lar MCP prompt_get ile çeker; master her role
 * otomatik eklenir — böylece alt modeller de aynı disiplinle çalışır.
 */
import fs from "node:fs";
import path from "node:path";

const PROMPTS_DIR = "./prompts";
const ROLES_DIR = path.join(PROMPTS_DIR, "roles");

export interface PromptInfo {
  name: string;
  description: string;
}

function parseFrontmatter(content: string): { description: string; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { description: "", body: content };
  const description = m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return { description, body: m[2].trim() };
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9-]/gi, "");
}

export function listPrompts(): { master: PromptInfo | null; roles: PromptInfo[] } {
  const read = (file: string, name: string): PromptInfo | null => {
    if (!fs.existsSync(file)) return null;
    return { name, description: parseFrontmatter(fs.readFileSync(file, "utf8")).description };
  };
  const master = read(path.join(PROMPTS_DIR, "master.md"), "master");
  const roles = fs.existsSync(ROLES_DIR)
    ? fs
        .readdirSync(ROLES_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => read(path.join(ROLES_DIR, f), f.replace(/\.md$/, "")))
        .filter((p): p is PromptInfo => p !== null)
    : [];
  return { master, roles };
}

export function getPromptRaw(name: string): string | null {
  const clean = safeName(name);
  const file = clean === "master" ? path.join(PROMPTS_DIR, "master.md") : path.join(ROLES_DIR, `${clean}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/** Rol prompt'unu master zihniyet çekirdeğiyle birleştirip döner. */
export function composePrompt(role: string): string | null {
  const roleRaw = getPromptRaw(role);
  if (roleRaw === null) return null;
  const roleBody = parseFrontmatter(roleRaw).body;
  if (safeName(role) === "master") return roleBody;
  const masterRaw = getPromptRaw("master");
  const masterBody = masterRaw ? parseFrontmatter(masterRaw).body : "";
  return masterBody ? `${masterBody}\n\n---\n\n${roleBody}` : roleBody;
}

export function savePrompt(name: string, content: string): void {
  const clean = safeName(name);
  const file = clean === "master" ? path.join(PROMPTS_DIR, "master.md") : path.join(ROLES_DIR, `${clean}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
