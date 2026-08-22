import path from "node:path";
import {
  createEvaluatorParity,
  type EvaluatorParityOptions,
} from "./evaluator-parity.js";
import type { EvaluatorParityArtifact } from "./agent-types.js";

interface CliOptions extends EvaluatorParityOptions {
  json: boolean;
  requireExact: boolean;
}

function help(): string {
  return [
    "Memory Bench — LongMemEval evaluator parity",
    "",
    "Usage:",
    "  npm run bench:memory:evaluator-parity -- --report=<agent-report.json> --official-results=<evaluate_qa.jsonl> --output=<parity.json> [options]",
    "",
    "Options:",
    "  --report=<path>               Memory Bench agent report",
    "  --official-results=<path>     Pinned LongMemEval evaluate_qa.py JSONL output",
    "  --output=<path>               New parity artifact (must not already exist)",
    "  --require-exact               Exit 1 after writing unless comparable labels agree exactly",
    "  --json                        Print the complete parity artifact",
    "  --help                        Show this help",
    "",
    "A label mismatch is normally an evaluation result and exits 0.",
    "--require-exact turns exact evaluator agreement into a CI/release gate.",
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes("--help")) {
    console.log(help());
    process.exit(0);
  }
  const valueNames = ["report", "official-results", "output"] as const;
  const flags = new Set(["--json", "--require-exact"]);
  for (const arg of args) {
    if (flags.has(arg)) continue;
    if (!valueNames.some((name) => arg.startsWith(`--${name}=`))) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  const value = (name: (typeof valueNames)[number]): string => {
    const prefix = `--${name}=`;
    const matches = args.filter((arg) => arg.startsWith(prefix));
    if (matches.length > 1) {
      throw new Error(`--${name} was provided more than once`);
    }
    const result = matches[0]?.slice(prefix.length);
    if (result === undefined || result === "") {
      throw new Error(`--${name} is required`);
    }
    return path.resolve(result);
  };
  return {
    report: value("report"),
    officialResults: value("official-results"),
    output: value("output"),
    json: args.includes("--json"),
    requireExact: args.includes("--require-exact"),
  };
}

function summary(artifact: EvaluatorParityArtifact, output: string): string {
  const agreement =
    artifact.metrics.agreementRate === null
      ? "-"
      : artifact.metrics.agreementRate.toFixed(6);
  return [
    `Memory Bench evaluator parity — ${artifact.candidate.dataset.subset}`,
    `Artifact: ${output}`,
    `Comparable: ${artifact.compatibility.comparable}`,
    `Decisions: candidate=${artifact.coverage.reportDecisions}; official=${artifact.coverage.officialDecisions}; compared=${artifact.metrics.compared}`,
    `Agreement: ${agreement}; mismatches=${artifact.metrics.labelMismatches}; exactAgreement=${artifact.metrics.exactAgreement}`,
    `Publication eligible: ${artifact.claim.publicationEligible}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const artifact = await createEvaluatorParity({
    report: options.report,
    officialResults: options.officialResults,
    output: options.output,
  });
  console.log(
    options.json
      ? JSON.stringify(artifact, null, 2)
      : summary(artifact, options.output)
  );
  if (options.requireExact && !artifact.metrics.exactAgreement) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    `Memory Bench evaluator parity failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
});
