import { config } from "./config.js";
import { hasVec } from "./db.js";
import { embeddingsEnabled } from "./embeddings.js";
import { searchMemories } from "./memories.js";
import { searchChunks } from "./documents.js";
import { getProject, resolveProjectFromPath } from "./projects.js";
import { recentSessionLogs } from "./sessions.js";
import type { ScoredChunk, ScoredMemory } from "./types.js";

export interface RecallResult {
  memories: ScoredMemory[];
  chunks: ScoredChunk[];
  /** cwd'den veya parametreden çözülen aktif proje (varsa). */
  project?: string | null;
}

/**
 * Auto-recall hassasiyet filtresi. Enjekte edilen bağlam az ve isabetli olmalı:
 * alakasız kayıt enjekte etmek, hiç enjekte etmemekten pahalıdır (agent'ı yanıltır,
 * context'i şişirir). Bu yüzden explicit memory_search geniş kalırken bu yol:
 * 1. anlamsal kanıt kapısı: embedding aktifken vektör kanalının bulmadığı kayıt
 *    enjekte edilmez — OR'lu FTS'in "proje", "kullanıcı" gibi genel kelimelerle
 *    yakaladığı gürültü explicit aramanın işidir, otomatik enjeksiyonun değil
 *    (vektör eşiği vecMaxDistance zaten ölçümle kalibre: gerçek eşleşme geçer),
 * 2. proje yakınlığı uygular (aktif proje ↑, yabancı proje ↓, global nötr),
 * 3. tek kanallı eşleşmeleri geriletir (iki kanalın anlaştığı kayıt daha güvenilir),
 * 4. en iyi skorun recallMinRatio'sunun altını atar (hiçbir şey kalmayabilir — doğrusu bu).
 * Not: Gemini geçici düşerse vektör kanalı boş kalır ve o mesajın recall'u sessizce
 * boş döner — bilinçli tercih; FTS-only kurulumlarda (embedding hiç yok) kapı kapalıdır.
 */
function adjustScores<T extends { score: number; channels?: ("fts" | "vec")[]; project?: string | null }>(
  items: T[],
  project: string | null | undefined,
  requireSemantic: boolean
): T[] {
  return items
    .filter((it) => !requireSemantic || (it.channels ?? []).includes("vec"))
    .map((it) => {
      let s = it.score;
      if (project && it.project === project) s *= config.recallProjectBoost;
      else if (project && it.project) s *= config.recallForeignPenalty;
      if ((it.channels ?? ["fts"]).length < 2) s *= config.recallSingleSourcePenalty;
      return { ...it, score: s };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Eşik iki havuzun (memory + chunk) ORTAK tepe skoruna göredir: güçlü bir hafıza
 * eşleşmesi varken zayıf doküman parçası sızamaz (ve tersi). Memory skorları
 * importance×decay ile şişkin olduğundan bu, enjeksiyonu damıtılmış bilgiye
 * (memory) doğru yanlı tutar — otomatik bağlam için istenen yanlılık.
 */
function thresholdCut<T extends { score: number }>(items: T[], globalTop: number, max: number): T[] {
  if (globalTop <= 0) return [];
  return items.filter((it) => it.score >= globalTop * config.recallMinRatio).slice(0, max);
}

/** Auto-recall: bir mesaj için ilgili hafıza + RAG parçalarını döner. */
export async function recall(query: string, project?: string, cwd?: string): Promise<RecallResult> {
  const resolved = project ?? (cwd ? resolveProjectFromPath(cwd) : null);
  // Geniş aday havuzu çek, hassasiyet filtresi daraltsın (proje filtresi arama
  // seviyesinde uygulanmaz — global tercih/karar kayıtları da aday kalmalı).
  const [memories, chunks] = await Promise.all([
    searchMemories(query, { limit: 8 }),
    searchChunks(query, { limit: 6 }),
  ]);
  const requireSemantic = hasVec() && embeddingsEnabled();
  const adjMems = adjustScores(memories, resolved, requireSemantic);
  const adjChunks = adjustScores(chunks, resolved, requireSemantic);
  const globalTop = Math.max(adjMems[0]?.score ?? 0, adjChunks[0]?.score ?? 0);
  return {
    memories: thresholdCut(adjMems, globalTop, config.recallMaxMemories),
    chunks: thresholdCut(adjChunks, globalTop, config.recallMaxChunks),
    project: resolved,
  };
}

/** Hook çıktısı: agent bağlamına enjekte edilecek kompakt markdown. Boşsa "". */
export function formatRecall(result: RecallResult): string {
  if (result.memories.length === 0 && result.chunks.length === 0) return "";
  const scope = result.project ? ` (aktif proje: ${result.project})` : "";
  const lines: string[] = ["<hub-recall>", `Hub hafızasından bu mesajla yüksek benzerlikli kayıtlar${scope}:`];
  for (const m of result.memories) {
    const body = m.body.length > 400 ? m.body.slice(0, 400) + "…" : m.body;
    lines.push(`- [memory #${m.id} | ${m.type}${m.project ? ` | ${m.project}` : ""}] ${m.title}: ${body}`);
  }
  for (const c of result.chunks) {
    const text = c.text.length > 400 ? c.text.slice(0, 400) + "…" : c.text;
    lines.push(`- [doc "${c.document_title}"${c.heading ? ` > ${c.heading}` : ""}] ${text}`);
  }
  lines.push(
    "Bu liste bilinçli olarak dar tutulur; eksik olabilir. Derin bağlam için memory_search / rag_search / project_get kullan.",
    "</hub-recall>"
  );
  return lines.join("\n");
}

/**
 * Oturum köprüsü (SessionStart hook'u): mesajdan bağımsız, deterministik bağlam —
 * aktif projenin map'i + o projenin son oturum özeti. Arama/embedding yok, hızlı.
 * Proje çözülemezse boş döner (alakasız proje enjekte etmek gürültüdür).
 */
export function bridge(cwd?: string, projectName?: string): string {
  const name = projectName ?? (cwd ? resolveProjectFromPath(cwd) : null);
  if (!name) return "";
  const proj = getProject(name);
  if (!proj) return "";
  const lines: string[] = ["<hub-bridge>", `Aktif proje (hub map): **${proj.name}**${proj.status ? ` [${proj.status}]` : ""}`];
  if (proj.summary) lines.push(`Özet: ${proj.summary}`);
  if (proj.current_focus) lines.push(`Mevcut odak: ${proj.current_focus}`);
  const steps = (proj.next_steps ?? []).slice(0, 5);
  if (steps.length > 0) lines.push(`Sıradaki adımlar:\n${steps.map((s) => `  - ${s}`).join("\n")}`);
  const [last] = recentSessionLogs({ project: proj.name, limit: 1 });
  if (last) {
    const summary = last.summary.length > 700 ? last.summary.slice(0, 700) + "…" : last.summary;
    lines.push(`Son oturum (${last.created_at}${last.source ? `, ${last.source}` : ""}):\n${summary}`);
  }
  if (proj.updated_at) {
    lines.push(
      `Map güncellemesi: ${proj.updated_at} — gerçek durumla çeliştiğini görürsen project_update ile düzelt (bayat map yanlış yönlendirir).`
    );
  }
  lines.push("</hub-bridge>");
  return lines.join("\n");
}
