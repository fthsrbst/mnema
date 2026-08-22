# Release evidence checklist

This checklist applies separately to a corpus release and to every published
provider comparison. A green command is evidence only for the scope it checks.

## Corpus release

- [ ] Dataset name, semantic version, track, and SPDX license identifier are
      final.
- [ ] `DATA_LICENSE.md` and required third-party attributions are included.
- [ ] Exact dataset SHA-256 is recorded.
- [ ] All adapted material names a pinned source URI and verified license.
- [ ] Imported corpora match the exact registered revision, byte size, and
      SHA-256; normalized outputs retain those fields.
- [ ] No downloaded third-party dataset, screenshot bundle, cache, credential,
      personal data, or confidential text is committed.
- [ ] Every retained scenario has an independent declared-human approval.
- [ ] Reviewer identity and conflicts were checked by a distinct human
      maintainer-verifier in the same hash-bound overlay.
- [ ] Maintainer verification timestamps do not predate their reviews, and
      every identity/conflict disposition is complete.
- [ ] Every approval and revision overlay is preserved byte-for-byte.
- [ ] Rejected scenarios and review notes remain auditable in overlays.
- [ ] Corpus size, per-ability coverage, duplicates, language, difficulty, and
      template concentration were reviewed.
- [ ] The release gate passes with every evidence overlay supplied:

  ```bash
  npm run bench:memory:release-check -- \
    --dataset=/path/to/public-core-v1.json \
    --review-overlay=/path/to/review-round-1.json \
    --review-overlay=/path/to/review-round-2.json
  ```

- [ ] `npm run build`, `npm run bench:memory:check`,
      `npm run bench:memory:smoke`, and `npm run smoke` pass.
- [ ] Dataset, overlays, checksums, source commit, and release notes are tagged
      together; no artifact is replaced in place.

## Adapter qualification

- [ ] API/SDK contract is pinned to a documented provider version or date.
- [ ] Authentication fails before an unauthenticated request is sent.
- [ ] API keys, project IDs, raw namespace names, and provider secrets are
      absent from reports and logs.
- [ ] Write, search, update, delete, settling, timeout, retry, partial failure,
      and idempotent cleanup paths were exercised.
- [ ] The run uses a fresh disposable namespace and cleanup is verified.
- [ ] Unsupported operations and replacement semantics are disclosed.
- [ ] Provider model, embedding model, thresholds, reranker, hosting region,
      and other quality-affecting configuration are pinned.
- [ ] A `component-qualification.schema.json` overlay binds the complete
      adapter configuration, core report, and agent report by SHA-256.
- [ ] Submitter, independent human reviewer, and human maintainer-verifier are
      distinct; conflicts and affiliations are disclosed.
- [ ] `npm run bench:memory:qualify -- check ...` passes against the exact
      evidence files included in the release bundle.

## Reader and judge qualification

- [ ] Reader and judge configuration hashes pin model, API surface, endpoint,
      prompt revision, request policy, temperature, and storage policy.
- [ ] The network endpoint is a live public service, not loopback, `.local`,
      `.test`, `.invalid`, or a fake/contract server.
- [ ] Endpoint configuration contains no embedded username, password, query
      token, or fragment.
- [ ] The judge qualification binds an exact, comparable, zero-mismatch
      evaluator-parity artifact.
- [ ] Each component has a distinct submitter, independent human reviewer, and
      human maintainer-verifier with role-specific attestations.
- [ ] `npm run bench:memory:qualify -- check ...` passes for every unique
      reader and judge configuration hash used by the comparison.

## Published comparison

- [ ] The dataset is a released, evidence-verified corpus.
- [ ] Every adapter runs in a separate process with the same immutable dataset.
- [ ] Agent comparisons record distinct child PIDs and one shared
      reader/judge evaluation SHA-256.
- [ ] Every published agent report has a hash-bound evaluator-parity artifact
      produced from the pinned LongMemEval Python evaluator at commit
      `9e0b455f4ef0e2ab8f2e582289761153549043fc`.
- [ ] The parity artifact has exact question-ID coverage, exact hypotheses,
      one matching model ID, a pinned prompt revision, and no unexplained
      label mismatches; any retained mismatch is published and discussed.
- [ ] An independent reviewer verifies the official evaluator invocation and
      live-run provenance rather than relying on a self-authored JSONL file.
- [ ] Raw normalized reports and the comparison manifest are published.
- [ ] A statistical-comparison artifact is generated from the exact comparison
      and report files with a published seed, iteration count, confidence
      level, and scenario-cluster resampling method.
- [ ] `npm run bench:memory:statistics -- check ...` passes; every applicable
      quality metric has at least two eligible scenario clusters and no
      `insufficient-data` blocker.
- [ ] Statistical intervals are presented as unadjusted descriptive
      corpus-sampling uncertainty, not as universal rankings, significance
      tests, or repeated-run provider variance.
- [ ] Dataset/report hashes, source commit, dirty state, runtime environment,
      latency, ingestion settling, request counts, cost availability, and
      cleanup status are present.
- [ ] Query-quality failures remain results; runtime failures are not converted
      into zero-quality scores or silently skipped.
- [ ] No provider received query-specific tuning or undisclosed retries.
- [ ] Provider affiliation and sponsorship are disclosed.
- [ ] At least one unaffiliated maintainer/reviewer reproduced or audited an
      official live result.
- [ ] Contract-server numbers are not presented as provider performance.
- [ ] The source commit is present and clean; reports and evidence are generated
      from that exact commit.
- [ ] Every candidate component hash resolves to a qualified overlay, and each
      report resolves to its own exact evaluator-parity artifact.
- [ ] `npm run bench:memory:publish-agent -- check` passes against the immutable
      comparison, reports, paired statistical artifact, qualifications, parity
      artifacts, and release metadata.
- [ ] `npm run bench:memory:publish-agent -- finalize` produces a schema-valid
      final
      manifest with `resultClass: "benchmark"`, no blockers, and
      `publicationEligible: true`.
- [ ] Release notes list known limitations, missing telemetry, and corrections
      from prior versions.
