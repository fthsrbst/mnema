/**
 * Skill/prompt depolama katmanı: DB authority (assets tablosu).
 * skills.ts ve prompts.ts dış davranışlarını korumak için bunun üzerine ince
 * sarmalayıcılardır — bu modül CRUD + tek seferlik disk-seed'i sağlar.
 *
 * Seed uid'leri deterministiktir (sha256(kind+name), randomUUID DEĞİL): birden
 * çok cihaz aynı repo dosyalarını ilk açılışta bağımsız seed ederse hepsi aynı
 * uid'e yakınsar — aksi halde ilk sync turunda UNIQUE(kind,name) çakışması
 * (farklı uid, aynı ad) yaşanırdı. saveAsset ile SONRADAN oluşturulan kayıtlar
 * randomUUID kullanır (gerçekten yeni, tek cihazda doğan içerik).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import { recordDeletion } from "./sync.js";
import type { AssetKind, AssetRecord } from "./types.js";

const SKILLS_DIR = "./skills";
const PROMPTS_DIR = "./prompts";
const ROLES_DIR = path.join(PROMPTS_DIR, "roles");

function seedUid(kind: AssetKind, name: string): string {
  return createHash("sha256").update(`asset-seed-v1\0${kind}\0${name}`).digest("hex").slice(0, 32);
}

export function listAssets(kind?: AssetKind): AssetRecord[] {
  const db = getDb();
  return (
    kind
      ? db.prepare("SELECT * FROM assets WHERE kind = ? ORDER BY name").all(kind)
      : db.prepare("SELECT * FROM assets ORDER BY kind, name").all()
  ) as AssetRecord[];
}

export function getAsset(kind: AssetKind, name: string): AssetRecord | null {
  return (
    (getDb().prepare("SELECT * FROM assets WHERE kind = ? AND name = ?").get(kind, name) as AssetRecord | undefined) ?? null
  );
}

/** Var olanı günceller (uid korunur), yoksa yeni (randomUUID) kayıt açar. */
export function saveAsset(kind: AssetKind, name: string, content: string): AssetRecord {
  const db = getDb();
  const existing = getAsset(kind, name);
  if (existing) {
    db.prepare(`UPDATE assets SET content = @content, updated_at = ${NOW_MS} WHERE id = @id`).run({
      content,
      id: existing.id,
    });
  } else {
    db.prepare(
      `INSERT INTO assets(uid, kind, name, content, created_at, updated_at)
       VALUES (@uid, @kind, @name, @content, ${NOW_MS}, ${NOW_MS})`
    ).run({ uid: randomUUID().replaceAll("-", ""), kind, name, content });
  }
  notifyWrite();
  return getAsset(kind, name)!;
}

export function deleteAsset(kind: AssetKind, name: string): boolean {
  const db = getDb();
  const existing = getAsset(kind, name);
  if (!existing) return false;
  db.prepare("DELETE FROM assets WHERE id = ?").run(existing.id);
  recordDeletion("assets", existing.uid);
  notifyWrite();
  return true;
}

/** DB'de o (kind,name) yoksa repo dosyasından import eder. Var olanın üzerine YAZMAZ. */
function seedOne(kind: AssetKind, name: string, content: string): boolean {
  if (getAsset(kind, name)) return false;
  const db = getDb();
  db.prepare(
    `INSERT INTO assets(uid, kind, name, content, created_at, updated_at)
     VALUES (@uid, @kind, @name, @content, ${NOW_MS}, ${NOW_MS})`
  ).run({ uid: seedUid(kind, name), kind, name, content });
  return true;
}

/**
 * Sunucu açılışında bir kez çağrılır (idempotent — zaten DB'de olanı atlar).
 * skills/<ad>/SKILL.md → kind='skill', name=<ad>.
 * prompts/master.md → kind='prompt', name='master'.
 * prompts/roles/<ad>.md → kind='prompt', name='roles/<ad>' (dış davranış: prompt_get
 * rol adını 'roles/' önekisiz alır — bkz. prompts.ts dbName()).
 */
export function seedAssetsFromDisk(): { seeded: number } {
  let seeded = 0;
  if (fs.existsSync(SKILLS_DIR)) {
    for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(SKILLS_DIR, entry.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      if (seedOne("skill", entry.name, fs.readFileSync(file, "utf8"))) seeded++;
    }
  }
  const masterFile = path.join(PROMPTS_DIR, "master.md");
  if (fs.existsSync(masterFile)) {
    if (seedOne("prompt", "master", fs.readFileSync(masterFile, "utf8"))) seeded++;
  }
  if (fs.existsSync(ROLES_DIR)) {
    for (const entry of fs.readdirSync(ROLES_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const roleName = `roles/${entry.name.replace(/\.md$/, "")}`;
      if (seedOne("prompt", roleName, fs.readFileSync(path.join(ROLES_DIR, entry.name), "utf8"))) seeded++;
    }
  }
  return { seeded };
}
