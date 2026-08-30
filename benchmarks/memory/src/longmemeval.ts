import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Transform, type Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { chain } from "stream-chain";
import { parser } from "stream-json/parser.js";
import { streamArray } from "stream-json/streamers/stream-array.js";
import type {
  AgentMemoryAbility,
  AgentMemoryDataset,
  AgentMemoryMessage,
  AgentMemoryScenario,
  LongMemEvalQuestionType,
  LongMemEvalSubset,
} from "./agent-types.js";
import { longMemEvalQuestionTypes } from "./agent-types.js";

const sha256Pattern = /^[a-f0-9]{64}$/;
const shaPlaceholder = "0".repeat(64);
const versionHashPlaceholder = "0".repeat(12);
const allowedQuestionTypes = new Set<LongMemEvalQuestionType>([
  ...longMemEvalQuestionTypes,
]);

export interface LongMemEvalSourceSpec {
  revision: string;
  subset: LongMemEvalSubset;
  uri: string;
  license: "MIT";
  expectedSha256?: string;
  expectedBytes?: number;
}

export interface LongMemEvalImportOptions {
  input: string;
  output: string;
  source: LongMemEvalSourceSpec;
}

export interface LongMemEvalImportSummary {
  output: string;
  sha256: string;
  bytes: number;
  scenarios: number;
  sessions: number;
  turns: number;
  abilities: Record<AgentMemoryAbility, number>;
}

function recordValue(value: unknown, location: string): Record<string, unknown> {
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
  if (unexpected.length > 0) {
    throw new Error(
      `${location} has unexpected fields: ${unexpected.sort().join(", ")}`
    );
  }
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  return value.map((item, index) =>
    nonEmptyString(item, `${location}[${index}]`)
  );
}

function uniqueStringArray(value: unknown, location: string): string[] {
  const result = stringArray(value, location);
  if (new Set(result).size !== result.length) {
    throw new Error(`${location} must not contain duplicates`);
  }
  return result;
}

function expectedAnswer(value: unknown, location: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return nonEmptyString(value, location);
}

function parseQuestionType(
  value: unknown,
  location: string
): LongMemEvalQuestionType {
  const result = nonEmptyString(value, location) as LongMemEvalQuestionType;
  if (!allowedQuestionTypes.has(result)) {
    throw new Error(`${location} has unsupported value ${JSON.stringify(result)}`);
  }
  return result;
}

function abilityFor(
  questionId: string,
  questionType: LongMemEvalQuestionType
): AgentMemoryAbility {
  if (questionId.endsWith("_abs")) return "abstention";
  if (questionType.startsWith("single-session-")) {
    return "information-extraction";
  }
  if (questionType === "multi-session") return "multi-session-reasoning";
  if (questionType === "knowledge-update") return "knowledge-update";
  return "temporal-reasoning";
}

function parseMessage(value: unknown, location: string): AgentMemoryMessage {
  const raw = recordValue(value, location);
  exactKeys(raw, ["role", "content", "has_answer"], location);
  const role = nonEmptyString(raw.role, `${location}.role`);
  if (role !== "user" && role !== "assistant") {
    throw new Error(`${location}.role must be user or assistant`);
  }
  const message: AgentMemoryMessage = {
    role,
    content: nonEmptyString(raw.content, `${location}.content`),
  };
  if (raw.has_answer !== undefined) {
    if (typeof raw.has_answer !== "boolean") {
      throw new Error(`${location}.has_answer must be a boolean`);
    }
    message.hasAnswer = raw.has_answer;
  }
  return message;
}

function parseScenario(value: unknown, index: number): AgentMemoryScenario {
  const location = `longmemeval[${index}]`;
  const raw = recordValue(value, location);
  exactKeys(
    raw,
    [
      "question_id",
      "question_type",
      "question",
      "answer",
      "question_date",
      "haystack_dates",
      "haystack_session_ids",
      "haystack_sessions",
      "answer_session_ids",
    ],
    location
  );
  const id = nonEmptyString(raw.question_id, `${location}.question_id`);
  const sourceQuestionType = parseQuestionType(
    raw.question_type,
    `${location}.question_type`
  );
  const sessionIds = uniqueStringArray(
    raw.haystack_session_ids,
    `${location}.haystack_session_ids`
  );
  const dates = stringArray(raw.haystack_dates, `${location}.haystack_dates`);
  if (!Array.isArray(raw.haystack_sessions)) {
    throw new Error(`${location}.haystack_sessions must be an array`);
  }
  const rawSessions = raw.haystack_sessions;
  if (
    sessionIds.length !== dates.length ||
    sessionIds.length !== rawSessions.length
  ) {
    throw new Error(
      `${location} session IDs, dates, and session bodies must have equal lengths`
    );
  }
  if (sessionIds.length === 0) {
    throw new Error(`${location} must contain at least one session`);
  }
  const sessions = sessionIds.map((sessionId, sessionIndex) => {
    const rawMessages = rawSessions[sessionIndex];
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      throw new Error(
        `${location}.haystack_sessions[${sessionIndex}] must be a non-empty array`
      );
    }
    return {
      id: sessionId,
      date: dates[sessionIndex]!,
      messages: rawMessages.map((message, messageIndex) =>
        parseMessage(
          message,
          `${location}.haystack_sessions[${sessionIndex}][${messageIndex}]`
        )
      ),
    };
  });
  const evidenceSessionIds = uniqueStringArray(
    raw.answer_session_ids,
    `${location}.answer_session_ids`
  );
  const sessionIdSet = new Set(sessionIds);
  const missingEvidence = evidenceSessionIds.filter(
    (sessionId) => !sessionIdSet.has(sessionId)
  );
  if (missingEvidence.length > 0) {
    throw new Error(
      `${location}.answer_session_ids reference missing sessions: ${missingEvidence.join(", ")}`
    );
  }
  return {
    id,
    sourceQuestionType,
    ability: abilityFor(id, sourceQuestionType),
    question: nonEmptyString(raw.question, `${location}.question`),
    expectedAnswer: expectedAnswer(raw.answer, `${location}.answer`),
    questionDate: nonEmptyString(
      raw.question_date,
      `${location}.question_date`
    ),
    expectedAbstention: id.endsWith("_abs"),
    evidenceSessionIds,
    sessions,
  };
}

function zeroAbilityCounts(): Record<AgentMemoryAbility, number> {
  return {
    "information-extraction": 0,
    "multi-session-reasoning": 0,
    "knowledge-update": 0,
    "temporal-reasoning": 0,
    abstention: 0,
  };
}

async function writeChunk(writer: Writable, chunk: string): Promise<void> {
  if (writer.errored) throw writer.errored;
  if (!writer.write(chunk)) await once(writer, "drain");
  if (writer.errored) throw writer.errored;
}

async function finishWriter(writer: Writable): Promise<void> {
  writer.end();
  await once(writer, "finish");
}

function datasetHeader(
  source: LongMemEvalSourceSpec,
  bytes: number
): Omit<AgentMemoryDataset, "scenarios"> {
  return {
    schemaVersion: 1,
    name: "memory-bench-longmemeval",
    version: `${source.subset}-${versionHashPlaceholder}`,
    license: source.license,
    track: "agent",
    language: "en",
    description:
      "Normalized LongMemEval chat-history import. " +
      "Source examples are not vendored with Memory Bench.",
    source: {
      benchmark: "longmemeval",
      revision: source.revision,
      subset: source.subset,
      uri: source.uri,
      fileName: path.basename(new URL(source.uri).pathname),
      sha256: shaPlaceholder,
      bytes,
    },
  };
}

async function patchDigest(
  file: string,
  digest: string,
  subset: LongMemEvalSubset
): Promise<void> {
  const handle = await fs.promises.open(file, "r+");
  try {
    const probe = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    const header = probe.subarray(0, bytesRead);
    const shaOffset = header.indexOf(shaPlaceholder);
    const versionPlaceholder = `${subset}-${versionHashPlaceholder}`;
    const versionOffset = header.indexOf(versionPlaceholder);
    if (shaOffset < 0 || versionOffset < 0) {
      throw new Error("internal error: import digest placeholders are missing");
    }
    await handle.write(digest, shaOffset, "utf8");
    await handle.write(
      `${subset}-${digest.slice(0, 12)}`,
      versionOffset,
      "utf8"
    );
  } finally {
    await handle.close();
  }
}

export async function importLongMemEval(
  options: LongMemEvalImportOptions
): Promise<LongMemEvalImportSummary> {
  const input = path.resolve(options.input);
  const output = path.resolve(options.output);
  if (input === output) throw new Error("input and output must be different files");
  if (
    options.source.expectedSha256 !== undefined &&
    !sha256Pattern.test(options.source.expectedSha256)
  ) {
    throw new Error("expected SHA-256 must be a lowercase digest");
  }
  const inputStat = await fs.promises.stat(input);
  if (!inputStat.isFile()) throw new Error(`input is not a file: ${input}`);
  if (
    options.source.expectedBytes !== undefined &&
    inputStat.size !== options.source.expectedBytes
  ) {
    throw new Error(
      `source size mismatch: expected ${options.source.expectedBytes}, got ${inputStat.size}`
    );
  }
  if (fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
  const outputDirectory = path.dirname(output);
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  const temporaryOutput = path.join(
    outputDirectory,
    `.${path.basename(output)}.${process.pid}.${randomUUID()}.tmp`
  );
  const writer = fs.createWriteStream(temporaryOutput, {
    encoding: "utf8",
    flags: "wx",
  });
  // Surface asynchronous filesystem failures through the importer promise.
  // Without a persistent listener, a write error between backpressure waits
  // would become an uncaught process error before writer.errored can be read.
  writer.on("error", () => undefined);
  const digest = createHash("sha256");
  const hashTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  const inputStream = fs.createReadStream(input);
  const jsonStream = chain([
    inputStream,
    hashTransform,
    parser(),
    streamArray<unknown>(),
  ]);
  const questionIds = new Set<string>();
  const abilities = zeroAbilityCounts();
  let scenarios = 0;
  let sessions = 0;
  let turns = 0;
  try {
    const header = JSON.stringify(
      datasetHeader(options.source, inputStat.size),
      null,
      2
    );
    await writeChunk(
      writer,
      `${header.slice(0, -2)},\n  "scenarios": [\n`
    );
    for await (const item of jsonStream as AsyncIterable<{
      key: number;
      value: unknown;
    }>) {
      const scenario = parseScenario(item.value, item.key);
      if (questionIds.has(scenario.id)) {
        throw new Error(`duplicate question_id: ${scenario.id}`);
      }
      questionIds.add(scenario.id);
      if (scenarios > 0) await writeChunk(writer, ",\n");
      await writeChunk(writer, `    ${JSON.stringify(scenario)}`);
      scenarios += 1;
      sessions += scenario.sessions.length;
      turns += scenario.sessions.reduce(
        (total, session) => total + session.messages.length,
        0
      );
      abilities[scenario.ability] += 1;
    }
    if (scenarios === 0) throw new Error("LongMemEval input is empty");
    await writeChunk(writer, "\n  ]\n}\n");
    await finishWriter(writer);
    const sha256 = digest.digest("hex");
    if (
      options.source.expectedSha256 !== undefined &&
      sha256 !== options.source.expectedSha256
    ) {
      throw new Error(
        `source SHA-256 mismatch: expected ${options.source.expectedSha256}, got ${sha256}`
      );
    }
    const finalInputStat = await fs.promises.stat(input);
    if (
      finalInputStat.size !== inputStat.size ||
      finalInputStat.mtimeMs !== inputStat.mtimeMs
    ) {
      throw new Error("source file changed during import");
    }
    await patchDigest(temporaryOutput, sha256, options.source.subset);
    await fs.promises.link(temporaryOutput, output);
    try {
      await fs.promises.unlink(temporaryOutput);
    } catch (error) {
      await fs.promises.rm(output, { force: true });
      throw error;
    }
    return {
      output,
      sha256,
      bytes: inputStat.size,
      scenarios,
      sessions,
      turns,
      abilities,
    };
  } catch (error) {
    const streamClosures = [
      finished(inputStream),
      finished(jsonStream),
      finished(writer),
    ];
    inputStream.destroy();
    jsonStream.destroy();
    if (!writer.writableFinished) writer.destroy();
    await Promise.allSettled(streamClosures);
    await fs.promises.rm(temporaryOutput, { force: true });
    throw error;
  }
}
