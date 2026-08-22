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
import type {
  AgentBenchmarkReport,
  AgentComponentInfo,
} from "./agent-types.js";
import type { EvaluatorParityArtifact } from "./agent-types.js";
import {
  qualificationRoles,
  type ComponentQualification,
  type ComponentQualificationAssessment,
  type ComponentQualificationOptions,
  type QualificationAttestation,
  type QualificationRole,
} from "./qualification-types.js";
import type { BenchmarkReport } from "./types.js";

export type {
  ComponentQualification,
  ComponentQualificationAssessment,
  ComponentQualificationOptions,
  QualificationAttestation,
  QualificationMaintainer,
  QualificationReviewer,
  QualificationRole,
  QualificationSubmitter,
} from "./qualification-types.js";

const agentReportSchemaFile = fileURLToPath(
  new URL("../schemas/v1/agent-report.schema.json", import.meta.url)
);
const coreReportSchemaFile = fileURLToPath(
  new URL("../schemas/v1/report.schema.json", import.meta.url)
);
const evaluatorParitySchemaFile = fileURLToPath(
  new URL("../schemas/v1/evaluator-parity.schema.json", import.meta.url)
);
const qualificationSchemaFile = fileURLToPath(
  new URL("../schemas/v1/component-qualification.schema.json", import.meta.url)
);
const maximumInputBytes = 100 * 1024 * 1024;
const remoteProviderAdapters = new Set(["mem0", "letta", "zep"]);
const commonAttestations = [
  "evidenceAuthentic",
  "realServiceOrImplementation",
  "noContractOrFakeServer",
  "configurationPinned",
  "credentialsExcluded",
  "evidencePublished",
  "independentReproduction",
] as const;

interface LoadedArtifact<T> {
  bytes: Buffer;
  sha256: string;
  value: T;
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

function parseJson<T>(
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
    bytes,
    sha256: sha256(bytes),
    value: value as T,
  };
}

function componentForRole(
  report: AgentBenchmarkReport,
  role: QualificationRole
): AgentComponentInfo {
  return report.run.components[role];
}

function roleValue(value: string): QualificationRole {
  if (!qualificationRoles.includes(value as QualificationRole)) {
    throw new Error(
      `qualification role must be ${qualificationRoles.join(", ")}`
    );
  }
  return value as QualificationRole;
}

function validateOptions(options: ComponentQualificationOptions): void {
  roleValue(options.role);
  if (options.agentReport.trim() === "") {
    throw new Error("agent report path must not be empty");
  }
  if (options.role === "adapter") {
    if (options.coreReport === undefined) {
      throw new Error(
        "adapter qualification requires a core report"
      );
    }
    if (options.evaluatorParity !== undefined) {
      throw new Error(
        "adapter qualification does not accept evaluator parity evidence"
      );
    }
    return;
  }
  if (options.coreReport !== undefined) {
    throw new Error(
      `${options.role} qualification does not accept a core report`
    );
  }
  if (options.role === "judge") {
    if (options.evaluatorParity === undefined) {
      throw new Error(
        "judge qualification requires evaluator parity evidence"
      );
    }
    return;
  }
  if (options.evaluatorParity !== undefined) {
    throw new Error(
      "reader qualification does not accept evaluator parity evidence"
    );
  }
}

function operationCounts(
  report: BenchmarkReport
): ComponentQualification["evidence"]["coreReport"] extends infer T
  ? T extends { operationCounts: infer C }
    ? C
    : never
  : never {
  return {
    write: report.metrics.operationLatency.write.count,
    update: report.metrics.operationLatency.update.count,
    delete: report.metrics.operationLatency.delete.count,
    query: report.metrics.operationLatency.query.count,
  };
}

function agentReportEvidence(
  file: string,
  artifact: LoadedArtifact<AgentBenchmarkReport>
): ComponentQualification["evidence"]["agentReport"] {
  const report = artifact.value;
  return {
    file: path.basename(file),
    sha256: artifact.sha256,
    runId: report.run.runId,
    reportStatus: report.run.status,
    resultClass: report.run.resultClass,
    datasetArtifactSha256: report.run.dataset.artifactSha256,
    scenarios: report.metrics.scenarios,
    runtimeFailures: report.metrics.runtimeFailures,
    cleanupVerificationRate: report.metrics.cleanupVerificationRate,
  };
}

function coreReportEvidence(
  file: string,
  artifact: LoadedArtifact<BenchmarkReport>
): NonNullable<ComponentQualification["evidence"]["coreReport"]> {
  const report = artifact.value;
  return {
    file: path.basename(file),
    sha256: artifact.sha256,
    runId: report.run.runId,
    datasetName: report.run.dataset.name,
    datasetVersion: report.run.dataset.version,
    datasetPublicationStatus: report.run.dataset.publicationStatus,
    adapterName: report.run.adapter.name,
    adapterVersion: report.run.adapter.version,
    adapterInfoSha256: sha256(canonicalJson(report.run.adapter)),
    queries: report.metrics.queries,
    queryFailures: report.queries.filter((query) => !query.passed).length,
    cleanupVerified: report.run.adapterTelemetry.cleanup.verified,
    operationCounts: operationCounts(report),
  };
}

function parityEvidence(
  file: string,
  artifact: LoadedArtifact<EvaluatorParityArtifact>
): NonNullable<ComponentQualification["evidence"]["evaluatorParity"]> {
  const parity = artifact.value;
  return {
    file: path.basename(file),
    sha256: artifact.sha256,
    candidateReportSha256: parity.candidate.reportSha256,
    comparable: parity.compatibility.comparable,
    exactAgreement: parity.metrics.exactAgreement,
    labelMismatches: parity.metrics.labelMismatches,
    evaluatorRevision: parity.official.evaluatorRevision,
    evaluatorScriptSha256: parity.official.scriptSha256,
  };
}

function qualificationId(
  role: QualificationRole,
  subject: ComponentQualification["subject"],
  evidence: ComponentQualification["evidence"]
): string {
  const digest = sha256(canonicalJson({ subject, evidence }));
  return `mbq-${role}-${digest.slice(0, 32)}`;
}

export async function createComponentQualificationTemplate(
  options: ComponentQualificationOptions
): Promise<ComponentQualification> {
  validateOptions(options);
  const agentArtifact = parseJson<AgentBenchmarkReport>(
    options.agentReport,
    "agent report",
    agentReportSchemaFile
  );
  const component = structuredClone(
    componentForRole(agentArtifact.value, options.role)
  );
  if (component.classification !== "candidate") {
    throw new Error(
      `${options.role} component classification is ${component.classification}, expected candidate`
    );
  }
  const coreArtifact =
    options.coreReport === undefined
      ? null
      : parseJson<BenchmarkReport>(
          options.coreReport,
          "core report",
          coreReportSchemaFile
        );
  const parityArtifact =
    options.evaluatorParity === undefined
      ? null
      : parseJson<EvaluatorParityArtifact>(
          options.evaluatorParity,
          "evaluator parity artifact",
          evaluatorParitySchemaFile
        );
  const subject: ComponentQualification["subject"] = {
    role: options.role,
    component,
    componentSha256: sha256(canonicalJson(component)),
  };
  const evidence: ComponentQualification["evidence"] = {
    agentReport: agentReportEvidence(
      options.agentReport,
      agentArtifact
    ),
    coreReport:
      coreArtifact === null || options.coreReport === undefined
        ? null
        : coreReportEvidence(options.coreReport, coreArtifact),
    evaluatorParity:
      parityArtifact === null || options.evaluatorParity === undefined
        ? null
        : parityEvidence(options.evaluatorParity, parityArtifact),
  };
  const template: ComponentQualification = {
    schemaVersion: 1,
    kind: "memory-bench-component-qualification",
    qualificationId: qualificationId(options.role, subject, evidence),
    subject,
    evidence,
    submitter: null,
    reviewer: null,
    maintainer: null,
    attestation: null,
    decision: "pending",
    decisionNote: null,
  };
  validateArtifact(
    compileValidator(qualificationSchemaFile),
    template,
    "component qualification template"
  );
  return template;
}

export function loadComponentQualification(
  file: string
): LoadedArtifact<ComponentQualification> {
  return parseJson<ComponentQualification>(
    file,
    "component qualification",
    qualificationSchemaFile
  );
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function isNonPublicHostname(hostname: string): boolean {
  const reservedNames = [
    "localhost",
    "local",
    "test",
    "invalid",
    "example",
  ];
  if (
    reservedNames.some(
      (name) => hostname === name || hostname.endsWith(`.${name}`)
    )
  ) {
    return true;
  }
  const ipv4 = hostname.split(".").map((part) => Number(part));
  if (
    ipv4.length === 4 &&
    ipv4.every(
      (part) => Number.isInteger(part) && part >= 0 && part <= 255
    )
  ) {
    const [first, second, third] = ipv4 as [
      number,
      number,
      number,
      number,
    ];
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 &&
        second === 0 &&
        (third === 0 || third === 2)) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  if (!hostname.includes(":")) return false;
  return (
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("::ffff:") ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    /^fe[89ab]/u.test(hostname) ||
    hostname.startsWith("2001:db8:")
  );
}

function endpointConfigurationIssue(
  component: AgentComponentInfo
): string | null {
  for (const [key, value] of Object.entries(component.config)) {
    if (
      typeof value !== "string" ||
      !/^(?:base.?url(?:origin)?|endpoint(?:url)?|origin)$/iu.test(key)
    ) {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return `config.${key} is not a valid absolute endpoint URL`;
    }
    const hostname = parsed.hostname
      .replace(/^\[|\]$/gu, "")
      .toLocaleLowerCase("en-US");
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return `config.${key} contains embedded credentials or unsafe URL parameters`;
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      hostname === "" ||
      isNonPublicHostname(hostname)
    ) {
      return `config.${key} uses a non-public local, reserved, or contract endpoint ${value}`;
    }
  }
  return null;
}

function nonEmptyConfigString(
  component: AgentComponentInfo,
  key: string
): boolean {
  const value = component.config[key];
  return typeof value === "string" && value.trim() !== "";
}

function adapterCompatibilityIssues(
  agentReport: AgentBenchmarkReport,
  coreReport: BenchmarkReport
): string[] {
  const issues: string[] = [];
  const component = agentReport.run.components.adapter;
  const coreInfo = coreReport.run.adapter;
  if (component.name !== coreInfo.name) {
    issues.push(
      `agent adapter is ${component.name}, core adapter is ${coreInfo.name}`
    );
  }
  if (
    component.version !== coreInfo.version &&
    !component.version.startsWith(`${coreInfo.version}+`)
  ) {
    issues.push(
      "agent adapter version is not the core adapter version or a declared agent wrapper of it"
    );
  }
  for (const [key, value] of Object.entries(coreInfo.config)) {
    if (canonicalJson(component.config[key]) !== canonicalJson(value)) {
      issues.push(
        `agent adapter config.${key} differs from the core adapter evidence`
      );
    }
  }
  const cleanup = coreReport.run.adapterTelemetry.cleanup;
  if (!cleanup.attempted || !cleanup.succeeded || !cleanup.verified) {
    issues.push(
      "core report cleanup was not attempted, successful, and verified"
    );
  }
  for (const [operation, metric] of Object.entries(
    coreReport.metrics.operationLatency
  )) {
    if (metric.count < 1) {
      issues.push(
        `core report did not exercise the ${operation} operation`
      );
    }
  }
  if (
    remoteProviderAdapters.has(component.name) &&
    component.config.apiKeyConfigured !== true
  ) {
    issues.push(
      `${component.name} qualification evidence does not record configured authentication`
    );
  }
  return issues;
}

function modelComponentIssues(
  role: Extract<QualificationRole, "reader" | "judge">,
  component: AgentComponentInfo
): string[] {
  const issues: string[] = [];
  for (const key of ["model", "apiSurface", "baseUrlOrigin"] as const) {
    if (!nonEmptyConfigString(component, key)) {
      issues.push(`${role} component config.${key} must be pinned`);
    }
  }
  if (component.config.temperature !== 0) {
    issues.push(`${role} component temperature must be 0`);
  }
  if (component.config.store !== false) {
    issues.push(`${role} component store must be false`);
  }
  return issues;
}

function agentReportIssues(report: AgentBenchmarkReport): string[] {
  const issues: string[] = [];
  if (report.run.status !== "completed") {
    issues.push(
      `agent report status is ${report.run.status}, expected completed`
    );
  }
  if (
    report.metrics.runtimeFailures !== 0 ||
    report.failures.length !== 0
  ) {
    issues.push("agent report contains runtime failures");
  }
  if (
    report.metrics.scenarios < 1 ||
    report.metrics.completed !== report.metrics.scenarios ||
    report.metrics.failed !== 0 ||
    report.scenarios.some((scenario) => scenario.status !== "completed")
  ) {
    issues.push("agent report does not contain a complete scenario set");
  }
  if (report.metrics.cleanupVerificationRate !== 1) {
    issues.push("agent report cleanup verification rate is not 1");
  }
  return issues;
}

function attestationIssues(
  role: QualificationRole,
  value: QualificationAttestation | null
): string[] {
  if (value === null) return ["qualification attestation is required"];
  const issues: string[] = [];
  for (const key of commonAttestations) {
    if (!value[key]) {
      issues.push(`qualification attestation ${key} must be accepted`);
    }
  }
  const adapterFields = [
    "authenticationFailureObserved",
    "lifecycleOperationsObserved",
    "disposableIsolationObserved",
    "cleanupVerified",
  ] as const;
  const modelFields = [
    "apiContractObserved",
    "requestPolicyVerified",
  ] as const;
  if (role === "adapter") {
    for (const key of adapterFields) {
      if (value[key] !== true) {
        issues.push(`adapter attestation ${key} must be accepted`);
      }
    }
    for (const key of [
      ...modelFields,
      "officialEvaluatorParityVerified",
    ] as const) {
      if (value[key] !== null) {
        issues.push(`adapter attestation ${key} must be null`);
      }
    }
  } else {
    for (const key of adapterFields) {
      if (value[key] !== null) {
        issues.push(`${role} attestation ${key} must be null`);
      }
    }
    for (const key of modelFields) {
      if (value[key] !== true) {
        issues.push(`${role} attestation ${key} must be accepted`);
      }
    }
    if (
      value.officialEvaluatorParityVerified !==
      (role === "judge" ? true : null)
    ) {
      issues.push(
        `${role} attestation officialEvaluatorParityVerified must be ${
          role === "judge" ? "accepted" : "null"
        }`
      );
    }
  }
  return issues;
}

function reviewIssues(
  qualification: ComponentQualification
): string[] {
  const issues: string[] = [];
  if (qualification.submitter === null) {
    issues.push("qualification submitter is required");
  }
  if (qualification.reviewer === null) {
    issues.push("an independent human qualification reviewer is required");
  }
  if (qualification.maintainer === null) {
    issues.push("maintainer reviewer-identity verification is required");
  }
  if (
    qualification.submitter !== null &&
    qualification.reviewer !== null &&
    normalizeIdentity(qualification.submitter.id) ===
      normalizeIdentity(qualification.reviewer.id)
  ) {
    issues.push("qualification reviewer must differ from the submitter");
  }
  if (
    qualification.reviewer !== null &&
    qualification.maintainer !== null &&
    normalizeIdentity(qualification.reviewer.id) ===
      normalizeIdentity(qualification.maintainer.id)
  ) {
    issues.push(
      "qualification maintainer verifier must differ from the reviewer"
    );
  }
  if (
    qualification.submitter !== null &&
    qualification.maintainer !== null &&
    normalizeIdentity(qualification.submitter.id) ===
      normalizeIdentity(qualification.maintainer.id)
  ) {
    issues.push(
      "qualification maintainer verifier must differ from the submitter"
    );
  }
  if (qualification.reviewer !== null) {
    const conflicts = qualification.reviewer.conflicts.map((conflict) =>
      normalizeIdentity(conflict)
    );
    if (new Set(conflicts).size !== conflicts.length) {
      issues.push("qualification reviewer conflicts contain duplicates");
    }
  }
  if (qualification.maintainer !== null) {
    if (!qualification.maintainer.reviewerIdentityVerified) {
      issues.push("maintainer must verify reviewer identity");
    }
    if (!qualification.maintainer.conflictsReviewed) {
      issues.push("maintainer must review disclosed conflicts");
    }
  }
  return issues;
}

export async function assessComponentQualification(
  qualification: ComponentQualification,
  options: ComponentQualificationOptions
): Promise<ComponentQualificationAssessment> {
  validateArtifact(
    compileValidator(qualificationSchemaFile),
    qualification,
    "component qualification"
  );
  const expected = await createComponentQualificationTemplate(options);
  const agentArtifact = parseJson<AgentBenchmarkReport>(
    options.agentReport,
    "agent report",
    agentReportSchemaFile
  );
  const coreArtifact =
    options.coreReport === undefined
      ? null
      : parseJson<BenchmarkReport>(
          options.coreReport,
          "core report",
          coreReportSchemaFile
        );
  const parityArtifact =
    options.evaluatorParity === undefined
      ? null
      : parseJson<EvaluatorParityArtifact>(
          options.evaluatorParity,
          "evaluator parity artifact",
          evaluatorParitySchemaFile
        );
  const issues: string[] = [];
  const warnings: string[] = [];
  if (qualification.qualificationId !== expected.qualificationId) {
    issues.push(
      "qualification ID does not match the source evidence"
    );
  }
  if (
    canonicalJson(qualification.subject) !== canonicalJson(expected.subject)
  ) {
    issues.push(
      "qualification subject does not match the source agent report component"
    );
  }
  if (
    canonicalJson(qualification.evidence) !==
    canonicalJson(expected.evidence)
  ) {
    issues.push(
      "qualification evidence identity does not match the supplied artifacts"
    );
  }
  issues.push(...agentReportIssues(agentArtifact.value));
  const component = componentForRole(agentArtifact.value, options.role);
  if (component.classification !== "candidate") {
    issues.push(
      `${options.role} component is ${component.classification}, expected candidate`
    );
  }
  const endpointIssue = endpointConfigurationIssue(component);
  if (endpointIssue !== null) {
    issues.push(`${options.role} component ${endpointIssue}`);
  }
  if (options.role === "adapter") {
    if (coreArtifact === null) {
      issues.push("adapter qualification is missing core report evidence");
    } else {
      issues.push(
        ...adapterCompatibilityIssues(
          agentArtifact.value,
          coreArtifact.value
        )
      );
      if (
        coreArtifact.value.run.dataset.publicationStatus !== "reviewed"
      ) {
        warnings.push(
          `core qualification dataset is ${coreArtifact.value.run.dataset.publicationStatus}; this can prove lifecycle coverage but not leaderboard quality`
        );
      }
    }
  } else {
    issues.push(...modelComponentIssues(options.role, component));
  }
  if (options.role === "judge") {
    if (parityArtifact === null) {
      issues.push("judge qualification is missing evaluator parity evidence");
    } else {
      const parity = parityArtifact.value;
      if (
        parity.candidate.reportSha256 !== agentArtifact.sha256
      ) {
        issues.push(
          "evaluator parity candidate report hash differs from qualification evidence"
        );
      }
      if (
        !parity.compatibility.comparable ||
        !parity.metrics.exactAgreement ||
        parity.metrics.labelMismatches !== 0
      ) {
        issues.push(
          "evaluator parity is not comparable with exact zero-mismatch agreement"
        );
      }
    }
  }
  if (qualification.decision !== "qualified") {
    issues.push(
      `qualification decision is ${qualification.decision}, expected qualified`
    );
  }
  issues.push(...reviewIssues(qualification));
  issues.push(
    ...attestationIssues(options.role, qualification.attestation)
  );
  return {
    qualified: issues.length === 0,
    qualificationId: qualification.qualificationId,
    role: qualification.subject.role,
    componentSha256: qualification.subject.componentSha256,
    issues: [...new Set(issues)],
    warnings: [...new Set(warnings)],
  };
}
