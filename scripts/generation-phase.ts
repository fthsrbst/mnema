import { randomUUID } from "node:crypto";

const phase = process.argv[2];
const { closeDb, embeddingGenerationState, getDb, searchMemories, vectorIndexReady } = await import(
  "../src/core/index.js"
);
const { putMemoryVector } = await import("../src/core/db.js");

try {
  const db = getDb();
  if (phase === "seed") {
    const info = db
      .prepare(
        `INSERT INTO memories(uid, type, title, body, project, tags, source, importance, related)
         VALUES (?, 'fact', 'Generation sentinel', 'generation sentinel searchable text', NULL, '[]', 'generation-smoke', 1, '[]')`
      )
      .run(randomUUID().replaceAll("-", ""));
    putMemoryVector(Number(info.lastInsertRowid), null, Buffer.from(new Float32Array(768).fill(0.01).buffer));
    console.log(JSON.stringify({ phase, state: embeddingGenerationState(), ready: vectorIndexReady() }));
  } else if (phase === "check") {
    const state = embeddingGenerationState();
    const hits = await searchMemories("generation sentinel", { limit: 5 });
    const vectorCount = (db.prepare("SELECT COUNT(*) AS n FROM memories_vec").get() as { n: number }).n;
    const ok =
      state.reindex_required &&
      state.active !== state.configured &&
      !vectorIndexReady() &&
      vectorCount === 1 &&
      hits.some((hit) => hit.title === "Generation sentinel" && hit.channels?.includes("fts") && !hit.channels.includes("vec"));
    console.log(JSON.stringify({ phase, ok, state, ready: vectorIndexReady(), vectorCount, hits: hits.map((hit) => hit.channels) }));
    if (!ok) process.exitCode = 1;
  } else {
    throw new Error("phase must be seed or check");
  }
} finally {
  closeDb();
}
