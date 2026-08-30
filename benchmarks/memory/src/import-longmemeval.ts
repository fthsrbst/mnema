import path from "node:path";
import type { LongMemEvalSubset } from "./agent-types.js";
import {
  importLongMemEval,
  type LongMemEvalSourceSpec,
} from "./longmemeval.js";

const revision = "98d7416c24c778c2fee6e6f3006e7a073259d48f";
const repository =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned";

const sources: Record<
  LongMemEvalSubset,
  Omit<LongMemEvalSourceSpec, "subset" | "license">
> = {
  oracle: {
    revision,
    uri: `${repository}/resolve/${revision}/longmemeval_oracle.json`,
    expectedSha256:
      "821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c",
    expectedBytes: 15_388_478,
  },
  small: {
    revision,
    uri: `${repository}/resolve/${revision}/longmemeval_s_cleaned.json`,
    expectedSha256:
      "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
    expectedBytes: 277_383_467,
  },
  medium: {
    revision,
    uri: `${repository}/resolve/${revision}/longmemeval_m_cleaned.json`,
    expectedSha256:
      "9d79e5524794a2e6900a3aa9cb7d9152c5a3e8319c9a87c25494ba1eacee495f",
    expectedBytes: 2_737_100_077,
  },
};

interface CliOptions {
  input: string;
  output: string;
  subset: LongMemEvalSubset;
}

function parseSubset(value: string): LongMemEvalSubset {
  if (value === "oracle" || value === "small" || value === "medium") {
    return value;
  }
  throw new Error("--subset must be oracle, small, or medium");
}

function inferSubset(input: string): LongMemEvalSubset | null {
  const fileName = path.basename(input);
  if (fileName === "longmemeval_oracle.json") return "oracle";
  if (fileName === "longmemeval_s_cleaned.json") return "small";
  if (fileName === "longmemeval_m_cleaned.json") return "medium";
  return null;
}

function parseArgs(args: string[]): CliOptions {
  let input: string | null = null;
  let output: string | null = null;
  let subset: LongMemEvalSubset | null = null;
  for (const arg of args) {
    if (arg.startsWith("--input=")) {
      input = arg.slice("--input=".length);
      continue;
    }
    if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
      continue;
    }
    if (arg.startsWith("--subset=")) {
      subset = parseSubset(arg.slice("--subset=".length));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!input) throw new Error("--input is required");
  if (!output) throw new Error("--output is required");
  subset ??= inferSubset(input);
  if (!subset) {
    throw new Error(
      "--subset is required when the input does not use an official file name"
    );
  }
  return { input, output, subset };
}

const options = parseArgs(process.argv.slice(2));
const pinned = sources[options.subset];
const summary = await importLongMemEval({
  input: options.input,
  output: options.output,
  source: {
    ...pinned,
    subset: options.subset,
    license: "MIT",
  },
});
console.log(JSON.stringify({ ok: true, sourceRevision: revision, ...summary }, null, 2));
