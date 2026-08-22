import { createHash } from "node:crypto";
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
import { agentEvaluationFingerprint } from "./agent-comparison.js";
import type {
  AgentBenchmarkReport,
  AgentComparisonManifest,
  AgentComponentInfo,
} from "./agent-types.js";
import type { EvaluatorParityArtifact } from "./agent-types.js";
import {
  type AgentPublicationAssessment,
  type AgentPublicationManifest,
  type AgentPublicationOptions,
  type AgentPublicationQualification,
  type AgentPublicationRelease,
  type AgentPublicationRun,
  type AgentPublicationStatistics,
} from "./publication-types.js";
import {
  assessComponentQualification,
  loadComponentQualification,
  type ComponentQualification,
  type ComponentQualificationOptions,
} from "./qualification.js";
import {
  assessStatisticalComparison,
  loadStatisticalComparison,
} from "./statistical-comparison.js";

export type {
  AgentPublicationAssessment,
  AgentPublicationManifest,
  AgentPublicationOptions,
  AgentPublicationRelease,
} from "./publication-types.js";

const agentComparisonSchemaFile = fileURLToPath(
  new URL(
    "../schemas/v1/agent-comparison-manifest.schema.json",
    import.meta.url
  )
);
const agentReportSchemaFile = fileURLToPath(
  new URL("../schemas/v1/agent-report.schema.json", import.meta.url)
);
const evaluatorParitySchemaFile = fileURLToPath(
  new URL("../schemas/v1/evaluator-parity.schema.json", import.meta.url)
);
const agentPublicationSchemaFile = fileURLToPath(
  new URL("../schemas/v1/agent-publication.schema.json", import.meta.url)
);
const maximumInputBytes = 100 * 1024 * 1024;
const releaseAttestationKeys = [
  "datasetRightsVerified",
  "noQuerySpecificTuning",
  "providerDisclosuresComplete",
  "sponsorshipDisclosuresComplete",
  "allEvidencePublished",
  "independentAuditComplete",
  "secretsExcluded",
  "correctionsPolicyAccepted",
] as const;

interface LoadedArtifact<T> {
  file: string;
  bytes: Buffer;
  sha256: string;
  value: T;
}

interface MechanicalEvidence {
  comparison: AgentPublicationManifest["comparison"];
  runs: AgentPublicationRun[];
  qualifications: AgentPublicationQualification[];
  statistics: AgentPublicationStatistics | null;
  issues: string[];
  warnings: string[];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function componentSha256(component: AgentComponentInfo): string {
  return sha256(canonicalJson(component));
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

function loadJson<T>(
  file: string,
  label: string,
  schemaFile: string
): LoadedArtifact<T> {
  const bytes = readBoundedFile(file, label);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  validateArtifact(compileValidator(schemaFile), value, label);
  return {
    file,
    bytes,
    sha256: sha256(bytes),
    value: value as T,
  };
}

function safeSibling(directory: string, file: string, label: string): string {
  if (
    file.trim() === "" ||
    path.isAbsolute(file) ||
    path.basename(file) !== file
  ) {
    throw new Error(`${label} must be a safe sibling filename`);
  }
  return path.join(directory, file);
}

function uniquePaths(paths: string[], label: string): void {
  const resolved = paths.map((file) => path.resolve(file));
  if (new Set(resolved).size !== resolved.length) {
    throw new Error(`${label} paths must not contain duplicates`);
  }
}

function validateOptions(options: AgentPublicationOptions): void {
  if (options.comparison.trim() === "") {
    throw new Error("comparison manifest path must not be empty");
  }
  uniquePaths(options.qualifications, "qualification");
  uniquePaths(options.evaluatorParities, "evaluator parity");
  if (
    options.statistics !== undefined &&
    options.statistics.trim() === ""
  ) {
    throw new Error(
      "statistical comparison artifact path must not be empty"
    );
  }
}

function reportInvariantIssues(
  report: AgentBenchmarkReport,
  run: AgentComparisonManifest["runs"][number],
  manifest: AgentComparisonManifest,
  reportSha: string
): string[] {
  const issues: string[] = [];
  if (run.reportSha256 !== reportSha) {
    issues.push(`${run.adapter} report SHA-256 differs from the manifest`);
  }
  if (report.run.components.adapter.name !== run.adapter) {
    issues.push(
      `${run.adapter} report component name is ${report.run.components.adapter.name}`
    );
  }
  if (
    report.run.status !== "completed" ||
    report.metrics.runtimeFailures !== 0 ||
    report.failures.length !== 0
  ) {
    issues.push(`${run.adapter} report contains runtime failures`);
  }
  if (
    report.run.dataset.artifactSha256 !==
      manifest.dataset.artifactSha256
  ) {
    issues.push(`${run.adapter} report dataset artifact differs`);
  }
  if (
    canonicalJson(report.run.components) !==
    canonicalJson(run.components)
  ) {
    issues.push(`${run.adapter} report components differ from the manifest`);
  }
  if (
    agentEvaluationFingerprint(report) !==
      manifest.evaluation.configurationSha256 ||
    run.evaluationSha256 !== manifest.evaluation.configurationSha256
  ) {
    issues.push(
      `${run.adapter} report evaluation fingerprint differs from the comparison`
    );
  }
  return issues;
}

function qualificationOptions(
  qualificationFile: string,
  qualification: ComponentQualification
): ComponentQualificationOptions {
  const directory = path.dirname(qualificationFile);
  return {
    role: qualification.subject.role,
    agentReport: safeSibling(
      directory,
      qualification.evidence.agentReport.file,
      "qualification agent report"
    ),
    ...(qualification.evidence.coreReport === null
      ? {}
      : {
          coreReport: safeSibling(
            directory,
            qualification.evidence.coreReport.file,
            "qualification core report"
          ),
        }),
    ...(qualification.evidence.evaluatorParity === null
      ? {}
      : {
          evaluatorParity: safeSibling(
            directory,
            qualification.evidence.evaluatorParity.file,
            "qualification evaluator parity"
          ),
        }),
  };
}

async function collectQualifications(
  files: string[]
): Promise<{
  artifacts: AgentPublicationQualification[];
  byComponent: Map<string, AgentPublicationQualification>;
  issues: string[];
  warnings: string[];
}> {
  const artifacts: AgentPublicationQualification[] = [];
  const byComponent = new Map<string, AgentPublicationQualification>();
  const issues: string[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const loaded = loadComponentQualification(file);
    const qualification = loaded.value;
    const key = `${qualification.subject.role}:${qualification.subject.componentSha256}`;
    if (byComponent.has(key)) {
      issues.push(
        `multiple qualifications were supplied for ${key}`
      );
      continue;
    }
    let assessment;
    try {
      assessment = await assessComponentQualification(
        qualification,
        qualificationOptions(file, qualification)
      );
    } catch (error) {
      issues.push(
        `${path.basename(file)} qualification evidence failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }
    issues.push(
      ...assessment.issues.map(
        (issue) => `${path.basename(file)}: ${issue}`
      )
    );
    warnings.push(
      ...assessment.warnings.map(
        (warning) => `${path.basename(file)}: ${warning}`
      )
    );
    if (
      !assessment.qualified ||
      qualification.reviewer === null ||
      qualification.maintainer === null
    ) {
      continue;
    }
    const artifact: AgentPublicationQualification = {
      file: path.basename(file),
      sha256: loaded.sha256,
      qualificationId: qualification.qualificationId,
      role: qualification.subject.role,
      componentName: qualification.subject.component.name,
      componentSha256: qualification.subject.componentSha256,
      reviewerId: qualification.reviewer.id,
      maintainerId: qualification.maintainer.id,
    };
    artifacts.push(artifact);
    byComponent.set(key, artifact);
  }
  artifacts.sort(
    (left, right) =>
      left.role.localeCompare(right.role) ||
      left.componentName.localeCompare(right.componentName) ||
      left.componentSha256.localeCompare(right.componentSha256)
  );
  return {
    artifacts,
    byComponent,
    issues,
    warnings,
  };
}

function collectParities(files: string[]): {
  byReportSha: Map<string, LoadedArtifact<EvaluatorParityArtifact>>;
  issues: string[];
} {
  const byReportSha = new Map<
    string,
    LoadedArtifact<EvaluatorParityArtifact>
  >();
  const issues: string[] = [];
  for (const file of files) {
    const loaded = loadJson<EvaluatorParityArtifact>(
      file,
      "evaluator parity artifact",
      evaluatorParitySchemaFile
    );
    const reportSha = loaded.value.candidate.reportSha256;
    if (byReportSha.has(reportSha)) {
      issues.push(
        `multiple evaluator parity artifacts target report ${reportSha}`
      );
      continue;
    }
    if (
      !loaded.value.compatibility.comparable ||
      !loaded.value.metrics.exactAgreement ||
      loaded.value.metrics.labelMismatches !== 0
    ) {
      issues.push(
        `${path.basename(file)} is not comparable exact evaluator agreement`
      );
    }
    byReportSha.set(reportSha, loaded);
  }
  return { byReportSha, issues };
}

function collectStatistics(
  file: string | undefined,
  comparisonFile: string,
  comparisonSha256: string
): {
  artifact: AgentPublicationStatistics | null;
  issues: string[];
} {
  if (file === undefined) {
    return {
      artifact: null,
      issues: ["statistical comparison artifact is required"],
    };
  }
  const loaded = loadStatisticalComparison(file);
  const assessment = assessStatisticalComparison(
    loaded.value,
    comparisonFile
  );
  const issues = assessment.issues.map(
    (issue) => `${path.basename(file)}: ${issue}`
  );
  if (loaded.value.track !== "agent") {
    issues.push(
      "agent publication requires an agent-track statistical comparison"
    );
  }
  if (
    loaded.value.comparison.sha256 !== comparisonSha256
  ) {
    issues.push(
      "statistical comparison targets a different comparison manifest"
    );
  }
  if (
    !loaded.value.claim.allIntervalsAvailable ||
    loaded.value.claim.blockers.length !== 0
  ) {
    issues.push(
      "statistical comparison has unavailable confidence intervals"
    );
  }
  return {
    artifact: {
      file: path.basename(file),
      sha256: loaded.sha256,
      analysisId: loaded.value.analysisId,
      comparisonSha256: loaded.value.comparison.sha256,
      iterations: loaded.value.method.iterations,
      confidenceLevel: loaded.value.method.confidenceLevel,
      seed: loaded.value.method.seed,
      allIntervalsAvailable:
        loaded.value.claim.allIntervalsAvailable,
    },
    issues,
  };
}

async function collectMechanicalEvidence(
  options: AgentPublicationOptions
): Promise<MechanicalEvidence> {
  validateOptions(options);
  const comparisonArtifact = loadJson<AgentComparisonManifest>(
    options.comparison,
    "agent comparison manifest",
    agentComparisonSchemaFile
  );
  const manifest = comparisonArtifact.value;
  const issues: string[] = [];
  const warnings: string[] = [];
  const statistics = collectStatistics(
    options.statistics,
    options.comparison,
    comparisonArtifact.sha256
  );
  issues.push(...statistics.issues);
  if (!manifest.claim.comparable) {
    issues.push("agent comparison is not mechanically comparable");
  }
  if (
    manifest.source.gitCommit === null ||
    manifest.source.gitDirty !== false
  ) {
    issues.push(
      "agent comparison source is dirty or has no pinned Git commit"
    );
  }
  if (
    manifest.evaluation.configurationSha256 === null
  ) {
    issues.push("agent comparison has no evaluation fingerprint");
  }
  if (manifest.runs.length < 2) {
    issues.push("agent publication requires at least two adapter runs");
  }
  const processIds = manifest.runs
    .map((run) => run.processId)
    .filter((value): value is number => value !== null);
  if (
    processIds.length !== manifest.runs.length ||
    new Set(processIds).size !== processIds.length
  ) {
    issues.push("agent comparison child process IDs are not distinct");
  }

  const qualificationSet = await collectQualifications(
    options.qualifications
  );
  issues.push(...qualificationSet.issues);
  warnings.push(...qualificationSet.warnings);
  const paritySet = collectParities(options.evaluatorParities);
  issues.push(...paritySet.issues);
  const expectedQualificationKeys = new Set<string>();
  const expectedReportShas = new Set<string>();
  const runs: AgentPublicationRun[] = [];
  for (const run of manifest.runs) {
    if (
      run.status !== "completed" ||
      run.processId === null ||
      run.reportFile === null ||
      run.reportSha256 === null ||
      run.resultClass === null
    ) {
      issues.push(`${run.adapter} comparison run is incomplete`);
      continue;
    }
    const reportFile = safeSibling(
      path.dirname(options.comparison),
      run.reportFile,
      `${run.adapter} report file`
    );
    const reportArtifact = loadJson<AgentBenchmarkReport>(
      reportFile,
      `${run.adapter} agent report`,
      agentReportSchemaFile
    );
    issues.push(
      ...reportInvariantIssues(
        reportArtifact.value,
        run,
        manifest,
        reportArtifact.sha256
      )
    );
    expectedReportShas.add(reportArtifact.sha256);
    const componentShas = {
      adapter: componentSha256(
        reportArtifact.value.run.components.adapter
      ),
      reader: componentSha256(
        reportArtifact.value.run.components.reader
      ),
      judge: componentSha256(
        reportArtifact.value.run.components.judge
      ),
    };
    for (const role of ["adapter", "reader", "judge"] as const) {
      const component = reportArtifact.value.run.components[role];
      if (component.classification === "harness") {
        issues.push(
          `${run.adapter} ${role} component is harness-class`
        );
      } else if (component.classification === "candidate") {
        const key = `${role}:${componentShas[role]}`;
        expectedQualificationKeys.add(key);
        if (!qualificationSet.byComponent.has(key)) {
          issues.push(
            `${run.adapter} ${role} component has no matching qualification`
          );
        }
      }
    }
    const parity = paritySet.byReportSha.get(reportArtifact.sha256);
    if (parity === undefined) {
      issues.push(
        `${run.adapter} report has no matching evaluator parity artifact`
      );
    }
    runs.push({
      adapter: run.adapter,
      processId: run.processId,
      reportFile: path.basename(reportFile),
      reportSha256: reportArtifact.sha256,
      resultClass: run.resultClass,
      componentSha256: componentShas,
      evaluatorParityFile:
        parity === undefined ? null : path.basename(parity.file),
      evaluatorParitySha256:
        parity === undefined ? null : parity.sha256,
    });
  }
  for (const key of qualificationSet.byComponent.keys()) {
    if (!expectedQualificationKeys.has(key)) {
      issues.push(`qualification ${key} is not used by the comparison`);
    }
  }
  for (const reportSha of paritySet.byReportSha.keys()) {
    if (!expectedReportShas.has(reportSha)) {
      issues.push(
        `evaluator parity targets report outside the comparison: ${reportSha}`
      );
    }
  }
  runs.sort((left, right) => left.adapter.localeCompare(right.adapter));
  const evaluationSha256 =
    manifest.evaluation.configurationSha256 ?? "0".repeat(64);
  return {
    comparison: {
      file: path.basename(options.comparison),
      sha256: comparisonArtifact.sha256,
      comparisonId: manifest.comparisonId,
      datasetArtifactSha256: manifest.dataset.artifactSha256,
      evaluationSha256,
      sourceCommit: manifest.source.gitCommit,
      sourceDirty: manifest.source.gitDirty,
    },
    runs,
    qualifications: qualificationSet.artifacts,
    statistics: statistics.artifact,
    issues: [...new Set(issues)],
    warnings: [...new Set(warnings)],
  };
}

function publicationId(evidence: MechanicalEvidence): string {
  const digest = sha256(
    canonicalJson({
      comparison: evidence.comparison,
      runs: evidence.runs,
      qualifications: evidence.qualifications,
      statistics: evidence.statistics,
    })
  );
  return `mbp-${digest.slice(0, 32)}`;
}

function releaseIssues(
  release: AgentPublicationRelease | null
): string[] {
  if (release === null) return ["release attestation is required"];
  const issues: string[] = [];
  for (const key of releaseAttestationKeys) {
    if (!release.attestation[key]) {
      issues.push(`release attestation ${key} must be accepted`);
    }
  }
  if (release.knownLimitations.length === 0) {
    issues.push("release must disclose at least one limitation");
  }
  const releasedAt = Date.parse(release.releasedAt);
  if (
    Number.isFinite(releasedAt) &&
    releasedAt > Date.now() + 24 * 60 * 60 * 1_000
  ) {
    issues.push("release timestamp is more than 24 hours in the future");
  }
  return issues;
}

function draftClaim(
  evidence: MechanicalEvidence,
  release: AgentPublicationRelease | null
): AgentPublicationManifest["claim"] {
  const blockers = [
    ...evidence.issues,
    ...releaseIssues(release),
  ];
  return {
    resultClass: "candidate",
    mechanicallyVerified: evidence.issues.length === 0,
    publicationEligible: false,
    blockers: [...new Set(blockers)],
  };
}

export async function createAgentPublicationTemplate(
  options: AgentPublicationOptions
): Promise<AgentPublicationManifest> {
  const evidence = await collectMechanicalEvidence(options);
  const manifest: AgentPublicationManifest = {
    schemaVersion: 1,
    kind: "memory-bench-agent-publication",
    publicationId: publicationId(evidence),
    status: "draft",
    assembledAt: new Date().toISOString(),
    finalizedAt: null,
    comparison: evidence.comparison,
    runs: evidence.runs,
    qualifications: evidence.qualifications,
    statistics: evidence.statistics,
    release: null,
    claim: draftClaim(evidence, null),
  };
  validateArtifact(
    compileValidator(agentPublicationSchemaFile),
    manifest,
    "agent publication template"
  );
  return manifest;
}

export function loadAgentPublicationManifest(
  file: string
): LoadedArtifact<AgentPublicationManifest> {
  return loadJson<AgentPublicationManifest>(
    file,
    "agent publication manifest",
    agentPublicationSchemaFile
  );
}

export async function assessAgentPublication(
  manifest: AgentPublicationManifest,
  options: AgentPublicationOptions
): Promise<AgentPublicationAssessment> {
  validateArtifact(
    compileValidator(agentPublicationSchemaFile),
    manifest,
    "agent publication manifest"
  );
  const evidence = await collectMechanicalEvidence(options);
  const issues = [...evidence.issues];
  const warnings = [...evidence.warnings];
  if (manifest.publicationId !== publicationId(evidence)) {
    issues.push(
      "publication ID does not match the supplied evidence bundle"
    );
  }
  if (
    canonicalJson(manifest.comparison) !==
    canonicalJson(evidence.comparison)
  ) {
    issues.push(
      "publication comparison identity differs from the supplied manifest"
    );
  }
  if (canonicalJson(manifest.runs) !== canonicalJson(evidence.runs)) {
    issues.push(
      "publication run evidence differs from the supplied reports/parities"
    );
  }
  if (
    canonicalJson(manifest.qualifications) !==
    canonicalJson(evidence.qualifications)
  ) {
    issues.push(
      "publication qualification evidence differs from supplied overlays"
    );
  }
  if (
    canonicalJson(manifest.statistics) !==
    canonicalJson(evidence.statistics)
  ) {
    issues.push(
      "publication statistical evidence differs from the supplied artifact"
    );
  }
  if (
    manifest.claim.mechanicallyVerified !==
    (evidence.issues.length === 0)
  ) {
    issues.push(
      "publication mechanical claim differs from current evidence"
    );
  }
  const releaseProblems = releaseIssues(manifest.release);
  issues.push(...releaseProblems);
  const mechanicallyVerified = evidence.issues.length === 0;
  const releaseVerified = releaseProblems.length === 0;
  const readyToFinalize =
    mechanicallyVerified &&
    releaseVerified &&
    issues.length === 0;
  if (manifest.status === "final") {
    if (
      !readyToFinalize ||
      manifest.claim.resultClass !== "benchmark" ||
      !manifest.claim.publicationEligible ||
      manifest.claim.blockers.length !== 0 ||
      manifest.finalizedAt === null
    ) {
      issues.push(
        "final publication claim is inconsistent with current evidence"
      );
    }
  } else if (
    manifest.claim.resultClass !== "candidate" ||
    manifest.claim.publicationEligible ||
    manifest.finalizedAt !== null
  ) {
    issues.push("draft publication claim must remain candidate and ineligible");
  }
  return {
    mechanicallyVerified,
    releaseVerified,
    readyToFinalize:
      mechanicallyVerified &&
      releaseVerified &&
      issues.length === 0,
    issues: [...new Set(issues)],
    warnings: [...new Set(warnings)],
  };
}

export async function finalizeAgentPublication(
  draft: AgentPublicationManifest,
  options: AgentPublicationOptions
): Promise<AgentPublicationManifest> {
  if (draft.status !== "draft") {
    throw new Error("only a draft publication manifest can be finalized");
  }
  const assessment = await assessAgentPublication(draft, options);
  if (!assessment.readyToFinalize) {
    throw new Error(
      `agent publication cannot be finalized: ${assessment.issues.join("; ")}`
    );
  }
  const finalized: AgentPublicationManifest = {
    ...structuredClone(draft),
    status: "final",
    finalizedAt: new Date().toISOString(),
    claim: {
      resultClass: "benchmark",
      mechanicallyVerified: true,
      publicationEligible: true,
      blockers: [],
    },
  };
  validateArtifact(
    compileValidator(agentPublicationSchemaFile),
    finalized,
    "final agent publication manifest"
  );
  return finalized;
}
