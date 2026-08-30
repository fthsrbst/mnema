import fs from "node:fs";
import path from "node:path";
import {
  assessStatisticalComparison,
  createStatisticalComparison,
  loadStatisticalComparison,
  type StatisticalComparisonOptions,
} from "./statistical-comparison.js";

type StatisticalCommand = "create" | "check";

interface ParsedValues extends StatisticalComparisonOptions {
  artifact?: string;
  output?: string;
}

function help(): string {
  return [
    "Memory Bench — paired statistical comparison",
    "",
    "Usage:",
    "  npm run bench:memory:statistics -- create --comparison=<manifest> --output=<artifact> [--iterations=10000] [--confidence-level=0.95] [--seed=20260727]",
    "  npm run bench:memory:statistics -- check --artifact=<artifact> --comparison=<manifest>",
    "",
    "The artifact recomputes quality metrics from paired report traces and uses",
    "a deterministic scenario-cluster percentile bootstrap. Intervals are",
    "descriptive and make no ranking or statistical-significance claim.",
  ].join("\n");
}

function pathValue(arg: string, name: string): string | null {
  const prefix = `--${name}=`;
  if (!arg.startsWith(prefix)) return null;
  const value = arg.slice(prefix.length);
  if (value === "") throw new Error(`--${name} requires a value`);
  return path.resolve(value);
}

function numberValue(arg: string, name: string): number | null {
  const prefix = `--${name}=`;
  if (!arg.startsWith(prefix)) return null;
  const value = arg.slice(prefix.length);
  if (value === "") throw new Error(`--${name} requires a value`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} must be a number`);
  }
  return parsed;
}

function parseValues(args: string[]): ParsedValues {
  let comparison: string | undefined;
  let artifact: string | undefined;
  let output: string | undefined;
  let iterations: number | undefined;
  let confidenceLevel: number | undefined;
  let seed: number | undefined;
  for (const arg of args) {
    const comparisonValue = pathValue(arg, "comparison");
    if (comparisonValue !== null) {
      if (comparison !== undefined) {
        throw new Error("--comparison was provided more than once");
      }
      comparison = comparisonValue;
      continue;
    }
    const artifactValue = pathValue(arg, "artifact");
    if (artifactValue !== null) {
      if (artifact !== undefined) {
        throw new Error("--artifact was provided more than once");
      }
      artifact = artifactValue;
      continue;
    }
    const outputValue = pathValue(arg, "output");
    if (outputValue !== null) {
      if (output !== undefined) {
        throw new Error("--output was provided more than once");
      }
      output = outputValue;
      continue;
    }
    const iterationsValue = numberValue(arg, "iterations");
    if (iterationsValue !== null) {
      if (iterations !== undefined) {
        throw new Error("--iterations was provided more than once");
      }
      iterations = iterationsValue;
      continue;
    }
    const confidenceValue = numberValue(arg, "confidence-level");
    if (confidenceValue !== null) {
      if (confidenceLevel !== undefined) {
        throw new Error(
          "--confidence-level was provided more than once"
        );
      }
      confidenceLevel = confidenceValue;
      continue;
    }
    const seedValue = numberValue(arg, "seed");
    if (seedValue !== null) {
      if (seed !== undefined) {
        throw new Error("--seed was provided more than once");
      }
      seed = seedValue;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (comparison === undefined) {
    throw new Error("--comparison is required");
  }
  return {
    comparison,
    ...(artifact === undefined ? {} : { artifact }),
    ...(output === undefined ? {} : { output }),
    ...(iterations === undefined ? {} : { iterations }),
    ...(confidenceLevel === undefined
      ? {}
      : { confidenceLevel }),
    ...(seed === undefined ? {} : { seed }),
  };
}

function writeExclusive(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
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
  }
}

function createCommand(args: string[]): void {
  const values = parseValues(args);
  if (values.artifact !== undefined) {
    throw new Error("create does not accept --artifact");
  }
  if (values.output === undefined) throw new Error("--output is required");
  const artifact = createStatisticalComparison({
    comparison: values.comparison,
    ...(values.iterations === undefined
      ? {}
      : { iterations: values.iterations }),
    ...(values.confidenceLevel === undefined
      ? {}
      : { confidenceLevel: values.confidenceLevel }),
    ...(values.seed === undefined ? {} : { seed: values.seed }),
  });
  writeExclusive(values.output, artifact);
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "create",
        analysisId: artifact.analysisId,
        track: artifact.track,
        adapters: artifact.coverage.adapters,
        pairs: artifact.coverage.pairs,
        allIntervalsAvailable:
          artifact.claim.allIntervalsAvailable,
        blockers: artifact.claim.blockers,
        output: values.output,
      },
      null,
      2
    )
  );
}

function checkCommand(args: string[]): void {
  const values = parseValues(args);
  if (values.output !== undefined) {
    throw new Error("check does not accept --output");
  }
  if (
    values.iterations !== undefined ||
    values.confidenceLevel !== undefined ||
    values.seed !== undefined
  ) {
    throw new Error(
      "check reads iterations, confidence level, and seed from the artifact"
    );
  }
  if (values.artifact === undefined) {
    throw new Error("--artifact is required");
  }
  const artifact = loadStatisticalComparison(values.artifact).value;
  const assessment = assessStatisticalComparison(
    artifact,
    values.comparison
  );
  console.log(
    JSON.stringify(
      {
        ok: assessment.valid,
        command: "check",
        artifact: values.artifact,
        ...assessment,
      },
      null,
      2
    )
  );
  if (!assessment.valid) process.exitCode = 1;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log(help());
    return;
  }
  const command = args[0] as StatisticalCommand;
  if (command === "create") {
    createCommand(args.slice(1));
    return;
  }
  if (command === "check") {
    checkCommand(args.slice(1));
    return;
  }
  throw new Error(`unknown statistical comparison command: ${args[0]}`);
}

try {
  main();
} catch (error) {
  console.error(
    `Memory Bench statistical comparison failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
}
