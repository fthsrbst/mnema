import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  url: string;
  token: string;
  repoPath: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".hub");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function loadCliConfig(): CliConfig {
  let file: Partial<CliConfig> = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    /* yok sayılır */
  }
  return {
    url: process.env.HUB_URL ?? file.url ?? "http://127.0.0.1:8033",
    token: process.env.HUB_TOKEN ?? file.token ?? "",
    repoPath: file.repoPath ?? "",
  };
}

export function saveCliConfig(patch: Partial<CliConfig>): CliConfig {
  const merged = { ...loadCliConfig(), ...patch };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

export async function api<T = unknown>(
  method: string,
  route: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {}
): Promise<T> {
  const cfg = loadCliConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await fetch(`${cfg.url}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const type = res.headers.get("content-type") ?? "";
    return (type.includes("json") ? await res.json() : await res.text()) as T;
  } finally {
    clearTimeout(timer);
  }
}
