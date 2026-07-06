import { searchMemories } from "./memories.js";
import { searchChunks } from "./documents.js";
import type { ScoredChunk, ScoredMemory } from "./types.js";

export interface RecallResult {
  memories: ScoredMemory[];
  chunks: ScoredChunk[];
}

/** Auto-recall: bir mesaj için ilgili hafıza + RAG parçalarını döner. */
export async function recall(query: string, project?: string): Promise<RecallResult> {
  const [memories, chunks] = await Promise.all([
    searchMemories(query, { project, limit: 4 }),
    searchChunks(query, { project, limit: 3 }),
  ]);
  return { memories, chunks };
}

/** Hook çıktısı: agent bağlamına enjekte edilecek kompakt markdown. Boşsa "". */
export function formatRecall(result: RecallResult): string {
  if (result.memories.length === 0 && result.chunks.length === 0) return "";
  const lines: string[] = ["<hub-recall>", "Hub hafızasından bu mesajla ilgili kayıtlar:"];
  for (const m of result.memories) {
    const body = m.body.length > 400 ? m.body.slice(0, 400) + "…" : m.body;
    lines.push(`- [memory #${m.id} | ${m.type}${m.project ? ` | ${m.project}` : ""}] ${m.title}: ${body}`);
  }
  for (const c of result.chunks) {
    const text = c.text.length > 400 ? c.text.slice(0, 400) + "…" : c.text;
    lines.push(`- [doc "${c.document_title}"${c.heading ? ` > ${c.heading}` : ""}] ${text}`);
  }
  lines.push("Gerekirse memory_search / rag_search ile devamını çekebilirsin.", "</hub-recall>");
  return lines.join("\n");
}
