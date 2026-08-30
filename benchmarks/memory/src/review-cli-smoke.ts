import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const reviewCli = fileURLToPath(new URL("./review-cli.ts", import.meta.url));
const corpusCheckCli = fileURLToPath(
  new URL("./corpus-check.ts", import.meta.url)
);

function run(
  script: string,
  args: string[]
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function assertSucceeded(
  result: SpawnSyncReturns<string>,
  label: string
): void {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function assertFailed(
  result: SpawnSyncReturns<string>,
  label: string
): void {
  assert.notEqual(
    result.status,
    0,
    `${label} unexpectedly passed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "memory-bench-review-cli-")
);
try {
  const missingReleaseDataset = run(corpusCheckCli, ["--release"]);
  assertFailed(missingReleaseDataset, "release gate without explicit dataset");
  assert.match(
    missingReleaseDataset.stderr,
    /--dataset is required with --release/
  );

  const bundle = path.join(temporaryRoot, "bundle");
  assertSucceeded(
    run(reviewCli, ["packet", `--output-dir=${bundle}`]),
    "packet generation"
  );
  const overlayFile = path.join(
    bundle,
    "memory-bench-core-draft-0.1.0-overlay.json"
  );
  assertFailed(
    run(reviewCli, ["check", `--overlay=${overlayFile}`]),
    "pending overlay check"
  );

  const overlay = JSON.parse(fs.readFileSync(overlayFile, "utf8")) as {
    reviewer: unknown;
    maintainer: unknown;
    attestation: unknown;
    reviewedAt: unknown;
    decisions: Array<Record<string, unknown>>;
  };
  overlay.reviewer = {
    id: "review-cli-smoke-human",
    type: "human",
    affiliation: "independent test fixture",
    conflicts: [],
  };
  overlay.attestation = {
    independentFromScenarioAuthors: true,
    rightsToPublish: true,
    noPrivateOrSecretData: true,
  };
  overlay.reviewedAt = "2026-07-27T12:00:00.000Z";
  overlay.decisions = overlay.decisions.map((decision) => ({
    ...decision,
    decision: "approve",
    note: "Automated CLI contract fixture.",
  }));
  fs.writeFileSync(overlayFile, `${JSON.stringify(overlay, null, 2)}\n`);

  assertFailed(
    run(reviewCli, ["check", `--overlay=${overlayFile}`]),
    "completed review without maintainer verification"
  );
  overlay.maintainer = {
    id: "review-cli-smoke-maintainer",
    type: "human",
    affiliation: "memory-bench-maintainers",
    verifiedAt: "2026-07-27T12:01:00.000Z",
    reviewerIdentityVerified: true,
    conflictsReviewed: true,
    disposition: "No disqualifying reviewer conflict was identified.",
  };
  fs.writeFileSync(overlayFile, `${JSON.stringify(overlay, null, 2)}\n`);

  assertSucceeded(
    run(reviewCli, ["check", `--overlay=${overlayFile}`]),
    "completed overlay check"
  );
  const reviewedFile = path.join(temporaryRoot, "reviewed.json");
  assertSucceeded(
    run(reviewCli, [
      "apply",
      `--overlay=${overlayFile}`,
      `--output=${reviewedFile}`,
      "--version=1.0.0",
      "--finalize",
    ]),
    "review application"
  );
  assertSucceeded(
    run(reviewCli, [
      "verify",
      `--dataset=${reviewedFile}`,
      `--overlay=${overlayFile}`,
    ]),
    "review evidence verification"
  );
  assertSucceeded(
    run(corpusCheckCli, [
      "--release",
      `--dataset=${reviewedFile}`,
      `--review-overlay=${overlayFile}`,
    ]),
    "evidence-backed release gate"
  );
  assertFailed(
    run(reviewCli, [
      "apply",
      `--overlay=${overlayFile}`,
      `--output=${reviewedFile}`,
      "--version=1.0.1",
    ]),
    "exclusive output protection"
  );

  fs.appendFileSync(overlayFile, " \n");
  assertFailed(
    run(reviewCli, [
      "verify",
      `--dataset=${reviewedFile}`,
      `--overlay=${overlayFile}`,
    ]),
    "tampered overlay verification"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        packet: true,
        pendingRejected: true,
        finalized: true,
        releaseVerified: true,
        overwriteRejected: true,
        tamperRejected: true,
      },
      null,
      2
    )
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
