import type { AnySchemaObject } from "ajv";
import {
  agentMemoryAbilities,
  longMemEvalQuestionTypes,
  longMemEvalSubsets,
} from "./agent-types.js";
import {
  officialLongMemEvalEvaluatorRevision,
  officialLongMemEvalEvaluatorScriptSha256,
  officialLongMemEvalEvaluatorScriptUri,
} from "./agent-openai.js";

const draft202012 = "https://json-schema.org/draft/2020-12/schema";
const schemaUrn = (name: string): string =>
  `urn:memory-bench:schema:${name}:1`;

const nonEmptyString = {
  type: "string",
  minLength: 1,
} as const;
const sha256 = {
  type: "string",
  pattern: "^[a-f0-9]{64}$",
} as const;
const dateTime = {
  type: "string",
  format: "date-time",
} as const;
const nonNegativeNumber = {
  type: "number",
  minimum: 0,
} as const;
const nonNegativeInteger = {
  type: "integer",
  minimum: 0,
} as const;
const ratio = {
  type: "number",
  minimum: 0,
  maximum: 1,
} as const;
const nullable = (schema: AnySchemaObject): AnySchemaObject => ({
  anyOf: [schema, { type: "null" }],
});
const stringArray = {
  type: "array",
  items: nonEmptyString,
  uniqueItems: true,
} as const;
const traceStringArray = {
  type: "array",
  items: nonEmptyString,
} as const;
const memoryAbilities = [
  "single-memory-recall",
  "multi-memory-recall",
  "knowledge-update",
  "temporal-recall",
  "abstention",
  "scope-isolation",
] as const;
const difficulties = ["basic", "intermediate", "advanced"] as const;
const publicationStatuses = ["harness", "draft", "reviewed"] as const;
const adapterNames = ["literal", "mnema", "mem0", "letta", "zep"] as const;

const scalarValue = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
} as const;

const memoryRecord = {
  type: "object",
  additionalProperties: false,
  required: ["id", "scope", "content", "observedAt"],
  properties: {
    id: nonEmptyString,
    scope: nonEmptyString,
    content: nonEmptyString,
    observedAt: dateTime,
    metadata: {
      type: "object",
      additionalProperties: scalarValue,
    },
  },
} as const;

const writeOperation = {
  type: "object",
  additionalProperties: false,
  required: ["op", "record"],
  properties: {
    op: { const: "write" },
    record: memoryRecord,
  },
} as const;

const updateOperation = {
  type: "object",
  additionalProperties: false,
  required: ["op", "targetId", "record"],
  properties: {
    op: { const: "update" },
    targetId: nonEmptyString,
    record: memoryRecord,
  },
} as const;

const deleteOperation = {
  type: "object",
  additionalProperties: false,
  required: ["op", "targetId", "scope"],
  properties: {
    op: { const: "delete" },
    targetId: nonEmptyString,
    scope: nonEmptyString,
  },
} as const;

const queryOperation = {
  type: "object",
  additionalProperties: false,
  required: [
    "op",
    "id",
    "scope",
    "query",
    "ability",
    "topK",
    "relevantIds",
  ],
  properties: {
    op: { const: "query" },
    id: nonEmptyString,
    scope: nonEmptyString,
    query: nonEmptyString,
    ability: { enum: memoryAbilities },
    topK: {
      type: "integer",
      minimum: 1,
      maximum: 100,
    },
    relevantIds: stringArray,
    forbiddenIds: stringArray,
    mustContain: stringArray,
    mustNotContain: stringArray,
    expectEmpty: { type: "boolean" },
  },
  allOf: [
    {
      if: {
        type: "object",
        properties: {
          expectEmpty: { const: true },
        },
        required: ["expectEmpty"],
      },
      then: {
        type: "object",
        properties: {
          ability: { const: "abstention" },
          relevantIds: {
            type: "array",
            maxItems: 0,
          },
        },
      },
    },
    {
      if: {
        type: "object",
        properties: {
          ability: { const: "abstention" },
        },
        required: ["ability"],
      },
      then: {
        type: "object",
        properties: {
          expectEmpty: { const: true },
        },
        required: ["expectEmpty"],
      },
    },
  ],
} as const;

const operation = {
  oneOf: [
    writeOperation,
    updateOperation,
    deleteOperation,
    queryOperation,
  ],
} as const;

const reviewEntry = {
  type: "object",
  additionalProperties: false,
  required: ["reviewer", "reviewedAt", "evidence"],
  properties: {
    reviewer: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type"],
      properties: {
        id: nonEmptyString,
        type: { enum: ["human", "ai"] },
      },
    },
    reviewedAt: dateTime,
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "sha256"],
      properties: {
        kind: { const: "review-overlay" },
        sha256,
      },
    },
  },
} as const;

const review = {
  type: "object",
  additionalProperties: false,
  required: ["status", "entries"],
  properties: {
    status: { enum: publicationStatuses },
    entries: {
      type: "array",
      items: reviewEntry,
    },
  },
  allOf: [
    {
      if: {
        type: "object",
        properties: {
          status: { const: "reviewed" },
        },
        required: ["status"],
      },
      then: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            minItems: 1,
            contains: {
              type: "object",
              properties: {
                reviewer: {
                  type: "object",
                  properties: {
                    type: { const: "human" },
                  },
                  required: ["type"],
                },
              },
              required: ["reviewer"],
            },
          },
        },
      },
      else: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            maxItems: 0,
          },
        },
      },
    },
  ],
} as const;

const scenario = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "description",
    "language",
    "difficulty",
    "provenance",
    "review",
    "operations",
  ],
  properties: {
    id: nonEmptyString,
    description: nonEmptyString,
    language: {
      type: "string",
      pattern: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
    },
    difficulty: { enum: difficulties },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["origin", "author", "authorType"],
      properties: {
        origin: { enum: ["synthetic", "adapted", "contributed"] },
        author: nonEmptyString,
        authorType: { enum: ["human", "ai", "mixed"] },
        sourceUri: {
          type: "string",
          format: "uri",
        },
        templateId: nonEmptyString,
        revisionEvidenceSha256: sha256,
      },
      allOf: [
        {
          if: {
            type: "object",
            properties: {
              origin: { const: "adapted" },
            },
            required: ["origin"],
          },
          then: {
            type: "object",
            properties: {
              sourceUri: true,
            },
            required: ["sourceUri"],
          },
        },
      ],
    },
    review,
    operations: {
      type: "array",
      minItems: 1,
      items: operation,
    },
  },
} as const;

const coreDefs = {
  memoryRecord,
  writeOperation,
  updateOperation,
  deleteOperation,
  queryOperation,
  operation,
  reviewEntry,
  review,
  scenario,
} as const;

export const datasetSchema: AnySchemaObject = {
  $schema: draft202012,
  $id: schemaUrn("dataset"),
  title: "Memory Bench core dataset schema v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "name",
    "version",
    "license",
    "track",
    "publicationStatus",
    "description",
    "scenarios",
  ],
  properties: {
    schemaVersion: { const: 1 },
    name: nonEmptyString,
    version: nonEmptyString,
    license: nonEmptyString,
    track: { const: "core" },
    publicationStatus: { enum: publicationStatuses },
    description: nonEmptyString,
    scenarios: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/$defs/scenario" },
    },
  },
  $defs: coreDefs,
};

const agentMessage = {
  type: "object",
  additionalProperties: false,
  required: ["role", "content"],
  properties: {
    role: { enum: ["user", "assistant"] },
    content: nonEmptyString,
    hasAnswer: { type: "boolean" },
  },
} as const;

const agentSession = {
  type: "object",
  additionalProperties: false,
  required: ["id", "date", "messages"],
  properties: {
    id: nonEmptyString,
    date: nonEmptyString,
    messages: {
      type: "array",
      minItems: 1,
      items: agentMessage,
    },
  },
} as const;

const agentScenario = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "sourceQuestionType",
    "ability",
    "question",
    "expectedAnswer",
    "questionDate",
    "expectedAbstention",
    "evidenceSessionIds",
    "sessions",
  ],
  properties: {
    id: nonEmptyString,
    sourceQuestionType: { enum: longMemEvalQuestionTypes },
    ability: { enum: agentMemoryAbilities },
    question: nonEmptyString,
    expectedAnswer: nonEmptyString,
    questionDate: nonEmptyString,
    expectedAbstention: { type: "boolean" },
    evidenceSessionIds: stringArray,
    sessions: {
      type: "array",
      minItems: 1,
      items: agentSession,
    },
  },
  allOf: [
    {
      if: {
        type: "object",
        properties: {
          ability: { const: "abstention" },
        },
        required: ["ability"],
      },
      then: {
        type: "object",
        properties: {
          expectedAbstention: { const: true },
        },
        required: ["expectedAbstention"],
      },
      else: {
        type: "object",
        properties: {
          expectedAbstention: { const: false },
        },
        required: ["expectedAbstention"],
      },
    },
  ],
} as const;

export const agentDatasetSchema: AnySchemaObject = {
  $schema: draft202012,
  $id: schemaUrn("agent-dataset"),
  title: "Memory Bench normalized agent-memory dataset schema v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "name",
    "version",
    "license",
    "track",
    "language",
    "description",
    "source",
    "scenarios",
  ],
  properties: {
    schemaVersion: { const: 1 },
    name: { const: "memory-bench-longmemeval" },
    version: nonEmptyString,
    license: { const: "MIT" },
    track: { const: "agent" },
    language: { const: "en" },
    description: nonEmptyString,
    source: {
      type: "object",
      additionalProperties: false,
      required: [
        "benchmark",
        "revision",
        "subset",
        "uri",
        "fileName",
        "sha256",
        "bytes",
      ],
      properties: {
        benchmark: { const: "longmemeval" },
        revision: nonEmptyString,
        subset: { enum: longMemEvalSubsets },
        uri: {
          type: "string",
          format: "uri",
        },
        fileName: nonEmptyString,
        sha256,
        bytes: {
          type: "integer",
          minimum: 1,
        },
      },
    },
    scenarios: {
      type: "array",
      minItems: 1,
      items: agentScenario,
    },
  },
  $defs: {
    agentMessage,
    agentSession,
    agentScenario,
  },
};

const latencySummary = {
  type: "object",
  additionalProperties: false,
  required: ["count", "p50Ms", "p95Ms", "maxMs"],
  properties: {
    count: nonNegativeInteger,
    p50Ms: nonNegativeNumber,
    p95Ms: nonNegativeNumber,
    maxMs: nonNegativeNumber,
  },
} as const;

const queryMetrics = {
  type: "object",
  additionalProperties: false,
  required: [
    "queries",
    "queryPassRate",
    "macroRecallAtK",
    "macroPrecisionAtK",
    "meanReciprocalRank",
    "forbiddenHitRate",
    "abstentionAccuracy",
    "queryLatency",
  ],
  properties: {
    queries: nonNegativeInteger,
    queryPassRate: ratio,
    macroRecallAtK: nullable(ratio),
    macroPrecisionAtK: nullable(ratio),
    meanReciprocalRank: nullable(ratio),
    forbiddenHitRate: ratio,
    abstentionAccuracy: nullable(ratio),
    queryLatency: latencySummary,
  },
} as const;

const adapterInfo = {
  type: "object",
  additionalProperties: false,
  required: ["name", "version", "mode", "config"],
  properties: {
    name: nonEmptyString,
    version: nonEmptyString,
    mode: nonEmptyString,
    config: {
      type: "object",
      additionalProperties: scalarValue,
    },
  },
} as const;

const adapterTelemetry = {
  type: "object",
  additionalProperties: false,
  required: [
    "requestCount",
    "retryCount",
    "pollRequestCount",
    "requestBytes",
    "responseBytes",
    "providerProcessingMs",
    "providerCostUsd",
    "costSource",
    "cleanup",
  ],
  properties: {
    requestCount: nonNegativeInteger,
    retryCount: nonNegativeInteger,
    pollRequestCount: nonNegativeInteger,
    requestBytes: nonNegativeInteger,
    responseBytes: nonNegativeInteger,
    providerProcessingMs: nullable(nonNegativeNumber),
    providerCostUsd: nullable(nonNegativeNumber),
    costSource: {
      enum: [
        "not-applicable",
        "not-exposed",
        "provider-reported",
        "estimated",
      ],
    },
    cleanup: {
      type: "object",
      additionalProperties: false,
      required: ["attempted", "succeeded", "verified"],
      properties: {
        attempted: { type: "boolean" },
        succeeded: { type: "boolean" },
        verified: { type: "boolean" },
      },
    },
  },
} as const;

const benchmarkMetrics = {
  ...queryMetrics,
  required: [
    ...queryMetrics.required,
    "operationLatency",
    "slices",
  ],
  properties: {
    ...queryMetrics.properties,
    operationLatency: {
      type: "object",
      additionalProperties: false,
      required: ["write", "update", "delete", "query"],
      properties: {
        write: latencySummary,
        update: latencySummary,
        delete: latencySummary,
        query: latencySummary,
      },
    },
    slices: {
      type: "object",
      additionalProperties: false,
      required: ["byAbility", "byLanguage", "byDifficulty"],
      properties: {
        byAbility: {
          type: "object",
          additionalProperties: false,
          required: memoryAbilities,
          properties: Object.fromEntries(
            memoryAbilities.map((ability) => [ability, queryMetrics])
          ),
        },
        byLanguage: {
          type: "object",
          minProperties: 1,
          propertyNames: {
            minLength: 1,
          },
          additionalProperties: queryMetrics,
        },
        byDifficulty: {
          type: "object",
          additionalProperties: false,
          required: difficulties,
          properties: Object.fromEntries(
            difficulties.map((difficulty) => [difficulty, queryMetrics])
          ),
        },
      },
    },
  },
} as const;

const normalizedHit = {
  type: "object",
  additionalProperties: false,
  required: ["recordId", "content", "score", "providerId"],
  properties: {
    recordId: nullable({ type: "string" }),
    content: { type: "string" },
    score: nullable({ type: "number" }),
    providerId: nullable({ type: "string" }),
  },
} as const;

const normalizedFeedback = {
  type: "object",
  additionalProperties: false,
  required: ["queryId", "verdict", "recordId", "rank"],
  properties: {
    queryId: nonEmptyString,
    verdict: { enum: ["helpful", "noisy", "missing"] },
    recordId: nullable({ type: "string" }),
    rank: nullable({
      type: "integer",
      minimum: 1,
    }),
  },
} as const;

const queryTrace = {
  type: "object",
  additionalProperties: false,
  required: [
    "scenarioId",
    "queryId",
    "ability",
    "language",
    "difficulty",
    "scope",
    "query",
    "topK",
    "latencyMs",
    "relevantIds",
    "retrievedIds",
    "missingRelevantIds",
    "forbiddenIdsFound",
    "recallAtK",
    "precisionAtK",
    "reciprocalRank",
    "contentChecksPassed",
    "abstentionPassed",
    "passed",
    "hits",
    "feedback",
  ],
  properties: {
    scenarioId: nonEmptyString,
    queryId: nonEmptyString,
    ability: { enum: memoryAbilities },
    language: nonEmptyString,
    difficulty: { enum: difficulties },
    scope: nonEmptyString,
    query: nonEmptyString,
    topK: {
      type: "integer",
      minimum: 1,
      maximum: 100,
    },
    latencyMs: nonNegativeNumber,
    relevantIds: stringArray,
    retrievedIds: traceStringArray,
    missingRelevantIds: stringArray,
    forbiddenIdsFound: stringArray,
    recallAtK: nullable(ratio),
    precisionAtK: nullable(ratio),
    reciprocalRank: nullable(ratio),
    contentChecksPassed: { type: "boolean" },
    abstentionPassed: nullable({ type: "boolean" }),
    passed: { type: "boolean" },
    hits: {
      type: "array",
      items: normalizedHit,
    },
    feedback: {
      type: "array",
      items: normalizedFeedback,
    },
  },
} as const;

const reportDefs = {
  latencySummary,
  queryMetrics,
  benchmarkMetrics,
  adapterInfo,
  adapterTelemetry,
  normalizedHit,
  normalizedFeedback,
  queryTrace,
} as const;

export const reportSchema: AnySchemaObject = {
  $schema: draft202012,
  $id: schemaUrn("report"),
  title: "Memory Bench normalized report schema v1",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "run", "metrics", "queries"],
  properties: {
    schemaVersion: { const: 1 },
    run: {
      type: "object",
      additionalProperties: false,
      required: [
        "runId",
        "startedAt",
        "durationMs",
        "dataset",
        "adapter",
        "adapterTelemetry",
      ],
      properties: {
        runId: nonEmptyString,
        startedAt: dateTime,
        durationMs: nonNegativeNumber,
        dataset: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "version",
            "license",
            "track",
            "publicationStatus",
          ],
          properties: {
            name: nonEmptyString,
            version: nonEmptyString,
            license: nonEmptyString,
            track: { const: "core" },
            publicationStatus: { enum: publicationStatuses },
          },
        },
        adapter: { $ref: "#/$defs/adapterInfo" },
        adapterTelemetry: { $ref: "#/$defs/adapterTelemetry" },
      },
    },
    metrics: { $ref: "#/$defs/benchmarkMetrics" },
    queries: {
      type: "array",
      items: { $ref: "#/$defs/queryTrace" },
    },
  },
  $defs: reportDefs,
};

const agentComponentInfo = {
  type: "object",
  additionalProperties: false,
  required: ["name", "version", "mode", "classification", "config"],
  properties: {
    name: nonEmptyString,
    version: nonEmptyString,
    mode: nonEmptyString,
    classification: { enum: ["harness", "candidate", "benchmark"] },
    config: {
      type: "object",
      additionalProperties: scalarValue,
    },
  },
} as const;

const agentComponentTelemetry = {
  type: "object",
  additionalProperties: false,
  required: [
    "requestCount",
    "retryCount",
    "requestBytes",
    "responseBytes",
    "inputTokens",
    "outputTokens",
    "providerProcessingMs",
    "providerCostUsd",
    "costSource",
  ],
  properties: {
    requestCount: nonNegativeInteger,
    retryCount: nonNegativeInteger,
    requestBytes: nonNegativeInteger,
    responseBytes: nonNegativeInteger,
    inputTokens: nullable(nonNegativeInteger),
    outputTokens: nullable(nonNegativeInteger),
    providerProcessingMs: nullable(nonNegativeNumber),
    providerCostUsd: nullable(nonNegativeNumber),
    costSource: {
      enum: [
        "not-applicable",
        "not-exposed",
        "provider-reported",
        "estimated",
      ],
    },
  },
} as const;

const agentStageLatency = {
  type: "object",
  additionalProperties: false,
  required: ["ingestion", "query", "reader", "judge", "total"],
  properties: {
    ingestion: nonNegativeNumber,
    query: nonNegativeNumber,
    reader: nonNegativeNumber,
    judge: nonNegativeNumber,
    total: nonNegativeNumber,
  },
} as const;

const agentLatencyMetrics = {
  type: "object",
  additionalProperties: false,
  required: ["ingestion", "query", "reader", "judge", "total"],
  properties: {
    ingestion: latencySummary,
    query: latencySummary,
    reader: latencySummary,
    judge: latencySummary,
    total: latencySummary,
  },
} as const;

const agentCleanup = {
  type: "object",
  additionalProperties: false,
  required: ["attempted", "succeeded", "verified"],
  properties: {
    attempted: { type: "boolean" },
    succeeded: { type: "boolean" },
    verified: { type: "boolean" },
  },
} as const;

const agentScenarioMetrics = {
  type: "object",
  additionalProperties: false,
  required: [
    "scenarios",
    "completed",
    "failed",
    "qaAccuracy",
    "retrievalQueries",
    "macroRecallAtK",
    "meanReciprocalRank",
    "cleanupVerificationRate",
    "latency",
  ],
  properties: {
    scenarios: nonNegativeInteger,
    completed: nonNegativeInteger,
    failed: nonNegativeInteger,
    qaAccuracy: nullable(ratio),
    retrievalQueries: nonNegativeInteger,
    macroRecallAtK: nullable(ratio),
    meanReciprocalRank: nullable(ratio),
    cleanupVerificationRate: nullable(ratio),
    latency: agentLatencyMetrics,
  },
} as const;

const agentBenchmarkMetrics = {
  type: "object",
  additionalProperties: false,
  required: [
    ...agentScenarioMetrics.required,
    "runtimeFailures",
    "slices",
  ],
  properties: {
    ...agentScenarioMetrics.properties,
    runtimeFailures: nonNegativeInteger,
    slices: {
      type: "object",
      additionalProperties: false,
      required: ["byAbility"],
      properties: {
        byAbility: {
          type: "object",
          additionalProperties: false,
          required: agentMemoryAbilities,
          properties: Object.fromEntries(
            agentMemoryAbilities.map((ability) => [
              ability,
              agentScenarioMetrics,
            ])
          ),
        },
      },
    },
  },
} as const;

const agentEvidenceDescriptor = {
  type: "object",
  additionalProperties: false,
  required: [
    "type",
    "observedAt",
    "sourceSessionId",
    "score",
    "valueSha256",
    "valueBytes",
  ],
  properties: {
    type: { enum: ["text", "image"] },
    observedAt: nullable(nonEmptyString),
    sourceSessionId: nullable({ type: "string" }),
    score: nullable({ type: "number" }),
    valueSha256: sha256,
    valueBytes: nonNegativeInteger,
  },
} as const;

const agentScenarioTrace = {
  type: "object",
  additionalProperties: false,
  required: [
    "scenarioId",
    "sourceQuestionType",
    "ability",
    "expectedAbstention",
    "status",
    "sessionCount",
    "turnCount",
    "topK",
    "expectedEvidenceSessionIds",
    "retrievedSessionIds",
    "missingEvidenceSessionIds",
    "retrievalEvaluated",
    "recallAtK",
    "reciprocalRank",
    "hypothesis",
    "judgeLabel",
    "qaPassed",
    "latencyMs",
    "cleanup",
    "evidence",
  ],
  properties: {
    scenarioId: nonEmptyString,
    sourceQuestionType: { enum: longMemEvalQuestionTypes },
    ability: { enum: agentMemoryAbilities },
    expectedAbstention: { type: "boolean" },
    status: { enum: ["completed", "failed"] },
    sessionCount: {
      type: "integer",
      minimum: 1,
    },
    turnCount: {
      type: "integer",
      minimum: 1,
    },
    topK: {
      type: "integer",
      minimum: 1,
      maximum: 100,
    },
    expectedEvidenceSessionIds: stringArray,
    retrievedSessionIds: traceStringArray,
    missingEvidenceSessionIds: stringArray,
    retrievalEvaluated: { type: "boolean" },
    recallAtK: nullable(ratio),
    reciprocalRank: nullable(ratio),
    hypothesis: nullable(nonEmptyString),
    judgeLabel: nullable(nonEmptyString),
    qaPassed: nullable({ type: "boolean" }),
    latencyMs: agentStageLatency,
    cleanup: agentCleanup,
    evidence: {
      type: "array",
      items: agentEvidenceDescriptor,
    },
  },
  allOf: [
    {
      if: {
        type: "object",
        properties: {
          expectedAbstention: { const: true },
        },
        required: ["expectedAbstention"],
      },
      then: {
        type: "object",
        properties: {
          ability: { const: "abstention" },
          retrievalEvaluated: { const: false },
        },
      },
    },
    {
      if: {
        type: "object",
        properties: {
          status: { const: "completed" },
          expectedAbstention: { const: false },
        },
        required: ["status", "expectedAbstention"],
      },
      then: {
        type: "object",
        properties: {
          retrievalEvaluated: { const: true },
        },
      },
    },
    {
      if: {
        type: "object",
        properties: {
          retrievalEvaluated: { const: true },
        },
        required: ["retrievalEvaluated"],
      },
      then: {
        type: "object",
        properties: {
          expectedAbstention: { const: false },
          recallAtK: ratio,
          reciprocalRank: ratio,
        },
      },
      else: {
        type: "object",
        properties: {
          recallAtK: { type: "null" },
          reciprocalRank: { type: "null" },
        },
      },
    },
    {
      if: {
        type: "object",
        properties: {
          status: { const: "completed" },
        },
        required: ["status"],
      },
      then: {
        type: "object",
        properties: {
          hypothesis: nonEmptyString,
          judgeLabel: nonEmptyString,
          qaPassed: { type: "boolean" },
          cleanup: {
            type: "object",
            properties: {
              attempted: { const: true },
              succeeded: { const: true },
              verified: { const: true },
            },
            required: ["attempted", "succeeded", "verified"],
          },
        },
      },
    },
  ],
} as const;

const agentRuntimeFailure = {
  type: "object",
  additionalProperties: false,
  required: ["scenarioId", "ability", "stage", "component", "message"],
  properties: {
    scenarioId: nullable({ type: "string" }),
    ability: nullable({ enum: agentMemoryAbilities }),
    stage: {
      enum: [
        "dataset",
        "setup",
        "begin-scenario",
        "ingest",
        "query",
        "reader",
        "judge",
        "cleanup",
        "teardown",
        "telemetry",
      ],
    },
    component: { enum: ["runner", "adapter", "reader", "judge"] },
    message: nonEmptyString,
  },
} as const;

const agentComponents = {
  type: "object",
  additionalProperties: false,
  required: ["adapter", "reader", "judge"],
  properties: {
    adapter: agentComponentInfo,
    reader: agentComponentInfo,
    judge: agentComponentInfo,
  },
} as const;

const agentTelemetry = {
  type: "object",
  additionalProperties: false,
  required: ["adapter", "reader", "judge"],
  properties: {
    adapter: agentComponentTelemetry,
    reader: agentComponentTelemetry,
    judge: agentComponentTelemetry,
  },
} as const;

const agentReportDefs = {
  agentComponentInfo,
  agentComponentTelemetry,
  agentScenarioMetrics,
  agentBenchmarkMetrics,
  agentEvidenceDescriptor,
  agentScenarioTrace,
  agentRuntimeFailure,
  agentComponents,
  agentTelemetry,
} as const;

export const agentReportSchema: AnySchemaObject = {
  $schema: draft202012,
  $id: schemaUrn("agent-report"),
  title: "Memory Bench agent-memory report schema v1",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "run", "metrics", "scenarios", "failures"],
  properties: {
    schemaVersion: { const: 1 },
    run: {
      type: "object",
      additionalProperties: false,
      required: [
        "runId",
        "startedAt",
        "durationMs",
        "status",
        "resultClass",
        "dataset",
        "topK",
        "maxScenarios",
        "components",
        "telemetry",
      ],
      properties: {
        runId: nonEmptyString,
        startedAt: dateTime,
        durationMs: nonNegativeNumber,
        status: {
          enum: ["completed", "completed-with-errors", "failed"],
        },
        resultClass: { enum: ["harness", "candidate", "benchmark"] },
        dataset: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "version",
            "license",
            "track",
            "language",
            "subset",
            "sourceRevision",
            "sourceSha256",
            "artifactSha256",
            "artifactBytes",
            "readPasses",
          ],
          properties: {
            name: { const: "memory-bench-longmemeval" },
            version: nonEmptyString,
            license: { const: "MIT" },
            track: { const: "agent" },
            language: { const: "en" },
            subset: { enum: longMemEvalSubsets },
            sourceRevision: nonEmptyString,
            sourceSha256: sha256,
            artifactSha256: sha256,
            artifactBytes: {
              type: "integer",
              minimum: 1,
            },
            readPasses: { const: 2 },
          },
        },
        topK: {
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
        maxScenarios: nullable({
          type: "integer",
          minimum: 1,
        }),
        components: agentComponents,
        telemetry: agentTelemetry,
      },
    },
    metrics: agentBenchmarkMetrics,
    scenarios: {
      type: "array",
      items: agentScenarioTrace,
    },
    failures: {
      type: "array",
      items: agentRuntimeFailure,
    },
  },
  $defs: agentReportDefs,
};

const reviewer = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "conflicts"],
  properties: {
    id: nonEmptyString,
    type: { enum: ["human", "ai"] },
    affiliation: nonEmptyString,
    conflicts: stringArray,
  },
} as const;

const reviewMaintainer = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "type",
    "affiliation",
    "verifiedAt",
    "reviewerIdentityVerified",
    "conflictsReviewed",
    "disposition",
  ],
  properties: {
    id: nonEmptyString,
    type: { const: "human" },
    affiliation: nonEmptyString,
    verifiedAt: dateTime,
    reviewerIdentityVerified: { type: "boolean" },
    conflictsReviewed: { type: "boolean" },
    disposition: nonEmptyString,
  },
} as const;

const attestation = {
  type: "object",
  additionalProperties: false,
  required: [
    "independentFromScenarioAuthors",
    "rightsToPublish",
    "noPrivateOrSecretData",
  ],
  properties: {
    independentFromScenarioAuthors: { type: "boolean" },
    rightsToPublish: { type: "boolean" },
    noPrivateOrSecretData: { type: "boolean" },
  },
} as const;

const revision = {
  type: "object",
  additionalProperties: false,
  required: ["description", "language", "difficulty", "operations"],
  properties: {
    description: nonEmptyString,
    language: nonEmptyString,
    difficulty: { enum: difficulties },
    operations: {
      type: "array",
      minItems: 1,
      items: operation,
    },
  },
} as const;

const reviewDecisionBaseProperties = {
  scenarioId: nonEmptyString,
  scenarioSha256: sha256,
} as const;

const pendingDecision = {
  type: "object",
  additionalProperties: false,
  required: ["scenarioId", "scenarioSha256", "decision"],
  properties: {
    ...reviewDecisionBaseProperties,
    decision: { const: "pending" },
    note: nonEmptyString,
  },
} as const;

const approveDecision = {
  type: "object",
  additionalProperties: false,
  required: ["scenarioId", "scenarioSha256", "decision"],
  properties: {
    ...reviewDecisionBaseProperties,
    decision: { const: "approve" },
    note: nonEmptyString,
  },
} as const;

const rejectDecision = {
  type: "object",
  additionalProperties: false,
  required: ["scenarioId", "scenarioSha256", "decision", "note"],
  properties: {
    ...reviewDecisionBaseProperties,
    decision: { const: "reject" },
    note: nonEmptyString,
  },
} as const;

const reviseDecision = {
  type: "object",
  additionalProperties: false,
  required: [
    "scenarioId",
    "scenarioSha256",
    "decision",
    "note",
    "replacement",
  ],
  properties: {
    ...reviewDecisionBaseProperties,
    decision: { const: "revise" },
    note: nonEmptyString,
    replacement: revision,
  },
} as const;

export const reviewPacketSchema: AnySchemaObject = {
  $schema: draft202012,
  $id: schemaUrn("review-packet"),
  title: "Memory Bench review packet schema v1",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "dataset", "instructions", "scenarios"],
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: "memory-bench-review-packet" },
    dataset: {
      type: "object",
      additionalProperties: false,
      required: [
        "name",
        "version",
        "license",
        "publicationStatus",
        "sha256",
        "scenarioCount",
        "queryCount",
      ],
      properties: {
        name: nonEmptyString,
        version: nonEmptyString,
        license: nonEmptyString,
        publicationStatus: { enum: publicationStatuses },
        sha256,
        scenarioCount: {
          type: "integer",
          minimum: 1,
        },
        queryCount: nonNegativeInteger,
      },
    },
    instructions: {
      type: "array",
      minItems: 1,
      items: nonEmptyString,
    },
    scenarios: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["scenarioId", "scenarioSha256", "scenario"],
        properties: {
          scenarioId: nonEmptyString,
          scenarioSha256: sha256,
          scenario: { $ref: "#/$defs/scenario" },
        },
      },
    },
  },
  $defs: coreDefs,
};

export const reviewOverlaySchema: AnySchemaObject = {
  $schema: draft202012,
  $id: schemaUrn("review-overlay"),
  title: "Memory Bench review overlay schema v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "dataset",
    "reviewer",
    "maintainer",
    "attestation",
    "reviewedAt",
    "decisions",
  ],
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: "memory-bench-review-overlay" },
    dataset: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version", "sha256", "packetSha256"],
      properties: {
        name: nonEmptyString,
        version: nonEmptyString,
        sha256,
        packetSha256: sha256,
      },
    },
    reviewer: nullable(reviewer),
    maintainer: nullable(reviewMaintainer),
    attestation: nullable(attestation),
    reviewedAt: nullable(dateTime),
    decisions: {
      type: "array",
      minItems: 1,
      items: {
        oneOf: [
          pendingDecision,
          approveDecision,
          rejectDecision,
          reviseDecision,
        ],
      },
    },
  },
  $defs: {
    ...coreDefs,
    reviewer,
    reviewMaintainer,
    attestation,
    revision,
    pendingDecision,
    approveDecision,
    rejectDecision,
    reviseDecision,
  },
};

export const comparisonManifestSchema: AnySchemaObject = {
  $schema: draft202012,
  $id: schemaUrn("comparison-manifest"),
  title: "Memory Bench comparison manifest schema v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "comparisonId",
    "createdAt",
    "dataset",
    "source",
    "environment",
    "policy",
    "runs",
  ],
  properties: {
    schemaVersion: { const: 1 },
    comparisonId: nonEmptyString,
    createdAt: dateTime,
    dataset: {
      type: "object",
      additionalProperties: false,
      required: [
        "name",
        "version",
        "license",
        "publicationStatus",
        "file",
        "sha256",
      ],
      properties: {
        name: nonEmptyString,
        version: nonEmptyString,
        license: nonEmptyString,
        publicationStatus: { enum: publicationStatuses },
        file: nonEmptyString,
        sha256,
      },
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["gitCommit", "gitDirty"],
      properties: {
        gitCommit: nullable({
          type: "string",
          pattern: "^[a-f0-9]{40,64}$",
        }),
        gitDirty: nullable({ type: "boolean" }),
      },
    },
    environment: {
      type: "object",
      additionalProperties: false,
      required: [
        "node",
        "platform",
        "arch",
        "osRelease",
        "cpuModel",
        "logicalCpuCount",
        "totalMemoryBytes",
      ],
      properties: {
        node: nonEmptyString,
        platform: nonEmptyString,
        arch: nonEmptyString,
        osRelease: nonEmptyString,
        cpuModel: nullable({ type: "string" }),
        logicalCpuCount: {
          type: "integer",
          minimum: 1,
        },
        totalMemoryBytes: nonNegativeInteger,
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      required: [
        "processIsolation",
        "runtimeFailureAffectsCommandExit",
        "queryFailureAffectsCommandExit",
      ],
      properties: {
        processIsolation: { const: "one-process-per-adapter" },
        runtimeFailureAffectsCommandExit: { const: true },
        queryFailureAffectsCommandExit: { const: false },
      },
    },
    runs: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "adapter",
          "status",
          "exitCode",
          "durationMs",
          "reportFile",
          "reportSha256",
          "queryFailures",
          "metrics",
          "adapterInfo",
          "adapterTelemetry",
          "error",
        ],
        properties: {
          adapter: { enum: adapterNames },
          status: { enum: ["completed", "failed"] },
          exitCode: nullable({ type: "integer" }),
          durationMs: nonNegativeNumber,
          reportFile: nullable({ type: "string" }),
          reportSha256: nullable(sha256),
          queryFailures: nullable(nonNegativeInteger),
          metrics: nullable({ $ref: "#/$defs/benchmarkMetrics" }),
          adapterInfo: nullable({ $ref: "#/$defs/adapterInfo" }),
          adapterTelemetry: nullable({
            $ref: "#/$defs/adapterTelemetry",
          }),
          error: nullable({ type: "string" }),
        },
      },
    },
  },
  $defs: reportDefs,
};

const agentComparisonRun = {
  type: "object",
  additionalProperties: false,
  required: [
    "adapter",
    "status",
    "processId",
    "exitCode",
    "durationMs",
    "reportStatus",
    "reportFile",
    "reportSha256",
    "evaluationSha256",
    "resultClass",
    "runtimeFailures",
    "metrics",
    "components",
    "telemetry",
    "error",
  ],
  properties: {
    adapter: { enum: adapterNames },
    status: { enum: ["completed", "failed"] },
    processId: nullable({
      type: "integer",
      minimum: 1,
    }),
    exitCode: nullable({ type: "integer" }),
    durationMs: nonNegativeNumber,
    reportStatus: nullable({
      enum: ["completed", "completed-with-errors", "failed"],
    }),
    reportFile: nullable(nonEmptyString),
    reportSha256: nullable(sha256),
    evaluationSha256: nullable(sha256),
    resultClass: nullable({
      enum: ["harness", "candidate", "benchmark"],
    }),
    runtimeFailures: nullable(nonNegativeInteger),
    metrics: nullable({ $ref: "#/$defs/agentBenchmarkMetrics" }),
    components: nullable({ $ref: "#/$defs/agentComponents" }),
    telemetry: nullable({ $ref: "#/$defs/agentTelemetry" }),
    error: nullable(nonEmptyString),
  },
  allOf: [
    {
      if: {
        type: "object",
        properties: {
          status: { const: "completed" },
        },
        required: ["status"],
      },
      then: {
        type: "object",
        properties: {
          processId: {
            type: "integer",
            minimum: 1,
          },
          exitCode: { const: 0 },
          reportStatus: { const: "completed" },
          reportFile: nonEmptyString,
          reportSha256: sha256,
          evaluationSha256: sha256,
          resultClass: {
            enum: ["harness", "candidate", "benchmark"],
          },
          runtimeFailures: { const: 0 },
          metrics: { $ref: "#/$defs/agentBenchmarkMetrics" },
          components: { $ref: "#/$defs/agentComponents" },
          telemetry: { $ref: "#/$defs/agentTelemetry" },
          error: { type: "null" },
        },
      },
    },
  ],
} as const;

export const agentComparisonManifestSchema: AnySchemaObject = {
  $schema: draft202012,
  $id: schemaUrn("agent-comparison-manifest"),
  title: "Memory Bench agent comparison manifest schema v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "comparisonId",
    "createdAt",
    "dataset",
    "source",
    "environment",
    "evaluation",
    "policy",
    "claim",
    "runs",
  ],
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: "memory-bench-agent-comparison" },
    comparisonId: nonEmptyString,
    createdAt: dateTime,
    dataset: {
      type: "object",
      additionalProperties: false,
      required: [
        "name",
        "version",
        "license",
        "track",
        "language",
        "subset",
        "sourceRevision",
        "sourceSha256",
        "artifactFile",
        "artifactSha256",
        "artifactBytes",
      ],
      properties: {
        name: { const: "memory-bench-longmemeval" },
        version: nonEmptyString,
        license: { const: "MIT" },
        track: { const: "agent" },
        language: { const: "en" },
        subset: { enum: longMemEvalSubsets },
        sourceRevision: nonEmptyString,
        sourceSha256: sha256,
        artifactFile: nonEmptyString,
        artifactSha256: sha256,
        artifactBytes: {
          type: "integer",
          minimum: 1,
        },
      },
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["gitCommit", "gitDirty"],
      properties: {
        gitCommit: nullable({
          type: "string",
          pattern: "^[a-f0-9]{40,64}$",
        }),
        gitDirty: nullable({ type: "boolean" }),
      },
    },
    environment: {
      type: "object",
      additionalProperties: false,
      required: [
        "node",
        "platform",
        "arch",
        "osRelease",
        "cpuModel",
        "logicalCpuCount",
        "totalMemoryBytes",
      ],
      properties: {
        node: nonEmptyString,
        platform: nonEmptyString,
        arch: nonEmptyString,
        osRelease: nonEmptyString,
        cpuModel: nullable({ type: "string" }),
        logicalCpuCount: {
          type: "integer",
          minimum: 1,
        },
        totalMemoryBytes: nonNegativeInteger,
      },
    },
    evaluation: {
      type: "object",
      additionalProperties: false,
      required: [
        "reader",
        "readerModel",
        "judge",
        "judgeModel",
        "topK",
        "maxScenarios",
        "configurationSha256",
      ],
      properties: {
        reader: { enum: ["fixture", "openai"] },
        readerModel: nullable(nonEmptyString),
        judge: { enum: ["fixture", "openai"] },
        judgeModel: nullable(nonEmptyString),
        topK: {
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
        maxScenarios: nullable({
          type: "integer",
          minimum: 1,
        }),
        configurationSha256: nullable(sha256),
      },
      allOf: [
        {
          if: {
            type: "object",
            properties: { reader: { const: "fixture" } },
            required: ["reader"],
          },
          then: {
            type: "object",
            properties: { readerModel: { type: "null" } },
          },
          else: {
            type: "object",
            properties: { readerModel: nonEmptyString },
          },
        },
        {
          if: {
            type: "object",
            properties: { judge: { const: "fixture" } },
            required: ["judge"],
          },
          then: {
            type: "object",
            properties: { judgeModel: { type: "null" } },
          },
          else: {
            type: "object",
            properties: { judgeModel: nonEmptyString },
          },
        },
      ],
    },
    policy: {
      type: "object",
      additionalProperties: false,
      required: [
        "processIsolation",
        "executionOrder",
        "runtimeFailureAffectsCommandExit",
        "qaFailureAffectsCommandExit",
      ],
      properties: {
        processIsolation: { const: "one-process-per-adapter" },
        executionOrder: { const: "sequential" },
        runtimeFailureAffectsCommandExit: { const: true },
        qaFailureAffectsCommandExit: { const: false },
      },
    },
    claim: {
      type: "object",
      additionalProperties: false,
      required: [
        "resultClass",
        "comparable",
        "publicationEligible",
        "blockers",
      ],
      properties: {
        resultClass: {
          enum: ["harness", "candidate", "benchmark"],
        },
        comparable: { type: "boolean" },
        publicationEligible: { type: "boolean" },
        blockers: {
          type: "array",
          items: nonEmptyString,
          uniqueItems: true,
        },
      },
      allOf: [
        {
          if: {
            type: "object",
            properties: {
              publicationEligible: { const: true },
            },
            required: ["publicationEligible"],
          },
          then: {
            type: "object",
            properties: {
              resultClass: { const: "benchmark" },
              comparable: { const: true },
              blockers: {
                type: "array",
                maxItems: 0,
              },
            },
          },
          else: {
            type: "object",
            properties: {
              blockers: {
                type: "array",
                minItems: 1,
              },
            },
          },
        },
      ],
    },
    runs: {
      type: "array",
      minItems: 2,
      items: { $ref: "#/$defs/agentComparisonRun" },
    },
  },
  allOf: [
    {
      if: {
        type: "object",
        properties: {
          claim: {
            type: "object",
            properties: {
              comparable: { const: true },
            },
            required: ["comparable"],
          },
        },
        required: ["claim"],
      },
      then: {
        type: "object",
        properties: {
          evaluation: {
            type: "object",
            properties: {
              configurationSha256: sha256,
            },
            required: ["configurationSha256"],
          },
          runs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                status: { const: "completed" },
              },
              required: ["status"],
            },
          },
        },
      },
    },
  ],
  $defs: {
    ...agentReportDefs,
    agentComparisonRun,
  },
};

const evaluatorParitySliceMetrics = {
  type: "object",
  additionalProperties: false,
  required: ["compared", "matches", "mismatches", "agreementRate"],
  properties: {
    compared: nonNegativeInteger,
    matches: nonNegativeInteger,
    mismatches: nonNegativeInteger,
    agreementRate: nullable(ratio),
  },
} as const;

const evaluatorParityMismatch = {
  type: "object",
  additionalProperties: false,
  required: [
    "scenarioId",
    "sourceQuestionType",
    "ability",
    "hypothesisSha256",
    "candidatePassed",
    "officialPassed",
    "officialModel",
  ],
  properties: {
    scenarioId: nonEmptyString,
    sourceQuestionType: { enum: longMemEvalQuestionTypes },
    ability: { enum: agentMemoryAbilities },
    hypothesisSha256: sha256,
    candidatePassed: { type: "boolean" },
    officialPassed: { type: "boolean" },
    officialModel: nonEmptyString,
  },
} as const;

export const evaluatorParitySchema: AnySchemaObject = {
  $schema: draft202012,
  $id: schemaUrn("evaluator-parity"),
  title: "Memory Bench LongMemEval evaluator parity schema v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "parityId",
    "createdAt",
    "candidate",
    "official",
    "coverage",
    "compatibility",
    "metrics",
    "policy",
    "claim",
    "mismatches",
  ],
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: "memory-bench-evaluator-parity" },
    parityId: nonEmptyString,
    createdAt: dateTime,
    candidate: {
      type: "object",
      additionalProperties: false,
      required: [
        "reportFile",
        "reportSha256",
        "runId",
        "reportStatus",
        "resultClass",
        "dataset",
        "judge",
      ],
      properties: {
        reportFile: nonEmptyString,
        reportSha256: sha256,
        runId: nonEmptyString,
        reportStatus: {
          enum: ["completed", "completed-with-errors", "failed"],
        },
        resultClass: {
          enum: ["harness", "candidate", "benchmark"],
        },
        dataset: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "version",
            "subset",
            "sourceRevision",
            "sourceSha256",
            "artifactSha256",
          ],
          properties: {
            name: { const: "memory-bench-longmemeval" },
            version: nonEmptyString,
            subset: { enum: longMemEvalSubsets },
            sourceRevision: nonEmptyString,
            sourceSha256: sha256,
            artifactSha256: sha256,
          },
        },
        judge: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "model",
            "promptRevision",
            "apiSurface",
            "decisionRule",
          ],
          properties: {
            name: nonEmptyString,
            model: nullable(nonEmptyString),
            promptRevision: nullable(nonEmptyString),
            apiSurface: nullable(nonEmptyString),
            decisionRule: nullable(nonEmptyString),
          },
        },
      },
    },
    official: {
      type: "object",
      additionalProperties: false,
      required: [
        "resultsFile",
        "resultsSha256",
        "resultModels",
        "evaluatorRevision",
        "scriptUri",
        "scriptSha256",
        "apiSurface",
        "decisionRule",
      ],
      properties: {
        resultsFile: nonEmptyString,
        resultsSha256: sha256,
        resultModels: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: nonEmptyString,
        },
        evaluatorRevision: {
          const: officialLongMemEvalEvaluatorRevision,
        },
        scriptUri: {
          const: officialLongMemEvalEvaluatorScriptUri,
        },
        scriptSha256: {
          const: officialLongMemEvalEvaluatorScriptSha256,
        },
        apiSurface: { const: "chat-completions" },
        decisionRule: { const: "case-insensitive-yes-substring" },
      },
    },
    coverage: {
      type: "object",
      additionalProperties: false,
      required: [
        "reportDecisions",
        "officialDecisions",
        "candidateOnlyIds",
        "officialOnlyIds",
        "hypothesisMismatchIds",
      ],
      properties: {
        reportDecisions: nonNegativeInteger,
        officialDecisions: nonNegativeInteger,
        candidateOnlyIds: stringArray,
        officialOnlyIds: stringArray,
        hypothesisMismatchIds: stringArray,
      },
    },
    compatibility: {
      type: "object",
      additionalProperties: false,
      required: [
        "reportComplete",
        "nonEmptyDecisionSet",
        "completeCoverage",
        "hypothesesExact",
        "modelExact",
        "promptRevisionPinned",
        "comparable",
      ],
      properties: {
        reportComplete: { type: "boolean" },
        nonEmptyDecisionSet: { type: "boolean" },
        completeCoverage: { type: "boolean" },
        hypothesesExact: { type: "boolean" },
        modelExact: { type: "boolean" },
        promptRevisionPinned: { type: "boolean" },
        comparable: { type: "boolean" },
      },
      allOf: [
        {
          if: {
            type: "object",
            properties: { comparable: { const: true } },
            required: ["comparable"],
          },
          then: {
            type: "object",
            properties: {
              reportComplete: { const: true },
              nonEmptyDecisionSet: { const: true },
              completeCoverage: { const: true },
              hypothesesExact: { const: true },
              modelExact: { const: true },
              promptRevisionPinned: { const: true },
            },
            required: [
              "reportComplete",
              "nonEmptyDecisionSet",
              "completeCoverage",
              "hypothesesExact",
              "modelExact",
              "promptRevisionPinned",
            ],
          },
        },
      ],
    },
    metrics: {
      type: "object",
      additionalProperties: false,
      required: [
        "compared",
        "labelMatches",
        "labelMismatches",
        "agreementRate",
        "exactAgreement",
        "confusion",
        "slices",
      ],
      properties: {
        compared: nonNegativeInteger,
        labelMatches: nonNegativeInteger,
        labelMismatches: nonNegativeInteger,
        agreementRate: nullable(ratio),
        exactAgreement: { type: "boolean" },
        confusion: {
          type: "object",
          additionalProperties: false,
          required: [
            "bothPass",
            "candidateOnlyPass",
            "officialOnlyPass",
            "bothFail",
          ],
          properties: {
            bothPass: nonNegativeInteger,
            candidateOnlyPass: nonNegativeInteger,
            officialOnlyPass: nonNegativeInteger,
            bothFail: nonNegativeInteger,
          },
        },
        slices: {
          type: "object",
          additionalProperties: false,
          required: ["byAbility", "byQuestionType"],
          properties: {
            byAbility: {
              type: "object",
              additionalProperties: false,
              required: agentMemoryAbilities,
              properties: Object.fromEntries(
                agentMemoryAbilities.map((ability) => [
                  ability,
                  evaluatorParitySliceMetrics,
                ])
              ),
            },
            byQuestionType: {
              type: "object",
              additionalProperties: false,
              required: longMemEvalQuestionTypes,
              properties: Object.fromEntries(
                longMemEvalQuestionTypes.map((questionType) => [
                  questionType,
                  evaluatorParitySliceMetrics,
                ])
              ),
            },
          },
        },
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      required: [
        "labelMismatchAffectsCommandExit",
        "requireExactAffectsCommandExit",
        "rawQuestionsIncluded",
        "rawExpectedAnswersIncluded",
        "rawHypothesesIncluded",
        "rawEvidenceIncluded",
      ],
      properties: {
        labelMismatchAffectsCommandExit: { const: false },
        requireExactAffectsCommandExit: { const: true },
        rawQuestionsIncluded: { const: false },
        rawExpectedAnswersIncluded: { const: false },
        rawHypothesesIncluded: { const: false },
        rawEvidenceIncluded: { const: false },
      },
    },
    claim: {
      type: "object",
      additionalProperties: false,
      required: [
        "evidenceClass",
        "exactAgreement",
        "publicationEligible",
        "blockers",
      ],
      properties: {
        evidenceClass: {
          enum: ["harness", "candidate", "benchmark"],
        },
        exactAgreement: { type: "boolean" },
        publicationEligible: { const: false },
        blockers: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: nonEmptyString,
        },
      },
    },
    mismatches: {
      type: "array",
      items: evaluatorParityMismatch,
    },
  },
  allOf: [
    ...(["harness", "candidate", "benchmark"] as const).map(
      (resultClass) => ({
        if: {
          type: "object",
          properties: {
            candidate: {
              type: "object",
              properties: {
                resultClass: { const: resultClass },
              },
              required: ["resultClass"],
            },
          },
          required: ["candidate"],
        },
        then: {
          type: "object",
          properties: {
            claim: {
              type: "object",
              properties: {
                evidenceClass: { const: resultClass },
              },
              required: ["evidenceClass"],
            },
          },
        },
      })
    ),
    {
      if: {
        type: "object",
        properties: {
          metrics: {
            type: "object",
            properties: { exactAgreement: { const: true } },
            required: ["exactAgreement"],
          },
        },
        required: ["metrics"],
      },
      then: {
        type: "object",
        properties: {
          compatibility: {
            type: "object",
            properties: { comparable: { const: true } },
            required: ["comparable"],
          },
          metrics: {
            type: "object",
            properties: {
              labelMismatches: { const: 0 },
              agreementRate: { const: 1 },
              compared: {
                type: "integer",
                minimum: 1,
              },
            },
            required: [
              "labelMismatches",
              "agreementRate",
              "compared",
            ],
          },
          coverage: {
            type: "object",
            properties: {
              candidateOnlyIds: {
                type: "array",
                maxItems: 0,
              },
              officialOnlyIds: {
                type: "array",
                maxItems: 0,
              },
              hypothesisMismatchIds: {
                type: "array",
                maxItems: 0,
              },
            },
            required: [
              "candidateOnlyIds",
              "officialOnlyIds",
              "hypothesisMismatchIds",
            ],
          },
          claim: {
            type: "object",
            properties: { exactAgreement: { const: true } },
            required: ["exactAgreement"],
          },
          mismatches: {
            type: "array",
            maxItems: 0,
          },
        },
      },
    },
    {
      if: {
        type: "object",
        properties: {
          claim: {
            type: "object",
            properties: { exactAgreement: { const: true } },
            required: ["exactAgreement"],
          },
        },
        required: ["claim"],
      },
      then: {
        type: "object",
        properties: {
          metrics: {
            type: "object",
            properties: { exactAgreement: { const: true } },
            required: ["exactAgreement"],
          },
        },
      },
    },
  ],
  $defs: {
    evaluatorParitySliceMetrics,
    evaluatorParityMismatch,
  },
};

const qualificationSubmitter = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "affiliation"],
  properties: {
    id: nonEmptyString,
    type: { enum: ["human", "organization", "automation"] },
    affiliation: nonEmptyString,
  },
} as const;

const qualificationReviewer = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "type",
    "affiliation",
    "conflicts",
    "reviewedAt",
  ],
  properties: {
    id: nonEmptyString,
    type: { const: "human" },
    affiliation: nonEmptyString,
    conflicts: stringArray,
    reviewedAt: dateTime,
  },
} as const;

const qualificationMaintainer = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "type",
    "verifiedAt",
    "reviewerIdentityVerified",
    "conflictsReviewed",
    "disposition",
  ],
  properties: {
    id: nonEmptyString,
    type: { const: "human" },
    verifiedAt: dateTime,
    reviewerIdentityVerified: { type: "boolean" },
    conflictsReviewed: { type: "boolean" },
    disposition: nonEmptyString,
  },
} as const;

const qualificationAttestation = {
  type: "object",
  additionalProperties: false,
  required: [
    "evidenceAuthentic",
    "realServiceOrImplementation",
    "noContractOrFakeServer",
    "configurationPinned",
    "credentialsExcluded",
    "evidencePublished",
    "independentReproduction",
    "authenticationFailureObserved",
    "lifecycleOperationsObserved",
    "disposableIsolationObserved",
    "cleanupVerified",
    "apiContractObserved",
    "requestPolicyVerified",
    "officialEvaluatorParityVerified",
  ],
  properties: {
    evidenceAuthentic: { type: "boolean" },
    realServiceOrImplementation: { type: "boolean" },
    noContractOrFakeServer: { type: "boolean" },
    configurationPinned: { type: "boolean" },
    credentialsExcluded: { type: "boolean" },
    evidencePublished: { type: "boolean" },
    independentReproduction: { type: "boolean" },
    authenticationFailureObserved: nullable({ type: "boolean" }),
    lifecycleOperationsObserved: nullable({ type: "boolean" }),
    disposableIsolationObserved: nullable({ type: "boolean" }),
    cleanupVerified: nullable({ type: "boolean" }),
    apiContractObserved: nullable({ type: "boolean" }),
    requestPolicyVerified: nullable({ type: "boolean" }),
    officialEvaluatorParityVerified: nullable({
      type: "boolean",
    }),
  },
} as const;

const qualificationAgentReportEvidence = {
  type: "object",
  additionalProperties: false,
  required: [
    "file",
    "sha256",
    "runId",
    "reportStatus",
    "resultClass",
    "datasetArtifactSha256",
    "scenarios",
    "runtimeFailures",
    "cleanupVerificationRate",
  ],
  properties: {
    file: nonEmptyString,
    sha256,
    runId: nonEmptyString,
    reportStatus: {
      enum: ["completed", "completed-with-errors", "failed"],
    },
    resultClass: {
      enum: ["harness", "candidate", "benchmark"],
    },
    datasetArtifactSha256: sha256,
    scenarios: nonNegativeInteger,
    runtimeFailures: nonNegativeInteger,
    cleanupVerificationRate: nullable(ratio),
  },
} as const;

const qualificationCoreReportEvidence = {
  type: "object",
  additionalProperties: false,
  required: [
    "file",
    "sha256",
    "runId",
    "datasetName",
    "datasetVersion",
    "datasetPublicationStatus",
    "adapterName",
    "adapterVersion",
    "adapterInfoSha256",
    "queries",
    "queryFailures",
    "cleanupVerified",
    "operationCounts",
  ],
  properties: {
    file: nonEmptyString,
    sha256,
    runId: nonEmptyString,
    datasetName: nonEmptyString,
    datasetVersion: nonEmptyString,
    datasetPublicationStatus: { enum: publicationStatuses },
    adapterName: nonEmptyString,
    adapterVersion: nonEmptyString,
    adapterInfoSha256: sha256,
    queries: nonNegativeInteger,
    queryFailures: nonNegativeInteger,
    cleanupVerified: { type: "boolean" },
    operationCounts: {
      type: "object",
      additionalProperties: false,
      required: ["write", "update", "delete", "query"],
      properties: {
        write: nonNegativeInteger,
        update: nonNegativeInteger,
        delete: nonNegativeInteger,
        query: nonNegativeInteger,
      },
    },
  },
} as const;

const qualificationParityEvidence = {
  type: "object",
  additionalProperties: false,
  required: [
    "file",
    "sha256",
    "candidateReportSha256",
    "comparable",
    "exactAgreement",
    "labelMismatches",
    "evaluatorRevision",
    "evaluatorScriptSha256",
  ],
  properties: {
    file: nonEmptyString,
    sha256,
    candidateReportSha256: sha256,
    comparable: { type: "boolean" },
    exactAgreement: { type: "boolean" },
    labelMismatches: nonNegativeInteger,
    evaluatorRevision: nonEmptyString,
    evaluatorScriptSha256: sha256,
  },
} as const;

const qualificationRoleCondition = (
  role: "adapter" | "reader" | "judge"
): AnySchemaObject => {
  const adapter = role === "adapter";
  const judge = role === "judge";
  return {
    if: {
      type: "object",
      properties: {
        subject: {
          type: "object",
          properties: {
            role: { const: role },
          },
          required: ["role"],
        },
      },
      required: ["subject"],
    },
    then: {
      type: "object",
      properties: {
        evidence: {
          type: "object",
          properties: {
            coreReport: adapter
              ? qualificationCoreReportEvidence
              : { type: "null" },
            evaluatorParity: judge
              ? qualificationParityEvidence
              : { type: "null" },
          },
          required: ["coreReport", "evaluatorParity"],
        },
      },
    },
  };
};

const qualifiedRoleAttestationCondition = (
  role: "adapter" | "reader" | "judge"
): AnySchemaObject => {
  const adapter = role === "adapter";
  const judge = role === "judge";
  return {
    if: {
      type: "object",
      properties: {
        decision: { const: "qualified" },
        subject: {
          type: "object",
          properties: {
            role: { const: role },
          },
          required: ["role"],
        },
      },
      required: ["decision", "subject"],
    },
    then: {
      type: "object",
      properties: {
        attestation: {
          type: "object",
          properties: {
            authenticationFailureObserved: adapter
              ? { const: true }
              : { type: "null" },
            lifecycleOperationsObserved: adapter
              ? { const: true }
              : { type: "null" },
            disposableIsolationObserved: adapter
              ? { const: true }
              : { type: "null" },
            cleanupVerified: adapter
              ? { const: true }
              : { type: "null" },
            apiContractObserved: adapter
              ? { type: "null" }
              : { const: true },
            requestPolicyVerified: adapter
              ? { type: "null" }
              : { const: true },
            officialEvaluatorParityVerified: judge
              ? { const: true }
              : { type: "null" },
          },
          required: [
            "authenticationFailureObserved",
            "lifecycleOperationsObserved",
            "disposableIsolationObserved",
            "cleanupVerified",
            "apiContractObserved",
            "requestPolicyVerified",
            "officialEvaluatorParityVerified",
          ],
        },
      },
    },
  };
};

export const componentQualificationSchema: AnySchemaObject = {
  $schema: draft202012,
  $id: schemaUrn("component-qualification"),
  title: "Memory Bench component qualification schema v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "qualificationId",
    "subject",
    "evidence",
    "submitter",
    "reviewer",
    "maintainer",
    "attestation",
    "decision",
    "decisionNote",
  ],
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: "memory-bench-component-qualification" },
    qualificationId: {
      type: "string",
      pattern: "^mbq-(adapter|reader|judge)-[a-f0-9]{32}$",
    },
    subject: {
      type: "object",
      additionalProperties: false,
      required: ["role", "component", "componentSha256"],
      properties: {
        role: { enum: ["adapter", "reader", "judge"] },
        component: agentComponentInfo,
        componentSha256: sha256,
      },
    },
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["agentReport", "coreReport", "evaluatorParity"],
      properties: {
        agentReport: qualificationAgentReportEvidence,
        coreReport: nullable(qualificationCoreReportEvidence),
        evaluatorParity: nullable(qualificationParityEvidence),
      },
    },
    submitter: nullable(qualificationSubmitter),
    reviewer: nullable(qualificationReviewer),
    maintainer: nullable(qualificationMaintainer),
    attestation: nullable(qualificationAttestation),
    decision: { enum: ["pending", "qualified", "rejected"] },
    decisionNote: nullable(nonEmptyString),
  },
  allOf: [
    qualificationRoleCondition("adapter"),
    qualificationRoleCondition("reader"),
    qualificationRoleCondition("judge"),
    qualifiedRoleAttestationCondition("adapter"),
    qualifiedRoleAttestationCondition("reader"),
    qualifiedRoleAttestationCondition("judge"),
    {
      if: {
        type: "object",
        properties: {
          decision: { const: "pending" },
        },
        required: ["decision"],
      },
      then: {
        type: "object",
        properties: {
          submitter: { type: "null" },
          reviewer: { type: "null" },
          maintainer: { type: "null" },
          attestation: { type: "null" },
          decisionNote: { type: "null" },
        },
      },
    },
    {
      if: {
        type: "object",
        properties: {
          decision: { enum: ["qualified", "rejected"] },
        },
        required: ["decision"],
      },
      then: {
        type: "object",
        properties: {
          submitter: qualificationSubmitter,
          reviewer: qualificationReviewer,
          maintainer: qualificationMaintainer,
          decisionNote: nonEmptyString,
        },
      },
    },
    {
      if: {
        type: "object",
        properties: {
          decision: { const: "qualified" },
        },
        required: ["decision"],
      },
      then: {
        type: "object",
        properties: {
          subject: {
            type: "object",
            properties: {
              component: {
                type: "object",
                properties: {
                  classification: { const: "candidate" },
                },
                required: ["classification"],
              },
            },
            required: ["component"],
          },
          attestation: {
            ...qualificationAttestation,
            properties: {
              ...qualificationAttestation.properties,
              evidenceAuthentic: { const: true },
              realServiceOrImplementation: { const: true },
              noContractOrFakeServer: { const: true },
              configurationPinned: { const: true },
              credentialsExcluded: { const: true },
              evidencePublished: { const: true },
              independentReproduction: { const: true },
            },
          },
        },
      },
    },
  ],
  $defs: {
    agentComponentInfo,
    qualificationSubmitter,
    qualificationReviewer,
    qualificationMaintainer,
    qualificationAttestation,
    qualificationAgentReportEvidence,
    qualificationCoreReportEvidence,
    qualificationParityEvidence,
  },
};

const statisticalMetricNames = [
  "query-pass-rate",
  "qa-accuracy",
  "macro-recall-at-k",
  "macro-precision-at-k",
  "mean-reciprocal-rank",
  "forbidden-hit-rate",
  "abstention-accuracy",
  "cleanup-verification-rate",
] as const;

const statisticalPointEstimate = {
  type: "object",
  additionalProperties: false,
  required: ["adapterA", "adapterB", "bMinusA"],
  properties: {
    adapterA: ratio,
    adapterB: ratio,
    bMinusA: {
      type: "number",
      minimum: -1,
      maximum: 1,
    },
  },
} as const;

const statisticalConfidenceInterval = {
  type: "object",
  additionalProperties: false,
  required: ["lower", "upper"],
  properties: {
    lower: {
      type: "number",
      minimum: -1,
      maximum: 1,
    },
    upper: {
      type: "number",
      minimum: -1,
      maximum: 1,
    },
  },
} as const;

const statisticalMetricResult = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "direction",
    "status",
    "eligibleClusters",
    "pairedObservations",
    "pointEstimate",
    "confidenceInterval",
  ],
  properties: {
    name: { enum: statisticalMetricNames },
    direction: {
      enum: ["higher-is-better", "lower-is-better"],
    },
    status: {
      enum: [
        "estimated",
        "insufficient-data",
        "not-applicable",
      ],
    },
    eligibleClusters: nonNegativeInteger,
    pairedObservations: nonNegativeInteger,
    pointEstimate: nullable(statisticalPointEstimate),
    confidenceInterval: nullable(statisticalConfidenceInterval),
  },
  allOf: [
    {
      if: {
        type: "object",
        properties: {
          status: { const: "estimated" },
        },
        required: ["status"],
      },
      then: {
        type: "object",
        properties: {
          eligibleClusters: {
            type: "integer",
            minimum: 2,
          },
          pairedObservations: {
            type: "integer",
            minimum: 2,
          },
          pointEstimate: statisticalPointEstimate,
          confidenceInterval: statisticalConfidenceInterval,
        },
      },
    },
    {
      if: {
        type: "object",
        properties: {
          status: { const: "insufficient-data" },
        },
        required: ["status"],
      },
      then: {
        type: "object",
        properties: {
          eligibleClusters: { const: 1 },
          pairedObservations: {
            type: "integer",
            minimum: 1,
          },
          pointEstimate: statisticalPointEstimate,
          confidenceInterval: { type: "null" },
        },
      },
    },
    {
      if: {
        type: "object",
        properties: {
          status: { const: "not-applicable" },
        },
        required: ["status"],
      },
      then: {
        type: "object",
        properties: {
          eligibleClusters: { const: 0 },
          pairedObservations: { const: 0 },
          pointEstimate: { type: "null" },
          confidenceInterval: { type: "null" },
        },
      },
    },
  ],
} as const;

export const statisticalComparisonSchema: AnySchemaObject = {
  $schema: draft202012,
  $id: schemaUrn("statistical-comparison"),
  title: "Memory Bench statistical comparison schema v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "analysisId",
    "createdAt",
    "track",
    "comparison",
    "method",
    "reports",
    "coverage",
    "pairwise",
    "policy",
    "claim",
  ],
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: "memory-bench-statistical-comparison" },
    analysisId: {
      type: "string",
      pattern: "^mbs-[a-f0-9]{32}$",
    },
    createdAt: dateTime,
    track: { enum: ["core", "agent"] },
    comparison: {
      type: "object",
      additionalProperties: false,
      required: [
        "file",
        "sha256",
        "comparisonId",
        "datasetSha256",
        "evaluationSha256",
      ],
      properties: {
        file: nonEmptyString,
        sha256,
        comparisonId: nonEmptyString,
        datasetSha256: sha256,
        evaluationSha256: nullable(sha256),
      },
    },
    method: {
      type: "object",
      additionalProperties: false,
      required: [
        "name",
        "resamplingUnit",
        "comparison",
        "interval",
        "rng",
        "iterations",
        "confidenceLevel",
        "seed",
        "multiplicityAdjustment",
      ],
      properties: {
        name: {
          const: "paired-scenario-cluster-bootstrap-percentile",
        },
        resamplingUnit: { const: "scenario" },
        comparison: { const: "adapter-b-minus-adapter-a" },
        interval: { const: "percentile" },
        rng: { const: "xorshift32" },
        iterations: {
          type: "integer",
          minimum: 1_000,
          maximum: 1_000_000,
        },
        confidenceLevel: {
          type: "number",
          minimum: 0.8,
          maximum: 0.999,
        },
        seed: {
          type: "integer",
          minimum: 1,
          maximum: 4_294_967_295,
        },
        multiplicityAdjustment: {
          const: "none-descriptive-only",
        },
      },
    },
    reports: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "adapter",
          "file",
          "sha256",
          "clusters",
          "observations",
        ],
        properties: {
          adapter: { enum: adapterNames },
          file: nonEmptyString,
          sha256,
          clusters: {
            type: "integer",
            minimum: 1,
          },
          observations: {
            type: "integer",
            minimum: 1,
          },
        },
      },
    },
    coverage: {
      type: "object",
      additionalProperties: false,
      required: [
        "adapters",
        "pairs",
        "clusterIdentityExact",
        "observationIdentityExact",
        "metricMissingnessExact",
      ],
      properties: {
        adapters: {
          type: "integer",
          minimum: 2,
        },
        pairs: {
          type: "integer",
          minimum: 1,
        },
        clusterIdentityExact: { const: true },
        observationIdentityExact: { const: true },
        metricMissingnessExact: { const: true },
      },
    },
    pairwise: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "adapterA",
          "adapterB",
          "sharedClusters",
          "sharedObservations",
          "metrics",
        ],
        properties: {
          adapterA: { enum: adapterNames },
          adapterB: { enum: adapterNames },
          sharedClusters: {
            type: "integer",
            minimum: 1,
          },
          sharedObservations: {
            type: "integer",
            minimum: 1,
          },
          metrics: {
            type: "array",
            minItems: 4,
            maxItems: 6,
            items: statisticalMetricResult,
          },
        },
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      required: [
        "descriptiveOnly",
        "rankingClaimed",
        "statisticalSignificanceClaimed",
        "rawQueriesIncluded",
        "rawExpectedAnswersIncluded",
        "rawHypothesesIncluded",
        "rawEvidenceIncluded",
      ],
      properties: {
        descriptiveOnly: { const: true },
        rankingClaimed: { const: false },
        statisticalSignificanceClaimed: { const: false },
        rawQueriesIncluded: { const: false },
        rawExpectedAnswersIncluded: { const: false },
        rawHypothesesIncluded: { const: false },
        rawEvidenceIncluded: { const: false },
      },
    },
    claim: {
      type: "object",
      additionalProperties: false,
      required: ["allIntervalsAvailable", "blockers"],
      properties: {
        allIntervalsAvailable: { type: "boolean" },
        blockers: {
          type: "array",
          uniqueItems: true,
          items: nonEmptyString,
        },
      },
    },
  },
  allOf: [
    {
      if: {
        type: "object",
        properties: {
          claim: {
            type: "object",
            properties: {
              allIntervalsAvailable: { const: true },
            },
            required: ["allIntervalsAvailable"],
          },
        },
        required: ["claim"],
      },
      then: {
        type: "object",
        properties: {
          claim: {
            type: "object",
            properties: {
              blockers: {
                type: "array",
                maxItems: 0,
              },
            },
            required: ["blockers"],
          },
        },
      },
      else: {
        type: "object",
        properties: {
          claim: {
            type: "object",
            properties: {
              blockers: {
                type: "array",
                minItems: 1,
              },
            },
            required: ["blockers"],
          },
        },
      },
    },
  ],
  $defs: {
    statisticalMetricResult,
    statisticalPointEstimate,
    statisticalConfidenceInterval,
  },
};

const agentPublicationRelease = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "releasedAt",
    "publisher",
    "maintainer",
    "evidenceBundleUri",
    "releaseNotesUri",
    "correctionsUri",
    "providerAffiliations",
    "sponsorships",
    "knownLimitations",
    "attestation",
  ],
  properties: {
    version: nonEmptyString,
    releasedAt: dateTime,
    publisher: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "affiliation"],
      properties: {
        id: nonEmptyString,
        type: { enum: ["human", "organization"] },
        affiliation: nonEmptyString,
      },
    },
    maintainer: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "affiliation"],
      properties: {
        id: nonEmptyString,
        type: { const: "human" },
        affiliation: nonEmptyString,
      },
    },
    evidenceBundleUri: {
      type: "string",
      format: "uri",
    },
    releaseNotesUri: {
      type: "string",
      format: "uri",
    },
    correctionsUri: {
      type: "string",
      format: "uri",
    },
    providerAffiliations: stringArray,
    sponsorships: stringArray,
    knownLimitations: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: nonEmptyString,
    },
    attestation: {
      type: "object",
      additionalProperties: false,
      required: [
        "datasetRightsVerified",
        "noQuerySpecificTuning",
        "providerDisclosuresComplete",
        "sponsorshipDisclosuresComplete",
        "allEvidencePublished",
        "independentAuditComplete",
        "secretsExcluded",
        "correctionsPolicyAccepted",
      ],
      properties: {
        datasetRightsVerified: { type: "boolean" },
        noQuerySpecificTuning: { type: "boolean" },
        providerDisclosuresComplete: { type: "boolean" },
        sponsorshipDisclosuresComplete: { type: "boolean" },
        allEvidencePublished: { type: "boolean" },
        independentAuditComplete: { type: "boolean" },
        secretsExcluded: { type: "boolean" },
        correctionsPolicyAccepted: { type: "boolean" },
      },
    },
  },
} as const;

const agentPublicationRun = {
  type: "object",
  additionalProperties: false,
  required: [
    "adapter",
    "processId",
    "reportFile",
    "reportSha256",
    "resultClass",
    "componentSha256",
    "evaluatorParityFile",
    "evaluatorParitySha256",
  ],
  properties: {
    adapter: { enum: adapterNames },
    processId: {
      type: "integer",
      minimum: 1,
    },
    reportFile: nonEmptyString,
    reportSha256: sha256,
    resultClass: {
      enum: ["harness", "candidate", "benchmark"],
    },
    componentSha256: {
      type: "object",
      additionalProperties: false,
      required: ["adapter", "reader", "judge"],
      properties: {
        adapter: sha256,
        reader: sha256,
        judge: sha256,
      },
    },
    evaluatorParityFile: nullable(nonEmptyString),
    evaluatorParitySha256: nullable(sha256),
  },
} as const;

const agentPublicationQualification = {
  type: "object",
  additionalProperties: false,
  required: [
    "file",
    "sha256",
    "qualificationId",
    "role",
    "componentName",
    "componentSha256",
    "reviewerId",
    "maintainerId",
  ],
  properties: {
    file: nonEmptyString,
    sha256,
    qualificationId: {
      type: "string",
      pattern: "^mbq-(adapter|reader|judge)-[a-f0-9]{32}$",
    },
    role: { enum: ["adapter", "reader", "judge"] },
    componentName: nonEmptyString,
    componentSha256: sha256,
    reviewerId: nonEmptyString,
    maintainerId: nonEmptyString,
  },
} as const;

const agentPublicationStatistics = {
  type: "object",
  additionalProperties: false,
  required: [
    "file",
    "sha256",
    "analysisId",
    "comparisonSha256",
    "iterations",
    "confidenceLevel",
    "seed",
    "allIntervalsAvailable",
  ],
  properties: {
    file: nonEmptyString,
    sha256,
    analysisId: {
      type: "string",
      pattern: "^mbs-[a-f0-9]{32}$",
    },
    comparisonSha256: sha256,
    iterations: {
      type: "integer",
      minimum: 1_000,
      maximum: 1_000_000,
    },
    confidenceLevel: {
      type: "number",
      minimum: 0.8,
      maximum: 0.999,
    },
    seed: {
      type: "integer",
      minimum: 1,
      maximum: 4_294_967_295,
    },
    allIntervalsAvailable: { type: "boolean" },
  },
} as const;

export const agentPublicationSchema: AnySchemaObject = {
  $schema: draft202012,
  $id: schemaUrn("agent-publication"),
  title: "Memory Bench agent publication evidence schema v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "publicationId",
    "status",
    "assembledAt",
    "finalizedAt",
    "comparison",
    "runs",
    "qualifications",
    "statistics",
    "release",
    "claim",
  ],
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: "memory-bench-agent-publication" },
    publicationId: {
      type: "string",
      pattern: "^mbp-[a-f0-9]{32}$",
    },
    status: { enum: ["draft", "final"] },
    assembledAt: dateTime,
    finalizedAt: nullable(dateTime),
    comparison: {
      type: "object",
      additionalProperties: false,
      required: [
        "file",
        "sha256",
        "comparisonId",
        "datasetArtifactSha256",
        "evaluationSha256",
        "sourceCommit",
        "sourceDirty",
      ],
      properties: {
        file: nonEmptyString,
        sha256,
        comparisonId: nonEmptyString,
        datasetArtifactSha256: sha256,
        evaluationSha256: sha256,
        sourceCommit: nullable({
          type: "string",
          pattern: "^[a-f0-9]{40,64}$",
        }),
        sourceDirty: nullable({ type: "boolean" }),
      },
    },
    runs: {
      type: "array",
      minItems: 2,
      items: agentPublicationRun,
    },
    qualifications: {
      type: "array",
      items: agentPublicationQualification,
    },
    statistics: nullable(agentPublicationStatistics),
    release: nullable(agentPublicationRelease),
    claim: {
      type: "object",
      additionalProperties: false,
      required: [
        "resultClass",
        "mechanicallyVerified",
        "publicationEligible",
        "blockers",
      ],
      properties: {
        resultClass: { enum: ["candidate", "benchmark"] },
        mechanicallyVerified: { type: "boolean" },
        publicationEligible: { type: "boolean" },
        blockers: {
          type: "array",
          uniqueItems: true,
          items: nonEmptyString,
        },
      },
    },
  },
  allOf: [
    {
      if: {
        type: "object",
        properties: {
          status: { const: "draft" },
        },
        required: ["status"],
      },
      then: {
        type: "object",
        properties: {
          finalizedAt: { type: "null" },
          claim: {
            type: "object",
            properties: {
              resultClass: { const: "candidate" },
              publicationEligible: { const: false },
              blockers: {
                type: "array",
                minItems: 1,
              },
            },
            required: [
              "resultClass",
              "publicationEligible",
              "blockers",
            ],
          },
        },
      },
    },
    {
      if: {
        type: "object",
        properties: {
          status: { const: "final" },
        },
        required: ["status"],
      },
      then: {
        type: "object",
        properties: {
          finalizedAt: dateTime,
          comparison: {
            type: "object",
            properties: {
              sourceCommit: {
                type: "string",
                pattern: "^[a-f0-9]{40,64}$",
              },
              sourceDirty: { const: false },
            },
            required: ["sourceCommit", "sourceDirty"],
          },
          runs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                resultClass: {
                  enum: ["candidate", "benchmark"],
                },
                evaluatorParityFile: nonEmptyString,
                evaluatorParitySha256: sha256,
              },
              required: [
                "resultClass",
                "evaluatorParityFile",
                "evaluatorParitySha256",
              ],
            },
          },
          qualifications: {
            type: "array",
            minItems: 1,
          },
          statistics: {
            ...agentPublicationStatistics,
            properties: {
              ...agentPublicationStatistics.properties,
              allIntervalsAvailable: { const: true },
            },
          },
          release: {
            ...agentPublicationRelease,
            properties: {
              ...agentPublicationRelease.properties,
              attestation: {
                type: "object",
                properties: Object.fromEntries(
                  [
                    "datasetRightsVerified",
                    "noQuerySpecificTuning",
                    "providerDisclosuresComplete",
                    "sponsorshipDisclosuresComplete",
                    "allEvidencePublished",
                    "independentAuditComplete",
                    "secretsExcluded",
                    "correctionsPolicyAccepted",
                  ].map((key) => [key, { const: true }])
                ),
                required: [
                  "datasetRightsVerified",
                  "noQuerySpecificTuning",
                  "providerDisclosuresComplete",
                  "sponsorshipDisclosuresComplete",
                  "allEvidencePublished",
                  "independentAuditComplete",
                  "secretsExcluded",
                  "correctionsPolicyAccepted",
                ],
              },
            },
          },
          claim: {
            type: "object",
            properties: {
              resultClass: { const: "benchmark" },
              mechanicallyVerified: { const: true },
              publicationEligible: { const: true },
              blockers: {
                type: "array",
                maxItems: 0,
              },
            },
            required: [
              "resultClass",
              "mechanicallyVerified",
              "publicationEligible",
              "blockers",
            ],
          },
        },
      },
    },
  ],
  $defs: {
    agentPublicationRelease,
    agentPublicationRun,
    agentPublicationQualification,
    agentPublicationStatistics,
  },
};

export const memoryBenchSchemas: Record<string, AnySchemaObject> = {
  "dataset.schema.json": datasetSchema,
  "agent-dataset.schema.json": agentDatasetSchema,
  "report.schema.json": reportSchema,
  "agent-report.schema.json": agentReportSchema,
  "comparison-manifest.schema.json": comparisonManifestSchema,
  "agent-comparison-manifest.schema.json": agentComparisonManifestSchema,
  "evaluator-parity.schema.json": evaluatorParitySchema,
  "component-qualification.schema.json": componentQualificationSchema,
  "statistical-comparison.schema.json": statisticalComparisonSchema,
  "agent-publication.schema.json": agentPublicationSchema,
  "review-packet.schema.json": reviewPacketSchema,
  "review-overlay.schema.json": reviewOverlaySchema,
};
