/**
 * Skill deposu: repo'daki skills/<ad>/SKILL.md dosyaları.
 * Web UI ve MCP (skill_save) buradan okur/yazar; kalıcılık için git commit
 * + her cihazda `hub sync` gerekir (sync bunları ~/.claude/skills'e kopyalar).
 */
import fs from "node:fs";
import path from "node:path";

const SKILLS_DIR = "./skills";

export interface SkillInfo {
  name: string;
  description: string;
  content: string;
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9-]/gi, "");
}

export function listSkills(): SkillInfo[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const file = path.join(SKILLS_DIR, e.name, "SKILL.md");
      const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const desc = content.match(/^description:\s*(.+)$/m)?.[1] ?? "";
      return { name: e.name, description: desc, content };
    });
}

export function saveSkill(name: string, content: string): { name: string } {
  const clean = safeName(name);
  if (!clean) throw new Error("Geçersiz skill adı (a-z, 0-9, - kullan)");
  const file = path.join(SKILLS_DIR, clean, "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { name: clean };
}

export function deleteSkill(name: string): boolean {
  const clean = safeName(name);
  const dir = path.join(SKILLS_DIR, clean);
  if (!clean || !fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true });
  return true;
}
