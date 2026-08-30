import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runAgentComparison,
  type AgentComparisonOptions,
} from "./agent-comparison.js";
import { officialLongMemEvalJudgeModel } from "./agent-openai.js";
import {
  agentAdapterNames,
  type AgentAdapterName,
  type AgentComparisonManifest,
  type AgentJudgeName,
  type AgentReaderName,
} from "./agent-types.js";

interface CliOptions extends AgentComparisonOptions {
  json: boolean;
}

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const supportedAdapters = new Set<AgentAdapterName>(agentAdapterNames);

function help(): string {
  return [
    "Memory Bench — agent-memory comparison",
    "",
    "Usage:",
    "  npm run bench:memory:agent:compare -- --dataset=<normalized.json> [options]",
    "",
    "Options:",
    "  --dataset=<path>              Normalized agent dataset (required)",
    "  --adapters=<a,b>              At least two of literal,mnema,mem0,letta,zep",
    "  --reader=<fixture|openai>     Shared answer generator (default: fixture)",
    "  --judge=<fixture|openai>      Shared QA judge (default: fixture)",
    `  --reader-model=<id>           Shared OpenAI reader model (default: ${officialLongMemEvalJudgeModel})`,
    `  --judge-model=<id>            Shared OpenAI judge model (default: ${officialLongMemEvalJudgeModel})`,
    "  --top-k=<integer>             Shared retrieval limit, 1-100 (default: 5)",
    "  --max-scenarios=<integer>     Optional identical scenario bound",
    "  --adapter-timeout-ms=<n>      Per-process timeout (default: 1800000)",
    "  --output-dir=<path>           Reports and manifest directory",
    "  --json                        Print the complete manifest",
    "  --help                        Show this help",
    "",
    "Each adapter runs sequentially in a separate process with the same dataset,",
    "reader, judge, top-k, and scenario bound. Fixture components are harness-only.",
  ].join("\n");
}

function integerValue(
  value: string,
  label: string,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}`
    );
  }
  return parsed;
}

function selectedValue<T extends string>(
  value: string | undefined,
  fallback: T,
  allowed: readonly T[],
  label: string
): T {
  const selected = value ?? fallback;
  if (!allowed.includes(selected as T)) {
    throw new Error(`${label} must be ${allowed.join(" or ")}`);
  }
  return selected as T;
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes("--help")) {
    console.log(help());
    process.exit(0);
  }
  const valueNames = [
    "dataset",
    "adapters",
    "reader",
    "reader-model",
    "judge",
    "judge-model",
    "top-k",
    "max-scenarios",
    "adapter-timeout-ms",
    "output-dir",
  ] as const;
  for (const arg of args) {
    if (arg === "--json") continue;
    if (!valueNames.some((name) => arg.startsWith(`--${name}=`))) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  const value = (name: (typeof valueNames)[number]): string | undefined => {
    const prefix = `--${name}=`;
    const matches = args.filter((arg) => arg.startsWith(prefix));
    if (matches.length > 1) {
      throw new Error(`--${name} was provided more than once`);
    }
    const result = matches[0]?.slice(prefix.length);
    if (result === "") throw new Error(`--${name} requires a value`);
    return result;
  };
  const dataset = value("dataset");
  if (dataset === undefined) throw new Error("--dataset is required");
  const requestedAdapters = (value("adapters") ?? "literal,mnema")
    .split(",")
    .map((adapter) => adapter.trim())
    .filter(Boolean);
  if (requestedAdapters.length < 2) {
    throw new Error("--adapters requires at least two adapters");
  }
  if (new Set(requestedAdapters).size !== requestedAdapters.length) {
    throw new Error("--adapters must not contain duplicates");
  }
  for (const adapter of requestedAdapters) {
    if (!supportedAdapters.has(adapter as AgentAdapterName)) {
      throw new Error(`unsupported adapter: ${adapter}`);
    }
  }
  const reader = selectedValue<AgentReaderName>(
    value("reader"),
    "fixture",
    ["fixture", "openai"],
    "--reader"
  );
  const judge = selectedValue<AgentJudgeName>(
    value("judge"),
    "fixture",
    ["fixture", "openai"],
    "--judge"
  );
  const topKRaw = value("top-k");
  const maximumScenariosRaw = value("max-scenarios");
  const timeoutRaw = value("adapter-timeout-ms");
  return {
    adapters: requestedAdapters as AgentAdapterName[],
    reader,
    readerModel:
      value("reader-model") ??
      process.env.MEMORY_BENCH_AGENT_READER_MODEL ??
      officialLongMemEvalJudgeModel,
    judge,
    judgeModel:
      value("judge-model") ??
      process.env.MEMORY_BENCH_AGENT_JUDGE_MODEL ??
      officialLongMemEvalJudgeModel,
    dataset: path.resolve(dataset),
    outputDir: path.resolve(
      value("output-dir") ??
        path.join(repositoryRoot, "artifacts", "memory-bench", "agent")
    ),
    topK:
      topKRaw === undefined
        ? 5
        : integerValue(topKRaw, "--top-k", 1, 100),
    ...(maximumScenariosRaw === undefined
      ? {}
      : {
          maxScenarios: integerValue(
            maximumScenariosRaw,
            "--max-scenarios",
            1,
            Number.MAX_SAFE_INTEGER
          ),
        }),
    adapterTimeoutMs:
      timeoutRaw === undefined
        ? 30 * 60 * 1_000
        : integerValue(
            timeoutRaw,
            "--adapter-timeout-ms",
            1_000,
            24 * 60 * 60 * 1_000
          ),
    json: args.includes("--json"),
  };
}

function summary(
  manifest: AgentComparisonManifest,
  manifestFile: string
): string {
  const metric = (value: number | null | undefined): string =>
    value === null || value === undefined ? "-" : value.toFixed(3);
  const lines = [
    `Memory Bench agent comparison — ${manifest.dataset.subset}`,
    `Manifest: ${manifestFile}`,
    `Claim: ${manifest.claim.resultClass}; comparable=${manifest.claim.comparable}; publication=${manifest.claim.publicationEligible}`,
    "",
    "adapter\tstatus\tscenarios\truntime_failures\tqa\trecall@k\tcleanup",
  ];
  for (const run of manifest.runs) {
    lines.push(
      [
        run.adapter,
        run.status,
        run.metrics?.scenarios ?? "-",
        run.runtimeFailures ?? "-",
        metric(run.metrics?.qaAccuracy),
        metric(run.metrics?.macroRecallAtK),
        metric(run.metrics?.cleanupVerificationRate),
      ].join("\t")
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { json, ...comparisonOptions } = options;
  const artifact = await runAgentComparison(comparisonOptions);
  console.log(
    json
      ? JSON.stringify(artifact.manifest, null, 2)
      : summary(artifact.manifest, artifact.manifestPath)
  );
  if (artifact.manifest.runs.some((run) => run.status === "failed")) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    `Memory Bench agent comparison failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
});
