import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapter } from "./adapters/index.js";
import { loadDataset } from "./dataset.js";
import { runBenchmark } from "./runner.js";
import type { BenchmarkReport } from "./types.js";

interface CliOptions {
  adapter: string;
  dataset: string;
  output?: string;
  runId?: string;
  json: boolean;
}

const defaultDataset = fileURLToPath(new URL("../datasets/core-smoke-v1.json", import.meta.url));

function help(): string {
  return [
    "Memory Bench",
    "",
    "Usage:",
    "  npm run bench:memory -- [options]",
    "",
    "Options:",
    "  --adapter=<literal|mnema|mem0|letta|zep>  Adapter to run (default: literal)",
    "  --dataset=<path>           Dataset JSON file",
    "  --output=<path>            Write the complete JSON report",
    "  --run-id=<id>              Reuse an externally assigned run identifier",
    "  --json                     Print the complete JSON report",
    "  --help                     Show this help",
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes("--help")) {
    console.log(help());
    process.exit(0);
  }
  const value = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  };
  const known = new Set(["--json", "--help"]);
  for (const arg of args) {
    if (known.has(arg)) continue;
    if (!["--adapter=", "--dataset=", "--output=", "--run-id="].some((prefix) => arg.startsWith(prefix))) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return {
    adapter: value("adapter") ?? "literal",
    dataset: path.resolve(value("dataset") ?? defaultDataset),
    ...(value("output") ? { output: path.resolve(value("output")!) } : {}),
    ...(value("run-id") ? { runId: value("run-id") } : {}),
    json: args.includes("--json"),
  };
}

function summary(report: BenchmarkReport): string {
  const metric = (value: number | null): string => (value === null ? "n/a" : value.toFixed(3));
  return [
    `Memory Bench — ${report.run.dataset.name}@${report.run.dataset.version}`,
    `Adapter: ${report.run.adapter.name} (${report.run.adapter.mode})`,
    `Queries: ${report.metrics.queries}`,
    `Pass rate: ${metric(report.metrics.queryPassRate)}`,
    `Recall@k: ${metric(report.metrics.macroRecallAtK)}`,
    `Precision@k: ${metric(report.metrics.macroPrecisionAtK)}`,
    `MRR: ${metric(report.metrics.meanReciprocalRank)}`,
    `Forbidden-hit rate: ${metric(report.metrics.forbiddenHitRate)}`,
    `Abstention accuracy: ${metric(report.metrics.abstentionAccuracy)}`,
    `Query latency p50/p95: ${report.metrics.queryLatency.p50Ms.toFixed(3)} / ${report.metrics.queryLatency.p95Ms.toFixed(3)} ms`,
    `Provider requests/retries: ${report.run.adapterTelemetry.requestCount} / ${report.run.adapterTelemetry.retryCount}`,
    `Provider cost: ${
      report.run.adapterTelemetry.providerCostUsd === null
        ? report.run.adapterTelemetry.costSource
        : `$${report.run.adapterTelemetry.providerCostUsd.toFixed(6)}`
    }`,
    `Cleanup verified: ${report.run.adapterTelemetry.cleanup.verified ? "yes" : "no"}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dataset = loadDataset(options.dataset);
  const report = await runBenchmark(dataset, createAdapter(options.adapter), options.runId);
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(options.json ? JSON.stringify(report, null, 2) : summary(report));
  if (report.metrics.queryPassRate < 1) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Memory Bench failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
