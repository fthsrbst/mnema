import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  FixtureEvidenceReader,
  FixtureJudge,
  LiteralAgentMemoryAdapter,
} from "./agent-components.js";
import { openAgentDataset } from "./agent-dataset.js";
import { MnemaAgentMemoryAdapter } from "./agent-mnema.js";
import {
  LongMemEvalOpenAIJudge,
  OpenAIResponsesReader,
  officialLongMemEvalJudgeModel,
  type OpenAIComponentOptions,
} from "./agent-openai.js";
import {
  LettaAgentMemoryAdapter,
  Mem0AgentMemoryAdapter,
  ZepAgentMemoryAdapter,
} from "./agent-providers.js";
import { runAgentBenchmark } from "./agent-runner.js";
import type {
  AgentBenchmarkReport,
  AgentMemoryAdapter,
  AgentMemoryJudge,
  AgentMemoryReader,
} from "./agent-types.js";

interface CliOptions {
  adapter: "literal" | "mnema" | "mem0" | "letta" | "zep";
  reader: "fixture" | "openai";
  judge: "fixture" | "openai";
  readerModel: string;
  judgeModel: string;
  dataset: string;
  output?: string;
  hypothesesOutput?: string;
  topK: number;
  maxScenarios?: number;
  runId?: string;
  json: boolean;
}

function help(): string {
  return [
    "Memory Bench — agent-memory track",
    "",
    "Usage:",
    "  npm run bench:memory:agent -- --dataset=<normalized.json> [options]",
    "",
    "Options:",
    "  --dataset=<path>              Normalized agent dataset (required)",
    "  --adapter=<name>              literal, mnema, mem0, letta, or zep",
    "  --reader=<fixture|openai>     Answer generator (default: fixture)",
    "  --judge=<fixture|openai>      QA judge (default: fixture)",
    `  --reader-model=<id>           OpenAI reader model (default: ${officialLongMemEvalJudgeModel})`,
    `  --judge-model=<id>            OpenAI judge model (default: ${officialLongMemEvalJudgeModel})`,
    "  --top-k=<integer>             Retrieved context limit (default: 5)",
    "  --max-scenarios=<integer>     Optional bounded run",
    "  --run-id=<id>                 Reuse an assigned run identifier",
    "  --output=<path>               Write the JSON report without overwriting",
    "  --hypotheses-output=<path>    Write LongMemEval-compatible JSONL",
    "  --json                        Print the complete report",
    "  --help                        Show this help",
    "",
    "Literal and fixture components are harness evidence only.",
    "OpenAI model components remain candidate-class until live qualification.",
  ].join("\n");
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function selectedValue<T extends string>(
  value: string | undefined,
  fallback: T,
  allowed: readonly T[],
  name: string
): T {
  const result = value ?? fallback;
  if (!allowed.includes(result as T)) {
    throw new Error(`--${name} must be ${allowed.join(" or ")}`);
  }
  return result as T;
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes("--help")) {
    console.log(help());
    process.exit(0);
  }
  const allowedFlags = new Set(["--json"]);
  const allowedValues = [
    "adapter",
    "reader",
    "judge",
    "reader-model",
    "judge-model",
    "dataset",
    "output",
    "hypotheses-output",
    "top-k",
    "max-scenarios",
    "run-id",
  ];
  for (const arg of args) {
    if (allowedFlags.has(arg)) continue;
    if (!allowedValues.some((name) => arg.startsWith(`--${name}=`))) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  const value = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const matches = args.filter((arg) => arg.startsWith(prefix));
    if (matches.length > 1) throw new Error(`--${name} was provided more than once`);
    const result = matches[0]?.slice(prefix.length);
    if (result === "") throw new Error(`--${name} requires a value`);
    return result;
  };
  const dataset = value("dataset");
  if (dataset === undefined) throw new Error("--dataset is required");
  const topKValue = value("top-k");
  const maxScenariosValue = value("max-scenarios");
  const output = value("output");
  const hypothesesOutput = value("hypotheses-output");
  const runId = value("run-id");
  return {
    adapter: selectedValue(
      value("adapter"),
      "literal",
      ["literal", "mnema", "mem0", "letta", "zep"],
      "adapter"
    ),
    reader: selectedValue(
      value("reader"),
      "fixture",
      ["fixture", "openai"],
      "reader"
    ),
    judge: selectedValue(
      value("judge"),
      "fixture",
      ["fixture", "openai"],
      "judge"
    ),
    readerModel:
      value("reader-model") ??
      process.env.MEMORY_BENCH_AGENT_READER_MODEL ??
      officialLongMemEvalJudgeModel,
    judgeModel:
      value("judge-model") ??
      process.env.MEMORY_BENCH_AGENT_JUDGE_MODEL ??
      officialLongMemEvalJudgeModel,
    dataset: path.resolve(dataset),
    ...(output === undefined ? {} : { output: path.resolve(output) }),
    ...(hypothesesOutput === undefined
      ? {}
      : { hypothesesOutput: path.resolve(hypothesesOutput) }),
    topK:
      topKValue === undefined ? 5 : positiveInteger(topKValue, "top-k"),
    ...(maxScenariosValue === undefined
      ? {}
      : {
          maxScenarios: positiveInteger(
            maxScenariosValue,
            "max-scenarios"
          ),
        }),
    ...(runId === undefined ? {} : { runId }),
    json: args.includes("--json"),
  };
}

function environmentInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}`
    );
  }
  return value;
}

function openAIOptions(model: string): OpenAIComponentOptions {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error(
      "OPENAI_API_KEY is required for the OpenAI reader or judge"
    );
  }
  const baseUrl = process.env.MEMORY_BENCH_OPENAI_BASE_URL?.trim();
  const organization = process.env.OPENAI_ORGANIZATION?.trim();
  return {
    apiKey,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(organization ? { organization } : {}),
    timeoutMs: environmentInteger(
      "MEMORY_BENCH_OPENAI_TIMEOUT_MS",
      60_000,
      1,
      600_000
    ),
    maxRetries: environmentInteger(
      "MEMORY_BENCH_OPENAI_MAX_RETRIES",
      2,
      0,
      10
    ),
    retryBaseDelayMs: environmentInteger(
      "MEMORY_BENCH_OPENAI_RETRY_BASE_DELAY_MS",
      500,
      0,
      60_000
    ),
    maxResponseBytes: environmentInteger(
      "MEMORY_BENCH_OPENAI_MAX_RESPONSE_BYTES",
      10 * 1024 * 1024,
      1,
      100 * 1024 * 1024
    ),
  };
}

function createReader(options: CliOptions): AgentMemoryReader {
  if (options.reader === "fixture") return new FixtureEvidenceReader();
  return new OpenAIResponsesReader({
    ...openAIOptions(options.readerModel),
    maxOutputTokens: environmentInteger(
      "MEMORY_BENCH_AGENT_READER_MAX_OUTPUT_TOKENS",
      800,
      1,
      100_000
    ),
  });
}

function createAdapter(options: CliOptions): AgentMemoryAdapter {
  switch (options.adapter) {
    case "literal":
      return new LiteralAgentMemoryAdapter();
    case "mnema":
      return new MnemaAgentMemoryAdapter();
    case "mem0":
      return new Mem0AgentMemoryAdapter();
    case "letta":
      return new LettaAgentMemoryAdapter();
    case "zep":
      return new ZepAgentMemoryAdapter();
  }
}

function createJudge(options: CliOptions): AgentMemoryJudge {
  if (options.judge === "fixture") return new FixtureJudge();
  return new LongMemEvalOpenAIJudge(
    openAIOptions(options.judgeModel)
  );
}

async function writeOutputsAtomic(
  outputs: Array<{ file: string; content: string }>
): Promise<void> {
  const uniqueFiles = new Set(outputs.map((output) => output.file));
  if (uniqueFiles.size !== outputs.length) {
    throw new Error("output paths must be different");
  }
  const artifacts = outputs.map((output) => ({
    ...output,
    temporary: path.join(
      path.dirname(output.file),
      `.${path.basename(output.file)}.${process.pid}.${randomUUID()}.tmp`
    ),
  }));
  const linked: string[] = [];
  try {
    for (const artifact of artifacts) {
      await fs.promises.mkdir(path.dirname(artifact.file), {
        recursive: true,
      });
      if (fs.existsSync(artifact.file)) {
        throw new Error(`output already exists: ${artifact.file}`);
      }
      await fs.promises.writeFile(artifact.temporary, artifact.content, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    for (const artifact of artifacts) {
      await fs.promises.link(artifact.temporary, artifact.file);
      linked.push(artifact.file);
    }
  } catch (error) {
    await Promise.all(
      linked.map((file) => fs.promises.rm(file, { force: true }))
    );
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new Error("an output was created by another process");
    }
    throw error;
  } finally {
    await Promise.all(
      artifacts.map((artifact) =>
        fs.promises.rm(artifact.temporary, { force: true })
      )
    );
  }
}

function hypothesesJsonl(report: AgentBenchmarkReport): string {
  const lines = report.scenarios
    .filter(
      (scenario): scenario is typeof scenario & { hypothesis: string } =>
        scenario.hypothesis !== null
    )
    .map((scenario) =>
      JSON.stringify({
        question_id: scenario.scenarioId,
        hypothesis: scenario.hypothesis,
      })
    );
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function summary(report: AgentBenchmarkReport): string {
  const metric = (value: number | null): string =>
    value === null ? "n/a" : value.toFixed(3);
  return [
    `Memory Bench agent — ${report.run.dataset.subset}`,
    `Status/result class: ${report.run.status} / ${report.run.resultClass}`,
    `Components: ${report.run.components.adapter.name} / ${report.run.components.reader.name} / ${report.run.components.judge.name}`,
    `Scenarios: ${report.metrics.scenarios} (${report.metrics.failed} runtime failures)`,
    `QA accuracy: ${metric(report.metrics.qaAccuracy)}`,
    `Retrieval recall@k / MRR: ${metric(report.metrics.macroRecallAtK)} / ${metric(report.metrics.meanReciprocalRank)}`,
    `Cleanup verification: ${metric(report.metrics.cleanupVerificationRate)}`,
    `Latency p50 ingest/query/reader/judge: ${report.metrics.latency.ingestion.p50Ms.toFixed(3)} / ${report.metrics.latency.query.p50Ms.toFixed(3)} / ${report.metrics.latency.reader.p50Ms.toFixed(3)} / ${report.metrics.latency.judge.p50Ms.toFixed(3)} ms`,
    `Model tokens reader in/out: ${report.run.telemetry.reader.inputTokens ?? "n/a"} / ${report.run.telemetry.reader.outputTokens ?? "n/a"}`,
    `Model tokens judge in/out: ${report.run.telemetry.judge.inputTokens ?? "n/a"} / ${report.run.telemetry.judge.outputTokens ?? "n/a"}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dataset = await openAgentDataset(options.dataset);
  const report = await runAgentBenchmark(
    dataset,
    createAdapter(options),
    createReader(options),
    createJudge(options),
    {
      topK: options.topK,
      ...(options.maxScenarios === undefined
        ? {}
        : { maxScenarios: options.maxScenarios }),
      ...(options.runId === undefined ? {} : { runId: options.runId }),
    }
  );
  const outputs: Array<{ file: string; content: string }> = [];
  if (options.output !== undefined) {
    outputs.push({
      file: options.output,
      content: `${JSON.stringify(report, null, 2)}\n`,
    });
  }
  if (options.hypothesesOutput !== undefined) {
    outputs.push({
      file: options.hypothesesOutput,
      content: hypothesesJsonl(report),
    });
  }
  await writeOutputsAtomic(outputs);
  console.log(options.json ? JSON.stringify(report, null, 2) : summary(report));
  if (report.run.status !== "completed") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(
    `Memory Bench agent failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
