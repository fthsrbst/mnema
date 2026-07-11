import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCliConfig } from "./client.js";
import { sync } from "./sync.js";

/**
 * Makinede kurulu agentic AI uygulamalarını tespit eder ve hub MCP'ye bağlar.
 * sync.ts'i DEĞİŞTİRMEDEN onun mevcut mantığını kullanır (Claude Code/Cursor/
 * opencode/Codex zaten orada); burada sadece ek istemciler (Gemini CLI, Windsurf)
 * ve "kurulu mu / bağlı mı" tespiti eklenir.
 */

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

/** PATH üzerinde bir komutun var olup olmadığını kontrol eder (Windows+Unix). */
function commandExists(cmd: string): boolean {
  const pathVar = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        const full = path.join(dir, cmd + ext.toLowerCase());
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return true;
        const fullExact = path.join(dir, cmd + ext);
        if (fs.existsSync(fullExact) && fs.statSync(fullExact).isFile()) return true;
      } catch {
        /* yok say */
      }
    }
  }
  return false;
}

export interface AgentInfo {
  id: string;
  label: string;
  installed: boolean;
  installedVia: string; // ne bulundu: "PATH" | "~/.claude" | vs.
  configFile: string;
  connected: boolean;
}

const home = os.homedir();

interface AgentDef {
  id: string;
  label: string;
  /** Kurulu mu tespiti. */
  detect: () => { installed: boolean; via: string };
  /** Hub MCP config dosyası (varsa) ve içinde "hub" girdisi var mı kontrolü. */
  configFile: string;
  isConnected: () => boolean;
}

function claudeCodeDetect() {
  if (commandExists("claude")) return { installed: true, via: "PATH" };
  if (fs.existsSync(path.join(home, ".claude"))) return { installed: true, via: "~/.claude" };
  return { installed: false, via: "" };
}

function claudeCodeConnected(): boolean {
  const f = path.join(home, ".claude.json");
  const j = readJson(f);
  return !!j?.mcpServers?.hub;
}

function opencodeDetect() {
  if (fs.existsSync(path.join(home, ".config", "opencode"))) return { installed: true, via: "~/.config/opencode" };
  if (commandExists("opencode")) return { installed: true, via: "PATH" };
  return { installed: false, via: "" };
}

function opencodeConnected(): boolean {
  const f = path.join(home, ".config", "opencode", "opencode.json");
  const j = readJson(f);
  return !!j?.mcp?.hub;
}

function codexDetect() {
  if (fs.existsSync(path.join(home, ".codex"))) return { installed: true, via: "~/.codex" };
  if (commandExists("codex")) return { installed: true, via: "PATH" };
  return { installed: false, via: "" };
}

function codexConnected(): boolean {
  const f = path.join(home, ".codex", "config.toml");
  let toml = "";
  try {
    toml = fs.readFileSync(f, "utf8");
  } catch {
    return false;
  }
  return /\[mcp_servers\.hub\]/.test(toml);
}

function cursorDetect() {
  if (fs.existsSync(path.join(home, ".cursor"))) return { installed: true, via: "~/.cursor" };
  return { installed: false, via: "" };
}

function cursorConnected(): boolean {
  const f = path.join(home, ".cursor", "mcp.json");
  const j = readJson(f);
  return !!j?.mcpServers?.hub;
}

function windsurfDetect() {
  if (fs.existsSync(path.join(home, ".codeium", "windsurf"))) return { installed: true, via: "~/.codeium/windsurf" };
  return { installed: false, via: "" };
}

function windsurfConfigFile(): string {
  return path.join(home, ".codeium", "windsurf", "mcp_config.json");
}

function windsurfConnected(): boolean {
  const j = readJson(windsurfConfigFile());
  return !!j?.mcpServers?.hub;
}

function lmstudioDetect() {
  if (fs.existsSync(path.join(home, ".lmstudio"))) return { installed: true, via: "~/.lmstudio" };
  if (commandExists("lms")) return { installed: true, via: "PATH (lms)" };
  return { installed: false, via: "" };
}

function lmstudioConfigFile(): string {
  return path.join(home, ".lmstudio", "mcp.json");
}

function lmstudioConnected(): boolean {
  const j = readJson(lmstudioConfigFile());
  return !!j?.mcpServers?.hub;
}

function geminiDetect() {
  if (fs.existsSync(path.join(home, ".gemini"))) return { installed: true, via: "~/.gemini" };
  if (commandExists("gemini")) return { installed: true, via: "PATH" };
  return { installed: false, via: "" };
}

function geminiConfigFile(): string {
  return path.join(home, ".gemini", "settings.json");
}

function geminiConnected(): boolean {
  const j = readJson(geminiConfigFile());
  return !!j?.mcpServers?.hub;
}

const AGENTS: AgentDef[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    detect: claudeCodeDetect,
    configFile: path.join(home, ".claude.json"),
    isConnected: claudeCodeConnected,
  },
  {
    id: "opencode",
    label: "opencode",
    detect: opencodeDetect,
    configFile: path.join(home, ".config", "opencode", "opencode.json"),
    isConnected: opencodeConnected,
  },
  {
    id: "codex",
    label: "Codex",
    detect: codexDetect,
    configFile: path.join(home, ".codex", "config.toml"),
    isConnected: codexConnected,
  },
  {
    id: "cursor",
    label: "Cursor",
    detect: cursorDetect,
    configFile: path.join(home, ".cursor", "mcp.json"),
    isConnected: cursorConnected,
  },
  {
    id: "windsurf",
    label: "Windsurf",
    detect: windsurfDetect,
    configFile: windsurfConfigFile(),
    isConnected: windsurfConnected,
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    detect: geminiDetect,
    configFile: geminiConfigFile(),
    isConnected: geminiConnected,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    detect: lmstudioDetect,
    configFile: lmstudioConfigFile(),
    isConnected: lmstudioConnected,
  },
];

export function detectAgents(): AgentInfo[] {
  return AGENTS.map((a) => {
    const { installed, via } = a.detect();
    return {
      id: a.id,
      label: a.label,
      installed,
      installedVia: via,
      configFile: a.configFile,
      connected: installed && a.isConnected(),
    };
  });
}

export function printAgentsTable(agents: AgentInfo[]): void {
  const idW = Math.max(...agents.map((a) => a.label.length), 12);
  console.log(`${"Agent".padEnd(idW)}  ${"Kurulu".padEnd(8)}  ${"Nerede".padEnd(20)}  Hub bağlı`);
  for (const a of agents) {
    const installed = a.installed ? "evet" : "hayır";
    const connected = !a.installed ? "-" : a.connected ? "evet" : "hayır";
    console.log(`${a.label.padEnd(idW)}  ${installed.padEnd(8)}  ${(a.installedVia || "-").padEnd(20)}  ${connected}`);
  }
}

/** Gemini CLI + Windsurf için ek MCP config yazımı (sync.ts kapsamadığı için burada). */
function connectExtras(): string[] {
  const cfg = loadCliConfig();
  const updated: string[] = [];
  const url = `${cfg.url}/mcp`;
  const headers = cfg.token ? { Authorization: `Bearer ${cfg.token}` } : undefined;

  // Gemini CLI: ~/.gemini/settings.json → mcpServers.hub { httpUrl, headers }
  const gemini = geminiDetect();
  if (gemini.installed) {
    const file = geminiConfigFile();
    const j = readJson(file) ?? {};
    j.mcpServers ??= {};
    const desired = { httpUrl: url, ...(headers ? { headers } : {}) };
    if (JSON.stringify(j.mcpServers.hub) !== JSON.stringify(desired)) {
      j.mcpServers.hub = desired;
      writeJson(file, j);
      updated.push("gemini-cli");
    }
  }

  // LM Studio: ~/.lmstudio/mcp.json — Cursor formatı (mcpServers.hub {url, headers}).
  // Yerel modeller (chat UI'daki tool use ile) hub'a bu köprüden erişir.
  const lmstudio = lmstudioDetect();
  if (lmstudio.installed) {
    const file = lmstudioConfigFile();
    const j = readJson(file) ?? {};
    j.mcpServers ??= {};
    const desired = { url, ...(headers ? { headers } : {}) };
    if (JSON.stringify(j.mcpServers.hub) !== JSON.stringify(desired)) {
      j.mcpServers.hub = desired;
      writeJson(file, j);
      updated.push("lmstudio");
    }
  }

  // Windsurf: ~/.codeium/windsurf/mcp_config.json — Cursor formatı (mcpServers.hub {url, headers})
  const windsurf = windsurfDetect();
  if (windsurf.installed) {
    const file = windsurfConfigFile();
    const j = readJson(file) ?? {};
    j.mcpServers ??= {};
    const desired = { url, ...(headers ? { headers } : {}) };
    if (JSON.stringify(j.mcpServers.hub) !== JSON.stringify(desired)) {
      j.mcpServers.hub = desired;
      writeJson(file, j);
      updated.push("windsurf");
    }
  }

  return updated;
}

export interface ConnectResult {
  detected: AgentInfo[];
  syncResult: ReturnType<typeof sync> | null;
  extrasUpdated: string[];
}

/** Tespit edilen tüm agentlara hub MCP konfigini yazar. Idempotent. */
export function connectAgents(): ConnectResult {
  const detected = detectAgents();
  const cfg = loadCliConfig();

  let syncResult: ReturnType<typeof sync> | null = null;
  // sync() repoPath ister (skills kopyalama + Claude Code/Cursor/opencode/Codex MCP).
  // repoPath yoksa (ör. public kullanıcı sadece CLI'ı kurduysa) sadece extras'ı dene.
  if (cfg.repoPath) {
    try {
      syncResult = sync();
    } catch (err) {
      console.error(`uyarı: sync() başarısız: ${(err as Error).message}`);
    }
  } else {
    console.error(
      "uyarı: repoPath ayarlı değil, Claude Code/Cursor/opencode/Codex için `hub sync` atlandı. " +
        "(`hub config set repoPath <ai-hub repo klasörü>` ile ayarlayıp tekrar dene.)"
    );
  }

  const extrasUpdated = connectExtras();
  return { detected, syncResult, extrasUpdated };
}
