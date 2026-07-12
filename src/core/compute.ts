import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import { composePrompt } from "./prompts.js";
import { recordDeletion } from "./sync.js";

export interface Machine {
  name: string;
  host: string;
  lmstudio_port: number | null;
  ollama_port: number | null;
  comfyui_port: number | null;
  notes: string | null;
  updated_at?: string;
}

export interface MachineStatus extends Machine {
  lmstudio: { online: boolean; models: string[] };
  ollama: { online: boolean; models: string[] };
  comfyui: { online: boolean };
}

/** Yerel LLM backend'i — ikisi de OpenAI-uyumlu /v1 API sunar. */
export type LlmBackend = "lmstudio" | "ollama";

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
      `INSERT INTO machines(name, host, lmstudio_port, ollama_port, comfyui_port, notes, updated_at)
       VALUES (@name, @host, @lmstudio_port, @ollama_port, @comfyui_port, @notes, ${NOW_MS})
       ON CONFLICT(name) DO UPDATE SET host=@host, lmstudio_port=@lmstudio_port,
         ollama_port=@ollama_port, comfyui_port=@comfyui_port, notes=@notes, updated_at=${NOW_MS}`
    )
    .run({
      name: m.name,
      host: m.host,
      lmstudio_port: m.lmstudio_port ?? null,
      ollama_port: m.ollama_port ?? null,
      comfyui_port: m.comfyui_port ?? null,
      notes: m.notes ?? null,
    });
  notifyWrite();
  return getMachine(m.name)!;
}

export function getMachine(name: string): Machine | null {
  return (getDb().prepare("SELECT * FROM machines WHERE name = ?").get(name) as Machine) ?? null;
}

export function listMachines(): Machine[] {
  return getDb().prepare("SELECT * FROM machines ORDER BY name").all() as Machine[];
}

export function deleteMachine(name: string): boolean {
  const deleted = getDb().prepare("DELETE FROM machines WHERE name = ?").run(name).changes > 0;
  if (deleted) {
    recordDeletion("machines", name);
    notifyWrite();
  }
  return deleted;
}

/** Tüm makinelerin servis durumunu canlı yoklar. */
export async function machinesStatus(): Promise<MachineStatus[]> {
  return Promise.all(
    listMachines().map(async (m): Promise<MachineStatus> => {
      const status: MachineStatus = {
        ...m,
        lmstudio: { online: false, models: [] },
        ollama: { online: false, models: [] },
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
      if (m.ollama_port) {
        try {
          const res = await fetchJson<{ data: { id: string }[] }>(
            `http://${m.host}:${m.ollama_port}/v1/models`, undefined, 3000
          );
          status.ollama = { online: true, models: res.data.map((d) => d.id) };
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

// --- Yerel LLM (LM Studio / Ollama — ikisi de OpenAI-uyumlu /v1) ---

export interface LocalLlmResult {
  machine: string;
  backend: LlmBackend;
  model: string;
  content: string;
  usage?: unknown;
}

export async function localLlm(opts: {
  machine?: string;
  backend?: LlmBackend;
  model?: string;
  messages?: { role: string; content: string }[];
  prompt?: string;
  temperature?: number;
  max_tokens?: number;
}): Promise<LocalLlmResult> {
  const hasBackend = (m: Machine, b?: LlmBackend) =>
    b === "lmstudio" ? !!m.lmstudio_port : b === "ollama" ? !!m.ollama_port : !!(m.lmstudio_port || m.ollama_port);
  const candidates = listMachines().filter((m) => hasBackend(m, opts.backend));
  if (candidates.length === 0) {
    throw new Error(
      opts.backend
        ? `${opts.backend} portu tanımlı makine yok (machine_register ile ekle)`
        : "LM Studio/Ollama portu tanımlı makine yok (machine_register ile ekle)"
    );
  }
  let machine: Machine | undefined;
  if (opts.machine) {
    machine = candidates.find((m) => m.name === opts.machine);
    if (!machine) throw new Error(`'${opts.machine}' makinesi yok veya istenen yerel LLM portu tanımsız`);
  } else {
    // Makine belirtilmediyse erişilebilir ilk makineyi seç — kayıt sırası alfabetik
    // olduğundan kapalı bir makine (örn. uyuyan laptop) listede önce gelebilir.
    for (const c of candidates) {
      const b: LlmBackend = opts.backend ?? (c.lmstudio_port ? "lmstudio" : "ollama");
      const p = b === "lmstudio" ? c.lmstudio_port : c.ollama_port;
      try {
        await fetchJson(`http://${c.host}:${p}/v1/models`, undefined, 2500);
        machine = c;
        break;
      } catch {
        /* erişilemiyor, sıradakine geç */
      }
    }
    if (!machine) throw new Error("Erişilebilir yerel LLM makinesi yok (hepsi offline — machine_status ile kontrol et)");
  }

  // Backend seçimi: istenen backend, yoksa LM Studio öncelikli
  const backend: LlmBackend = opts.backend ?? (machine.lmstudio_port ? "lmstudio" : "ollama");
  const port = backend === "lmstudio" ? machine.lmstudio_port : machine.ollama_port;
  const base = `http://${machine.host}:${port}/v1`;
  let model = opts.model;
  if (!model) {
    const res = await fetchJson<{ data: { id: string }[] }>(`${base}/models`, undefined, 4000);
    if (res.data.length === 0) throw new Error(`${machine.name}: ${backend} üzerinde yüklü model yok`);
    model = res.data[0].id;
  }
  let messages = opts.messages ?? [{ role: "user", content: opts.prompt ?? "" }];
  // System prompt verilmediyse master mühendis zihniyetini enjekte et —
  // küçük yerel modeller de aynı disiplinle (objektif, kanıta dayalı) çalışsın
  if (!messages.some((m) => m.role === "system")) {
    const master = composePrompt("master");
    if (master) messages = [{ role: "system", content: master }, ...messages];
  }
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
  return { machine: machine.name, backend, model, content: res.choices[0]?.message?.content ?? "", usage: res.usage };
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
  inputs?: Record<string, string | number | boolean>;
  timeoutSec?: number;
}): Promise<ImageResult> {
  const candidates = listMachines().filter((m) => m.comfyui_port);
  if (candidates.length === 0) throw new Error("ComfyUI portu tanımlı makine yok (machine_register ile ekle)");
  const machine = opts.machine ? candidates.find((m) => m.name === opts.machine) : candidates[0];
  if (!machine) throw new Error(`'${opts.machine}' makinesi yok veya ComfyUI portu tanımsız`);
  const base = `http://${machine.host}:${machine.comfyui_port}`;

  // path traversal engeli: workflow adı sadece dosya adı olabilir
  if (!/^[a-zA-Z0-9_-]+$/.test(opts.workflow)) throw new Error("geçersiz workflow adı");
  const wfPath = path.join("./workflows", `${opts.workflow}.json`);
  if (!fs.existsSync(wfPath)) {
    throw new Error(`workflow yok: ${opts.workflow} (mevcut: ${listWorkflows().join(", ") || "yok"})`);
  }
  // _meta: workflow açıklaması + placeholder varsayılanları (sunucuya gönderilmez)
  const parsed = JSON.parse(fs.readFileSync(wfPath, "utf8")) as Record<string, unknown> & {
    _meta?: { defaults?: Record<string, string | number | boolean> };
  };
  const defaults = parsed._meta?.defaults ?? {};
  delete parsed._meta;
  let wfText = JSON.stringify(parsed);
  const inputs: Record<string, string | number | boolean> = {
    seed: Math.floor(Math.random() * 1e9),
    ...defaults,
    ...opts.inputs,
  };

  // "*_path" girdileri: yerel dosyayı ComfyUI'a yükle, placeholder'a dosya adını koy
  // (örn. image_path: "C:\foo.png" → {{image}} = yüklenen ad)
  for (const [key, value] of Object.entries(inputs)) {
    if (!key.endsWith("_path") || typeof value !== "string") continue;
    if (!fs.existsSync(value)) throw new Error(`${key}: dosya yok: ${value}`);
    const form = new FormData();
    form.append("image", new Blob([fs.readFileSync(value)]), path.basename(value));
    form.append("overwrite", "true");
    const up = await fetch(`${base}/upload/image`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    if (!up.ok) throw new Error(`ComfyUI upload hatası ${up.status}: ${(await up.text()).slice(0, 200)}`);
    const uploaded = (await up.json()) as { name: string; subfolder?: string };
    delete inputs[key];
    inputs[key.replace(/_path$/, "")] = uploaded.subfolder
      ? `${uploaded.subfolder}/${uploaded.name}`
      : uploaded.name;
  }
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

  // Her tür çıktıyı topla: images, gifs, video, audio, mesh... — filename'i olan her şey
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const files: string[] = [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const node of Object.values(outputs)) {
    for (const group of Object.values(node as Record<string, unknown>)) {
      if (!Array.isArray(group)) continue;
      for (const item of group) {
        if (typeof item !== "object" || item === null) continue;
        const f = item as { filename?: string; subfolder?: string; type?: string };
        if (!f.filename || f.type === "temp") continue;
        const key = `${f.subfolder}/${f.filename}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const params = new URLSearchParams({
          filename: f.filename,
          subfolder: f.subfolder ?? "",
          type: f.type ?? "output",
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120000);
        try {
          const res = await fetch(`${base}/view?${params}`, { signal: controller.signal });
          if (!res.ok) continue;
          const name = `${Date.now()}-${f.filename}`;
          const dest = path.join(OUTPUT_DIR, name);
          fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
          files.push(path.resolve(dest));
          urls.push(`/outputs/${name}`);
        } finally {
          clearTimeout(timer);
        }
      }
    }
  }
  return { machine: machine.name, workflow: opts.workflow, prompt_id: queued.prompt_id, files, urls };
}
