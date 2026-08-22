import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importLongMemEval } from "./longmemeval.js";

const fixture = fileURLToPath(
  new URL("../fixtures/longmemeval-contract.json", import.meta.url)
);
const fixtureBytes = fs.readFileSync(fixture);
const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "memory-bench-longmemeval-smoke-")
);
const source = {
  revision: "fixture-v1",
  subset: "oracle" as const,
  uri: "https://example.invalid/longmemeval-contract.json",
  license: "MIT" as const,
  expectedSha256: fixtureSha256,
  expectedBytes: fixtureBytes.length,
};

try {
  const firstOutput = path.join(temporaryDirectory, "first.json");
  const secondOutput = path.join(temporaryDirectory, "second.json");
  const first = await importLongMemEval({
    input: fixture,
    output: firstOutput,
    source,
  });
  const second = await importLongMemEval({
    input: fixture,
    output: secondOutput,
    source,
  });
  assert.deepEqual(first.abilities, {
    "information-extraction": 1,
    "multi-session-reasoning": 0,
    "knowledge-update": 0,
    "temporal-reasoning": 0,
    abstention: 1,
  });
  assert.equal(first.scenarios, 2);
  assert.equal(first.sessions, 2);
  assert.equal(first.turns, 4);
  assert.deepEqual(
    fs.readFileSync(firstOutput),
    fs.readFileSync(secondOutput),
    "the same source must produce byte-identical normalized output"
  );

  await assert.rejects(
    importLongMemEval({
      input: fixture,
      output: path.join(temporaryDirectory, "sha-mismatch.json"),
      source: {
        ...source,
        expectedSha256: "0".repeat(64),
      },
    }),
    /source SHA-256 mismatch/
  );
  assert.equal(
    fs.existsSync(path.join(temporaryDirectory, "sha-mismatch.json")),
    false
  );

  await assert.rejects(
    importLongMemEval({
      input: fixture,
      output: firstOutput,
      source,
    }),
    /output already exists/
  );

  const malformed = JSON.parse(fixtureBytes.toString("utf8")) as Array<
    Record<string, unknown>
  >;
  malformed[0]!.haystack_dates = [];
  const malformedFile = path.join(temporaryDirectory, "malformed.json");
  fs.writeFileSync(malformedFile, `${JSON.stringify(malformed)}\n`);
  await assert.rejects(
    importLongMemEval({
      input: malformedFile,
      output: path.join(temporaryDirectory, "malformed-output.json"),
      source: {
        ...source,
        expectedSha256: undefined,
        expectedBytes: undefined,
      },
    }),
    /must have equal lengths/
  );

  const duplicate = JSON.parse(fixtureBytes.toString("utf8")) as Array<
    Record<string, unknown>
  >;
  duplicate[1]!.question_id = duplicate[0]!.question_id;
  const duplicateFile = path.join(temporaryDirectory, "duplicate.json");
  fs.writeFileSync(duplicateFile, `${JSON.stringify(duplicate)}\n`);
  await assert.rejects(
    importLongMemEval({
      input: duplicateFile,
      output: path.join(temporaryDirectory, "duplicate-output.json"),
      source: {
        ...source,
        expectedSha256: undefined,
        expectedBytes: undefined,
      },
    }),
    /duplicate question_id/
  );

  const temporaryFiles = fs.readdirSync(temporaryDirectory);
  assert.equal(
    temporaryFiles.some((file) => file.endsWith(".tmp")),
    false,
    "failed imports must remove partial files"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        scenarios: first.scenarios,
        deterministic: true,
        shaMismatchRejected: true,
        overwriteRejected: true,
        malformedRejected: true,
        duplicateRejected: true,
      },
      null,
      2
    )
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
