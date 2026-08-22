import fs from "node:fs";
import type {
  BenchmarkDataset,
  BenchmarkMemoryRecord,
  BenchmarkOperation,
  BenchmarkScenario,
  DatasetPublicationStatus,
  MemoryAbility,
  ScenarioAuthorType,
  ScenarioDifficulty,
  ScenarioReviewEntry,
  ScenarioReviewStatus,
  ScenarioReviewerType,
} from "./types.js";
import { analyzeCorpus } from "./corpus.js";

const abilities = new Set<MemoryAbility>([
  "single-memory-recall",
  "multi-memory-recall",
  "knowledge-update",
  "temporal-recall",
  "abstention",
  "scope-isolation",
]);
const publicationStatuses = new Set<DatasetPublicationStatus>(["harness", "draft", "reviewed"]);
const reviewStatuses = new Set<ScenarioReviewStatus>(["harness", "draft", "reviewed"]);
const authorTypes = new Set<ScenarioAuthorType>(["human", "ai", "mixed"]);
const reviewerTypes = new Set<ScenarioReviewerType>(["human", "ai"]);
const difficulties = new Set<ScenarioDifficulty>(["basic", "intermediate", "advanced"]);
const provenanceOrigins = new Set(["synthetic", "adapted", "contributed"] as const);
const unresolvedLicenses = new Set(["unknown", "tbd", "unlicensed", "none", "n/a"]);
const releaseCompatibleLicenses = new Set([
  "cc-by-4.0",
  "cc0-1.0",
  "mit",
  "apache-2.0",
]);
const sha256Pattern = /^[a-f0-9]{64}$/;

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  return [...value];
}

function uniqueStringArray(value: unknown, path: string): string[] {
  const items = stringArray(value, path);
  if (new Set(items).size !== items.length) {
    throw new Error(`${path} must not contain duplicates`);
  }
  return items;
}

function languageValue(value: unknown, path: string): string {
  const language = stringValue(value, path);
  try {
    return new Intl.Locale(language).toString();
  } catch {
    throw new Error(`${path} must be a valid BCP 47 language tag`);
  }
}

function parseRecord(value: unknown, path: string): BenchmarkMemoryRecord {
  assertObject(value, path);
  const observedAt = stringValue(value.observedAt, `${path}.observedAt`);
  if (Number.isNaN(Date.parse(observedAt))) throw new Error(`${path}.observedAt must be an ISO-8601 timestamp`);
  const metadata = value.metadata;
  if (metadata !== undefined) {
    assertObject(metadata, `${path}.metadata`);
    for (const [key, item] of Object.entries(metadata)) {
      const valid =
        item === null ||
        typeof item === "string" ||
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item));
      if (!valid) throw new Error(`${path}.metadata.${key} must be a string, finite number, boolean, or null`);
    }
  }
  return {
    id: stringValue(value.id, `${path}.id`),
    scope: stringValue(value.scope, `${path}.scope`),
    content: stringValue(value.content, `${path}.content`),
    observedAt,
    ...(metadata === undefined ? {} : { metadata: metadata as BenchmarkMemoryRecord["metadata"] }),
  };
}

function parseOperation(value: unknown, path: string): BenchmarkOperation {
  assertObject(value, path);
  const op = stringValue(value.op, `${path}.op`);
  if (op === "write") return { op, record: parseRecord(value.record, `${path}.record`) };
  if (op === "update") {
    return {
      op,
      targetId: stringValue(value.targetId, `${path}.targetId`),
      record: parseRecord(value.record, `${path}.record`),
    };
  }
  if (op === "delete") {
    return {
      op,
      targetId: stringValue(value.targetId, `${path}.targetId`),
      scope: stringValue(value.scope, `${path}.scope`),
    };
  }
  if (op === "query") {
    const ability = stringValue(value.ability, `${path}.ability`) as MemoryAbility;
    if (!abilities.has(ability)) throw new Error(`${path}.ability is unsupported: ${ability}`);
    if (!Number.isInteger(value.topK) || (value.topK as number) < 1 || (value.topK as number) > 100) {
      throw new Error(`${path}.topK must be an integer from 1 to 100`);
    }
    if (value.expectEmpty !== undefined && typeof value.expectEmpty !== "boolean") {
      throw new Error(`${path}.expectEmpty must be a boolean`);
    }
    return {
      op,
      id: stringValue(value.id, `${path}.id`),
      scope: stringValue(value.scope, `${path}.scope`),
      query: stringValue(value.query, `${path}.query`),
      ability,
      topK: value.topK as number,
      relevantIds: uniqueStringArray(value.relevantIds, `${path}.relevantIds`),
      ...(value.forbiddenIds === undefined
        ? {}
        : {
            forbiddenIds: uniqueStringArray(
              value.forbiddenIds,
              `${path}.forbiddenIds`
            ),
          }),
      ...(value.mustContain === undefined
        ? {}
        : {
            mustContain: uniqueStringArray(
              value.mustContain,
              `${path}.mustContain`
            ),
          }),
      ...(value.mustNotContain === undefined
        ? {}
        : {
            mustNotContain: uniqueStringArray(
              value.mustNotContain,
              `${path}.mustNotContain`
            ),
          }),
      ...(value.expectEmpty === undefined ? {} : { expectEmpty: value.expectEmpty }),
    };
  }
  throw new Error(`${path}.op is unsupported: ${op}`);
}

function parseReviewEntry(value: unknown, path: string): ScenarioReviewEntry {
  assertObject(value, path);
  assertObject(value.reviewer, `${path}.reviewer`);
  const reviewerType = stringValue(
    value.reviewer.type,
    `${path}.reviewer.type`
  ) as ScenarioReviewerType;
  if (!reviewerTypes.has(reviewerType)) {
    throw new Error(`${path}.reviewer.type is unsupported: ${reviewerType}`);
  }
  const reviewedAt = stringValue(value.reviewedAt, `${path}.reviewedAt`);
  if (Number.isNaN(Date.parse(reviewedAt))) {
    throw new Error(`${path}.reviewedAt must be an ISO-8601 timestamp`);
  }
  assertObject(value.evidence, `${path}.evidence`);
  if (value.evidence.kind !== "review-overlay") {
    throw new Error(`${path}.evidence.kind must be review-overlay`);
  }
  const sha256 = stringValue(value.evidence.sha256, `${path}.evidence.sha256`);
  if (!sha256Pattern.test(sha256)) {
    throw new Error(`${path}.evidence.sha256 must be a lowercase SHA-256 digest`);
  }
  return {
    reviewer: {
      id: stringValue(value.reviewer.id, `${path}.reviewer.id`),
      type: reviewerType,
    },
    reviewedAt,
    evidence: {
      kind: "review-overlay",
      sha256,
    },
  };
}

function parseScenario(value: unknown, path: string): BenchmarkScenario {
  assertObject(value, path);
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    throw new Error(`${path}.operations must be a non-empty array`);
  }
  assertObject(value.provenance, `${path}.provenance`);
  const origin = stringValue(
    value.provenance.origin,
    `${path}.provenance.origin`
  ) as BenchmarkScenario["provenance"]["origin"];
  if (!provenanceOrigins.has(origin)) {
    throw new Error(`${path}.provenance.origin is unsupported: ${origin}`);
  }
  const author = stringValue(value.provenance.author, `${path}.provenance.author`);
  const authorType = stringValue(
    value.provenance.authorType,
    `${path}.provenance.authorType`
  ) as ScenarioAuthorType;
  if (!authorTypes.has(authorType)) {
    throw new Error(`${path}.provenance.authorType is unsupported: ${authorType}`);
  }
  const sourceUri =
    value.provenance.sourceUri === undefined
      ? undefined
      : stringValue(value.provenance.sourceUri, `${path}.provenance.sourceUri`);
  if (origin === "adapted" && sourceUri === undefined) {
    throw new Error(`${path}.provenance.sourceUri is required for adapted scenarios`);
  }
  const templateId =
    value.provenance.templateId === undefined
      ? undefined
      : stringValue(value.provenance.templateId, `${path}.provenance.templateId`);
  const revisionEvidenceSha256 =
    value.provenance.revisionEvidenceSha256 === undefined
      ? undefined
      : stringValue(
          value.provenance.revisionEvidenceSha256,
          `${path}.provenance.revisionEvidenceSha256`
        );
  if (
    revisionEvidenceSha256 !== undefined &&
    !sha256Pattern.test(revisionEvidenceSha256)
  ) {
    throw new Error(
      `${path}.provenance.revisionEvidenceSha256 must be a lowercase SHA-256 digest`
    );
  }
  assertObject(value.review, `${path}.review`);
  const reviewStatus = stringValue(
    value.review.status,
    `${path}.review.status`
  ) as ScenarioReviewStatus;
  if (!reviewStatuses.has(reviewStatus)) {
    throw new Error(`${path}.review.status is unsupported: ${reviewStatus}`);
  }
  if (!Array.isArray(value.review.entries)) {
    throw new Error(`${path}.review.entries must be an array`);
  }
  const reviewEntries = value.review.entries.map((entry, index) =>
    parseReviewEntry(entry, `${path}.review.entries[${index}]`)
  );
  const normalizedReviewerIds = reviewEntries.map((entry) =>
    entry.reviewer.id.normalize("NFKC").trim().toLocaleLowerCase("en-US")
  );
  if (new Set(normalizedReviewerIds).size !== reviewEntries.length) {
    throw new Error(`${path}.review.entries must not contain duplicate reviewer IDs`);
  }
  if (reviewStatus === "reviewed") {
    if (!reviewEntries.some((entry) => entry.reviewer.type === "human")) {
      throw new Error(`${path}.review.entries must name an independent human reviewer`);
    }
    const normalizedAuthor = author.normalize("NFKC").trim().toLocaleLowerCase("en-US");
    if (normalizedReviewerIds.includes(normalizedAuthor)) {
      throw new Error(`${path}.review.entries must be independent from the provenance author`);
    }
  } else if (reviewEntries.length > 0) {
    throw new Error(`${path}.review.entries must be empty unless status is reviewed`);
  }
  return {
    id: stringValue(value.id, `${path}.id`),
    description: stringValue(value.description, `${path}.description`),
    language: languageValue(value.language, `${path}.language`),
    difficulty: (() => {
      const difficulty = stringValue(value.difficulty, `${path}.difficulty`) as ScenarioDifficulty;
      if (!difficulties.has(difficulty)) {
        throw new Error(`${path}.difficulty is unsupported: ${difficulty}`);
      }
      return difficulty;
    })(),
    provenance: {
      origin,
      author,
      authorType,
      ...(sourceUri === undefined ? {} : { sourceUri }),
      ...(templateId === undefined ? {} : { templateId }),
      ...(revisionEvidenceSha256 === undefined
        ? {}
        : { revisionEvidenceSha256 }),
    },
    review: {
      status: reviewStatus,
      entries: reviewEntries,
    },
    operations: value.operations.map((operation, index) => parseOperation(operation, `${path}.operations[${index}]`)),
  };
}

function validateLifecycle(dataset: BenchmarkDataset): void {
  const scenarioIds = new Set<string>();
  const queryIds = new Set<string>();
  const globalRecordIds = new Set<string>();
  for (const scenario of dataset.scenarios) {
    if (scenarioIds.has(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`);
    scenarioIds.add(scenario.id);
    const liveIds = new Set<string>();
    const knownIds = new Set<string>();
    const scopeByLiveId = new Map<string, string>();
    for (const operation of scenario.operations) {
      if (operation.op === "write") {
        if (knownIds.has(operation.record.id) || globalRecordIds.has(operation.record.id)) {
          throw new Error(`${scenario.id}: duplicate record id ${operation.record.id}`);
        }
        knownIds.add(operation.record.id);
        globalRecordIds.add(operation.record.id);
        liveIds.add(operation.record.id);
        scopeByLiveId.set(operation.record.id, operation.record.scope);
      } else if (operation.op === "update") {
        const targetScope = scopeByLiveId.get(operation.targetId);
        if (!liveIds.delete(operation.targetId)) {
          throw new Error(`${scenario.id}: update target is not live: ${operation.targetId}`);
        }
        if (targetScope !== operation.record.scope) {
          throw new Error(
            `${scenario.id}: update cannot move ${operation.targetId} from ${targetScope} to ${operation.record.scope}`
          );
        }
        scopeByLiveId.delete(operation.targetId);
        if (knownIds.has(operation.record.id) || globalRecordIds.has(operation.record.id)) {
          throw new Error(`${scenario.id}: update creates duplicate record id ${operation.record.id}`);
        }
        knownIds.add(operation.record.id);
        globalRecordIds.add(operation.record.id);
        liveIds.add(operation.record.id);
        scopeByLiveId.set(operation.record.id, operation.record.scope);
      } else if (operation.op === "delete") {
        const targetScope = scopeByLiveId.get(operation.targetId);
        if (!liveIds.delete(operation.targetId)) {
          throw new Error(`${scenario.id}: delete target is not live: ${operation.targetId}`);
        }
        if (targetScope !== operation.scope) {
          throw new Error(
            `${scenario.id}: delete scope ${operation.scope} does not match ${operation.targetId} scope ${targetScope}`
          );
        }
        scopeByLiveId.delete(operation.targetId);
      } else {
        if (queryIds.has(operation.id)) throw new Error(`duplicate query id: ${operation.id}`);
        queryIds.add(operation.id);
        const overlap = operation.relevantIds.filter((id) => operation.forbiddenIds?.includes(id));
        if (overlap.length > 0) throw new Error(`${operation.id}: relevant and forbidden IDs overlap: ${overlap.join(", ")}`);
        if (operation.expectEmpty && operation.relevantIds.length > 0) {
          throw new Error(`${operation.id}: expectEmpty cannot be combined with relevant IDs`);
        }
        if (operation.relevantIds.length === 0 && operation.expectEmpty !== true) {
          throw new Error(`${operation.id}: a query without relevant IDs must set expectEmpty=true`);
        }
        if (operation.ability === "abstention" && operation.expectEmpty !== true) {
          throw new Error(`${operation.id}: abstention queries must set expectEmpty=true`);
        }
        if (operation.expectEmpty === true && operation.ability !== "abstention") {
          throw new Error(`${operation.id}: expectEmpty=true requires the abstention ability`);
        }
        for (const id of operation.relevantIds) {
          if (!liveIds.has(id)) throw new Error(`${operation.id}: relevant record is not live: ${id}`);
          if (scopeByLiveId.get(id) !== operation.scope) {
            throw new Error(`${operation.id}: relevant record ${id} is outside query scope ${operation.scope}`);
          }
        }
        for (const id of operation.forbiddenIds ?? []) {
          if (!knownIds.has(id)) throw new Error(`${operation.id}: forbidden record is not defined yet: ${id}`);
        }
      }
    }
  }
}

export function parseDataset(raw: unknown): BenchmarkDataset {
  assertObject(raw, "dataset");
  if (raw.schemaVersion !== 1) throw new Error("dataset.schemaVersion must be 1");
  if (raw.track !== "core") throw new Error("dataset.track must be core");
  const publicationStatus = stringValue(
    raw.publicationStatus,
    "dataset.publicationStatus"
  ) as DatasetPublicationStatus;
  if (!publicationStatuses.has(publicationStatus)) {
    throw new Error(`dataset.publicationStatus is unsupported: ${publicationStatus}`);
  }
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    throw new Error("dataset.scenarios must be a non-empty array");
  }
  const dataset: BenchmarkDataset = {
    schemaVersion: 1,
    name: stringValue(raw.name, "dataset.name"),
    version: stringValue(raw.version, "dataset.version"),
    license: stringValue(raw.license, "dataset.license"),
    track: "core",
    publicationStatus,
    description: stringValue(raw.description, "dataset.description"),
    scenarios: raw.scenarios.map((scenario, index) => parseScenario(scenario, `dataset.scenarios[${index}]`)),
  };
  validateLifecycle(dataset);
  return dataset;
}

export function loadDataset(file: string): BenchmarkDataset {
  return parseDataset(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
}

export interface PublicationReadiness {
  ready: boolean;
  queryCount: number;
  minimumQueries: number;
  minimumQueriesPerAbility: number;
  abilityCounts: Record<MemoryAbility, number>;
  issues: string[];
}

export function assessPublicationReadiness(
  dataset: BenchmarkDataset,
  minimumQueries = 100,
  minimumQueriesPerAbility = 10
): PublicationReadiness {
  if (!Number.isInteger(minimumQueries) || minimumQueries < 1) {
    throw new Error("minimumQueries must be a positive integer");
  }
  if (!Number.isInteger(minimumQueriesPerAbility) || minimumQueriesPerAbility < 1) {
    throw new Error("minimumQueriesPerAbility must be a positive integer");
  }
  const abilityCounts = Object.fromEntries([...abilities].map((ability) => [ability, 0])) as Record<
    MemoryAbility,
    number
  >;
  let queryCount = 0;
  for (const scenario of dataset.scenarios) {
    for (const operation of scenario.operations) {
      if (operation.op !== "query") continue;
      queryCount++;
      abilityCounts[operation.ability]++;
    }
  }
  const issues: string[] = [];
  if (dataset.publicationStatus !== "reviewed") {
    issues.push(`dataset publicationStatus is ${dataset.publicationStatus}, expected reviewed`);
  }
  const normalizedLicense = dataset.license
    .trim()
    .toLocaleLowerCase("en-US");
  if (unresolvedLicenses.has(normalizedLicense)) {
    issues.push(`dataset license is unresolved: ${dataset.license}`);
  } else if (!releaseCompatibleLicenses.has(normalizedLicense)) {
    issues.push(
      `dataset license is not approved for public release: ${dataset.license}`
    );
  }
  if (queryCount < minimumQueries) {
    issues.push(`dataset has ${queryCount} queries, expected at least ${minimumQueries}`);
  }
  for (const [ability, count] of Object.entries(abilityCounts)) {
    if (count < minimumQueriesPerAbility) {
      issues.push(
        `dataset has ${count} ${ability} queries, expected at least ${minimumQueriesPerAbility}`
      );
    }
  }
  const nonReviewedCounts = new Map<ScenarioReviewStatus, number>();
  for (const scenario of dataset.scenarios.filter((item) => item.review.status !== "reviewed")) {
    nonReviewedCounts.set(
      scenario.review.status,
      (nonReviewedCounts.get(scenario.review.status) ?? 0) + 1
    );
  }
  for (const [status, count] of nonReviewedCounts) {
    issues.push(`${count} scenarios review status is ${status}, expected reviewed`);
  }
  const analysis = analyzeCorpus(dataset);
  for (const issue of analysis.blockingIssues) {
    if (!issues.includes(issue)) {
      issues.push(issue);
    }
  }
  return {
    ready: issues.length === 0,
    queryCount,
    minimumQueries,
    minimumQueriesPerAbility,
    abilityCounts,
    issues,
  };
}
