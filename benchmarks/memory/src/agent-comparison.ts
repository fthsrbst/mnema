import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Ajv2020,
  type AnySchemaObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { openAgentDataset } from "./agent-dataset.js";
import {
  agentAdapterNames,
  type AgentAdapterName,
  type AgentBenchmarkReport,
  type AgentComparisonManifest,
  type AgentComparisonRun,
  type AgentJudgeName,
  type AgentReaderName,
  type AgentResultClass,
} from "./agent-types.js";

export interface AgentComparisonOptions {
  adapters: AgentAdapterName[];
  reader: AgentReaderName;
  readerModel: string;
  judge: AgentJudgeName;
  judgeModel: string;
  dataset: string;
  outputDir: string;
  topK: number;
  maxScenarios?: number;
  adapterTimeoutMs: number;
}

export interface AgentComparisonArtifact {
  manifest: AgentComparisonManifest;
  manifestPath: string;
}

interface ProcessResult {
  processId: number | null;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
  spawnError: string | null;
}

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const agentCli = fileURLToPath(new URL("./agent-cli.ts", import.meta.url));
const agentReportSchemaFile = fileURLToPath(
  new URL("../schemas/v1/agent-report.schema.json", import.meta.url)
);
const agentComparisonSchemaFile = fileURLToPath(
  new URL(
    "../schemas/v1/agent-comparison-manifest.schema.json",
    import.meta.url
  )
);
const supportedAdapters = new Set<AgentAdapterName>(agentAdapterNames);
const maximumProcessOutputBytes = 1_000_000;
const secretEnvironmentNames = [
  "MEM0_API_KEY",
  "LETTA_API_KEY",
  "ZEP_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ORGANIZATION",
  "MEMORY_BENCH_LETTA_PROJECT_ID",
] as const;

function validateOptions(options: AgentComparisonOptions): void {
  if (options.adapters.length < 2) {
    throw new Error("agent comparison requires at least two adapters");
  }
  if (new Set(options.adapters).size !== options.adapters.length) {
    throw new Error("agent comparison adapters must not contain duplicates");
  }
  for (const adapter of options.adapters) {
    if (!supportedAdapters.has(adapter)) {
      throw new Error(`unsupported agent comparison adapter: ${adapter}`);
    }
  }
  if (
    !Number.isInteger(options.topK) ||
    options.topK < 1 ||
    options.topK > 100
  ) {
    throw new Error("agent comparison topK must be an integer from 1 to 100");
  }
  if (
    options.maxScenarios !== undefined &&
    (!Number.isInteger(options.maxScenarios) || options.maxScenarios < 1)
  ) {
    throw new Error(
      "agent comparison maxScenarios must be a positive integer"
    );
  }
  if (
    !Number.isInteger(options.adapterTimeoutMs) ||
    options.adapterTimeoutMs < 1_000 ||
    options.adapterTimeoutMs > 24 * 60 * 60 * 1_000
  ) {
    throw new Error(
      "agent comparison adapterTimeoutMs must be an integer from 1000 to 86400000"
    );
  }
  if (options.dataset.trim() === "") {
    throw new Error("agent comparison dataset path must not be empty");
  }
  if (options.outputDir.trim() === "") {
    throw new Error("agent comparison output directory must not be empty");
  }
  if (options.reader === "openai" && options.readerModel.trim() === "") {
    throw new Error("agent comparison reader model must not be empty");
  }
  if (options.judge === "openai" && options.judgeModel.trim() === "") {
    throw new Error("agent comparison judge model must not be empty");
  }
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
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function gitValue(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function redact(value: string): string {
  let redacted = value;
  for (const name of secretEnvironmentNames) {
    const secret = process.env[name];
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted
    .replace(
      /(authorization|api[-_ ]?key|token)\s*[:=]\s*\S+/giu,
      "$1=[redacted]"
    )
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gu, "[redacted]")
    .slice(0, 2_000);
}

function compileArtifactValidator(schemaFile: string): {
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

const agentReportValidator = compileArtifactValidator(agentReportSchemaFile);
const agentComparisonValidator = compileArtifactValidator(
  agentComparisonSchemaFile
);

function artifactValidationError(
  validator: ReturnType<typeof compileArtifactValidator>,
  value: unknown
): string | null {
  if (validator.validate(value)) return null;
  return validator.ajv.errorsText(
    validator.validate.errors,
    { separator: "; " }
  );
}

async function runChildProcess(args: string[], timeoutMs: number): Promise<ProcessResult> {
  const startedAt = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const processId = child.pid ?? null;
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let timedOut = false;
  let outputExceeded = false;
  let spawnError: string | null = null;
  let forceKillTimer: NodeJS.Timeout | null = null;
  const terminate = (): void => {
    child.kill("SIGTERM");
    if (forceKillTimer === null) {
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKillTimer.unref();
    }
  };
  const append = (
    current: Buffer<ArrayBufferLike>,
    chunk: Buffer<ArrayBufferLike>
  ): Buffer<ArrayBufferLike> => {
    const remaining = maximumProcessOutputBytes - current.length;
    if (chunk.length > remaining) {
      outputExceeded = true;
      terminate();
      return remaining > 0
        ? Buffer.concat([current, chunk.subarray(0, remaining)])
        : current;
    }
    return Buffer.concat([current, chunk]);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      spawnError = error.message;
      resolve(null);
    });
    child.once("close", resolve);
  }).finally(() => {
    clearTimeout(timeout);
    if (forceKillTimer !== null) clearTimeout(forceKillTimer);
  });
  return {
    processId,
    exitCode,
    durationMs: Number((performance.now() - startedAt).toFixed(6)),
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    timedOut,
    outputExceeded,
    spawnError,
  };
}

function expectedReaderName(reader: AgentReaderName): string {
  return reader === "fixture"
    ? "fixture-evidence-reader"
    : "openai-responses-reader";
}

function expectedJudgeName(judge: AgentJudgeName): string {
  return judge === "fixture" ? "fixture-judge" : "longmemeval-openai-judge";
}

export function agentEvaluationFingerprint(
  report: AgentBenchmarkReport
): string {
  return sha256(
    canonicalJson({
      datasetArtifactSha256: report.run.dataset.artifactSha256,
      topK: report.run.topK,
      maxScenarios: report.run.maxScenarios,
      reader: report.run.components.reader,
      judge: report.run.components.judge,
    })
  );
}

function reportInvariantError(
  report: AgentBenchmarkReport,
  adapter: AgentAdapterName,
  options: AgentComparisonOptions,
  dataset: Awaited<ReturnType<typeof openAgentDataset>>
): string | null {
  const expectedDataset = {
    name: dataset.metadata.name,
    version: dataset.metadata.version,
    license: dataset.metadata.license,
    track: dataset.metadata.track,
    language: dataset.metadata.language,
    subset: dataset.metadata.source.subset,
    sourceRevision: dataset.metadata.source.revision,
    sourceSha256: dataset.metadata.source.sha256,
    artifactSha256: dataset.artifactSha256,
    artifactBytes: dataset.artifactBytes,
    readPasses: dataset.readPasses,
  };
  if (canonicalJson(report.run.dataset) !== canonicalJson(expectedDataset)) {
    return "agent report dataset identity differs from the comparison input";
  }
  if (report.run.topK !== options.topK) {
    return "agent report topK differs from the comparison configuration";
  }
  if (report.run.maxScenarios !== (options.maxScenarios ?? null)) {
    return "agent report maxScenarios differs from the comparison configuration";
  }
  if (report.run.components.adapter.name !== adapter) {
    return `agent report adapter is ${report.run.components.adapter.name}, expected ${adapter}`;
  }
  if (
    report.run.components.reader.name !== expectedReaderName(options.reader)
  ) {
    return "agent report reader differs from the comparison configuration";
  }
  if (report.run.components.judge.name !== expectedJudgeName(options.judge)) {
    return "agent report judge differs from the comparison configuration";
  }
  if (
    options.reader === "openai" &&
    report.run.components.reader.config.model !== options.readerModel
  ) {
    return "agent report reader model differs from the comparison configuration";
  }
  if (
    options.judge === "openai" &&
    report.run.components.judge.config.model !== options.judgeModel
  ) {
    return "agent report judge model differs from the comparison configuration";
  }
  return null;
}

function failedRun(
  adapter: AgentAdapterName,
  process: ProcessResult,
  reportFile: string | null,
  reportSha256: string | null,
  error: string
): AgentComparisonRun {
  return {
    adapter,
    status: "failed",
    processId: process.processId,
    exitCode: process.exitCode,
    durationMs: process.durationMs,
    reportStatus: null,
    reportFile,
    reportSha256,
    evaluationSha256: null,
    resultClass: null,
    runtimeFailures: null,
    metrics: null,
    components: null,
    telemetry: null,
    error: redact(error),
  };
}

async function runAdapter(
  adapter: AgentAdapterName,
  options: AgentComparisonOptions,
  comparisonId: string,
  dataset: Awaited<ReturnType<typeof openAgentDataset>>
): Promise<AgentComparisonRun> {
  const reportName = `${comparisonId}-${adapter}-agent-report.json`;
  const reportPath = path.join(options.outputDir, reportName);
  const childArgs = [
    "--import",
    "tsx",
    agentCli,
    `--adapter=${adapter}`,
    `--reader=${options.reader}`,
    `--judge=${options.judge}`,
    `--dataset=${options.dataset}`,
    `--top-k=${options.topK}`,
    `--output=${reportPath}`,
    `--run-id=${comparisonId}-${adapter}`,
    ...(options.reader === "openai"
      ? [`--reader-model=${options.readerModel}`]
      : []),
    ...(options.judge === "openai"
      ? [`--judge-model=${options.judgeModel}`]
      : []),
    ...(options.maxScenarios === undefined
      ? []
      : [`--max-scenarios=${options.maxScenarios}`]),
  ];
  const process = await runChildProcess(
    childArgs,
    options.adapterTimeoutMs
  );
  if (!fs.existsSync(reportPath)) {
    const reason = process.timedOut
      ? `adapter exceeded ${options.adapterTimeoutMs}ms timeout`
      : process.outputExceeded
        ? `adapter exceeded the ${maximumProcessOutputBytes} byte process-output limit`
        : process.spawnError ||
          process.stderr.trim() ||
          process.stdout.trim() ||
          `adapter process exited with code ${process.exitCode}`;
    return failedRun(adapter, process, null, null, reason);
  }

  const reportBytes = fs.readFileSync(reportPath);
  const reportHash = sha256(reportBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportBytes.toString("utf8"));
  } catch {
    return failedRun(
      adapter,
      process,
      reportName,
      reportHash,
      "adapter wrote an invalid JSON report"
    );
  }
  const validationError = artifactValidationError(
    agentReportValidator,
    parsed
  );
  if (validationError !== null) {
    return failedRun(
      adapter,
      process,
      reportName,
      reportHash,
      `adapter report failed schema validation: ${validationError}`
    );
  }
  const report = parsed as AgentBenchmarkReport;
  const invariantError = reportInvariantError(
    report,
    adapter,
    options,
    dataset
  );
  const evaluationSha256 = agentEvaluationFingerprint(report);
  const reportFailure =
    report.failures[0] === undefined
      ? null
      : `${report.failures[0].stage}/${report.failures[0].component}: ${report.failures[0].message}`;
  const completed =
    invariantError === null &&
    report.run.status === "completed" &&
    process.exitCode === 0 &&
    !process.timedOut &&
    !process.outputExceeded &&
    process.spawnError === null;
  return {
    adapter,
    status: completed ? "completed" : "failed",
    processId: process.processId,
    exitCode: process.exitCode,
    durationMs: process.durationMs,
    reportStatus: report.run.status,
    reportFile: reportName,
    reportSha256: reportHash,
    evaluationSha256,
    resultClass: report.run.resultClass,
    runtimeFailures: report.metrics.runtimeFailures,
    metrics: report.metrics,
    components: report.run.components,
    telemetry: report.run.telemetry,
    error: completed
      ? null
      : redact(
          invariantError ??
            reportFailure ??
            (process.timedOut
              ? `adapter exceeded ${options.adapterTimeoutMs}ms timeout`
              : process.outputExceeded
                ? `adapter exceeded the ${maximumProcessOutputBytes} byte process-output limit`
                : process.spawnError ??
                  `agent report status was ${report.run.status} with process exit ${process.exitCode}`)
        ),
  };
}

function weakestResultClass(
  options: AgentComparisonOptions,
  runs: AgentComparisonRun[]
): AgentResultClass {
  const requestedClass: AgentResultClass =
    options.reader === "fixture" ||
    options.judge === "fixture" ||
    options.adapters.includes("literal")
      ? "harness"
      : "candidate";
  const classes = [
    requestedClass,
    ...runs
      .map((run) => run.resultClass)
      .filter((value): value is AgentResultClass => value !== null),
  ];
  const rank: Record<AgentResultClass, number> = {
    harness: 0,
    candidate: 1,
    benchmark: 2,
  };
  return classes.reduce((weakest, current) =>
    rank[current] < rank[weakest] ? current : weakest
  );
}

function comparisonClaim(
  options: AgentComparisonOptions,
  runs: AgentComparisonRun[],
  configurationSha256: string | null
): AgentComparisonManifest["claim"] {
  const completed = runs.every((run) => run.status === "completed");
  const fingerprints = new Set(
    runs
      .map((run) => run.evaluationSha256)
      .filter((value): value is string => value !== null)
  );
  const comparable =
    completed &&
    configurationSha256 !== null &&
    fingerprints.size === 1 &&
    fingerprints.has(configurationSha256);
  const resultClass = weakestResultClass(options, runs);
  const publicationEligible =
    comparable && resultClass === "benchmark";
  const blockers: string[] = [];
  if (!comparable) {
    blockers.push(
      "one or more adapter runs failed or did not share one evaluation fingerprint"
    );
  }
  if (resultClass === "harness") {
    blockers.push(
      "harness components are contract evidence only and cannot support publication claims"
    );
  } else if (resultClass === "candidate") {
    blockers.push(
      "candidate components require live provider qualification and official evaluator cross-validation"
    );
  }
  return {
    resultClass,
    comparable,
    publicationEligible,
    blockers,
  };
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

export async function runAgentComparison(
  options: AgentComparisonOptions
): Promise<AgentComparisonArtifact> {
  validateOptions(options);
  const dataset = await openAgentDataset(options.dataset);
  fs.mkdirSync(options.outputDir, { recursive: true });
  const comparisonId = randomUUID();
  const runs: AgentComparisonRun[] = [];
  for (const adapter of options.adapters) {
    runs.push(await runAdapter(adapter, options, comparisonId, dataset));
  }
  const configurationSha256 =
    runs.find((run) => run.evaluationSha256 !== null)?.evaluationSha256 ??
    null;
  for (const run of runs) {
    if (
      run.status === "completed" &&
      run.evaluationSha256 !== configurationSha256
    ) {
      run.status = "failed";
      run.error =
        "agent report reader/judge evaluation fingerprint differs from the comparison baseline";
    }
  }
  const cpus = os.cpus();
  const dirtyOutput = gitValue(["status", "--porcelain"]);
  const manifest: AgentComparisonManifest = {
    schemaVersion: 1,
    kind: "memory-bench-agent-comparison",
    comparisonId,
    createdAt: new Date().toISOString(),
    dataset: {
      name: dataset.metadata.name,
      version: dataset.metadata.version,
      license: dataset.metadata.license,
      track: dataset.metadata.track,
      language: dataset.metadata.language,
      subset: dataset.metadata.source.subset,
      sourceRevision: dataset.metadata.source.revision,
      sourceSha256: dataset.metadata.source.sha256,
      artifactFile: path.relative(repositoryRoot, options.dataset),
      artifactSha256: dataset.artifactSha256,
      artifactBytes: dataset.artifactBytes,
    },
    source: {
      gitCommit: gitValue(["rev-parse", "HEAD"]),
      gitDirty: dirtyOutput === null ? null : dirtyOutput.length > 0,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpuModel: cpus[0]?.model ?? null,
      logicalCpuCount: cpus.length,
      totalMemoryBytes: os.totalmem(),
    },
    evaluation: {
      reader: options.reader,
      readerModel:
        options.reader === "openai" ? options.readerModel : null,
      judge: options.judge,
      judgeModel: options.judge === "openai" ? options.judgeModel : null,
      topK: options.topK,
      maxScenarios: options.maxScenarios ?? null,
      configurationSha256,
    },
    policy: {
      processIsolation: "one-process-per-adapter",
      executionOrder: "sequential",
      runtimeFailureAffectsCommandExit: true,
      qaFailureAffectsCommandExit: false,
    },
    claim: comparisonClaim(options, runs, configurationSha256),
    runs,
  };
  const manifestName = `${comparisonId}-agent-manifest.json`;
  const manifestPath = path.join(options.outputDir, manifestName);
  const manifestValidationError = artifactValidationError(
    agentComparisonValidator,
    manifest
  );
  if (manifestValidationError !== null) {
    throw new Error(
      `generated agent comparison manifest failed schema validation: ${manifestValidationError}`
    );
  }
  await writeExclusiveAtomic(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return {
    manifest,
    manifestPath,
  };
}
