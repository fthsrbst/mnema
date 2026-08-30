import fs from "node:fs";
import path from "node:path";
import {
  assessComponentQualification,
  createComponentQualificationTemplate,
  loadComponentQualification,
  type ComponentQualificationOptions,
  type QualificationRole,
} from "./qualification.js";
import { qualificationRoles } from "./qualification-types.js";

type QualificationCommand = "template" | "check";

interface ParsedValues {
  role?: QualificationRole;
  agentReport?: string;
  coreReport?: string;
  evaluatorParity?: string;
  qualification?: string;
  output?: string;
}

function help(): string {
  return [
    "Memory Bench — component qualification evidence",
    "",
    "Usage:",
    "  npm run bench:memory:qualify -- template --role=<adapter|reader|judge> --agent-report=<path> [role evidence] --output=<path>",
    "  npm run bench:memory:qualify -- check --qualification=<path> --agent-report=<path> [role evidence]",
    "",
    "Role evidence:",
    "  adapter: --core-report=<core-report.json>",
    "  reader:  no additional artifact",
    "  judge:   --evaluator-parity=<parity.json>",
    "",
    "The generated template is pending. A qualifying overlay requires distinct",
    "submitter, human reviewer, and maintainer-verifier identities plus all",
    "role-specific attestations. Source reports remain immutable candidate evidence.",
  ].join("\n");
}

function optionValue(arg: string, name: string): string | null {
  const prefix = `--${name}=`;
  if (!arg.startsWith(prefix)) return null;
  const value = arg.slice(prefix.length);
  if (value === "") throw new Error(`--${name} requires a value`);
  return value;
}

function parseValues(args: string[]): ParsedValues {
  const values: ParsedValues = {};
  const seen = new Set<string>();
  for (const arg of args) {
    let matched = false;
    for (const name of [
      "role",
      "agent-report",
      "core-report",
      "evaluator-parity",
      "qualification",
      "output",
    ] as const) {
      const value = optionValue(arg, name);
      if (value === null) continue;
      if (seen.has(name)) {
        throw new Error(`--${name} was provided more than once`);
      }
      seen.add(name);
      matched = true;
      if (name === "role") {
        if (!qualificationRoles.includes(value as QualificationRole)) {
          throw new Error(
            `--role must be ${qualificationRoles.join(", ")}`
          );
        }
        values.role = value as QualificationRole;
      } else {
        const resolved = path.resolve(value);
        if (name === "agent-report") values.agentReport = resolved;
        else if (name === "core-report") values.coreReport = resolved;
        else if (name === "evaluator-parity") {
          values.evaluatorParity = resolved;
        } else if (name === "qualification") {
          values.qualification = resolved;
        } else {
          values.output = resolved;
        }
      }
      break;
    }
    if (!matched) throw new Error(`unknown argument: ${arg}`);
  }
  return values;
}

function qualificationOptions(
  values: ParsedValues,
  fallbackRole?: QualificationRole
): ComponentQualificationOptions {
  const role = values.role ?? fallbackRole;
  if (role === undefined) throw new Error("--role is required");
  if (values.agentReport === undefined) {
    throw new Error("--agent-report is required");
  }
  return {
    role,
    agentReport: values.agentReport,
    ...(values.coreReport === undefined
      ? {}
      : { coreReport: values.coreReport }),
    ...(values.evaluatorParity === undefined
      ? {}
      : { evaluatorParity: values.evaluatorParity }),
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
  if (values.qualification !== undefined) {
    throw new Error("template does not accept --qualification");
  }
  if (values.output === undefined) throw new Error("--output is required");
  const template = await createComponentQualificationTemplate(
    qualificationOptions(values)
  );
  writeExclusive(values.output, template);
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "template",
        qualificationId: template.qualificationId,
        role: template.subject.role,
        component: template.subject.component.name,
        componentSha256: template.subject.componentSha256,
        decision: template.decision,
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
  if (values.qualification === undefined) {
    throw new Error("--qualification is required");
  }
  const qualification = loadComponentQualification(
    values.qualification
  ).value;
  if (
    values.role !== undefined &&
    values.role !== qualification.subject.role
  ) {
    throw new Error(
      `--role is ${values.role}, qualification role is ${qualification.subject.role}`
    );
  }
  const assessment = await assessComponentQualification(
    qualification,
    qualificationOptions(values, qualification.subject.role)
  );
  console.log(
    JSON.stringify(
      {
        ok: assessment.qualified,
        command: "check",
        qualification: values.qualification,
        ...assessment,
      },
      null,
      2
    )
  );
  if (!assessment.qualified) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(help());
    return;
  }
  const command = args[0] as QualificationCommand;
  if (command === "template") {
    await templateCommand(args.slice(1));
    return;
  }
  if (command === "check") {
    await checkCommand(args.slice(1));
    return;
  }
  throw new Error(`unknown qualification command: ${args[0]}`);
}

main().catch((error: unknown) => {
  console.error(
    `Memory Bench qualification failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
});
