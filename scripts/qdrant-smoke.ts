import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const requests: Array<{ method: string; url: string; body: unknown }> = [];
const collections = new Set<string>();
let failUpserts = true;
let failQueries = false;
let queryResultPoints: Array<{ id: number; score: number }> = [{ id: 1, score: 0.98 }];
let blockNextUpsert = false;
let releaseBlockedUpsert: (() => void) | null = null;
let signalBlockedUpsert: (() => void) | null = null;

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw ? JSON.parse(raw) as unknown : null;
  requests.push({ method: req.method ?? "", url: req.url ?? "", body });
  res.setHeader("content-type", "application/json");

  if (req.method === "GET" && req.url?.startsWith("/collections/")) {
    const name = req.url.split("/")[2];
    if (!collections.has(name)) {
      res.statusCode = 404;
      return void res.end(JSON.stringify({ status: "not found" }));
    }
    return void res.end(JSON.stringify({
      status: "ok",
      result: { config: { params: { vectors: { size: 3, distance: "Cosine" } } } },
    }));
  }
  if (req.method === "PUT" && /^\/collections\/[^/]+$/.test(req.url ?? "")) {
    collections.add((req.url ?? "").split("/")[2]);
    return void res.end(JSON.stringify({ status: "ok", result: true }));
  }
  if (req.method === "PUT" && req.url?.includes("/index?")) {
    return void res.end(JSON.stringify({ status: "ok", result: { status: "completed" } }));
  }
  if (req.method === "PUT" && req.url?.includes("/points?")) {
    if (failUpserts) {
      res.statusCode = 503;
      return void res.end(JSON.stringify({ status: "temporarily unavailable" }));
    }
    if (blockNextUpsert) {
      blockNextUpsert = false;
      signalBlockedUpsert?.();
      await new Promise<void>((resolve) => { releaseBlockedUpsert = resolve; });
    }
    return void res.end(JSON.stringify({ status: "ok", result: { status: "completed" } }));
  }
  if (req.method === "POST" && req.url?.includes("/points/query")) {
    if (failQueries) {
      res.statusCode = 503;
      return void res.end(JSON.stringify({ status: "query unavailable" }));
    }
    return void res.end(JSON.stringify({ status: "ok", result: { points: queryResultPoints } }));
  }
  if (req.method === "POST" && req.url?.includes("/points/count")) {
    const count = 1;
    return void res.end(JSON.stringify({ status: "ok", result: { count } }));
  }
  if (req.method === "POST" && req.url?.includes("/points/delete?")) {
    return void res.end(JSON.stringify({ status: "ok", result: { status: "completed" } }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ status: "unexpected route" }));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("fake Qdrant did not bind");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnema-qdrant-smoke-"));
process.env.HUB_DB_PATH = path.join(tempDir, "hub.db");
process.env.HUB_DEPLOYMENT_PROFILE = "personal";
process.env.HUB_VECTOR_BACKEND = "qdrant";
process.env.HUB_QDRANT_URL = `http://127.0.0.1:${address.port}`;
process.env.HUB_QDRANT_API_KEY = "fake-qdrant-key-for-contract-test";
process.env.HUB_QDRANT_COLLECTION_PREFIX = "mnema_smoke";
process.env.HUB_QDRANT_TIMEOUT_MS = "1000";
process.env.EMBEDDING_DIM = "3";
process.env.GEMINI_API_KEY = "";

// Exercise the additive migration path from the first outbox schema, which did
// not yet carry a concurrency revision.
const LegacyDatabase = (await import("better-sqlite3")).default;
const legacyDb = new LegacyDatabase(process.env.HUB_DB_PATH);
legacyDb.exec(`
  CREATE TABLE vector_outbox(
    entity TEXT NOT NULL,
    row_id INTEGER NOT NULL,
    operation TEXT NOT NULL,
    payload TEXT,
    embedding BLOB,
    generation TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(entity, row_id)
  )
`);
legacyDb.close();

const { closeDb, flushVectorOutbox, getDb, queueFullVectorProjection, vectorStore, verifyVectorProjectionParity } = await import("../src/core/index.js");

let failed = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failed++;
}

try {
  const db = getDb();
  check(
    "legacy outbox schema gains a monotonic revision",
    (db.prepare("PRAGMA table_info(vector_outbox)").all() as { name: string }[]).some((column) => column.name === "revision")
  );
  db.prepare(
    `INSERT INTO memories(uid, type, title, body, project, tags, source)
     VALUES ('qdrant-smoke-memory', 'decision', 'Qdrant contract', 'Durable projection test', 'ai-hub', '["scale","vector"]', 'smoke')`
  ).run();
  db.prepare(
    `INSERT INTO documents(id, uid, title, project, kind, enabled, is_current, valid_from, valid_to)
     VALUES (1, 'qdrant-smoke-document', 'Current runbook', 'ai-hub', 'runbook', 1, 1, '2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z')`
  ).run();
  db.prepare("INSERT INTO chunks(id, document_id, seq, heading, text) VALUES (1, 1, 0, 'Runbook', 'Current vector projection runbook')").run();
  const vector = Buffer.from(new Float32Array([1, 0, 0]).buffer);
  vectorStore.putMemory(1, "ai-hub", vector);
  vectorStore.putChunk(1, "ai-hub", true, true, "runbook", vector);
  check("Qdrant writes are durably queued", vectorStore.status().outbox_pending === 2);

  const failedFlush = await flushVectorOutbox();
  check(
    "remote failure keeps outbox row with retry state",
    failedFlush.failed === 2 && vectorStore.status().outbox_pending === 2 && vectorStore.status().outbox_failed === 2
  );

  db.prepare("UPDATE vector_outbox SET next_attempt_at='1970-01-01 00:00:00.000'").run();
  failUpserts = false;
  const successfulFlush = await flushVectorOutbox();
  check(
    "retry delivers idempotent upsert and clears outbox",
    successfulFlush.processed === 2 && vectorStore.status().outbox_pending === 0
  );
  check("projection is not trusted before a complete backfill", !vectorStore.status().projection_ready);

  const upsert = requests.find((request) => request.method === "PUT" && request.url.includes("/points?"))?.body as
    | { points?: Array<{ payload?: Record<string, unknown>; vector?: number[] }> }
    | undefined;
  const payload = upsert?.points?.[0]?.payload;
  check(
    "projection preserves native filter payload",
    payload?.project === "ai-hub" && payload?.type === "decision" && Array.isArray(payload?.tags) && payload?.generation !== undefined
  );
  check("projection preserves configured vector dimension", upsert?.points?.[0]?.vector?.length === 3);

  const rebuilt = queueFullVectorProjection();
  check("full projection rebuild is sourced from authoritative local vectors", rebuilt.memories === 1 && rebuilt.chunks === 1);
  const rebuildFlush = await flushVectorOutbox();
  check(
    "full projection rebuild establishes generation readiness",
    rebuildFlush.processed === 2 && vectorStore.status().outbox_pending === 0 && vectorStore.status().projection_ready
  );

  vectorStore.putMemory(1, "ai-hub", vector);
  queryResultPoints = [];
  const readYourWriteHits = await vectorStore.search("memory", vector, 3, { project: "ai-hub" });
  check("pending outbox preserves read-your-write via local merge", readYourWriteHits[0]?.id === 1);
  await flushVectorOutbox();
  queryResultPoints = [{ id: 1, score: 0.98 }];

  const updatedVector = Buffer.from(new Float32Array([0, 1, 0]).buffer);
  vectorStore.putMemory(1, "ai-hub", vector);
  blockNextUpsert = true;
  const blocked = new Promise<void>((resolve) => { signalBlockedUpsert = resolve; });
  const firstConcurrentFlush = flushVectorOutbox();
  await blocked;
  vectorStore.putMemory(1, "ai-hub", updatedVector);
  releaseBlockedUpsert?.();
  await firstConcurrentFlush;
  const queuedRevision = db.prepare(
    "SELECT revision, embedding FROM vector_outbox WHERE entity='memory' AND row_id=1"
  ).get() as { revision: number; embedding: Buffer } | undefined;
  check(
    "in-flight delivery cannot delete a newer outbox revision",
    queuedRevision?.revision === 2 && queuedRevision.embedding.equals(updatedVector)
  );
  queryResultPoints = [{ id: 1, score: 1 }];
  const staleRemoteHits = await vectorStore.search("memory", vector, 3, { project: "ai-hub" });
  check(
    "pending update uses the local vector score instead of a stale remote score",
    staleRemoteHits[0]?.id === 1 && staleRemoteHits[0].distance > 1
  );
  await flushVectorOutbox();
  const finalConcurrentUpsert = requests.filter(
    (request) => request.method === "PUT" && request.url.includes("_memories_") && request.url.includes("/points?")
  ).at(-1)?.body as { points?: Array<{ vector?: number[] }> } | undefined;
  check(
    "newer outbox revision is delivered after the in-flight write",
    vectorStore.status().outbox_pending === 0 && finalConcurrentUpsert?.points?.[0]?.vector?.[1] === 1
  );

  const hits = await vectorStore.search("memory", vector, 3, {
    project: "ai-hub",
    memoryType: "decision",
    memoryTag: "scale",
  });
  const query = requests.filter((request) => request.url.includes("/points/query")).at(-1)?.body as
    | { filter?: { must?: Array<{ key?: string }> } }
    | undefined;
  const filterKeys = new Set(query?.filter?.must?.map((item) => item.key));
  check(
    "Qdrant query applies project/type/tag/generation before ANN",
    ["project", "type", "tags", "generation"].every((key) => filterKeys.has(key))
  );
  check("cosine score is converted to existing L2 threshold space", hits[0]?.id === 1 && hits[0].distance < 0.21);

  const chunkHits = await vectorStore.search("chunk", vector, 3, {
    project: "ai-hub",
    currentOnly: true,
    documentKind: "runbook",
  });
  const chunkQuery = requests.filter((request) => request.url.includes("_chunks_") && request.url.includes("/points/query")).at(-1)?.body as
    | { filter?: { must?: Array<{ key?: string }> } }
    | undefined;
  const chunkFilterKeys = new Set(chunkQuery?.filter?.must?.map((item) => item.key));
  check(
    "Qdrant chunk query applies project/lifecycle/validity/generation before ANN",
    chunkHits[0]?.id === 1 && ["project", "enabled", "current", "kind", "valid_from_ms", "valid_to_ms", "generation"].every((key) => chunkFilterKeys.has(key))
  );

  const parity = await verifyVectorProjectionParity();
  check(
    "exact SQLite/Qdrant generation parity is observable",
    parity.ok && parity.local.memories === 1 && parity.local.chunks === 1 && parity.remote?.memories === 1 && parity.remote.chunks === 1
  );

  failQueries = true;
  const fallbackHits = await vectorStore.search("memory", vector, 3, { project: "ai-hub" });
  check("Qdrant query outage falls back to sqlite-vec", fallbackHits[0]?.id === 1 && Number.isFinite(fallbackHits[0].distance));

  vectorStore.delete("memory", 1);
  check("delete is durably queued", vectorStore.status().outbox_pending === 1);
  failQueries = false;
  queryResultPoints = [{ id: 1, score: 1 }];
  const pendingDeleteHits = await vectorStore.search("memory", vector, 3, { project: "ai-hub" });
  check("pending delete hides the stale remote point", pendingDeleteHits.every((hit) => hit.id !== 1));
  const deleteFlush = await flushVectorOutbox();
  check(
    "delete reaches remote projection",
    deleteFlush.processed === 1 && requests.some((request) => request.url.includes("/points/delete?"))
  );
} finally {
  closeDb();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} Qdrant checks failed.`);
  process.exitCode = 1;
} else {
  console.log("\nQdrant projection smoke passed.");
}
