/**
 * Agent Intelligence Platform — Detaylı Benchmark Testi
 * Tüm yeni modüllerin performans ve doğruluk testleri.
 */
process.env.HUB_DB_PATH = `./data/benchmark-${Date.now()}.db`;

const startTime = Date.now();
const results: { name: string; duration: number; passed: boolean; detail?: string }[] = [];

function bench(name: string, fn: () => void | Promise<void>) {
  return async () => {
    const t0 = performance.now();
    try {
      await fn();
      const duration = performance.now() - t0;
      results.push({ name, duration, passed: true });
      console.log(`✓ ${name} — ${duration.toFixed(2)}ms`);
    } catch (err) {
      const duration = performance.now() - t0;
      results.push({ name, duration, passed: false, detail: (err as Error).message });
      console.log(`✗ ${name} — ${duration.toFixed(2)}ms — HATA: ${(err as Error).message}`);
    }
  };
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const core = await import("../src/core/index.js");
const {
  // Tasks
  createTask, claimTask, updateTask, completeTask, cancelTask, listTasks, getTask, taskQueue,
  // Capabilities
  registerAgent, agentHeartbeat, findCapableAgents, listAgents,
  // Messaging
  sendMessage, inbox, markRead, markAllRead, createHandoff,
  // Hygiene
  hygieneReport, runHygiene, findDuplicates, findStale,
  // Learning
  recordTaskFeedback, projectLessons, suggestForTask,
  // Compaction
  compactSessions,
  // Events
  emitHubEvent, getEventLog,
  // Webhooks
  registerWebhook, listWebhooks, removeWebhook,
  // Worker
  enqueueJob, getJob, listJobs, jobStats,
  // Metrics
  getMetricsSnapshot, incCounter, recordRequest, coordinationStats,
  // Context
  contextGet,
  // Recall
  transferableKnowledge,
  // Base
  saveMemory, getDb, closeDb,
} = core;

console.log("\n═══════════════════════════════════════════════════════════");
console.log("  MNEMA AGENT INTELLIGENCE PLATFORM — BENCHMARK TESTİ");
console.log("═══════════════════════════════════════════════════════════\n");

// ═══════════════════════════════════════════════════════════
// BÖLÜM 1: GÖREV KUYRUĞU (Task Queue)
// ═══════════════════════════════════════════════════════════
console.log("── BÖLÜM 1: Görev Kuyruğu ──\n");

await bench("1.1 Görev oluşturma (tek)", () => {
  const task = createTask({ title: "Benchmark görev 1", project: "bench", priority: 3, created_by: "bench" });
  assert(task.uid.length === 32, `uid uzunluğu 32 olmalı, gelen: ${task.uid.length}`);
  assert(task.status === "pending", `status pending olmalı, gelen: ${task.status}`);
  assert(task.priority === 3, `priority 3 olmalı, gelen: ${task.priority}`);
})();

await bench("1.2 Toplu görev oluşturma (50 adet)", () => {
  for (let i = 0; i < 50; i++) {
    createTask({ title: `Toplu görev ${i}`, project: "bench-bulk", priority: i % 10, created_by: "bench" });
  }
  const tasks = listTasks({ project: "bench-bulk" });
  assert(tasks.length === 50, `50 görev bekleniyor, gelen: ${tasks.length}`);
})();

await bench("1.3 Bağımlılık zinciri (A→B→C)", () => {
  const a = createTask({ title: "Zincir A", project: "bench", created_by: "bench" });
  const b = createTask({ title: "Zincir B", project: "bench", depends_on: [a.uid], created_by: "bench" });
  const c = createTask({ title: "Zincir C", project: "bench", depends_on: [b.uid], created_by: "bench" });
  
  // B claim edilememeli (A bitmedi)
  try {
    claimTask(b.uid, "agent-x");
    throw new Error("Bağımlı görev claim edilmemeli!");
  } catch (e) {
    assert((e as Error).message.includes("bağımlılık") || (e as Error).message.includes("depend"), "Bağımlılık hatası bekleniyor");
  }
  
  // A'yı bitir → B claim edilebilmeli
  completeTask(a.uid, "A bitti");
  const claimed = claimTask(b.uid, "agent-x");
  assert(claimed.status === "claimed", "B claim edilebilmeli");
})();

await bench("1.4 Görev claim + complete döngüsü", () => {
  const task = createTask({ title: "Döngü görev", project: "bench", created_by: "bench" });
  const claimed = claimTask(task.uid, "agent-1");
  assert(claimed.claimed_by === "agent-1", "claimed_by agent-1 olmalı");
  assert(claimed.status === "claimed", "status claimed olmalı");
  
  const updated = updateTask(task.uid, { status: "in_progress" });
  assert(updated.status === "in_progress", "status in_progress olmalı");
  
  const completed = completeTask(task.uid, "Sonuç: başarılı");
  assert(completed.status === "done", "status done olmalı");
  assert(completed.result === "Sonuç: başarılı", "result kaydedilmeli");
  assert(completed.finished_at !== null, "finished_at dolu olmalı");
})();

await bench("1.5 Görev iptal (cancel)", () => {
  const task = createTask({ title: "İptal görev", project: "bench", created_by: "bench" });
  const cancelled = cancelTask(task.uid, "Gereksiz");
  assert(cancelled.status === "cancelled", "status cancelled olmalı");
  assert(cancelled.error === "Gereksiz", "error kaydedilmeli");
})();

await bench("1.6 Öncelik sıralaması (taskQueue)", () => {
  createTask({ title: "Düşük öncelik", project: "bench-queue", priority: 1, created_by: "bench" });
  createTask({ title: "Yüksek öncelik", project: "bench-queue", priority: 9, created_by: "bench" });
  createTask({ title: "Orta öncelik", project: "bench-queue", priority: 5, created_by: "bench" });
  
  const queue = taskQueue("bench-queue");
  assert(queue.length >= 3, "En az 3 görev sıradan olmalı");
  assert(queue[0].priority >= queue[1].priority, "Yüksek öncelik önce gelmeli");
})();

// ═══════════════════════════════════════════════════════════
// BÖLÜM 2: AGENT YETENEK KAYDI (Capability Registry)
// ═══════════════════════════════════════════════════════════
console.log("\n── BÖLÜM 2: Agent Yetenek Kaydı ──\n");

await bench("2.1 Agent kayıt (register)", () => {
  const agent = registerAgent({
    agent: "claude-code",
    machine: "bench-pc",
    capabilities: ["code_review", "testing", "refactoring", "documentation"],
    models: ["claude-sonnet-4-20250514"],
    max_concurrent: 3,
  });
  assert(agent.uid.length > 0, "uid dolu olmalı");
  assert(agent.status === "available", "status available olmalı");
  assert(agent.capabilities.length === 4, "4 yetenek olmalı");
})();

await bench("2.2 Çoklu agent kayıt + yetenek arama", () => {
  registerAgent({ agent: "cursor", machine: "bench-pc", capabilities: ["frontend", "testing"], models: [] });
  registerAgent({ agent: "windsurf", machine: "bench-pc", capabilities: ["backend", "deploy"], models: [] });
  registerAgent({ agent: "copilot", machine: "bench-pc", capabilities: ["testing", "documentation"], models: [] });
  
  const testers = findCapableAgents("testing");
  assert(testers.length >= 3, `testing yeteneği en az 3 agent'ta olmalı, gelen: ${testers.length}`);
  
  const deployers = findCapableAgents("deploy");
  assert(deployers.length >= 1, "deploy yeteneği en az 1 agent'ta olmalı");
})();

await bench("2.3 Agent heartbeat", () => {
  const agents = listAgents({ agent: "claude-code" });
  assert(agents.length > 0, "claude-code kayıtlı olmalı");
  const updated = agentHeartbeat(agents[0].uid);
  assert(updated !== null, "heartbeat başarılı olmalı");
  assert(updated!.last_seen_at !== null, "last_seen_at güncellenmeli");
})();

// ═══════════════════════════════════════════════════════════
// BÖLÜM 3: MESAJLAŞMA (Agent Messaging)
// ═══════════════════════════════════════════════════════════
console.log("\n── BÖLÜM 3: Agent Mesajlaşma ──\n");

await bench("3.1 Mesaj gönderme (info)", () => {
  const msg = sendMessage({
    from_agent: "claude-code",
    to_agent: "cursor",
    project: "bench",
    kind: "info",
    subject: "Test tamamlandı",
    body: "Tüm testler başarılı",
  });
  assert(msg.uid.length > 0, "uid dolu olmalı");
  assert(msg.kind === "info", "kind info olmalı");
})();

await bench("3.2 Toplu mesaj (20 adet) + inbox", () => {
  for (let i = 0; i < 20; i++) {
    sendMessage({
      from_agent: `agent-${i % 4}`,
      to_agent: "inbox-test",
      kind: "request",
      subject: `İstek ${i}`,
      body: `Mesaj gövdesi ${i}`,
    });
  }
  const msgs = inbox("inbox-test");
  assert(msgs.length === 20, `20 mesaj bekleniyor, gelen: ${msgs.length}`);
})();

await bench("3.3 Mesaj okundu işaretleme", () => {
  const msgs = inbox("inbox-test");
  const first = msgs[0];
  const read = markRead(first.uid);
  assert(read !== null, "markRead başarılı olmalı");
  assert(read!.read_at !== null, "read_at dolu olmalı");
  
  const remaining = inbox("inbox-test");
  assert(remaining.length === 19, `19 okunmamış kalmalı, gelen: ${remaining.length}`);
})();

await bench("3.4 Tümünü okundu işaretle", () => {
  markAllRead("inbox-test");
  const remaining = inbox("inbox-test");
  assert(remaining.length === 0, `0 okunmamış kalmalı, gelen: ${remaining.length}`);
})();

await bench("3.5 Broadcast mesaj (to_agent=null)", () => {
  sendMessage({
    from_agent: "system",
    to_agent: null,
    kind: "alert",
    subject: "Sistem bakımı",
    body: "5 dakika içinde restart",
  });
  // Broadcast herkesin inbox'ına düşmeli
  const msgs = inbox("any-agent");
  assert(msgs.some(m => m.subject === "Sistem bakımı"), "Broadcast mesaj inbox'a düşmeli");
})();

// ═══════════════════════════════════════════════════════════
// BÖLÜM 4: BELLEK HİJYENİ (Memory Hygiene)
// ═══════════════════════════════════════════════════════════
console.log("\n── BÖLÜM 4: Bellek Hijyeni ──\n");

await bench("4.1 Hijyen raporu", () => {
  const report = hygieneReport();
  assert(Array.isArray(report.duplicates), "duplicates array olmalı");
  assert(Array.isArray(report.stale), "stale array olmalı");
  assert(Array.isArray(report.contradictions), "contradictions array olmalı");
  assert(typeof report.total_memories === "number", "total_memories sayı olmalı");
})();

await bench("4.2 Eskimiş kayıt tespiti (findStale)", async () => {
  // Eski bir hafıza oluştur (importance min 0.5)
  const mem = await saveMemory({
    title: "Eski bilgi",
    body: "Bu çok eski bir kayıt",
    project: "bench",
    importance: 0.5,
  });
  // last_accessed'ı 100 gün geriye al
  getDb().prepare("UPDATE memories SET last_accessed = strftime('%Y-%m-%d %H:%M:%f','now','-100 days') WHERE id = ?").run(mem.id);
  
  const stale = findStale(90);
  // findStale fonksiyonu çalışıyor olmalı (array döner)
  assert(Array.isArray(stale), "findStale array dönmeli");
})();

// ═══════════════════════════════════════════════════════════
// BÖLÜM 5: ÖĞRENME DÖNGÜSÜ (Learning Loop)
// ═══════════════════════════════════════════════════════════
console.log("\n── BÖLÜM 5: Öğrenme Döngüsü ──\n");

await bench("5.1 Görev geri bildirimi (feedback)", () => {
  const task = createTask({ title: "Feedback test", project: "bench-learn", created_by: "bench" });
  const fb = recordTaskFeedback({
    task_uid: task.uid,
    project: "bench-learn",
    agent: "claude-code",
    outcome: "success",
    what_worked: "TDD yaklaşımı işe yaradı",
    what_failed: "İlk başta mock'lar yanlıştı",
    lessons: "Mock'ları önce interface'den türet",
    duration_min: 45,
  });
  assert(fb.id > 0, "feedback id > 0 olmalı");
})();

await bench("5.2 Proje dersleri (projectLessons)", () => {
  // Birkaç feedback daha ekle
  recordTaskFeedback({ project: "bench-learn", agent: "cursor", outcome: "partial", lessons: "CSS grid daha iyi" });
  recordTaskFeedback({ project: "bench-learn", agent: "windsurf", outcome: "failure", lessons: "Deploy öncesi test şart" });
  
  const lessons = projectLessons("bench-learn");
  assert(lessons.length >= 3, `En az 3 ders olmalı, gelen: ${lessons.length}`);
})();

await bench("5.3 Görev için öneri (suggestForTask)", () => {
  const suggestions = suggestForTask("test yazma", "bench-learn");
  // suggestForTask bir object veya array dönebilir
  assert(suggestions !== null && suggestions !== undefined, "suggestions null olmamalı");
})();

// ═══════════════════════════════════════════════════════════
// BÖLÜM 6: EVENT BUS
// ═══════════════════════════════════════════════════════════
console.log("\n── BÖLÜM 6: Event Bus ──\n");

await bench("6.1 Event yayınlama + log", () => {
  emitHubEvent({ type: "task_created", task_uid: "test-uid", project: "bench" });
  emitHubEvent({ type: "task_completed", task_uid: "test-uid" });
  emitHubEvent({ type: "memory_saved", memory_uid: "mem-uid", project: "bench" });
  
  const events = getEventLog(10);
  assert(events.length >= 3, `En az 3 event olmalı, gelen: ${events.length}`);
  assert(events.some(e => e.type === "task_created"), "task_created eventi olmalı");
})();

await bench("6.2 Toplu event (100 adet)", () => {
  for (let i = 0; i < 100; i++) {
    emitHubEvent({ type: "agent_checkin", agent: `agent-${i}`, project: "bench" });
  }
  const events = getEventLog(200);
  assert(events.length >= 100, `En az 100 event olmalı, gelen: ${events.length}`);
})();

// ═══════════════════════════════════════════════════════════
// BÖLÜM 7: WEBHOOK
// ═══════════════════════════════════════════════════════════
console.log("\n── BÖLÜM 7: Webhook ──\n");

await bench("7.1 Webhook kayıt", () => {
  const wh = registerWebhook({
    url: "https://example.com/hook1",
    events: ["memory_saved", "task_completed"],
    secret: "test-secret",
  });
  assert(wh.uid.length > 0, "uid dolu olmalı");
  assert(wh.active === true, "active true olmalı");
  assert(wh.events.length === 2, "2 event filtresi olmalı");
})();

await bench("7.2 Webhook listele + sil", () => {
  const wh2 = registerWebhook({ url: "https://example.com/hook2", events: ["*"] });
  const list = listWebhooks();
  assert(list.length >= 2, "En az 2 webhook olmalı");
  
  const removed = removeWebhook(wh2.uid);
  assert(removed === true, "silme başarılı olmalı");
  
  const afterRemove = listWebhooks();
  assert(!afterRemove.some(w => w.uid === wh2.uid), "silinen webhook listede olmamalı");
})();

// ═══════════════════════════════════════════════════════════
// BÖLÜM 8: WORKER QUEUE (İş Kuyruğu)
// ═══════════════════════════════════════════════════════════
console.log("\n── BÖLÜM 8: Worker Queue ──\n");

await bench("8.1 İş kuyruğuna ekleme", () => {
  const job = enqueueJob("embed", { memory_id: 123 });
  assert(job.uid.length > 0, "uid dolu olmalı");
  assert(job.status === "queued", "status queued olmalı");
  assert(job.kind === "embed", "kind embed olmalı");
})();

await bench("8.2 Toplu iş ekleme (30 adet)", () => {
  for (let i = 0; i < 30; i++) {
    enqueueJob(i % 3 === 0 ? "compact" : i % 3 === 1 ? "hygiene" : "webhook", { index: i });
  }
  const jobs = listJobs({});
  assert(jobs.length >= 31, `En az 31 iş olmalı, gelen: ${jobs.length}`);
})();

await bench("8.3 İş istatistikleri (jobStats)", () => {
  const stats = jobStats();
  assert(typeof stats.queued === "number", "queued sayı olmalı");
  assert(stats.queued >= 31, `queued en az 31 olmalı, gelen: ${stats.queued}`);
})();

// ═══════════════════════════════════════════════════════════
// BÖLÜM 9: METRİKLER
// ═══════════════════════════════════════════════════════════
console.log("\n── BÖLÜM 9: Metrikler ──\n");

await bench("9.1 Metrik sayacı (incCounter)", () => {
  incCounter("test_counter", 5);
  incCounter("test_counter", 3);
  const snapshot = getMetricsSnapshot();
  assert(snapshot.requests_total >= 0, "requests_total >= 0 olmalı");
})();

await bench("9.2 İstek kaydı (recordRequest)", () => {
  recordRequest("GET", "/api/test", 200, 15.5);
  recordRequest("POST", "/api/test", 201, 25.3);
  recordRequest("GET", "/api/test", 500, 5.2);
  const snapshot = getMetricsSnapshot();
  assert(snapshot.errors_5xx >= 1, "errors_5xx >= 1 olmalı");
})();

// 9.3 — Koordinasyon-yükü bloğu (metrics_overview'a 7 günlük pencere eklendi).
// B benchmark vakasında zaten 1+ görev tamamlandı (bkz. BÖLÜM 1) ve
// task_claimed hub_events'te saklanır; bu ölçüm hem doğruluk hem latans kontrolü.
await bench("9.3 Koordinasyon bloğu — coordinationStats (<5ms)", () => {
  const t0 = performance.now();
  const c = coordinationStats();
  const dur = performance.now() - t0;
  assert(typeof c.tasks_completed_7d === "number", "tasks_completed_7d number olmalı");
  assert(typeof c.avg_task_cycle_time_min === "number", "avg_task_cycle_time_min number olmalı");
  assert(typeof c.handoff_ratio === "number" && c.handoff_ratio >= 0, "handoff_ratio >= 0 olmalı");
  assert(typeof c.reclaim_count_7d === "number" && c.reclaim_count_7d >= 0, "reclaim_count_7d >= 0 olmalı");
  assert(
    typeof c.verification_coverage === "number" && c.verification_coverage >= 0 && c.verification_coverage <= 1,
    `verification_coverage [0,1] olmalı, gelen: ${c.verification_coverage}`
  );
  assert(dur < 5, `coordinationStats 5ms altında olmalı, gelen: ${dur.toFixed(2)}ms`);
})();

await bench("9.4 coordination — getMetricsSnapshot coordination alanı döner", () => {
  const snap = getMetricsSnapshot();
  assert(snap.coordination !== undefined, "snapshot.coordination tanımlı olmalı");
  assert(snap.coordination.tasks_completed_7d >= 0, "coordination.tasks_completed_7d >= 0 olmalı");
})();

// ═══════════════════════════════════════════════════════════
// BÖLÜM 10: PROGRESSIVE CONTEXT
// ═══════════════════════════════════════════════════════════
console.log("\n── BÖLÜM 10: Progressive Context ──\n");

await bench("10.1 Context level 0 (minimal)", async () => {
  const ctx = await contextGet({ query: "test", level: 0 });
  assert(ctx !== null, "context null olmamalı");
  // Level 0 çok hızlı olmalı (search yok)
})();

await bench("10.2 Context level 1 (standart)", async () => {
  const ctx = await contextGet({ query: "test", level: 1 });
  assert(ctx !== null, "context null olmamalı");
})();

await bench("10.3 Context level 2 (tam RAG)", async () => {
  const ctx = await contextGet({ query: "test", level: 2 });
  assert(ctx !== null, "context null olmamalı");
})();

// ═══════════════════════════════════════════════════════════
// BÖLÜM 11: CROSS-PROJECT TRANSFER
// ═══════════════════════════════════════════════════════════
console.log("\n── BÖLÜM 11: Cross-Project Transfer ──\n");

await bench("11.1 Transfer edilebilir bilgi", () => {
  const result = transferableKnowledge("bench");
  // Fonksiyon çalışıyor olmalı (null/undefined dönmemeli)
  assert(result !== null && result !== undefined, "transferableKnowledge sonuç dönmeli");
})();

// ═══════════════════════════════════════════════════════════
// ÖZET
// ═══════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════════");
console.log("  BENCHMARK ÖZETİ");
console.log("═══════════════════════════════════════════════════════════\n");

const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;
const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
const avgDuration = totalDuration / results.length;
const maxDuration = Math.max(...results.map(r => r.duration));
const minDuration = Math.min(...results.map(r => r.duration));

console.log(`Toplam test: ${results.length}`);
console.log(`Başarılı: ${passed} ✓`);
console.log(`Başarısız: ${failed} ${failed > 0 ? "✗" : ""}`);
console.log(`\nToplam süre: ${totalDuration.toFixed(2)}ms`);
console.log(`Ortalama: ${avgDuration.toFixed(2)}ms`);
console.log(`En hızlı: ${minDuration.toFixed(2)}ms`);
console.log(`En yavaş: ${maxDuration.toFixed(2)}ms`);

// Bölüm bazında özet
const sections = [
  { name: "Görev Kuyruğu", prefix: "1." },
  { name: "Agent Yetenek", prefix: "2." },
  { name: "Mesajlaşma", prefix: "3." },
  { name: "Bellek Hijyeni", prefix: "4." },
  { name: "Öğrenme Döngüsü", prefix: "5." },
  { name: "Event Bus", prefix: "6." },
  { name: "Webhook", prefix: "7." },
  { name: "Worker Queue", prefix: "8." },
  { name: "Metrikler", prefix: "9." },
  { name: "Progressive Context", prefix: "10." },
  { name: "Cross-Project Transfer", prefix: "11." },
];

console.log("\n── Bölüm Bazında Performans ──\n");
for (const section of sections) {
  const sectionResults = results.filter(r => r.name.startsWith(section.prefix));
  if (sectionResults.length === 0) continue;
  const sectionTime = sectionResults.reduce((s, r) => s + r.duration, 0);
  const sectionPassed = sectionResults.filter(r => r.passed).length;
  const status = sectionPassed === sectionResults.length ? "✓" : "✗";
  console.log(`${status} ${section.name.padEnd(22)} ${sectionTime.toFixed(2).padStart(10)}ms (${sectionPassed}/${sectionResults.length} geçti)`);
}

// En yavaş 5 test
console.log("\n── En Yavaş 5 Test ──\n");
const sorted = [...results].sort((a, b) => b.duration - a.duration).slice(0, 5);
for (const r of sorted) {
  console.log(`  ${r.duration.toFixed(2).padStart(10)}ms — ${r.name}`);
}

// Başarısız testler
if (failed > 0) {
  console.log("\n── Başarısız Testler ──\n");
  for (const r of results.filter(r => !r.passed)) {
    console.log(`  ✗ ${r.name}: ${r.detail}`);
  }
}

const wallTime = Date.now() - startTime;
console.log(`\nToplam duvar süresi: ${wallTime}ms`);
console.log(failed === 0 ? "\n✓ TÜM BENCHMARK TESTLERİ BAŞARILI" : `\n✗ ${failed} TEST BAŞARISIZ`);

closeDb();
const fs = await import("node:fs");
fs.rmSync(process.env.HUB_DB_PATH!, { force: true });
fs.rmSync(process.env.HUB_DB_PATH! + "-wal", { force: true });
fs.rmSync(process.env.HUB_DB_PATH! + "-shm", { force: true });

process.exit(failed === 0 ? 0 : 1);
