import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dbPath = path.resolve(`./data/generation-smoke-${process.pid}.db`);
const run = (phase: "seed" | "check", model: string) =>
  spawnSync(process.execPath, ["--import", "tsx", "scripts/generation-phase.ts", phase], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HUB_DB_PATH: dbPath,
      EMBEDDING_MODEL: model,
      EMBEDDING_DIM: "768",
      GEMINI_API_KEY: "",
      HUB_PRIMARY_URL: "",
    },
    encoding: "utf8",
  });

try {
  const seed = run("seed", "generation-model-a");
  process.stdout.write(seed.stdout);
  process.stderr.write(seed.stderr);
  if (seed.status !== 0) process.exit(seed.status ?? 1);
  const check = run("check", "generation-model-b");
  process.stdout.write(check.stdout);
  process.stderr.write(check.stderr);
  if (check.status !== 0) process.exit(check.status ?? 1);
  console.log("Embedding generation smoke passed.");
} finally {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
}
