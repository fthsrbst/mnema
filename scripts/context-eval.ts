import fs from "node:fs";
import { closeDb, contextGet, embeddingsEnabled, type ContextGetInput } from "../src/core/index.js";

interface Expected {
  intent?: string;
  authority_project?: string | null;
  latest_session?: boolean;
  authority_focus_any?: string[];
  max_memories?: number;
  max_chunks?: number;
  memory_title_any?: string[];
  chunk_title_any?: string[];
  warning_any?: string[];
  forbidden_chunk_title_any?: string[];
  empty_evidence?: boolean;
}

interface EvalCase extends ContextGetInput {
  id: string;
  reviewed_by?: string;
  reviewed_at?: string;
  expect: Expected;
}

interface EvalSuite {
  schema_version: number;
  description?: string;
  cases: EvalCase[];
}

const includesAny = (values: string[], expected: string[]): boolean =>
  expected.some((needle) => values.some((value) => value.toLocaleLowerCase().includes(needle.toLocaleLowerCase())));

function evaluate(item: EvalCase, actual: Awaited<ReturnType<typeof contextGet>>): string[] {
  const failures: string[] = [];
  const expected = item.expect;
  if (expected.intent !== undefined && actual.intent !== expected.intent)
    failures.push(`intent expected=${expected.intent} actual=${actual.intent}`);
  if (Object.hasOwn(expected, "authority_project")) {
    const actualProject = actual.authority.project?.name ?? null;
    if (actualProject !== expected.authority_project)
      failures.push(`authority_project expected=${expected.authority_project} actual=${actualProject}`);
  }
  if (expected.latest_session === true && actual.authority.latest_session === null)
    failures.push("latest_session missing");
  if (
    expected.authority_focus_any &&
    !includesAny([actual.authority.project?.current_focus ?? ""], expected.authority_focus_any)
  )
    failures.push(`authority focus missing one of: ${expected.authority_focus_any.join(" | ")}`);
  if (expected.max_memories !== undefined && actual.evidence.memories.length > expected.max_memories)
    failures.push(`memories expected<=${expected.max_memories} actual=${actual.evidence.memories.length}`);
  if (expected.max_chunks !== undefined && actual.evidence.chunks.length > expected.max_chunks)
    failures.push(`chunks expected<=${expected.max_chunks} actual=${actual.evidence.chunks.length}`);
  if (expected.memory_title_any && !includesAny(actual.evidence.memories.map((m) => m.title), expected.memory_title_any))
    failures.push(`memory title missing one of: ${expected.memory_title_any.join(" | ")}`);
  if (expected.chunk_title_any && !includesAny(actual.evidence.chunks.map((c) => c.document_title), expected.chunk_title_any))
    failures.push(`chunk title missing one of: ${expected.chunk_title_any.join(" | ")}`);
  if (expected.warning_any && !includesAny(actual.warnings, expected.warning_any))
    failures.push(`warning missing one of: ${expected.warning_any.join(" | ")}`);
  if (
    expected.forbidden_chunk_title_any &&
    includesAny(actual.evidence.chunks.map((chunk) => chunk.document_title), expected.forbidden_chunk_title_any)
  )
    failures.push(`forbidden chunk title present: ${expected.forbidden_chunk_title_any.join(" | ")}`);
  if (expected.empty_evidence && actual.evidence.memories.length + actual.evidence.chunks.length !== 0)
    failures.push(`expected empty evidence, got ${actual.evidence.memories.length} memories + ${actual.evidence.chunks.length} chunks`);
  return failures;
}

const cliArgs = process.argv.slice(2);
const releaseGate = cliArgs.includes("--release");
const file = cliArgs.find((arg) => !arg.startsWith("--")) ?? "./evals/context-golden.json";
const suite = JSON.parse(fs.readFileSync(file, "utf8")) as EvalSuite;
if (suite.schema_version !== 1 || !Array.isArray(suite.cases)) throw new Error("unsupported context eval suite");

let passed = 0;
const results: { id: string; ok: boolean; failures: string[]; estimated_tokens?: number }[] = [];
try {
  for (const item of suite.cases) {
    const { id: _id, expect: _expect, reviewed_by: _reviewedBy, reviewed_at: _reviewedAt, ...input } = item;
    const actual = await contextGet({ ...input, record_usage: false });
    const failures = evaluate(item, actual);
    const ok = failures.length === 0;
    if (ok) passed++;
    results.push({ id: item.id, ok, failures, estimated_tokens: actual.budget.estimated_tokens });
    console.log(`${ok ? "PASS" : "FAIL"} ${item.id}${ok ? "" : ` — ${failures.join("; ")}`}`);
  }
} finally {
  closeDb();
}

const report = {
  suite: file,
  embeddings: embeddingsEnabled(),
  total: suite.cases.length,
  passed,
  pass_rate: suite.cases.length === 0 ? 0 : passed / suite.cases.length,
  average_estimated_tokens:
    results.length === 0
      ? 0
      : Math.round(results.reduce((sum, result) => sum + (result.estimated_tokens ?? 0), 0) / results.length),
  by_intent: suite.cases.reduce<Record<string, { total: number; passed: number }>>((acc, item, index) => {
    const intent = item.expect.intent ?? item.intent ?? "unspecified";
    const group = acc[intent] ?? { total: 0, passed: 0 };
    group.total++;
    if (results[index]?.ok) group.passed++;
    acc[intent] = group;
    return acc;
  }, {}),
  release_gate: {
    requested: releaseGate,
    minimum_human_reviewed_cases: 50,
    human_reviewed_cases: suite.cases.filter((item) => Boolean(item.reviewed_by && item.reviewed_at)).length,
    enough_cases: suite.cases.filter((item) => Boolean(item.reviewed_by && item.reviewed_at)).length >= 50,
    all_cases_passed: passed === suite.cases.length,
  },
  results,
};
console.log(`\n${JSON.stringify(report, null, 2)}`);
const humanReviewed = suite.cases.filter((item) => Boolean(item.reviewed_by && item.reviewed_at)).length;
const releaseReady = !releaseGate || (humanReviewed >= 50 && passed === suite.cases.length);
if (releaseGate && humanReviewed < 50) {
  console.error(`\nRelease gate failed: ${humanReviewed}/50 human-reviewed cases.`);
}
process.exit(passed === suite.cases.length && releaseReady ? 0 : 1);
