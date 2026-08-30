import { randomUUID, createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDataset } from "./dataset.js";
import type {
  BenchmarkAdapterName,
  BenchmarkReport,
  ComparisonManifest,
  ComparisonRun,
} from "./types.js";

type AdapterName = BenchmarkAdapterName;

interface ComparisonOptions {
  adapters: AdapterName[];
  dataset: string;
  outputDir: string;
  adapterTimeoutMs: number;
  json: boolean;
}

const supportedAdapters = new Set<AdapterName>([
  "literal",
  "mnema",
  "mem0",
  "letta",
  "zep",
]);
const defaultDataset = fileURLToPath(
  new URL("../datasets/core-smoke-v1.json", import.meta.url)
);
const benchmarkCli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function numberValue(value: string, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function parseArgs(args: string[]): ComparisonOptions {
  let adapters: AdapterName[] = ["literal", "mnema"];
  let dataset = defaultDataset;
  let outputDir = path.join(repositoryRoot, "artifacts", "memory-bench");
  let adapterTimeoutMs = 30 * 60 * 1_000;
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--adapters=")) {
      const requested = arg
        .slice("--adapters=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (requested.length === 0) throw new Error("--adapters requires at least one adapter");
      if (new Set(requested).size !== requested.length) {
        throw new Error("--adapters must not contain duplicates");
      }
      for (const adapter of requested) {
        if (!supportedAdapters.has(adapter as AdapterName)) {
          throw new Error(`unsupported adapter: ${adapter}`);
        }
      }
      adapters = requested as AdapterName[];
      continue;
    }
    if (arg.startsWith("--dataset=")) {
      const value = arg.slice("--dataset=".length);
      if (!value) throw new Error("--dataset requires a path");
      dataset = path.resolve(value);
      continue;
    }
    if (arg.startsWith("--output-dir=")) {
      const value = arg.slice("--output-dir=".length);
      if (!value) throw new Error("--output-dir requires a path");
      outputDir = path.resolve(value);
      continue;
    }
    if (arg.startsWith("--adapter-timeout-ms=")) {
      adapterTimeoutMs = numberValue(
        arg.slice("--adapter-timeout-ms=".length),
        "--adapter-timeout-ms",
        1_000,
        24 * 60 * 60 * 1_000
      );
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { adapters, dataset, outputDir, adapterTimeoutMs, json };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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
  for (const key of [
    "MEM0_API_KEY",
    "LETTA_API_KEY",
    "ZEP_API_KEY",
    "MEMORY_BENCH_LETTA_PROJECT_ID",
  ]) {
    const secret = process.env[key];
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted.slice(0, 2_000);
}

async function runAdapter(
  adapter: AdapterName,
  options: ComparisonOptions,
  comparisonId: string
): Promise<ComparisonRun> {
  const reportName = `${comparisonId}-${adapter}.json`;
  const reportPath = path.join(options.outputDir, reportName);
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      benchmarkCli,
      `--adapter=${adapter}`,
      `--dataset=${options.dataset}`,
      `--output=${reportPath}`,
      `--run-id=${comparisonId}-${adapter}`,
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let outputExceeded = false;
  const spawnState: { errorMessage: string | null } = { errorMessage: null };
  let forceKillTimer: NodeJS.Timeout | null = null;
  const maximumOutputBytes = 1_000_000;
  const terminate = (): void => {
    child.kill("SIGTERM");
    if (forceKillTimer === null) {
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKillTimer.unref();
    }
  };
  const append = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString("utf8");
    if (Buffer.byteLength(next) > maximumOutputBytes) {
      outputExceeded = true;
      terminate();
      return next.slice(0, maximumOutputBytes);
    }
    return next;
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
  }, options.adapterTimeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      spawnState.errorMessage = error.message;
      resolve(null);
    });
    child.once("close", resolve);
  }).finally(() => {
    clearTimeout(timeout);
    if (forceKillTimer !== null) clearTimeout(forceKillTimer);
  });
  const durationMs = Number((performance.now() - startedAt).toFixed(6));

  if (fs.existsSync(reportPath)) {
    const reportBytes = fs.readFileSync(reportPath);
    let report: BenchmarkReport;
    try {
      report = JSON.parse(reportBytes.toString("utf8")) as BenchmarkReport;
    } catch {
      return {
        adapter,
        status: "failed",
        exitCode,
        durationMs,
        reportFile: reportName,
        reportSha256: sha256(reportBytes),
        queryFailures: null,
        metrics: null,
        adapterInfo: null,
        adapterTelemetry: null,
        error: "adapter wrote an invalid JSON report",
      };
    }
    const queryFailures = report.queries.filter((query) => !query.passed).length;
    return {
      adapter,
      status: "completed",
      exitCode,
      durationMs,
      reportFile: reportName,
      reportSha256: sha256(reportBytes),
      queryFailures,
      metrics: report.metrics,
      adapterInfo: report.run.adapter,
      adapterTelemetry: report.run.adapterTelemetry,
      error: null,
    };
  }

  const reason = timedOut
    ? `adapter exceeded ${options.adapterTimeoutMs}ms timeout`
    : outputExceeded
      ? "adapter exceeded the 1MB process-output limit"
      : spawnState.errorMessage ||
        stderr.trim() ||
        stdout.trim() ||
        `adapter process exited with code ${exitCode}`;
  return {
    adapter,
    status: "failed",
    exitCode,
    durationMs,
    reportFile: null,
    reportSha256: null,
    queryFailures: null,
    metrics: null,
    adapterInfo: null,
    adapterTelemetry: null,
    error: redact(reason),
  };
}

function summary(manifest: ComparisonManifest, manifestFile: string): string {
  const lines = [
    `Memory Bench comparison — ${manifest.dataset.name}@${manifest.dataset.version}`,
    `Manifest: ${manifestFile}`,
    "",
    "adapter\tstatus\tqueries\tfailures\tpass_rate\tp95_ms\tcleanup",
  ];
  for (const run of manifest.runs) {
    lines.push(
      [
        run.adapter,
        run.status,
        run.metrics?.queries ?? "-",
        run.queryFailures ?? "-",
        run.metrics?.queryPassRate.toFixed(3) ?? "-",
        run.metrics?.queryLatency.p95Ms.toFixed(3) ?? "-",
        run.adapterTelemetry?.cleanup.verified === true
          ? "verified"
          : run.adapterTelemetry?.cleanup.verified === false
            ? "unverified"
            : "-",
      ].join("\t")
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const datasetBytes = fs.readFileSync(options.dataset);
  const dataset = loadDataset(options.dataset);
  const comparisonId = randomUUID();
  fs.mkdirSync(options.outputDir, { recursive: true });
  const runs: ComparisonRun[] = [];
  for (const adapter of options.adapters) {
    runs.push(await runAdapter(adapter, options, comparisonId));
  }
  const cpus = os.cpus();
  const dirtyOutput = gitValue(["status", "--porcelain"]);
  const manifest: ComparisonManifest = {
    schemaVersion: 1,
    comparisonId,
    createdAt: new Date().toISOString(),
    dataset: {
      name: dataset.name,
      version: dataset.version,
      license: dataset.license,
      publicationStatus: dataset.publicationStatus,
      file: path.relative(repositoryRoot, options.dataset),
      sha256: sha256(datasetBytes),
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
    policy: {
      processIsolation: "one-process-per-adapter",
      runtimeFailureAffectsCommandExit: true,
      queryFailureAffectsCommandExit: false,
    },
    runs,
  };
  const manifestName = `${comparisonId}-manifest.json`;
  const manifestPath = path.join(options.outputDir, manifestName);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(options.json ? JSON.stringify(manifest, null, 2) : summary(manifest, manifestPath));
  if (runs.some((run) => run.status === "failed")) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(
    `Memory Bench comparison failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
});
