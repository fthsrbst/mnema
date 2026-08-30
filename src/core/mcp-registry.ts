/**
 * Ortak MCP sunucu kayıt defteri (DB authority, mcp_servers tablosu).
 *
 * Agent'lar hangi MCP sunuculara bağlanacaklarını hub'dan yönetir: kayıt/güncelleme
 * normal Mnema sync ile tüm cihazlara yayılır, böylece tek noktadan ortak yönetim olur.
 * uid DETERMİNİSTİKTİR (sha256("mcp-server:"+name), assets seed deseni): iki cihaz aynı
 * adı bağımsız kaydederse aynı uid'e yakınsar — ilk sync turunda UNIQUE(name) çakışması
 * yerine LWW birleşmesi yaşanır.
 *
 * GİZLİLİK: env/headers DB'ye düz metin yazılır ve cihazlar arasında senkronlanır.
 * Buraya gizli değer koymayın; istemci tarafında ortam değişkeni referansı kullanın
 * (örn. "${GITHUB_TOKEN}" — tüketici aracı kendi ortamından çözümlemeli).
 */
import { createHash } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import { recordDeletion } from "./sync.js";
import { mcpServerInputSchema } from "./schemas.js";
import type { McpServer } from "./types.js";

function serverUid(name: string): string {
  return createHash("sha256").update(`mcp-server-v1\0${name}`).digest("hex").slice(0, 32);
}

function rowToServer(row: Record<string, unknown>): McpServer {
  return {
    ...(row as unknown as McpServer),
    args: JSON.parse((row.args as string) ?? "[]"),
    env: JSON.parse((row.env as string) ?? "{}"),
    headers: JSON.parse((row.headers as string) ?? "{}"),
    enabled: Number(row.enabled) !== 0,
  };
}

export function listMcpServers(filter: { enabled?: boolean } = {}): McpServer[] {
  const where = filter.enabled === undefined ? "" : filter.enabled ? "WHERE enabled = 1" : "WHERE enabled = 0";
  return (getDb().prepare(`SELECT * FROM mcp_servers ${where} ORDER BY name`).all() as Record<string, unknown>[]).map(
    rowToServer
  );
}

export function getMcpServer(name: string): McpServer | null {
  const row = getDb().prepare("SELECT * FROM mcp_servers WHERE name = ?").get(name) as Record<string, unknown> | undefined;
  return row ? rowToServer(row) : null;
}

/** Ad bazlı upsert (mevcut kaydın uid'i korunur). http → url, stdio → command zorunlu. */
export function saveMcpServer(name: string, input: unknown): McpServer {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name)) throw new Error(`geçersiz MCP sunucu adı: ${name}`);
  const parsed = mcpServerInputSchema.parse(input ?? {});
  const db = getDb();
  const existingRow = db.prepare("SELECT * FROM mcp_servers WHERE name = ?").get(name) as Record<string, unknown> | undefined;
  const current = existingRow ? rowToServer(existingRow) : null;

  const transport = parsed.transport ?? current?.transport ?? "http";
  const url = parsed.url !== undefined ? parsed.url : (current?.url ?? null);
  const command = parsed.command !== undefined ? parsed.command : (current?.command ?? null);
  if (transport === "http" && !url) throw new Error(`'${name}': http transport url gerektirir`);
  if (transport === "stdio" && !command) throw new Error(`'${name}': stdio transport command gerektirir`);

  const next = {
    transport,
    url,
    command,
    args: JSON.stringify(parsed.args ?? current?.args ?? []),
    env: JSON.stringify(parsed.env ?? current?.env ?? {}),
    headers: JSON.stringify(parsed.headers ?? current?.headers ?? {}),
    scope: parsed.scope !== undefined ? parsed.scope : (current?.scope ?? null),
    description: parsed.description !== undefined ? parsed.description : (current?.description ?? null),
    enabled: parsed.enabled === undefined ? (current?.enabled ?? true) : parsed.enabled,
  };

  if (current) {
    db.prepare(
      `UPDATE mcp_servers SET transport=@transport, url=@url, command=@command, args=@args, env=@env,
       headers=@headers, scope=@scope, description=@description, enabled=@enabled, updated_at=${NOW_MS}
       WHERE id=@id`
    ).run({ ...next, enabled: next.enabled ? 1 : 0, id: current.id });
  } else {
    db.prepare(
      `INSERT INTO mcp_servers(uid, name, transport, url, command, args, env, headers, scope, description, enabled, created_at, updated_at)
       VALUES (@uid, @name, @transport, @url, @command, @args, @env, @headers, @scope, @description, @enabled, ${NOW_MS}, ${NOW_MS})`
    ).run({
      uid: serverUid(name),
      name,
      ...next,
      enabled: next.enabled ? 1 : 0,
    });
  }
  notifyWrite();
  return getMcpServer(name)!;
}

export function deleteMcpServer(name: string): boolean {
  const existing = getMcpServer(name);
  if (!existing) return false;
  const db = getDb();
  // Silme + tombstone TEK işlemde — crash penceresinde kayıt peer'lardan dirilirdi.
  db.transaction(() => {
    db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(existing.id);
    recordDeletion("mcp_servers", existing.uid);
  })();
  notifyWrite();
  return true;
}
