import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Ajv2020,
  type AnySchemaObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import {
  agentMemoryAbilities,
  longMemEvalQuestionTypes,
  type AgentBenchmarkReport,
  type AgentMemoryAbility,
  type AgentScenarioTrace,
  type EvaluatorParityArtifact,
  type EvaluatorParitySliceMetrics,
  type LongMemEvalQuestionType,
} from "./agent-types.js";
import {
  longMemEvalJudgePromptRevision,
  officialLongMemEvalEvaluatorRevision,
  officialLongMemEvalEvaluatorScriptSha256,
  officialLongMemEvalEvaluatorScriptUri,
} from "./agent-openai.js";

export interface OfficialEvaluatorResult {
  question_id: string;
  hypothesis: string;
  autoeval_label: {
    model: string;
    label: boolean;
  };
}

export interface EvaluatorParityOptions {
  report: string;
  officialResults: string;
  output: string;
}

interface CandidateDecision {
  scenarioId: string;
  sourceQuestionType: LongMemEvalQuestionType;
  ability: AgentMemoryAbility;
  hypothesis: string;
  passed: boolean;
}

const agentReportSchemaFile = fileURLToPath(
  new URL("../schemas/v1/agent-report.schema.json", import.meta.url)
);
const evaluatorParitySchemaFile = fileURLToPath(
  new URL("../schemas/v1/evaluator-parity.schema.json", import.meta.url)
);
const maximumInputBytes = 100 * 1024 * 1024;
const maximumOfficialRows = 100_000;
const officialApiSurface = "chat-completions" as const;
const officialDecisionRule = "case-insensitive-yes-substring" as const;
const candidateDecisionRule =
  "official-case-insensitive-yes-substring";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readBoundedFile(file: string, label: string): Buffer {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (stat.size < 1) throw new Error(`${label} must not be empty`);
  if (stat.size > maximumInputBytes) {
    throw new Error(
      `${label} exceeds the ${maximumInputBytes} byte input limit`
    );
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > maximumInputBytes) {
    throw new Error(
      `${label} exceeds the ${maximumInputBytes} byte input limit`
    );
  }
  return bytes;
}

function compileValidator(schemaFile: string): {
  ajv: Ajv2020;
  validate: ValidateFunction;
} {
  const require = createRequire(import.meta.url);
  const addFormats = require("ajv-formats") as FormatsPlugin;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(
    fs.readFileSync(schemaFile, "utf8")
  ) as AnySchemaObject;
  return {
    ajv,
    validate: ajv.compile(schema),
  };
}

function validateArtifact(
  validator: ReturnType<typeof compileValidator>,
  value: unknown,
  label: string
): void {
  if (validator.validate(value)) return;
  throw new Error(
    `${label} failed schema validation: ${validator.ajv.errorsText(
      validator.validate.errors,
      { separator: "; " }
    )}`
  );
}

function objectValue(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `${label} must contain exactly ${expected.join(", ")}`
    );
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function parseOfficialEvaluatorResults(
  bytes: Buffer
): OfficialEvaluatorResult[] {
  const lines = bytes.toString("utf8").split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 1) {
    throw new Error("official evaluator results must contain at least one row");
  }
  if (lines.length > maximumOfficialRows) {
    throw new Error(
      `official evaluator results exceed the ${maximumOfficialRows} row limit`
    );
  }
  const seen = new Set<string>();
  return lines.map((line, index) => {
    const rowNumber = index + 1;
    if (line.trim() === "") {
      throw new Error(
        `official evaluator results row ${rowNumber} must not be blank`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(
        `official evaluator results row ${rowNumber} is not valid JSON`
      );
    }
    const row = objectValue(
      parsed,
      `official evaluator results row ${rowNumber}`
    );
    requireExactKeys(
      row,
      ["question_id", "hypothesis", "autoeval_label"],
      `official evaluator results row ${rowNumber}`
    );
    const questionId = nonEmptyString(
      row.question_id,
      `official evaluator results row ${rowNumber}.question_id`
    );
    if (seen.has(questionId)) {
      throw new Error(
        `official evaluator results contain duplicate question_id: ${questionId}`
      );
    }
    seen.add(questionId);
    const label = objectValue(
      row.autoeval_label,
      `official evaluator results row ${rowNumber}.autoeval_label`
    );
    requireExactKeys(
      label,
      ["model", "label"],
      `official evaluator results row ${rowNumber}.autoeval_label`
    );
    if (typeof label.label !== "boolean") {
      throw new Error(
        `official evaluator results row ${rowNumber}.autoeval_label.label must be a boolean`
      );
    }
    return {
      question_id: questionId,
      hypothesis: nonEmptyString(
        row.hypothesis,
        `official evaluator results row ${rowNumber}.hypothesis`
      ),
      autoeval_label: {
        model: nonEmptyString(
          label.model,
          `official evaluator results row ${rowNumber}.autoeval_label.model`
        ),
        label: label.label,
      },
    };
  });
}

function readCandidateReport(bytes: Buffer): AgentBenchmarkReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("candidate agent report is not valid JSON");
  }
  validateArtifact(
    compileValidator(agentReportSchemaFile),
    parsed,
    "candidate agent report"
  );
  const report = parsed as AgentBenchmarkReport;
  const seen = new Set<string>();
  for (const scenario of report.scenarios) {
    if (seen.has(scenario.scenarioId)) {
      throw new Error(
        `candidate agent report contains duplicate scenarioId: ${scenario.scenarioId}`
      );
    }
    seen.add(scenario.scenarioId);
  }
  return report;
}

function candidateDecisions(
  report: AgentBenchmarkReport
): CandidateDecision[] {
  return report.scenarios
    .filter(
      (
        scenario
      ): scenario is AgentScenarioTrace & {
        status: "completed";
        hypothesis: string;
        qaPassed: boolean;
      } =>
        scenario.status === "completed" &&
        scenario.hypothesis !== null &&
        scenario.qaPassed !== null
    )
    .map((scenario) => ({
      scenarioId: scenario.scenarioId,
      sourceQuestionType: scenario.sourceQuestionType,
      ability: scenario.ability,
      hypothesis: scenario.hypothesis,
      passed: scenario.qaPassed,
    }));
}

function reportComplete(report: AgentBenchmarkReport): boolean {
  return (
    report.run.status === "completed" &&
    report.failures.length === 0 &&
    report.metrics.runtimeFailures === 0 &&
    report.metrics.scenarios === report.scenarios.length &&
    report.metrics.completed === report.scenarios.length &&
    report.metrics.failed === 0 &&
    report.scenarios.length > 0 &&
    report.scenarios.every((scenario) => scenario.status === "completed")
  );
}

function configString(
  config: Record<string, string | number | boolean | null>,
  key: string
): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function emptySliceMap<T extends string>(
  names: readonly T[]
): Record<T, EvaluatorParitySliceMetrics> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        compared: 0,
        matches: 0,
        mismatches: 0,
        agreementRate: null,
      },
    ])
  ) as Record<T, EvaluatorParitySliceMetrics>;
}

function finalizeSlices<T extends string>(
  slices: Record<T, EvaluatorParitySliceMetrics>
): void {
  for (const slice of Object.values(slices) as EvaluatorParitySliceMetrics[]) {
    slice.agreementRate =
      slice.compared === 0 ? null : slice.matches / slice.compared;
  }
}

async function writeExclusiveAtomic(
  file: string,
  content: string
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await fs.promises.writeFile(temporary, content, {
      encoding: "utf8",
      flag: "wx",
    });
    await fs.promises.link(temporary, file);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new Error(`output already exists: ${file}`);
    }
    throw error;
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

export async function createEvaluatorParity(
  options: EvaluatorParityOptions
): Promise<EvaluatorParityArtifact> {
  if (options.report.trim() === "") {
    throw new Error("candidate agent report path must not be empty");
  }
  if (options.officialResults.trim() === "") {
    throw new Error("official evaluator results path must not be empty");
  }
  if (options.output.trim() === "") {
    throw new Error("evaluator parity output path must not be empty");
  }
  const reportBytes = readBoundedFile(
    options.report,
    "candidate agent report"
  );
  const officialBytes = readBoundedFile(
    options.officialResults,
    "official evaluator results"
  );
  const report = readCandidateReport(reportBytes);
  const officialRows = parseOfficialEvaluatorResults(officialBytes);
  const decisions = candidateDecisions(report);
  const candidateById = new Map(
    decisions.map((decision) => [decision.scenarioId, decision])
  );
  const officialById = new Map(
    officialRows.map((result) => [result.question_id, result])
  );
  const candidateOnlyIds = [...candidateById.keys()]
    .filter((id) => !officialById.has(id))
    .sort();
  const officialOnlyIds = [...officialById.keys()]
    .filter((id) => !candidateById.has(id))
    .sort();
  const hypothesisMismatchIds: string[] = [];
  const mismatches: EvaluatorParityArtifact["mismatches"] = [];
  const confusion = {
    bothPass: 0,
    candidateOnlyPass: 0,
    officialOnlyPass: 0,
    bothFail: 0,
  };
  const byAbility = emptySliceMap(agentMemoryAbilities);
  const byQuestionType = emptySliceMap(longMemEvalQuestionTypes);
  let compared = 0;
  let labelMatches = 0;
  for (const decision of decisions) {
    const official = officialById.get(decision.scenarioId);
    if (official === undefined) continue;
    if (official.hypothesis !== decision.hypothesis) {
      hypothesisMismatchIds.push(decision.scenarioId);
      continue;
    }
    compared += 1;
    const matches = decision.passed === official.autoeval_label.label;
    if (matches) labelMatches += 1;
    const abilitySlice = byAbility[decision.ability];
    const questionTypeSlice =
      byQuestionType[decision.sourceQuestionType];
    for (const slice of [abilitySlice, questionTypeSlice]) {
      slice.compared += 1;
      if (matches) slice.matches += 1;
      else slice.mismatches += 1;
    }
    if (decision.passed && official.autoeval_label.label) {
      confusion.bothPass += 1;
    } else if (decision.passed) {
      confusion.candidateOnlyPass += 1;
    } else if (official.autoeval_label.label) {
      confusion.officialOnlyPass += 1;
    } else {
      confusion.bothFail += 1;
    }
    if (!matches) {
      mismatches.push({
        scenarioId: decision.scenarioId,
        sourceQuestionType: decision.sourceQuestionType,
        ability: decision.ability,
        hypothesisSha256: sha256(decision.hypothesis),
        candidatePassed: decision.passed,
        officialPassed: official.autoeval_label.label,
        officialModel: official.autoeval_label.model,
      });
    }
  }
  hypothesisMismatchIds.sort();
  mismatches.sort((left, right) =>
    left.scenarioId.localeCompare(right.scenarioId)
  );
  finalizeSlices(byAbility);
  finalizeSlices(byQuestionType);

  const resultModels = [
    ...new Set(
      officialRows.map((result) => result.autoeval_label.model)
    ),
  ].sort();
  const judgeConfig = report.run.components.judge.config;
  const candidateModel = configString(judgeConfig, "model");
  const candidatePromptRevision = configString(
    judgeConfig,
    "promptRevision"
  );
  const candidateApiSurface = configString(judgeConfig, "apiSurface");
  const candidateRule = configString(judgeConfig, "decisionRule");
  const isReportComplete = reportComplete(report);
  const nonEmptyDecisionSet = decisions.length > 0;
  const completeCoverage =
    nonEmptyDecisionSet &&
    candidateOnlyIds.length === 0 &&
    officialOnlyIds.length === 0;
  const hypothesesExact =
    completeCoverage && hypothesisMismatchIds.length === 0;
  const modelExact =
    candidateModel !== null &&
    resultModels.length === 1 &&
    resultModels[0] === candidateModel;
  const promptRevisionPinned =
    report.run.components.judge.name === "longmemeval-openai-judge" &&
    report.run.components.judge.version === "1" &&
    report.run.components.judge.mode ===
      "category-specific-yes-no-port" &&
    candidatePromptRevision === longMemEvalJudgePromptRevision &&
    candidateApiSurface === "responses" &&
    candidateRule === candidateDecisionRule;
  const comparable =
    isReportComplete &&
    nonEmptyDecisionSet &&
    completeCoverage &&
    hypothesesExact &&
    modelExact &&
    promptRevisionPinned;
  const labelMismatches = compared - labelMatches;
  const exactAgreement =
    comparable &&
    compared === decisions.length &&
    labelMismatches === 0;
  const blockers: string[] = [];
  if (!isReportComplete) {
    blockers.push(
      "candidate report is not a complete zero-runtime-failure run"
    );
  }
  if (!nonEmptyDecisionSet) {
    blockers.push("candidate report contains no evaluator decisions");
  }
  if (!completeCoverage) {
    blockers.push(
      "candidate and official evaluator decision ID sets do not match"
    );
  }
  if (!hypothesesExact) {
    blockers.push(
      "official evaluator hypotheses do not exactly match candidate hypotheses"
    );
  }
  if (!modelExact) {
    blockers.push(
      "official evaluator model does not exactly match the candidate judge model"
    );
  }
  if (!promptRevisionPinned) {
    blockers.push(
      "candidate judge is not the hash-pinned LongMemEval evaluator port"
    );
  }
  if (comparable && !exactAgreement) {
    blockers.push(
      "candidate and official evaluator labels are not in exact agreement"
    );
  }
  if (report.run.resultClass === "harness") {
    blockers.push(
      "harness evidence is contract-only and cannot support publication claims"
    );
  } else if (report.run.resultClass === "candidate") {
    blockers.push(
      "candidate evidence still requires live provider qualification"
    );
  }
  pushUnique(
    blockers,
    "independent live-run provenance and reviewer attestation are not represented by this artifact"
  );

  const artifact: EvaluatorParityArtifact = {
    schemaVersion: 1,
    kind: "memory-bench-evaluator-parity",
    parityId: randomUUID(),
    createdAt: new Date().toISOString(),
    candidate: {
      reportFile: path.basename(options.report),
      reportSha256: sha256(reportBytes),
      runId: report.run.runId,
      reportStatus: report.run.status,
      resultClass: report.run.resultClass,
      dataset: {
        name: report.run.dataset.name,
        version: report.run.dataset.version,
        subset: report.run.dataset.subset,
        sourceRevision: report.run.dataset.sourceRevision,
        sourceSha256: report.run.dataset.sourceSha256,
        artifactSha256: report.run.dataset.artifactSha256,
      },
      judge: {
        name: report.run.components.judge.name,
        model: candidateModel,
        promptRevision: candidatePromptRevision,
        apiSurface: candidateApiSurface,
        decisionRule: candidateRule,
      },
    },
    official: {
      resultsFile: path.basename(options.officialResults),
      resultsSha256: sha256(officialBytes),
      resultModels,
      evaluatorRevision: officialLongMemEvalEvaluatorRevision,
      scriptUri: officialLongMemEvalEvaluatorScriptUri,
      scriptSha256: officialLongMemEvalEvaluatorScriptSha256,
      apiSurface: officialApiSurface,
      decisionRule: officialDecisionRule,
    },
    coverage: {
      reportDecisions: decisions.length,
      officialDecisions: officialRows.length,
      candidateOnlyIds,
      officialOnlyIds,
      hypothesisMismatchIds,
    },
    compatibility: {
      reportComplete: isReportComplete,
      nonEmptyDecisionSet,
      completeCoverage,
      hypothesesExact,
      modelExact,
      promptRevisionPinned,
      comparable,
    },
    metrics: {
      compared,
      labelMatches,
      labelMismatches,
      agreementRate: compared === 0 ? null : labelMatches / compared,
      exactAgreement,
      confusion,
      slices: {
        byAbility,
        byQuestionType,
      },
    },
    policy: {
      labelMismatchAffectsCommandExit: false,
      requireExactAffectsCommandExit: true,
      rawQuestionsIncluded: false,
      rawExpectedAnswersIncluded: false,
      rawHypothesesIncluded: false,
      rawEvidenceIncluded: false,
    },
    claim: {
      evidenceClass: report.run.resultClass,
      exactAgreement,
      publicationEligible: false,
      blockers,
    },
    mismatches,
  };
  validateArtifact(
    compileValidator(evaluatorParitySchemaFile),
    artifact,
    "evaluator parity artifact"
  );
  await writeExclusiveAtomic(
    options.output,
    `${JSON.stringify(artifact, null, 2)}\n`
  );
  return artifact;
}
