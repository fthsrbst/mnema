/**
 * Gece özeti + otomatik hafıza çıkarımı: son 1/7 günün oturum loglarını ve yeni
 * hafızaları yerel LLM'e (compute.ts localLlm) verip kısa bir özet + kalıcı olmaya
 * değer hafıza adayları üretir. Yerel model kapalıysa/hata verirse throw ETMEZ —
 * sunucuyu asla etkilemez, {ok:false, error} döner.
 */
import { getDb } from "./db.js";
import { localLlm } from "./compute.js";
import { saveMemory } from "./memories.js";
import type { Memory, MemoryType, SessionLog } from "./types.js";

const VALID_TYPES: MemoryType[] = ["fact", "preference", "decision", "howto", "context"];

export interface DigestCandidate {
  title: string;
  body: string;
  type?: string;
  tags?: string[];
}

export interface DigestResult {
  ok: boolean;
  skipped?: string;
  error?: string;
  memory_id?: number;
  candidates_saved?: number;
}

function periodOffset(period: "daily" | "weekly"): string {
  return period === "daily" ? "-1 days" : "-7 days";
}

function periodLabel(period: "daily" | "weekly"): string {
  return period === "daily" ? "günlük" : "haftalık";
}

function parseCandidates(content: string): { summary: string; candidates: DigestCandidate[] } {
  const summaryMatch = content.match(/##\s*Özet\s*([\s\S]*?)(?=##\s*Adaylar|$)/i);
  const candidatesMatch = content.match(/##\s*Adaylar\s*([\s\S]*)$/i);
  const summary = (summaryMatch ? summaryMatch[1] : content).trim();

  let candidates: DigestCandidate[] = [];
  if (candidatesMatch) {
    const jsonMatch = candidatesMatch[1].match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as unknown;
        if (Array.isArray(parsed)) {
          candidates = parsed.filter(
            (c): c is DigestCandidate =>
              !!c && typeof c === "object" && typeof (c as DigestCandidate).title === "string" && typeof (c as DigestCandidate).body === "string"
          );
        }
      } catch {
        // bozuk JSON — sadece özeti kaydet, adayları atla
      }
    }
  }
  return { summary, candidates };
}

/** Bugün için bu period'un digest'i zaten kaydedilmiş mi? Çift tetiklenme koruması. */
function alreadyRan(titleDate: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM memories WHERE title = ? LIMIT 1").get(titleDate);
}

export async function runDigest(period: "daily" | "weekly" = "daily"): Promise<DigestResult> {
  const db = getDb();
  const today = (db.prepare("SELECT date('now') AS d").get() as { d: string }).d;
  const titleDate = period === "daily" ? `Günlük özet ${today}` : `Haftalık özet ${today}`;

  if (alreadyRan(titleDate)) return { ok: true, skipped: "bugün zaten çalıştı" };

  const since = periodOffset(period);
  const sessions = db
    .prepare("SELECT * FROM session_logs WHERE created_at >= datetime('now', ?) ORDER BY created_at")
    .all(since) as SessionLog[];
  const memories = db
    .prepare("SELECT * FROM memories WHERE created_at >= datetime('now', ?) AND source != 'digest' ORDER BY created_at")
    .all(since) as Memory[];

  if (sessions.length === 0 && memories.length === 0) {
    return { ok: true, skipped: "veri yok" };
  }

  const sourceLines = [
    "Oturum özetleri:",
    ...(sessions.length > 0
      ? sessions.map((s) => `- [${s.created_at}]${s.project ? ` (${s.project})` : ""} ${s.summary}`)
      : ["(yok)"]),
    "",
    "Yeni hafıza kayıtları:",
    ...(memories.length > 0
      ? memories.map((m) => `- [${m.type}]${m.project ? ` (${m.project})` : ""} ${m.title}: ${m.body.slice(0, 200)}`)
      : ["(yok)"]),
  ].join("\n");

  const prompt = `Aşağıda son ${periodLabel(period)} dönemin oturum özetleri ve yeni hafıza kayıtları var. Görevin:
1) Kısa bir markdown özet yaz (ne yapıldı, önemli kararlar, yarım kalanlar).
2) Kalıcı olmaya değer 0-5 hafıza adayı çıkar (tekrar eden/önemsiz bilgi çıkarma) — JSON dizisi olarak:
[{"title": "...", "body": "...", "type": "fact|preference|decision|howto|context", "tags": ["..."]}]

Yanıtını TAM olarak şu formatta ver:
## Özet
<markdown özet>

## Adaylar
<JSON dizisi, aday yoksa []>

---
${sourceLines}`;

  let content: string;
  try {
    const result = await localLlm({ prompt, temperature: 0.4, max_tokens: 1500 });
    content = result.content ?? "";
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const { summary, candidates } = parseCandidates(content);

  const summaryMem = await saveMemory({
    type: "context",
    title: titleDate,
    body: summary || content.trim() || "(boş özet)",
    tags: ["digest"],
    source: "digest",
    importance: 0.5, // özet zamanla bayatlar
  });

  let saved = 0;
  for (const c of candidates.slice(0, 5)) {
    try {
      await saveMemory({
        type: VALID_TYPES.includes(c.type as MemoryType) ? (c.type as MemoryType) : "fact",
        title: c.title,
        body: c.body,
        tags: [...(c.tags ?? []), "auto-extract"],
        source: "digest",
      });
      saved++;
    } catch (err) {
      console.error(`[hub] digest aday kaydı başarısız (devam ediliyor): ${(err as Error).message}`);
    }
  }

  return { ok: true, memory_id: summaryMem.id, candidates_saved: saved };
}
