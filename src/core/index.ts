export { config, assertDeploymentSafety } from "./config.js";
export {
  getDb,
  hasVec,
  closeDb,
  vecError,
  configuredEmbeddingGeneration,
  embeddingGenerationState,
  vectorIndexReady,
  markEmbeddingGenerationReady,
} from "./db.js";
export { embed, embedOne, embeddingsEnabled, embeddingsDisabledReason } from "./embeddings.js";
export { chunkMarkdown, CHUNKER_VERSION } from "./chunker.js";
export * from "./types.js";
export * from "./schemas.js";
export * from "./events.js";
export * from "./events-bus.js";
export * from "./memories.js";
export * from "./feedback.js";
export * from "./relations.js";
export * from "./vector-store.js";
export * from "./audit.js";
export * from "./documents.js";
export * from "./extract.js";
export * from "./projects.js";
export * from "./profiles.js";
export * from "./sessions.js";
export * from "./recall.js";
export * from "./context.js";
export * from "./graph.js";
export * from "./compute.js";
export * from "./sync.js";
export * from "./admin.js";
export * from "./prompts.js";
export * from "./skills.js";
export * from "./assets.js";
export * from "./presence.js";
export * from "./digest.js";
export * from "./tasks.js";
export * from "./capabilities.js";
export * from "./messaging.js";
export * from "./hygiene.js";
export * from "./compaction.js";
export * from "./learning.js";
export * from "./webhooks.js";
export * from "./worker.js";
export * from "./metrics.js";
export * from "./logger.js";
export { resolveMachineName } from "./machine.js";
export { backfillMissingEmbeddings, type BackfillResult } from "./backfill.js";
