/**
 * Knowledge compaction: summarize old sessions, decisions, and memories
 * into concise reference documents. Uses local_llm for zero-cost summarization
 * with Gemini fallback.
 */
import { getDb, NOW_MS } from "./db.js";
import { notifyWrite } from "./events.js";
import { recentSessionLogs } from "./sessions.js";
import { searchMemories } from "./memories.js";
import { addDocument } from "./documents.js";
import { localLlm, machinesStatus } from "./compute.js";
import { getProject } from "./projects.js";
import type { SessionLog } from "./types.js";

/** Check if local LLM is available for summarization. */
async function localLlmAvailable(): Promise<boolean> {
  try {
    const status = await machinesStatus();
    return status.some((m) => m.lmstudio?.online || m.ollama?.online);
  } catch {
    return false;
  }
}

/** Summarize text using local LLM or return original if unavailable. */
async function summarize(text: string, prompt: string): Promise<string> {
  const canLocal = await localLlmAvailable();
  if (!canLocal) {
    // Return truncated text as fallback
    return text.length > 2000 ? text.slice(0, 2000) + "..." : text;
  }
  try {
    const result = await localLlm({
      messages: [
        { role: "system", content: "You are a concise summarizer. Output only the summary, no preamble." },
        { role: "user", content: `${prompt}\n\n${text}` },
      ],
      max_tokens: 1000,
    });
    return result.content ?? text;
  } catch {
    return text.length > 2000 ? text.slice(0, 2000) + "..." : text;
  }
}

/** Compact recent session logs into a summary document. */
export async function compactSessions(
  project: string,
  opts: { count?: number; archiveOld?: boolean } = {}
): Promise<{ document_uid: string; sessions_compacted: number }> {
  const count = opts.count ?? 20;
  const sessions = recentSessionLogs({ project, limit: count });
  if (sessions.length === 0) {
    throw new Error(`No sessions found for project: ${project}`);
  }

  // Build session text
  const sessionText = sessions
    .map((s, i) => `## Session ${i + 1} (${s.created_at}${s.source ? `, ${s.source}` : ""})\n${s.summary}`)
    .join("\n\n");

  const summaryPrompt = `Summarize these ${sessions.length} development sessions for project "${project}" into a concise history document. Focus on: key decisions made, problems solved, current state, and remaining work.`;

  const summary = await summarize(sessionText, summaryPrompt);

  // Create the compacted document
  const doc = await addDocument({
    title: `${project} - Session History (compacted ${new Date().toISOString().slice(0, 10)})`,
    text: `# ${project} Session History\n\n*Compacted from ${sessions.length} sessions on ${new Date().toISOString()}*\n\n${summary}`,
    project,
    kind: "status",
    source: "compaction",
  });

  // Optionally tag old sessions as compacted — non-destructively. The original
  // summary text is left intact (it's syncable, historical record); compacted_at
  // is just a marker for readers that want to skip already-summarized sessions.
  if (opts.archiveOld !== false && sessions.length > 5) {
    const db = getDb();
    const oldSessionIds = sessions.slice(5).map((s) => s.id);
    const placeholders = oldSessionIds.map(() => "?").join(",");
    db.prepare(
      `UPDATE session_logs SET compacted_at = ${NOW_MS} WHERE id IN (${placeholders})`
    ).run(...oldSessionIds);
    notifyWrite();
  }

  return { document_uid: doc.uid, sessions_compacted: sessions.length };
}

/** Compact project decisions into a summary document. */
export async function compactDecisions(project: string): Promise<{ document_uid: string; decisions_compacted: number }> {
  const decisions = await searchMemories("decision", { project, type: "decision", limit: 50 });
  if (decisions.length === 0) {
    throw new Error(`No decisions found for project: ${project}`);
  }

  const decisionText = decisions
    .map((d, i) => `## Decision ${i + 1}: ${d.title}\n${d.body}\n*(importance: ${d.importance}, ${d.created_at})*`)
    .join("\n\n");

  const summaryPrompt = `Summarize these ${decisions.length} project decisions into a concise decision log. Group by theme, highlight the most important decisions, and note any superseded decisions.`;

  const summary = await summarize(decisionText, summaryPrompt);

  const doc = await addDocument({
    title: `${project} - Decision Log (compacted ${new Date().toISOString().slice(0, 10)})`,
    text: `# ${project} Decision Log\n\n*Compacted from ${decisions.length} decisions on ${new Date().toISOString()}*\n\n${summary}`,
    project,
    kind: "decision",
    source: "compaction",
  });

  return { document_uid: doc.uid, decisions_compacted: decisions.length };
}

/** Full project distillation: sessions + decisions + old memories into one reference doc. */
export async function distillProject(project: string): Promise<{
  document_uid: string;
  sessions_compacted: number;
  decisions_compacted: number;
  memories_referenced: number;
}> {
  const projectMap = getProject(project);
  const sessions = recentSessionLogs({ project, limit: 30 });
  const decisions = await searchMemories("decision", { project, type: "decision", limit: 30 });
  const howtos = await searchMemories("howto", { project, type: "howto", limit: 20 });

  // Build comprehensive text
  const sections: string[] = [];

  if (projectMap) {
    sections.push(`## Project Overview\n${projectMap.summary ?? ""}\n\nCurrent focus: ${projectMap.current_focus ?? "N/A"}`);
    if (projectMap.next_steps?.length) {
      sections.push(`### Next Steps\n${projectMap.next_steps.map((s) => `- ${s}`).join("\n")}`);
    }
  }

  if (sessions.length > 0) {
    const sessionSummary = sessions.slice(0, 10).map((s) => `- ${s.created_at}: ${s.summary.slice(0, 200)}`).join("\n");
    sections.push(`## Recent Sessions (${sessions.length} total)\n${sessionSummary}`);
  }

  if (decisions.length > 0) {
    const decisionSummary = decisions.slice(0, 15).map((d) => `- **${d.title}**: ${d.body.slice(0, 150)}`).join("\n");
    sections.push(`## Key Decisions (${decisions.length} total)\n${decisionSummary}`);
  }

  if (howtos.length > 0) {
    const howtoSummary = howtos.slice(0, 10).map((h) => `- **${h.title}**: ${h.body.slice(0, 150)}`).join("\n");
    sections.push(`## How-Tos & Procedures (${howtos.length} total)\n${howtoSummary}`);
  }

  const fullText = sections.join("\n\n");
  const distillPrompt = `Create a comprehensive but concise project reference document for "${project}". This should serve as a quick-start guide for any agent or developer joining the project. Include: overview, key decisions, current state, procedures, and next steps.`;

  const distilled = await summarize(fullText, distillPrompt);

  const doc = await addDocument({
    title: `${project} - Project Reference (distilled ${new Date().toISOString().slice(0, 10)})`,
    text: `# ${project} Project Reference\n\n*Distilled on ${new Date().toISOString()}*\n\n${distilled}`,
    project,
    kind: "reference",
    source: "distillation",
  });

  return {
    document_uid: doc.uid,
    sessions_compacted: sessions.length,
    decisions_compacted: decisions.length,
    memories_referenced: howtos.length,
  };
}

/** Get compaction statistics for a project. */
export function compactionStats(project: string): {
  session_count: number;
  decision_count: number;
  howto_count: number;
  last_compaction: string | null;
} {
  const db = getDb();

  const sessionCount = (
    db.prepare("SELECT COUNT(*) AS n FROM session_logs WHERE project = ?").get(project) as { n: number }
  ).n;

  const decisionCount = (
    db.prepare("SELECT COUNT(*) AS n FROM memories WHERE project = ? AND type = 'decision'").get(project) as { n: number }
  ).n;

  const howtoCount = (
    db.prepare("SELECT COUNT(*) AS n FROM memories WHERE project = ? AND type = 'howto'").get(project) as { n: number }
  ).n;

  const lastCompaction = (
    db
      .prepare("SELECT created_at FROM documents WHERE project = ? AND source IN ('compaction', 'distillation') ORDER BY created_at DESC LIMIT 1")
      .get(project) as { created_at: string } | undefined
  )?.created_at ?? null;

  return { session_count: sessionCount, decision_count: decisionCount, howto_count: howtoCount, last_compaction: lastCompaction };
}
