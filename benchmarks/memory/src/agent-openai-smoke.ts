import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LongMemEvalOpenAIJudge,
  OpenAIResponsesReader,
} from "./agent-openai.js";
import type {
  AgentComponentTelemetry,
  AgentJudgeInput,
  AgentReaderInput,
} from "./agent-types.js";
import { FakeOpenAIResponsesServer } from "./testing/fake-openai-responses-server.js";
import { importLongMemEval } from "./longmemeval.js";

const apiKey = "contract-test-key-not-a-real-secret";
const server = new FakeOpenAIResponsesServer({
  apiKey,
  failFirstRequests: 1,
});
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "memory-bench-agent-openai-smoke-")
);

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "benchmarks/memory/src/agent-cli.ts", ...args],
    {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  return { exitCode, stdout, stderr };
}

const judgeBase: Omit<
  AgentJudgeInput,
  "sourceQuestionType" | "ability" | "expectedAbstention"
> = {
  question: "What is the answer?",
  expectedAnswer: "green",
  hypothesis: "green",
};

try {
  await server.start();
  const reader = new OpenAIResponsesReader({
    apiKey,
    organization: "org-contract",
    baseUrl: server.baseUrl,
    model: "gpt-4o-2024-08-06",
    maxRetries: 2,
    retryBaseDelayMs: 0,
    timeoutMs: 5_000,
    maxOutputTokens: 100,
  });
  const readerInput: AgentReaderInput = {
    question: "Which color did the user choose?",
    questionDate: "2026/07/03 (Fri) 09:00",
    context: [
      {
        type: "text",
        value: '[{"role":"user","content":"Later distractor."}]',
        observedAt: "2026/07/02 (Thu) 09:00",
        sourceSessionId: "later",
        score: 0.9,
      },
      {
        type: "text",
        value: '[{"role":"user","content":"Use green."}]',
        observedAt: "2026/07/01 (Wed) 09:00",
        sourceSessionId: "earlier",
        score: 0.8,
      },
    ],
  };
  assert.equal(await reader.answer(readerInput), "green");
  assert.equal(reader.info.classification, "candidate");
  assert.equal(reader.info.config.store, false);
  assert.equal(reader.info.config.model, "gpt-4o-2024-08-06");
  assert.equal(JSON.stringify(reader.info).includes(apiKey), false);

  const readerRequests = server.requests.slice(0, 2);
  assert.equal(readerRequests.length, 2);
  assert.equal(readerRequests[0]!.authorization, `Bearer ${apiKey}`);
  assert.equal(readerRequests[0]!.organization, "org-contract");
  assert.equal(readerRequests[0]!.body.store, false);
  assert.equal(readerRequests[0]!.body.temperature, 0);
  assert.equal(readerRequests[0]!.body.max_output_tokens, 100);
  const readerPrompt = String(readerRequests[1]!.body.input);
  assert(
    readerPrompt.indexOf("Use green.") <
      readerPrompt.indexOf("Later distractor."),
    "reader evidence must be presented chronologically"
  );
  assert.match(readerPrompt, /untrusted data/);
  const readerTelemetry = reader.getTelemetry();
  assert.equal(readerTelemetry.requestCount, 2);
  assert.equal(readerTelemetry.retryCount, 1);
  assert.equal(readerTelemetry.inputTokens, 100);
  assert.equal(readerTelemetry.outputTokens, 3);
  assert.equal(readerTelemetry.providerProcessingMs, 14);
  await assert.rejects(
    reader.answer({
      question: "What is shown?",
      questionDate: "2026/07/03",
      context: [
        {
          type: "image",
          value: "https://example.invalid/image.png",
          observedAt: null,
          sourceSessionId: null,
          score: null,
        },
      ],
    }),
    /does not support image context/
  );

  const judge = new LongMemEvalOpenAIJudge({
    apiKey,
    baseUrl: server.baseUrl,
    model: "gpt-4o-2024-08-06",
    maxRetries: 0,
    timeoutMs: 5_000,
  });
  const judgeCases: AgentJudgeInput[] = [
    {
      ...judgeBase,
      sourceQuestionType: "single-session-user",
      ability: "information-extraction",
      expectedAbstention: false,
    },
    {
      ...judgeBase,
      sourceQuestionType: "temporal-reasoning",
      ability: "temporal-reasoning",
      expectedAbstention: false,
    },
    {
      ...judgeBase,
      sourceQuestionType: "knowledge-update",
      ability: "knowledge-update",
      expectedAbstention: false,
    },
    {
      ...judgeBase,
      sourceQuestionType: "single-session-preference",
      ability: "information-extraction",
      expectedAbstention: false,
    },
    {
      ...judgeBase,
      sourceQuestionType: "multi-session",
      ability: "abstention",
      expectedAbstention: true,
    },
  ];
  for (const input of judgeCases) {
    const decision = await judge.evaluate(input);
    assert.equal(decision.passed, true);
    assert.equal(decision.score, 1);
    assert.equal(decision.label, "Yes");
  }
  const negative = await judge.evaluate({
    ...judgeCases[0]!,
    hypothesis: "FORCE_NO",
  });
  assert.equal(negative.passed, false);
  assert.equal(negative.score, 0);
  assert.equal(negative.label, "No");
  assert.equal(judge.info.classification, "candidate");
  assert.equal(JSON.stringify(judge.info).includes(apiKey), false);

  const judgePrompts = server.requests
    .slice(2)
    .map((request) => String(request.body.input));
  assert.match(judgePrompts[1]!, /off-by-one/);
  assert.match(judgePrompts[2]!, /updated answer/);
  assert.match(judgePrompts[3]!, /personal information/);
  assert.match(judgePrompts[4]!, /cannot be answered/);
  const judgeTelemetry = judge.getTelemetry();
  assert.equal(judgeTelemetry.requestCount, 6);
  assert.equal(judgeTelemetry.retryCount, 0);
  assert.equal(judgeTelemetry.inputTokens, 600);
  assert.equal(judgeTelemetry.outputTokens, 18);
  assert.equal(judgeTelemetry.providerProcessingMs, 42);

  const fixture = fileURLToPath(
    new URL("../fixtures/longmemeval-contract.json", import.meta.url)
  );
  const datasetFile = path.join(temporaryDirectory, "agent-dataset.json");
  const reportFile = path.join(temporaryDirectory, "agent-report.json");
  await importLongMemEval({
    input: fixture,
    output: datasetFile,
    source: {
      revision: "agent-openai-cli-fixture-v1",
      subset: "oracle",
      uri: "https://example.invalid/longmemeval-contract.json",
      license: "MIT",
    },
  });
  const cliResult = await runCli(
    [
      `--dataset=${datasetFile}`,
      "--adapter=literal",
      "--reader=openai",
      "--judge=openai",
      "--reader-model=gpt-4o-2024-08-06",
      "--judge-model=gpt-4o-2024-08-06",
      "--top-k=1",
      `--output=${reportFile}`,
    ],
    {
      ...process.env,
      OPENAI_API_KEY: apiKey,
      MEMORY_BENCH_OPENAI_BASE_URL: server.baseUrl,
      MEMORY_BENCH_OPENAI_TIMEOUT_MS: "5000",
      MEMORY_BENCH_OPENAI_MAX_RETRIES: "0",
    }
  );
  assert.equal(
    cliResult.exitCode,
    0,
    `agent OpenAI CLI failed:\n${cliResult.stdout}\n${cliResult.stderr}`
  );
  const cliReport = JSON.parse(
    fs.readFileSync(reportFile, "utf8")
  ) as {
    run: {
      status: string;
      resultClass: string;
      telemetry: {
        reader: AgentComponentTelemetry;
        judge: AgentComponentTelemetry;
      };
    };
    metrics: {
      qaAccuracy: number | null;
    };
  };
  assert.equal(cliReport.run.status, "completed");
  assert.equal(cliReport.run.resultClass, "harness");
  assert.equal(cliReport.metrics.qaAccuracy, 1);
  assert.equal(cliReport.run.telemetry.reader.requestCount, 2);
  assert.equal(cliReport.run.telemetry.judge.requestCount, 2);
  assert.equal(JSON.stringify(cliReport).includes(apiKey), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        apiSurface: "responses",
        readerRetries: readerTelemetry.retryCount,
        judgeBranches: judgeCases.length,
        judgeNegative: negative.passed === false,
        inputTokens:
          (readerTelemetry.inputTokens ?? 0) +
          (judgeTelemetry.inputTokens ?? 0),
        secretsOmitted: true,
        cliScenarios: 2,
      },
      null,
      2
    )
  );
} finally {
  await server.stop();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
