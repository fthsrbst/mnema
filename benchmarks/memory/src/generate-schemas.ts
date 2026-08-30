import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memoryBenchSchemas } from "./schema-definitions.js";

const defaultOutputDir = fileURLToPath(
  new URL("../schemas/v1", import.meta.url)
);

function parseArgs(args: string[]): { check: boolean; outputDir: string } {
  let check = false;
  let outputDir = defaultOutputDir;
  for (const arg of args) {
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg.startsWith("--output-dir=")) {
      const value = arg.slice("--output-dir=".length);
      if (value === "") throw new Error("--output-dir requires a path");
      outputDir = path.resolve(value);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { check, outputDir };
}

function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const options = parseArgs(process.argv.slice(2));
const results: Array<{
  file: string;
  sha256: string;
}> = [];
if (!options.check) fs.mkdirSync(options.outputDir, { recursive: true });
for (const [name, schema] of Object.entries(memoryBenchSchemas)) {
  const file = path.join(options.outputDir, name);
  const rendered = render(schema);
  const sha256 = createHash("sha256").update(rendered).digest("hex");
  if (options.check) {
    if (!fs.existsSync(file)) {
      throw new Error(`generated schema is missing: ${file}`);
    }
    if (fs.readFileSync(file, "utf8") !== rendered) {
      throw new Error(
        `generated schema is stale: run npm run bench:memory:schema-generate`
      );
    }
  } else {
    fs.writeFileSync(file, rendered);
  }
  results.push({ file, sha256 });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      mode: options.check ? "check" : "write",
      schemas: results,
    },
    null,
    2
  )
);
