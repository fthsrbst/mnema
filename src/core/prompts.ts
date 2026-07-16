/**
 * Rol bazlı prompt kütüphanesi: DB authority (assets tablosu, kind='prompt' —
 * bkz. assets.ts). prompts/master.md + prompts/roles/<rol>.md yalnızca ilk
 * kurulum seed'idir; sonraki yazımlar DB'ye düşer ve sync ile otomatik yayılır.
 * DB'de rol promptları 'roles/<rol>' adıyla saklanır (master ile ad çakışmasın
 * diye); prompt_get/prompt_list dış davranışı (rol adı 'roles/' önekisiz) AYNEN
 * korunur — bkz. dbName().
 */
import { getAsset, listAssets, saveAsset } from "./assets.js";

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

function dbName(role: string): string {
  const clean = safeName(role);
  return clean === "master" ? "master" : `roles/${clean}`;
}

export function listPrompts(): { master: PromptInfo | null; roles: PromptInfo[] } {
  const assets = listAssets("prompt");
  const masterAsset = assets.find((a) => a.name === "master");
  const master = masterAsset
    ? { name: "master", description: parseFrontmatter(masterAsset.content).description }
    : null;
  const roles = assets
    .filter((a) => a.name.startsWith("roles/"))
    .map((a) => ({ name: a.name.slice("roles/".length), description: parseFrontmatter(a.content).description }));
  return { master, roles };
}

export function getPromptRaw(name: string): string | null {
  const asset = getAsset("prompt", dbName(name));
  return asset ? asset.content : null;
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
  if (!clean) throw new Error("Geçersiz prompt adı (a-z, 0-9, - kullan)");
  saveAsset("prompt", dbName(clean), content);
}
