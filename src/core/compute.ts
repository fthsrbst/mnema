import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";

export interface Machine {
  name: string;
  host: string;
  lmstudio_port: number | null;
  comfyui_port: number | null;
  notes: string | null;
  updated_at?: string;
}

export interface MachineStatus extends Machine {
  lmstudio: { online: boolean; models: string[] };
  comfyui: { online: boolean };
}

const OUTPUT_DIR = "./data/outputs";

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 5000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`${url} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// --- machines registry ---

export function upsertMachine(m: Omit<Machine, "updated_at">): Machine {
  getDb()
    .prepare(
      `INSERT INTO machines(name, host, lmstudio_port, comfyui_port, notes, updated_at)
       VALUES (@name, @host, @lmstudio_port, @comfyui_port, @notes, datetime('now'))
       ON CONFLICT(name) DO UPDATE SET host=@host, lmstudio_port=@lmstudio_port,
         comfyui_port=@comfyui_port, notes=@notes, updated_at=datetime('now')`
    )
    .run({
      name: m.name,
      host: m.host,
      lmstudio_port: m.lmstudio_port ?? null,
      comfyui_port: m.comfyui_port ?? null,
      notes: m.notes ?? null,
    });
  return getMachine(m.name)!;
}

export function getMachine(name: string): Machine | null {
  return (getDb().prepare("SELECT * FROM machines WHERE name = ?").get(name) as Machine) ?? null;
}

export function listMachines(): Machine[] {
  return getDb().prepare("SELECT * FROM machines ORDER BY name").all() as Machine[];
}

export function deleteMachine(name: string): boolean {
  return getDb().prepare("DELETE FROM machines WHERE name = ?").run(name).changes > 0;
}

/** Tüm makinelerin servis durumunu canlı yoklar. */
export async function machinesStatus(): Promise<MachineStatus[]> {
  return Promise.all(
    listMachines().map(async (m): Promise<MachineStatus> => {
      const status: MachineStatus = {
        ...m,
        lmstudio: { online: false, models: [] },
        comfyui: { online: false },
      };
      if (m.lmstudio_port) {
        try {
          const res = await fetchJson<{ data: { id: string }[] }>(
            `http://${m.host}:${m.lmstudio_port}/v1/models`, undefined, 3000
          );
          status.lmstudio = { online: true, models: res.data.map((d) => d.id) };
        } catch { /* offline */ }
      }
      if (m.comfyui_port) {
        try {
          await fetchJson(`http://${m.host}:${m.comfyui_port}/system_stats`, undefined, 3000);
          status.comfyui.online = true;
        } catch { /* offline */ }
      }
      return status;
    })
  );
}

// --- LM Studio (OpenAI-uyumlu) ---

export interface LocalLlmResult {
  machine: string;
  model: string;
  content: string;
  usage?: unknown;
}

export async function localLlm(opts: {
  machine?: string;
  model?: string;
  messages?: { role: string; content: string }[];
  prompt?: string;
  temperature?: number;
  max_tokens?: number;
}): Promise<LocalLlmResult> {
  const candidates = listMachines().filter((m) => m.lmstudio_port);
  if (candidates.length === 0) throw new Error("LM Studio portu tanımlı makine yok (machine_register ile ekle)");
  const machine = opts.machine ? candidates.find((m) => m.name === opts.machine) : candidates[0];
  if (!machine) throw new Error(`'${opts.machine}' makinesi yok veya LM Studio portu tanımsız`);

  const base = `http://${machine.host}:${machine.lmstudio_port}/v1`;
  let model = opts.model;
  if (!model) {
    const res = await fetchJson<{ data: { id: string }[] }>(`${base}/models`, undefined, 4000);
    if (res.data.length === 0) throw new Error(`${machine.name}: LM Studio'da yüklü model yok`);
    model = res.data[0].id;
  }
  const messages = opts.messages ?? [{ role: "user", content: opts.prompt ?? "" }];
  const res = await fetchJson<{ choices: { message: { content: string } }[]; usage?: unknown }>(
    `${base}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.max_tokens ?? 1024,
      }),
    },
    180000 // yerel model yavaş olabilir
  );
  return { machine: machine.name, model, content: res.choices[0]?.message?.content ?? "", usage: res.usage };
}

// --- ComfyUI ---

export function listWorkflows(): string[] {
  try {
    return fs
      .readdirSync("./workflows")
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

export interface ImageResult {
  machine: string;
  workflow: string;
  prompt_id: string;
  files: string[]; // hub sunucusundaki dosya yolları
  urls: string[];  // /outputs/<dosya> — REST üzerinden erişim
}

/**
 * workflows/<name>.json (ComfyUI API format) yükler, {{placeholder}} değerlerini
 * doldurur, kuyruğa atar, bitmesini bekler, çıktı görsellerini kaydeder.
 */
export async function generateImage(opts: {
  machine?: string;
  workflow: string;
  inputs?: Record<string, string | number>;
  timeoutSec?: number;
}): Promise<ImageResult> {
  const candidates = listMachines().filter((m) => m.comfyui_port);
  if (candidates.length === 0) throw new Error("ComfyUI portu tanımlı makine yok (machine_register ile ekle)");
  const machine = opts.machine ? candidates.find((m) => m.name === opts.machine) : candidates[0];
  if (!machine) throw new Error(`'${opts.machine}' makinesi yok veya ComfyUI portu tanımsız`);
  const base = `http://${machine.host}:${machine.comfyui_port}`;

  const wfPath = path.join("./workflows", `${opts.workflow}.json`);
  if (!fs.existsSync(wfPath)) {
    throw new Error(`workflow yok: ${opts.workflow} (mevcut: ${listWorkflows().join(", ") || "yok"})`);
  }
  let wfText = fs.readFileSync(wfPath, "utf8");
  // {{seed}} verilmemişse rastgele üret
  const inputs: Record<string, string | number> = { seed: Math.floor(Math.random() * 1e9), ...opts.inputs };
  for (const [key, value] of Object.entries(inputs)) {
    // sayı placeholder'ları tırnaklı da yazılabilsin: "{{seed}}" → 42
    wfText = wfText.replaceAll(`"{{${key}}}"`, JSON.stringify(value));
    wfText = wfText.replaceAll(`{{${key}}}`, String(value).replaceAll('"', '\\"'));
  }
  const unresolved = wfText.match(/\{\{([a-zA-Z0-9_]+)\}\}/);
  if (unresolved) throw new Error(`workflow '${opts.workflow}' doldurulmamış girdi bekliyor: ${unresolved[1]}`);

  const clientId = randomUUID();
  const queued = await fetchJson<{ prompt_id: string }>(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: JSON.parse(wfText), client_id: clientId }),
  });

  // Poll /history — üretim bitene kadar
  type ComfyOutputs = Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
  const deadline = Date.now() + (opts.timeoutSec ?? 300) * 1000;
  let outputs: ComfyOutputs | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const hist = await fetchJson<Record<string, { status?: { completed?: boolean; status_str?: string }; outputs?: ComfyOutputs }>>(
      `${base}/history/${queued.prompt_id}`, undefined, 10000
    );
    const entry = hist[queued.prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === "error") throw new Error(`ComfyUI üretim hatası (prompt_id ${queued.prompt_id})`);
    if (entry.outputs && Object.keys(entry.outputs).length > 0) {
      outputs = entry.outputs;
      break;
    }
  }
  if (!outputs) throw new Error(`ComfyUI zaman aşımı (${opts.timeoutSec ?? 300}s) — prompt_id ${queued.prompt_id}`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const files: string[] = [];
  const urls: string[] = [];
  for (const node of Object.values(outputs)) {
    for (const img of node.images ?? []) {
      const params = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(`${base}/view?${params}`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const name = `${Date.now()}-${img.filename}`;
      const dest = path.join(OUTPUT_DIR, name);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      files.push(path.resolve(dest));
      urls.push(`/outputs/${name}`);
    }
  }
  return { machine: machine.name, workflow: opts.workflow, prompt_id: queued.prompt_id, files, urls };
}
