import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeCorpus } from "./corpus.js";
import { assessPublicationReadiness, loadDataset } from "./dataset.js";
import {
  loadReviewOverlayEvidence,
  verifyDatasetReviewEvidence,
} from "./review.js";

const defaultDataset = fileURLToPath(new URL("../datasets/core-smoke-v1.json", import.meta.url));

function value(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const args = process.argv.slice(2);
for (const arg of args) {
  if (arg === "--release") continue;
  if (
    ![
      "--dataset=",
      "--minimum-queries=",
      "--minimum-per-ability=",
      "--review-overlay=",
    ].some((prefix) => arg.startsWith(prefix))
  ) {
    throw new Error(`unknown argument: ${arg}`);
  }
}
const minimumQueriesRaw = value(args, "minimum-queries");
const minimumQueries = minimumQueriesRaw === undefined ? 100 : Number(minimumQueriesRaw);
const minimumPerAbilityRaw = value(args, "minimum-per-ability");
const minimumPerAbility =
  minimumPerAbilityRaw === undefined ? 10 : Number(minimumPerAbilityRaw);
const datasetArgument = value(args, "dataset");
if (args.includes("--release") && datasetArgument === undefined) {
  throw new Error("--dataset is required with --release");
}
const datasetPath = path.resolve(datasetArgument ?? defaultDataset);
const dataset = loadDataset(datasetPath);
const publication = assessPublicationReadiness(
  dataset,
  minimumQueries,
  minimumPerAbility
);
const reviewOverlayPaths = args
  .filter((arg) => arg.startsWith("--review-overlay="))
  .map((arg) => path.resolve(arg.slice("--review-overlay=".length)));
if (new Set(reviewOverlayPaths).size !== reviewOverlayPaths.length) {
  throw new Error("--review-overlay paths must not contain duplicates");
}
const reviewEvidence = reviewOverlayPaths.map((file) =>
  loadReviewOverlayEvidence(file)
);
const reviewEvidenceIssues = verifyDatasetReviewEvidence(
  dataset,
  reviewEvidence
);
const result = {
  ...publication,
  ready: publication.ready && reviewEvidenceIssues.length === 0,
  issues: [...publication.issues, ...reviewEvidenceIssues],
};
const analysis = analyzeCorpus(dataset);

console.log(
  JSON.stringify(
    {
      dataset: `${dataset.name}@${dataset.version}`,
      publicationStatus: dataset.publicationStatus,
      ...result,
      reviewEvidence: {
        suppliedOverlays: reviewEvidence.length,
        issues: reviewEvidenceIssues,
      },
      analysis,
    },
    null,
    2
  )
);
if (args.includes("--release") && !result.ready) process.exitCode = 1;
