import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { chain } from "stream-chain";
import { pick } from "stream-json/filters/pick.js";
import { parser } from "stream-json/parser.js";
import { streamArray } from "stream-json/streamers/stream-array.js";
import { streamObject } from "stream-json/streamers/stream-object.js";
import {
  agentMemoryAbilities,
  longMemEvalQuestionTypes,
  longMemEvalSubsets,
  type AgentMemoryAbility,
  type AgentMemoryDatasetMetadata,
  type AgentMemoryDatasetSource,
  type AgentMemoryMessage,
  type AgentMemoryScenario,
  type LongMemEvalQuestionType,
  type LongMemEvalSubset,
} from "./agent-types.js";

const sha256Pattern = /^[a-f0-9]{64}$/;
const allowedAbilities = new Set<AgentMemoryAbility>(agentMemoryAbilities);
const allowedQuestionTypes = new Set<LongMemEvalQuestionType>(
  longMemEvalQuestionTypes
);
const allowedSubsets = new Set<LongMemEvalSubset>(longMemEvalSubsets);
const metadataKeys = [
  "schemaVersion",
  "name",
  "version",
  "license",
  "track",
  "language",
  "description",
  "source",
] as const;

function recordValue(
  value: unknown,
  location: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !(key in value));
  if (unexpected.length > 0) {
    throw new Error(
      `${location} has unexpected fields: ${unexpected.sort().join(", ")}`
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `${location} is missing fields: ${missing.sort().join(", ")}`
    );
  }
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, location: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${location} must be a positive integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${location} must be a boolean`);
  }
  return value;
}

function uniqueStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  const result = value.map((item, index) =>
    nonEmptyString(item, `${location}[${index}]`)
  );
  if (new Set(result).size !== result.length) {
    throw new Error(`${location} must not contain duplicates`);
  }
  return result;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  location: string
): T {
  const result = nonEmptyString(value, location) as T;
  if (!allowed.has(result)) {
    throw new Error(`${location} has unsupported value ${JSON.stringify(result)}`);
  }
  return result;
}

function expectedAbility(
  id: string,
  questionType: LongMemEvalQuestionType
): AgentMemoryAbility {
  if (id.endsWith("_abs")) return "abstention";
  if (questionType.startsWith("single-session-")) {
    return "information-extraction";
  }
  if (questionType === "multi-session") return "multi-session-reasoning";
  if (questionType === "knowledge-update") return "knowledge-update";
  return "temporal-reasoning";
}

function parseMessage(value: unknown, location: string): AgentMemoryMessage {
  const raw = recordValue(value, location);
  const allowed = raw.hasAnswer === undefined
    ? ["role", "content"]
    : ["role", "content", "hasAnswer"];
  exactKeys(raw, allowed, location);
  const role = nonEmptyString(raw.role, `${location}.role`);
  if (role !== "user" && role !== "assistant") {
    throw new Error(`${location}.role must be user or assistant`);
  }
  return {
    role,
    content: nonEmptyString(raw.content, `${location}.content`),
    ...(raw.hasAnswer === undefined
      ? {}
      : { hasAnswer: booleanValue(raw.hasAnswer, `${location}.hasAnswer`) }),
  };
}

export function parseAgentScenario(
  value: unknown,
  index: number
): AgentMemoryScenario {
  const location = `agentDataset.scenarios[${index}]`;
  const raw = recordValue(value, location);
  exactKeys(
    raw,
    [
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
    location
  );
  const id = nonEmptyString(raw.id, `${location}.id`);
  const sourceQuestionType = enumValue(
    raw.sourceQuestionType,
    allowedQuestionTypes,
    `${location}.sourceQuestionType`
  );
  const ability = enumValue(
    raw.ability,
    allowedAbilities,
    `${location}.ability`
  );
  const inferredAbility = expectedAbility(id, sourceQuestionType);
  if (ability !== inferredAbility) {
    throw new Error(
      `${location}.ability must be ${inferredAbility} for this question`
    );
  }
  const expectedAbstention = booleanValue(
    raw.expectedAbstention,
    `${location}.expectedAbstention`
  );
  if (expectedAbstention !== id.endsWith("_abs")) {
    throw new Error(
      `${location}.expectedAbstention must match the _abs question suffix`
    );
  }
  if (!Array.isArray(raw.sessions) || raw.sessions.length === 0) {
    throw new Error(`${location}.sessions must be a non-empty array`);
  }
  const sessionIds = new Set<string>();
  const sessions = raw.sessions.map((session, sessionIndex) => {
    const sessionLocation = `${location}.sessions[${sessionIndex}]`;
    const sessionRaw = recordValue(session, sessionLocation);
    exactKeys(sessionRaw, ["id", "date", "messages"], sessionLocation);
    const sessionId = nonEmptyString(sessionRaw.id, `${sessionLocation}.id`);
    if (sessionIds.has(sessionId)) {
      throw new Error(`${location}.sessions contains duplicate ID ${sessionId}`);
    }
    sessionIds.add(sessionId);
    if (
      !Array.isArray(sessionRaw.messages) ||
      sessionRaw.messages.length === 0
    ) {
      throw new Error(`${sessionLocation}.messages must be a non-empty array`);
    }
    return {
      id: sessionId,
      date: nonEmptyString(sessionRaw.date, `${sessionLocation}.date`),
      messages: sessionRaw.messages.map((message, messageIndex) =>
        parseMessage(message, `${sessionLocation}.messages[${messageIndex}]`)
      ),
    };
  });
  const evidenceSessionIds = uniqueStringArray(
    raw.evidenceSessionIds,
    `${location}.evidenceSessionIds`
  );
  const missingEvidence = evidenceSessionIds.filter(
    (sessionId) => !sessionIds.has(sessionId)
  );
  if (missingEvidence.length > 0) {
    throw new Error(
      `${location}.evidenceSessionIds reference missing sessions: ${missingEvidence.join(", ")}`
    );
  }
  if (!expectedAbstention && evidenceSessionIds.length === 0) {
    throw new Error(
      `${location}.evidenceSessionIds must not be empty outside abstention`
    );
  }
  return {
    id,
    sourceQuestionType,
    ability,
    question: nonEmptyString(raw.question, `${location}.question`),
    expectedAnswer: nonEmptyString(
      raw.expectedAnswer,
      `${location}.expectedAnswer`
    ),
    questionDate: nonEmptyString(
      raw.questionDate,
      `${location}.questionDate`
    ),
    expectedAbstention,
    evidenceSessionIds,
    sessions,
  };
}

function parseMetadata(value: unknown): AgentMemoryDatasetMetadata {
  const raw = recordValue(value, "agentDataset");
  exactKeys(raw, metadataKeys, "agentDataset");
  if (raw.schemaVersion !== 1) {
    throw new Error("agentDataset.schemaVersion must be 1");
  }
  if (raw.name !== "memory-bench-longmemeval") {
    throw new Error("agentDataset.name must be memory-bench-longmemeval");
  }
  if (raw.license !== "MIT") throw new Error("agentDataset.license must be MIT");
  if (raw.track !== "agent") {
    throw new Error("agentDataset.track must be agent");
  }
  if (raw.language !== "en") {
    throw new Error("agentDataset.language must be en");
  }
  const source = recordValue(raw.source, "agentDataset.source");
  exactKeys(
    source,
    [
      "benchmark",
      "revision",
      "subset",
      "uri",
      "fileName",
      "sha256",
      "bytes",
    ],
    "agentDataset.source"
  );
  if (source.benchmark !== "longmemeval") {
    throw new Error("agentDataset.source.benchmark must be longmemeval");
  }
  const sourceSha256 = nonEmptyString(
    source.sha256,
    "agentDataset.source.sha256"
  );
  if (!sha256Pattern.test(sourceSha256)) {
    throw new Error("agentDataset.source.sha256 must be a lowercase SHA-256");
  }
  const sourceUri = nonEmptyString(source.uri, "agentDataset.source.uri");
  try {
    new URL(sourceUri);
  } catch {
    throw new Error("agentDataset.source.uri must be an absolute URI");
  }
  return {
    schemaVersion: 1,
    name: "memory-bench-longmemeval",
    version: nonEmptyString(raw.version, "agentDataset.version"),
    license: "MIT",
    track: "agent",
    language: "en",
    description: nonEmptyString(
      raw.description,
      "agentDataset.description"
    ),
    source: {
      benchmark: "longmemeval",
      revision: nonEmptyString(
        source.revision,
        "agentDataset.source.revision"
      ),
      subset: enumValue(
        source.subset,
        allowedSubsets,
        "agentDataset.source.subset"
      ),
      uri: sourceUri,
      fileName: nonEmptyString(
        source.fileName,
        "agentDataset.source.fileName"
      ),
      sha256: sourceSha256,
      bytes: positiveInteger(source.bytes, "agentDataset.source.bytes"),
    },
  };
}

async function readMetadata(file: string): Promise<{
  metadata: AgentMemoryDatasetMetadata;
  artifactSha256: string;
  stat: fs.Stats;
}> {
  const initialStat = await fs.promises.stat(file);
  if (!initialStat.isFile()) throw new Error(`agent dataset is not a file: ${file}`);
  const digest = createHash("sha256");
  const hashTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  let scenariosKeySeen = false;
  const jsonStream = chain([
    fs.createReadStream(file),
    hashTransform,
    parser(),
    streamObject<unknown>({
      objectFilter(assembler) {
        if (
          assembler.depth === 1 &&
          assembler.key === "scenarios"
        ) {
          if (scenariosKeySeen) {
            throw new Error("agentDataset contains duplicate scenarios fields");
          }
          scenariosKeySeen = true;
          return undefined;
        }
        if (assembler.path[0] === "scenarios") return false;
        if (assembler.depth === 1 && assembler.key !== null) return true;
        return undefined;
      },
    }),
  ]);
  const metadataValues: Record<string, unknown> = {};
  for await (const item of jsonStream as AsyncIterable<{
    key: string;
    value: unknown;
  }>) {
    if (item.key in metadataValues) {
      throw new Error(`agentDataset contains duplicate ${item.key} fields`);
    }
    metadataValues[item.key] = item.value;
  }
  if (!scenariosKeySeen) {
    throw new Error("agentDataset is missing fields: scenarios");
  }
  const finalStat = await fs.promises.stat(file);
  if (
    finalStat.size !== initialStat.size ||
    finalStat.mtimeMs !== initialStat.mtimeMs
  ) {
    throw new Error("agent dataset changed during metadata read");
  }
  return {
    metadata: parseMetadata(metadataValues),
    artifactSha256: digest.digest("hex"),
    stat: initialStat,
  };
}

export async function openAgentDataset(
  input: string
): Promise<AgentMemoryDatasetSource> {
  const file = path.resolve(input);
  const loaded = await readMetadata(file);
  return {
    file,
    artifactSha256: loaded.artifactSha256,
    artifactBytes: loaded.stat.size,
    readPasses: 2,
    metadata: loaded.metadata,
    async *scenarios(): AsyncGenerator<AgentMemoryScenario> {
      const before = await fs.promises.stat(file);
      if (
        before.size !== loaded.stat.size ||
        before.mtimeMs !== loaded.stat.mtimeMs
      ) {
        throw new Error("agent dataset changed between read passes");
      }
      const jsonStream = chain([
        fs.createReadStream(file),
        parser(),
        pick({ filter: "scenarios" }),
        streamArray<unknown>(),
      ]);
      const ids = new Set<string>();
      let count = 0;
      try {
        for await (const item of jsonStream as AsyncIterable<{
          key: number;
          value: unknown;
        }>) {
          const scenario = parseAgentScenario(item.value, item.key);
          if (ids.has(scenario.id)) {
            throw new Error(
              `agentDataset contains duplicate scenario ID ${scenario.id}`
            );
          }
          ids.add(scenario.id);
          count += 1;
          yield scenario;
        }
        if (count === 0) {
          throw new Error("agentDataset.scenarios must be a non-empty array");
        }
      } finally {
        jsonStream.destroy();
        const after = await fs.promises.stat(file);
        if (
          after.size !== loaded.stat.size ||
          after.mtimeMs !== loaded.stat.mtimeMs
        ) {
          throw new Error("agent dataset changed during scenario read");
        }
      }
    },
  };
}
