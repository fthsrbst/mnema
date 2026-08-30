import type {
  BenchmarkDataset,
  MemoryAbility,
  ScenarioDifficulty,
  ScenarioReviewStatus,
} from "./types.js";

export interface CorpusDuplicateGroup {
  normalizedValue: string;
  ids: string[];
}

export interface CorpusAnalysis {
  scenarioCount: number;
  queryCount: number;
  operationCount: number;
  recordCount: number;
  counts: {
    abilities: Record<MemoryAbility, number>;
    languages: Record<string, number>;
    difficulties: Record<ScenarioDifficulty, number>;
    origins: Record<string, number>;
    authorTypes: Record<string, number>;
    reviewStatuses: Record<ScenarioReviewStatus, number>;
    templates: Record<string, number>;
  };
  duplicateQueries: CorpusDuplicateGroup[];
  duplicateQueriesWithinScope: CorpusDuplicateGroup[];
  duplicateRecordContents: CorpusDuplicateGroup[];
  duplicateRecordContentsWithinScope: CorpusDuplicateGroup[];
  maximumTemplateShare: number;
  blockingIssues: string[];
  warnings: string[];
}

const abilityOrder: MemoryAbility[] = [
  "single-memory-recall",
  "multi-memory-recall",
  "knowledge-update",
  "temporal-recall",
  "abstention",
  "scope-isolation",
];
const difficultyOrder: ScenarioDifficulty[] = ["basic", "intermediate", "advanced"];
const reviewStatusOrder: ScenarioReviewStatus[] = ["harness", "draft", "reviewed"];

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim();
}

function increment(counts: Map<string, number>, key: string, amount = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + amount);
}

function orderedRecord(
  counts: Map<string, number>,
  preferredOrder: readonly string[] = []
): Record<string, number> {
  const preferred = preferredOrder
    .filter((key) => counts.has(key))
    .map((key) => [key, counts.get(key)!] as const);
  const preferredSet = new Set(preferredOrder);
  const remaining = [...counts]
    .filter(([key]) => !preferredSet.has(key))
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries([...preferred, ...remaining]);
}

function duplicateGroups(values: Map<string, string[]>): CorpusDuplicateGroup[] {
  return [...values]
    .filter(([, ids]) => ids.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([normalizedValue, ids]) => ({
      normalizedValue,
      ids: [...ids].sort(),
    }));
}

function groupsWithRepeatedScope(
  groups: CorpusDuplicateGroup[],
  scopeById: Map<string, string>
): CorpusDuplicateGroup[] {
  return groups.filter((group) => {
    const seen = new Set<string>();
    for (const id of group.ids) {
      const scope = scopeById.get(id);
      if (scope === undefined) continue;
      if (seen.has(scope)) return true;
      seen.add(scope);
    }
    return false;
  });
}

export function analyzeCorpus(dataset: BenchmarkDataset): CorpusAnalysis {
  const abilityCounts = new Map<string, number>(abilityOrder.map((ability) => [ability, 0]));
  const languageCounts = new Map<string, number>();
  const difficultyCounts = new Map<string, number>(
    difficultyOrder.map((difficulty) => [difficulty, 0])
  );
  const originCounts = new Map<string, number>();
  const authorTypeCounts = new Map<string, number>();
  const reviewStatusCounts = new Map<string, number>(
    reviewStatusOrder.map((status) => [status, 0])
  );
  const templateCounts = new Map<string, number>();
  const queriesByNormalizedValue = new Map<string, string[]>();
  const recordsByNormalizedContent = new Map<string, string[]>();
  const queryScopeById = new Map<string, string>();
  const recordScopeById = new Map<string, string>();
  const scenariosWithoutQueries: string[] = [];
  const aiScenariosWithoutTemplates: string[] = [];
  let queryCount = 0;
  let operationCount = 0;
  let recordCount = 0;

  for (const scenario of dataset.scenarios) {
    increment(originCounts, scenario.provenance.origin);
    increment(authorTypeCounts, scenario.provenance.authorType);
    increment(reviewStatusCounts, scenario.review.status);
    if (scenario.provenance.authorType === "ai" && !scenario.provenance.templateId) {
      aiScenariosWithoutTemplates.push(scenario.id);
    }
    let scenarioQueryCount = 0;
    for (const operation of scenario.operations) {
      operationCount++;
      if (operation.op === "query") {
        queryCount++;
        scenarioQueryCount++;
        increment(abilityCounts, operation.ability);
        increment(languageCounts, scenario.language);
        increment(difficultyCounts, scenario.difficulty);
        increment(templateCounts, scenario.provenance.templateId ?? "(none)");
        const normalizedQuery = normalize(operation.query);
        const ids = queriesByNormalizedValue.get(normalizedQuery) ?? [];
        ids.push(operation.id);
        queriesByNormalizedValue.set(normalizedQuery, ids);
        queryScopeById.set(operation.id, operation.scope);
        continue;
      }
      if (operation.op === "delete") continue;
      recordCount++;
      const normalizedContent = normalize(operation.record.content);
      const ids = recordsByNormalizedContent.get(normalizedContent) ?? [];
      ids.push(operation.record.id);
      recordsByNormalizedContent.set(normalizedContent, ids);
      recordScopeById.set(operation.record.id, operation.record.scope);
    }
    if (scenarioQueryCount === 0) scenariosWithoutQueries.push(scenario.id);
  }

  const duplicateQueries = duplicateGroups(queriesByNormalizedValue);
  const duplicateRecordContents = duplicateGroups(recordsByNormalizedContent);
  const duplicateQueriesWithinScope = groupsWithRepeatedScope(
    duplicateQueries,
    queryScopeById
  );
  const duplicateRecordContentsWithinScope = groupsWithRepeatedScope(
    duplicateRecordContents,
    recordScopeById
  );
  const maximumTemplateCount = Math.max(0, ...templateCounts.values());
  const maximumTemplateShare = queryCount === 0 ? 0 : maximumTemplateCount / queryCount;
  const blockingIssues: string[] = [];
  const warnings: string[] = [];

  if (scenariosWithoutQueries.length > 0) {
    blockingIssues.push(
      `${scenariosWithoutQueries.length} scenarios have no query: ${scenariosWithoutQueries
        .slice(0, 5)
        .join(", ")}`
    );
  }
  if (duplicateQueriesWithinScope.length > 0) {
    blockingIssues.push(
      `${duplicateQueriesWithinScope.length} normalized query texts are duplicated within a scope`
    );
  }
  if (duplicateRecordContentsWithinScope.length > 0) {
    blockingIssues.push(
      `${duplicateRecordContentsWithinScope.length} normalized memory record contents are duplicated within a scope`
    );
  }
  if (duplicateQueries.length > duplicateQueriesWithinScope.length) {
    warnings.push(
      `${duplicateQueries.length - duplicateQueriesWithinScope.length} normalized query texts repeat only across scopes`
    );
  }
  if (duplicateRecordContents.length > duplicateRecordContentsWithinScope.length) {
    warnings.push(
      `${duplicateRecordContents.length - duplicateRecordContentsWithinScope.length} normalized memory contents repeat only across scopes`
    );
  }
  if (aiScenariosWithoutTemplates.length > 0) {
    warnings.push(
      `${aiScenariosWithoutTemplates.length} AI-authored scenarios do not declare templateId`
    );
  }
  if (maximumTemplateShare > 0.1) {
    warnings.push(
      `one template accounts for ${(maximumTemplateShare * 100).toFixed(1)}% of queries`
    );
  }

  return {
    scenarioCount: dataset.scenarios.length,
    queryCount,
    operationCount,
    recordCount,
    counts: {
      abilities: orderedRecord(abilityCounts, abilityOrder) as Record<MemoryAbility, number>,
      languages: orderedRecord(languageCounts),
      difficulties: orderedRecord(
        difficultyCounts,
        difficultyOrder
      ) as Record<ScenarioDifficulty, number>,
      origins: orderedRecord(originCounts),
      authorTypes: orderedRecord(authorTypeCounts),
      reviewStatuses: orderedRecord(
        reviewStatusCounts,
        reviewStatusOrder
      ) as Record<ScenarioReviewStatus, number>,
      templates: orderedRecord(templateCounts),
    },
    duplicateQueries,
    duplicateQueriesWithinScope,
    duplicateRecordContents,
    duplicateRecordContentsWithinScope,
    maximumTemplateShare: Number(maximumTemplateShare.toFixed(6)),
    blockingIssues,
    warnings,
  };
}
