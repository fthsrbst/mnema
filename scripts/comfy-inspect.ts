/**
 * ComfyUI keşif aracı: kurulu modelleri ve kayıtlı workflowları döker.
 * Kullanım: npx tsx scripts/comfy-inspect.ts [host] [port]
 * Çıktı: workflows/ için hangi grafiklerin kurulabileceğini gösterir.
 */
const host = process.argv[2] ?? "127.0.0.1";
const port = process.argv[3] ?? "8188";
const base = `http://${host}:${port}`;

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const stats = await get<{ system: { comfyui_version: string } }>("/system_stats");
if (!stats) {
  console.error(`ComfyUI erişilemez: ${base} — uygulama açık mı, port doğru mu?`);
  process.exit(1);
}
console.log(`ComfyUI ${stats.system.comfyui_version} @ ${base}\n`);

// Model klasörleri (yeni API)
const folders = ["checkpoints", "diffusion_models", "unet", "clip", "text_encoders", "vae", "loras", "controlnet", "upscale_models"];
for (const folder of folders) {
  const models = await get<string[]>(`/models/${folder}`);
  if (models && models.length > 0) {
    console.log(`[${folder}]`);
    for (const m of models) console.log(`  ${m}`);
  }
}

// Kayıtlı kullanıcı workflowları
const userdata = await get<string[]>("/userdata?dir=workflows&recurse=true");
if (userdata && userdata.length > 0) {
  console.log("\n[kayıtlı workflowlar]");
  for (const w of userdata) console.log(`  ${w}`);
}

// Kritik node'ların varlığı (API workflow kurarken lazım)
const nodes = ["CheckpointLoaderSimple", "UNETLoader", "DualCLIPLoader", "CLIPLoader", "VAELoader", "KSampler", "EmptyLatentImage", "EmptySD3LatentImage", "FluxGuidance", "ModelSamplingAuraFlow", "SaveImage"];
console.log("\n[node kontrolü]");
for (const n of nodes) {
  const info = await get<Record<string, unknown>>(`/object_info/${n}`);
  console.log(`  ${info && Object.keys(info).length ? "var " : "YOK "} ${n}`);
}
