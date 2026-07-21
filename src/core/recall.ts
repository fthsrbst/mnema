import { config } from "./config.js";
import { getDb, hasVec } from "./db.js";
import { embeddingsEnabled } from "./embeddings.js";
import { recordMemoryAccess, searchMemories } from "./memories.js";
import { searchChunks } from "./documents.js";
import { getProject, resolveProjectFromPath } from "./projects.js";
import { recentSessionLogs } from "./sessions.js";
import { listMemoryRelations } from "./relations.js";
import { agentActive, formatPresenceLines } from "./presence.js";
import { taskQueue } from "./tasks.js";
import { unreadCount } from "./messaging.js";
import type { KnowledgeTransferSuggestion, ScoredChunk, ScoredMemory } from "./types.js";

export interface RecallResult {
  memories: ScoredMemory[];
  chunks: ScoredChunk[];
  /** cwd'den veya parametreden çözülen aktif proje (varsa). */
  project?: string | null;
  /** Cross-project suggestions from other projects that may apply. */
  cross_project_suggestions?: KnowledgeTransferSuggestion[];
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
  // Havuz limitleri enjeksiyon limitinden bilinçli büyük: yüksek importance'lı
  // FTS-only gürültü, vec kanıtlı kayıtları havuz dışına itememeli.
  const [memories, chunks] = await Promise.all([
    searchMemories(query, { limit: 12 }),
    searchChunks(query, { limit: 8 }),
  ]);
  const requireSemantic = hasVec() && embeddingsEnabled();
  const adjMems = adjustScores(memories, resolved, requireSemantic);
  const adjChunks = adjustScores(chunks, resolved, requireSemantic);
  const globalTop = Math.max(adjMems[0]?.score ?? 0, adjChunks[0]?.score ?? 0);
  const selectedMemories = thresholdCut(adjMems, globalTop, config.recallMaxMemories);
  const result = {
    memories: selectedMemories,
    chunks: thresholdCut(adjChunks, globalTop, config.recallMaxChunks),
    project: resolved,
  };
  recordMemoryAccess(selectedMemories.map((item) => item.id));
  return result;
}

/**
 * Find transferable knowledge from other projects that might apply.
 * Based on tag overlap, semantic similarity, and applies_to relations.
 */
export async function transferableKnowledge(project: string, limit = 5): Promise<KnowledgeTransferSuggestion[]> {
  const db = getDb();
  const suggestions: KnowledgeTransferSuggestion[] = [];

  // Get tags used in the target project
  const projectTags = db
    .prepare(
      `SELECT DISTINCT json_each.value AS tag FROM memories, json_each(memories.tags) WHERE project = ?`
    )
    .all(project) as { tag: string }[];
  const tagSet = new Set(projectTags.map((t) => t.tag));

  if (tagSet.size === 0) return [];

  // Find high-importance memories from other projects with overlapping tags
  const placeholders = [...tagSet].map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT m.id, m.uid, m.title, m.body, m.project, m.importance, m.type, m.tags
       FROM memories m, json_each(m.tags) AS jt
       WHERE m.project IS NOT NULL AND m.project != ?
         AND m.importance >= 1.2
         AND jt.value IN (${placeholders})
       ORDER BY m.importance DESC
       LIMIT ?`
    )
    .all(project, ...tagSet, limit * 2) as {
    id: number; uid: string; title: string; body: string; project: string; importance: number; type: string; tags: string;
  }[];

  for (const row of rows) {
    const rowTags: string[] = JSON.parse(row.tags || "[]");
    const sharedTags = rowTags.filter((t) => tagSet.has(t));
    if (sharedTags.length === 0) continue;
    suggestions.push({
      memory_uid: row.uid,
      title: row.title,
      source_project: row.project,
      target_project: project,
      reason: `Shared tags: ${sharedTags.join(", ")}`,
      relevance_score: Math.min(1, row.importance / 2 + sharedTags.length * 0.1),
    });
    if (suggestions.length >= limit) break;
  }

  return suggestions;
}

/**
 * review_after hem SQLite'ın varsayılan "YYYY-MM-DD HH:MM:SS" biçimini hem de ISO 8601
 * (offset/Z'li) girdiyi kabul eder — schema formatı zorlamaz (memory_save/memory_update
 * herhangi bir agent'tan gelebilir).
 */
function parseReviewAfter(ts: string): number {
  const looksIso = ts.includes("T") || /[zZ]$/.test(ts) || /[+-]\d{2}:\d{2}$/.test(ts);
  return Date.parse(looksIso ? ts : `${ts.replace(" ", "T")}Z`);
}

/** ADR-006 faz 2: review_after geçmişte kalmışsa görünür bir uyarı üretir; boşsa "". */
function reviewAfterWarning(reviewAfter: string | null | undefined): string {
  if (!reviewAfter) return "";
  const dueMs = parseReviewAfter(reviewAfter);
  if (!Number.isFinite(dueMs) || dueMs >= Date.now()) return "";
  const days = Math.floor((Date.now() - dueMs) / 86_400_000);
  return ` ⚠ ${days} gündür doğrulanmadı`;
}

/** Hook çıktısı: agent bağlamına enjekte edilecek kompakt markdown. Boşsa "". */
export function formatRecall(result: RecallResult): string {
  if (result.memories.length === 0 && result.chunks.length === 0) return "";
  const scope = result.project ? ` (aktif proje: ${result.project})` : "";
  const lines: string[] = ["<hub-recall>", `Hub hafızasından bu mesajla yüksek benzerlikli kayıtlar${scope}:`];
  for (const m of result.memories) {
    const compact = m.canonical_summary ?? m.body;
    const body = compact.length > 400 ? compact.slice(0, 400) + "…" : compact;
    const normalized = m.canonical_summary ? " | canonical-summary" : "";
    const staleTag = reviewAfterWarning(m.review_after);
    lines.push(`- [memory #${m.id} | ${m.type}${m.project ? ` | ${m.project}` : ""}${normalized}] ${m.title}: ${body}${staleTag}`);
    // Bağlantılı kayıtlar tek satır başlık olarak gelir — agent derine inmek isterse id ile çeker.
    // Tek sorgu: listMemoryRelations, resolveRelated'ın (memories.related JSON alanı) ürettiği
    // 'related' tipli kenarları da içerir (legacy alan bu tabloya projekte edilir) — ayrı bir
    // resolveRelated çağrısına gerek yok.
    const relations = listMemoryRelations({ memory_id: m.id, active_at: new Date().toISOString(), limit: 12 });
    const rel = relations
      .filter((relation) => relation.relation_type === "related")
      .slice(0, 3)
      .map((relation) => {
        const outgoing = relation.from_id === m.id;
        return { id: outgoing ? relation.to_id : relation.from_id, title: outgoing ? relation.to_title : relation.from_title };
      });
    if (rel.length > 0) lines.push(`  ilgili: ${rel.map((r) => `#${r.id} ${r.title}`).join(" · ")}`);
    const typed = relations.filter((relation) => relation.relation_type !== "related").slice(0, 3);
    if (typed.length > 0) {
      lines.push(
        `  ilişkiler: ${typed
          .map((relation) => {
            const outgoing = relation.from_id === m.id;
            const otherId = outgoing ? relation.to_id : relation.from_id;
            const otherTitle = outgoing ? relation.to_title : relation.from_title;
            const arrow = outgoing ? "→" : "←";
            return `${relation.relation_type}${arrow}#${otherId} ${otherTitle} (${relation.confidence.toFixed(2)})`;
          })
          .join(" · ")}`
      );
    }
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
  // Advisory presence: kilit değil, sadece "kim ne üzerinde çalışıyor" sinyali — en üstte,
  // agent görev planlamaya başlamadan önce görsün.
  lines.push(...formatPresenceLines(agentActive(proj.name)));
  if (proj.summary) lines.push(`Özet: ${proj.summary}`);
  if (proj.current_focus) lines.push(`Mevcut odak: ${proj.current_focus}`);
  if (typeof proj.architecture === "string" && proj.architecture) lines.push(`Mimari: ${proj.architecture}`);
  // Map verisi serbest JSON'dan gelir — diziler dizi olmayabilir; hook'u düşürme.
  const modules = Array.isArray(proj.modules) ? proj.modules.slice(0, 12) : [];
  if (modules.length > 0) {
    lines.push(
      `Kod haritası:\n${modules
        .map((m) => `  - ${m?.name ?? "?"} (${m?.path ?? "?"}): ${m?.purpose ?? ""}`)
        .join("\n")}`
    );
  }
  const entries = proj.entry_points && typeof proj.entry_points === "object" ? Object.entries(proj.entry_points) : [];
  if (entries.length > 0) lines.push(`Giriş noktaları: ${entries.map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  const cmds = proj.commands && typeof proj.commands === "object" ? Object.entries(proj.commands) : [];
  if (cmds.length > 0) lines.push(`Komutlar: ${cmds.map(([k, v]) => `${k}: \`${v}\``).join(" · ")}`);
  const conventions = Array.isArray(proj.conventions) ? proj.conventions.slice(0, 6) : [];
  if (conventions.length > 0) lines.push(`Konvansiyonlar:\n${conventions.map((c) => `  - ${c}`).join("\n")}`);
  const steps = Array.isArray(proj.next_steps) ? proj.next_steps.slice(0, 5) : [];
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
  // Agent Intelligence Platform discoverability: bridge çağrısında belirli bir agent
  // kimliği yok (yalnızca cwd/proje çözülür) — bu yüzden görev sayısı için agent-özel
  // agentTasks() değil proje kuyruğu (taskQueue) kullanılır; mesaj sayısı için de
  // presence.ts'in varsayılan agent kimliğiyle (agentCheckin'deki "claude-code" fallback)
  // aynı jenerik kimlik kullanılır. En fazla 2 satır, sadece sayı > 0 iken.
  const pendingTaskCount = taskQueue(proj.name).length;
  if (pendingTaskCount > 0) {
    lines.push(`📋 Kuyrukta ${pendingTaskCount} bekleyen görev var (task_list claimed_by=<agent>)`);
  }
  const unread = unreadCount("claude-code");
  if (unread > 0) {
    lines.push(`✉ ${unread} okunmamış mesajın var (agent_inbox)`);
  }
  lines.push("</hub-bridge>");
  return lines.join("\n");
}
