# Contributing to Memory Bench

Memory Bench accepts code, adapters, scenarios, review overlays, documentation,
and reproducible result bundles. Read [GOVERNANCE.md](GOVERNANCE.md) before
submitting review or leaderboard evidence.

## Contribution licenses and sign-off

- Code is contributed under the repository's MIT license.
- Original dataset scenarios and review artifacts are contributed under
  [CC BY 4.0](DATA_LICENSE.md).
- Every commit must include a Developer Certificate of Origin 1.1 sign-off:

  ```text
  Signed-off-by: Your Name <public-contact@example.com>
  ```

Use `git commit --signoff`. The sign-off certifies that you have the right to
submit the contribution under the license stated in the relevant file. It is a
public, durable record; use contact information you are willing to publish.
See the [Linux Foundation DCO
guidance](https://bestpractices.linuxfoundation.org/ip/contribution-mechanisms-dco.html).

## Scenario contributions

Prefer synthetic facts that do not describe a real person. Every scenario must:

1. use globally unique scenario, query, and record IDs;
2. declare BCP 47 language, difficulty, author identity/type, and origin;
3. contain an explicit query expectation, including `expectEmpty: true` for
   abstention;
4. keep relevant records live and in the query scope;
5. identify forbidden records/content where leakage would otherwise pass;
6. avoid credentials, personal data, copyrighted private text, harmful
   instructions, and confidential business information; and
7. remain `draft` until independently approved through a review overlay.

AI assistance is allowed, but `authorType` must be `ai` or `mixed`, the
generation template should be named, and AI output cannot self-certify its own
ground truth.

Run:

```bash
npm run bench:memory:check
npm run bench:memory:corpus-check -- --dataset=/path/to/candidate.json
npm run bench:memory:smoke
```

## Adapted datasets and scenarios

Do not copy a dataset because its code repository is open. Verify the license
on the exact data artifact and pinned revision. An adapted case must include
its source URI and retain required attribution/change notices.

The public core corpus normally accepts original contributions under
`CC-BY-4.0` and may import material under `CC0-1.0`, `CC-BY-4.0`, `MIT`, or
`Apache-2.0` only after maintainers confirm that the terms cover the data and
the intended redistribution. `NonCommercial`, `NoDerivatives`, custom
research-only, ambiguous, or missing terms are rejected from the public core
artifact. ShareAlike material requires a separate compatibility decision and
must not be merged by default.

If redistribution is unnecessary, contribute an importer that reads a
user-supplied local copy. Never commit downloaded source datasets, screenshots,
archives, API responses, or generated caches.

## Review contributions

Create a packet and overlay:

```bash
npm run bench:memory:review-packet -- \
  --dataset=/path/to/draft.json \
  --output-dir=artifacts/memory-bench/review-round-1
```

Fill the reviewer, affiliation/conflicts, attestations, timestamp, and
decisions. A distinct human maintainer-verifier must then fill their public
identity and affiliation, affirm reviewer-identity and conflict checks, record
a disposition, and use a verification timestamp at or after `reviewedAt`. Use a
note for every rejection or revision. Validate before submission:

```bash
npm run bench:memory:review-check -- \
  --dataset=/path/to/draft.json \
  --overlay=/path/to/review-overlay.json
```

Do not edit or reformat an overlay after it has been applied. Published review
evidence should contain public reviewer and maintainer identifiers, not private
email addresses.

## Adapter and result contributions

Adapters must use a disposable provider-native namespace, bounded timeouts,
secret-free reports, explicit unsupported-capability semantics, and verified
cleanup. A fake-server result is contract evidence only.

Live result pull requests must include the evidence listed in
[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md). Per-query/provider tuning after
seeing labels is prohibited. Missing cost or provider-processing data must be
reported as unavailable, never silently omitted or estimated without a method.

Generate a pending qualification overlay for every unique candidate adapter,
reader, and judge configuration with `npm run bench:memory:qualify -- template`.
Do not edit the source reports. An independent human reviewer and a distinct
human maintainer-verifier must complete the overlay; its evidence hashes must
still match when `bench:memory:qualify -- check` runs.

Bundle each qualification beside the exact evidence files named inside it.
Generate and check a paired statistical artifact from the immutable comparison
before publication; do not compare adapters whose observation identities or
metric missingness differ. Report its intervals as descriptive and unadjusted.
Create a post-run publication draft with
`npm run bench:memory:publish-agent -- template`, complete its release and
disclosure fields, and include the successful `check` plus finalized manifest
in the pull request. A draft, a candidate report, or a contract-server run is
not leaderboard evidence even if all aggregate scores look valid.
