/**
 * Skill deposu: DB authority (assets tablosu, kind='skill' — bkz. assets.ts).
 * repo'daki skills/<ad>/SKILL.md dosyaları yalnızca ilk kurulum seed'idir
 * (seedAssetsFromDisk). Bir kayıt DB'ye girdikten sonra kalıcılık ve cihazlar
 * arası dağıtım sync motoru üzerinden OTOMATİKTİR — git commit/push GEREKMEZ.
 * Bir cihazda ~/.claude/skills'e dosya olarak materyalize etmek için `hub sync`
 * CLI'ını kullan (REST /api/skills üzerinden DB'den çeker).
 */
import { deleteAsset, listAssets, saveAsset } from "./assets.js";

export interface SkillInfo {
  name: string;
  description: string;
  content: string;
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9-]/gi, "");
}

function parseDescription(content: string): string {
  return content.match(/^description:\s*(.+)$/m)?.[1] ?? "";
}

export function listSkills(): SkillInfo[] {
  return listAssets("skill").map((a) => ({ name: a.name, description: parseDescription(a.content), content: a.content }));
}

export function saveSkill(name: string, content: string): { name: string } {
  const clean = safeName(name);
  if (!clean) throw new Error("Geçersiz skill adı (a-z, 0-9, - kullan)");
  saveAsset("skill", clean, content);
  return { name: clean };
}

export function deleteSkill(name: string): boolean {
  const clean = safeName(name);
  if (!clean) return false;
  return deleteAsset("skill", clean);
}
