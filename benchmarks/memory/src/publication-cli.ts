import fs from "node:fs";
import path from "node:path";
import {
  assessAgentPublication,
  createAgentPublicationTemplate,
  finalizeAgentPublication,
  loadAgentPublicationManifest,
  type AgentPublicationOptions,
} from "./publication.js";

type PublicationCommand = "template" | "check" | "finalize";

interface ParsedValues extends AgentPublicationOptions {
  manifest?: string;
  output?: string;
}

function help(): string {
  return [
    "Memory Bench — agent publication evidence",
    "",
    "Usage:",
    "  npm run bench:memory:publish-agent -- template --comparison=<manifest> --statistics=<file> --qualification=<file>... --evaluator-parity=<file>... --output=<draft>",
    "  npm run bench:memory:publish-agent -- check --manifest=<draft> --comparison=<manifest> --statistics=<file> --qualification=<file>... --evaluator-parity=<file>...",
    "  npm run bench:memory:publish-agent -- finalize --manifest=<draft> --comparison=<manifest> --statistics=<file> --qualification=<file>... --evaluator-parity=<file>... --output=<final>",
    "",
    "A draft remains candidate/ineligible while release metadata is filled.",
    "Finalize re-verifies every report, component qualification, parity artifact,",
    "paired statistical comparison, clean source commit, independent process ID,",
    "and release attestation.",
  ].join("\n");
}

function optionValue(arg: string, name: string): string | null {
  const prefix = `--${name}=`;
  if (!arg.startsWith(prefix)) return null;
  const value = arg.slice(prefix.length);
  if (value === "") throw new Error(`--${name} requires a value`);
  return path.resolve(value);
}

function parseValues(args: string[]): ParsedValues {
  let comparison: string | undefined;
  let manifest: string | undefined;
  let output: string | undefined;
  let statistics: string | undefined;
  const qualifications: string[] = [];
  const evaluatorParities: string[] = [];
  for (const arg of args) {
    const comparisonValue = optionValue(arg, "comparison");
    if (comparisonValue !== null) {
      if (comparison !== undefined) {
        throw new Error("--comparison was provided more than once");
      }
      comparison = comparisonValue;
      continue;
    }
    const qualificationValue = optionValue(arg, "qualification");
    if (qualificationValue !== null) {
      qualifications.push(qualificationValue);
      continue;
    }
    const parityValue = optionValue(arg, "evaluator-parity");
    if (parityValue !== null) {
      evaluatorParities.push(parityValue);
      continue;
    }
    const statisticsValue = optionValue(arg, "statistics");
    if (statisticsValue !== null) {
      if (statistics !== undefined) {
        throw new Error("--statistics was provided more than once");
      }
      statistics = statisticsValue;
      continue;
    }
    const manifestValue = optionValue(arg, "manifest");
    if (manifestValue !== null) {
      if (manifest !== undefined) {
        throw new Error("--manifest was provided more than once");
      }
      manifest = manifestValue;
      continue;
    }
    const outputValue = optionValue(arg, "output");
    if (outputValue !== null) {
      if (output !== undefined) {
        throw new Error("--output was provided more than once");
      }
      output = outputValue;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (comparison === undefined) throw new Error("--comparison is required");
  return {
    comparison,
    qualifications,
    evaluatorParities,
    ...(statistics === undefined ? {} : { statistics }),
    ...(manifest === undefined ? {} : { manifest }),
    ...(output === undefined ? {} : { output }),
  };
}

function sourceOptions(values: ParsedValues): AgentPublicationOptions {
  return {
    comparison: values.comparison,
    qualifications: values.qualifications,
    evaluatorParities: values.evaluatorParities,
    ...(values.statistics === undefined
      ? {}
      : { statistics: values.statistics }),
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

async function templateCommand(args: string[]): Promise<void> {
  const values = parseValues(args);
  if (values.manifest !== undefined) {
    throw new Error("template does not accept --manifest");
  }
  if (values.output === undefined) throw new Error("--output is required");
  const manifest = await createAgentPublicationTemplate(
    sourceOptions(values)
  );
  writeExclusive(values.output, manifest);
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "template",
        publicationId: manifest.publicationId,
        mechanicallyVerified: manifest.claim.mechanicallyVerified,
        publicationEligible: manifest.claim.publicationEligible,
        blockers: manifest.claim.blockers,
        output: values.output,
      },
      null,
      2
    )
  );
}

async function checkCommand(args: string[]): Promise<void> {
  const values = parseValues(args);
  if (values.output !== undefined) {
    throw new Error("check does not accept --output");
  }
  if (values.manifest === undefined) {
    throw new Error("--manifest is required");
  }
  const manifest = loadAgentPublicationManifest(values.manifest).value;
  const assessment = await assessAgentPublication(
    manifest,
    sourceOptions(values)
  );
  console.log(
    JSON.stringify(
      {
        ok: assessment.readyToFinalize,
        command: "check",
        manifest: values.manifest,
        ...assessment,
      },
      null,
      2
    )
  );
  if (!assessment.readyToFinalize) process.exitCode = 1;
}

async function finalizeCommand(args: string[]): Promise<void> {
  const values = parseValues(args);
  if (values.manifest === undefined) {
    throw new Error("--manifest is required");
  }
  if (values.output === undefined) throw new Error("--output is required");
  const draft = loadAgentPublicationManifest(values.manifest).value;
  const finalized = await finalizeAgentPublication(
    draft,
    sourceOptions(values)
  );
  writeExclusive(values.output, finalized);
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "finalize",
        publicationId: finalized.publicationId,
        resultClass: finalized.claim.resultClass,
        publicationEligible: finalized.claim.publicationEligible,
        output: values.output,
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(help());
    return;
  }
  const command = args[0] as PublicationCommand;
  if (command === "template") {
    await templateCommand(args.slice(1));
    return;
  }
  if (command === "check") {
    await checkCommand(args.slice(1));
    return;
  }
  if (command === "finalize") {
    await finalizeCommand(args.slice(1));
    return;
  }
  throw new Error(`unknown publication command: ${args[0]}`);
}

main().catch((error: unknown) => {
  console.error(
    `Memory Bench agent publication failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
});
