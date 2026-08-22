import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessPublicationReadiness, loadDataset } from "./dataset.js";
import {
  applyReviewOverlay,
  assessReviewOverlay,
  createReviewOverlayTemplate,
  createReviewPacket,
  loadReviewOverlayEvidence,
  renderReviewArtifact,
  reviewArtifactSha256,
  verifyDatasetReviewEvidence,
} from "./review.js";

type ReviewCommand = "packet" | "check" | "apply" | "verify";

interface CommonOptions {
  dataset: string;
  overlay: string | null;
  evidenceOverlays: string[];
}

const defaultDataset = fileURLToPath(
  new URL("../datasets/core-draft-v0.1.json", import.meta.url)
);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function optionValue(arg: string, name: string): string | null {
  const prefix = `--${name}=`;
  if (!arg.startsWith(prefix)) return null;
  const value = arg.slice(prefix.length);
  if (value === "") throw new Error(`--${name} requires a value`);
  return value;
}

function parseCommonOptions(args: string[]): {
  options: CommonOptions;
  remaining: string[];
} {
  let dataset = defaultDataset;
  let overlay: string | null = null;
  const evidenceOverlays: string[] = [];
  const remaining: string[] = [];
  for (const arg of args) {
    const datasetValue = optionValue(arg, "dataset");
    if (datasetValue !== null) {
      dataset = path.resolve(datasetValue);
      continue;
    }
    const overlayValue = optionValue(arg, "overlay");
    if (overlayValue !== null) {
      if (overlay !== null) throw new Error("--overlay may be provided only once");
      overlay = path.resolve(overlayValue);
      continue;
    }
    const evidenceValue = optionValue(arg, "evidence-overlay");
    if (evidenceValue !== null) {
      evidenceOverlays.push(path.resolve(evidenceValue));
      continue;
    }
    remaining.push(arg);
  }
  if (new Set(evidenceOverlays).size !== evidenceOverlays.length) {
    throw new Error("--evidence-overlay paths must not contain duplicates");
  }
  return {
    options: {
      dataset,
      overlay,
      evidenceOverlays,
    },
    remaining,
  };
}

function datasetSha256(file: string): string {
  return reviewArtifactSha256(fs.readFileSync(file));
}

function safeArtifactStem(name: string, version: string): string {
  const value = `${name}-${version}`
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (value === "") throw new Error("dataset name and version cannot form a safe artifact name");
  return value;
}

function writeExclusiveJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, renderReviewArtifact(value), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String(error.code)
        : null;
    if (code === "EEXIST") {
      throw new Error(`refusing to overwrite existing review artifact: ${file}`);
    }
    throw error;
  }
}

function packetCommand(args: string[]): void {
  const { options, remaining } = parseCommonOptions(args);
  if (options.overlay !== null || options.evidenceOverlays.length > 0) {
    throw new Error("packet does not accept --overlay or --evidence-overlay");
  }
  let outputDir = path.join(
    repositoryRoot,
    "artifacts",
    "memory-bench",
    "review"
  );
  for (const arg of remaining) {
    const outputDirValue = optionValue(arg, "output-dir");
    if (outputDirValue !== null) {
      outputDir = path.resolve(outputDirValue);
      continue;
    }
    throw new Error(`unknown packet argument: ${arg}`);
  }
  const dataset = loadDataset(options.dataset);
  const packet = createReviewPacket(dataset, datasetSha256(options.dataset));
  const overlay = createReviewOverlayTemplate(packet);
  const stem = safeArtifactStem(dataset.name, dataset.version);
  const packetFile = path.join(outputDir, `${stem}-packet.json`);
  const overlayFile = path.join(outputDir, `${stem}-overlay.json`);
  if (fs.existsSync(packetFile) || fs.existsSync(overlayFile)) {
    throw new Error(
      `refusing to overwrite an existing review bundle in ${outputDir}`
    );
  }
  writeExclusiveJson(packetFile, packet);
  writeExclusiveJson(overlayFile, overlay);
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "packet",
        dataset: `${dataset.name}@${dataset.version}`,
        datasetSha256: packet.dataset.sha256,
        packetSha256: reviewArtifactSha256(renderReviewArtifact(packet)),
        scenarios: packet.dataset.scenarioCount,
        queries: packet.dataset.queryCount,
        packet: packetFile,
        overlay: overlayFile,
      },
      null,
      2
    )
  );
}

function requireOverlay(options: CommonOptions): string {
  if (options.overlay === null) throw new Error("--overlay is required");
  return options.overlay;
}

function checkCommand(args: string[]): void {
  const { options, remaining } = parseCommonOptions(args);
  if (remaining.length > 0) {
    throw new Error(`unknown check argument: ${remaining[0]}`);
  }
  if (options.evidenceOverlays.length > 0) {
    throw new Error("check does not accept --evidence-overlay");
  }
  const dataset = loadDataset(options.dataset);
  const overlayEvidence = loadReviewOverlayEvidence(requireOverlay(options));
  const result = assessReviewOverlay(
    dataset,
    datasetSha256(options.dataset),
    overlayEvidence.overlay
  );
  console.log(
    JSON.stringify(
      {
        ok: result.readyToApply,
        command: "check",
        dataset: `${dataset.name}@${dataset.version}`,
        overlaySha256: overlayEvidence.sha256,
        ...result,
      },
      null,
      2
    )
  );
  if (!result.readyToApply) process.exitCode = 1;
}

function applyCommand(args: string[]): void {
  const { options, remaining } = parseCommonOptions(args);
  let output: string | null = null;
  let version: string | null = null;
  let finalize = false;
  for (const arg of remaining) {
    const outputValue = optionValue(arg, "output");
    if (outputValue !== null) {
      if (output !== null) throw new Error("--output may be provided only once");
      output = path.resolve(outputValue);
      continue;
    }
    const versionValue = optionValue(arg, "version");
    if (versionValue !== null) {
      if (version !== null) throw new Error("--version may be provided only once");
      version = versionValue;
      continue;
    }
    if (arg === "--finalize") {
      finalize = true;
      continue;
    }
    throw new Error(`unknown apply argument: ${arg}`);
  }
  if (output === null) throw new Error("--output is required");
  if (version === null) throw new Error("--version is required");
  const overlayFile = requireOverlay(options);
  const resolvedTargets = new Set([
    path.resolve(options.dataset),
    path.resolve(overlayFile),
    ...options.evidenceOverlays.map((file) => path.resolve(file)),
  ]);
  if (resolvedTargets.has(output)) {
    throw new Error("--output must not overwrite an input artifact");
  }
  const dataset = loadDataset(options.dataset);
  const overlayEvidence = loadReviewOverlayEvidence(overlayFile);
  const priorEvidence = options.evidenceOverlays.map((file) =>
    loadReviewOverlayEvidence(file)
  );
  const result = applyReviewOverlay(
    dataset,
    datasetSha256(options.dataset),
    overlayEvidence.overlay,
    overlayEvidence.sha256,
    version,
    {
      finalize,
      evidence: priorEvidence,
    }
  );
  writeExclusiveJson(output, result);
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "apply",
        source: `${dataset.name}@${dataset.version}`,
        outputDataset: `${result.name}@${result.version}`,
        publicationStatus: result.publicationStatus,
        scenarios: result.scenarios.length,
        reviewedScenarios: result.scenarios.filter(
          (scenario) => scenario.review.status === "reviewed"
        ).length,
        overlaySha256: overlayEvidence.sha256,
        output,
        outputSha256: datasetSha256(output),
      },
      null,
      2
    )
  );
}

function verifyCommand(args: string[]): void {
  const { options, remaining } = parseCommonOptions(args);
  if (remaining.length > 0) {
    throw new Error(`unknown verify argument: ${remaining[0]}`);
  }
  const evidenceFiles = [
    ...(options.overlay === null ? [] : [options.overlay]),
    ...options.evidenceOverlays,
  ];
  if (evidenceFiles.length === 0) {
    throw new Error("verify requires --overlay or --evidence-overlay");
  }
  const dataset = loadDataset(options.dataset);
  const evidence = evidenceFiles.map((file) => loadReviewOverlayEvidence(file));
  const evidenceIssues = verifyDatasetReviewEvidence(dataset, evidence);
  const readiness = assessPublicationReadiness(dataset);
  const issues = [...readiness.issues, ...evidenceIssues];
  console.log(
    JSON.stringify(
      {
        ok: issues.length === 0,
        command: "verify",
        dataset: `${dataset.name}@${dataset.version}`,
        publication: readiness,
        reviewEvidence: {
          suppliedOverlays: evidence.length,
          issues: evidenceIssues,
        },
        issues,
      },
      null,
      2
    )
  );
  if (issues.length > 0) process.exitCode = 1;
}

function main(args: string[]): void {
  const command = args[0] as ReviewCommand | undefined;
  const commandArgs = args.slice(1);
  if (command === "packet") return packetCommand(commandArgs);
  if (command === "check") return checkCommand(commandArgs);
  if (command === "apply") return applyCommand(commandArgs);
  if (command === "verify") return verifyCommand(commandArgs);
  throw new Error(
    "first argument must be one of: packet, check, apply, verify"
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
