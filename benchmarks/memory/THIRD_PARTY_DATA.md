# Third-party data registry

No third-party dataset is currently vendored or redistributed by Memory Bench.
Importers should read a user-supplied local copy or download only after explicit
user action, then record the exact source revision and checksum.

| Source | Observed data license | Repository status | Planned use |
|---|---|---|---|
| [LongMemEval cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) | MIT, observed 2026-07-27 | Not vendored; pinned import-by-path and harness runner implemented | Normalize chat histories; qualify pinned reader/judge and live provider adapters before publishing scores |
| [LongMemEval-V2](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2) | Apache-2.0, observed 2026-07-27 | Not vendored | Import-by-path; preserve multimodal/trajectory semantics and upstream checksums |

## Pinned LongMemEval cleaned source

Dataset revision:
`98d7416c24c778c2fee6e6f3006e7a073259d48f`.

| Subset | Upstream file | Bytes | SHA-256 |
|---|---|---:|---|
| oracle | `longmemeval_oracle.json` | 15,388,478 | `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c` |
| small | `longmemeval_s_cleaned.json` | 277,383,467 | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |
| medium | `longmemeval_m_cleaned.json` | 2,737,100,077 | `9d79e5524794a2e6900a3aa9cb7d9152c5a3e8319c9a87c25494ba1eacee495f` |

The importer uses immutable `resolve/<revision>/<file>` URLs in generated
metadata and rejects any byte or digest mismatch. The synthetic contract
fixture in this repository contains no copied LongMemEval examples.

The agent judge is a TypeScript semantic port of
`src/evaluation/evaluate_qa.py` at LongMemEval repository commit
`9e0b455f4ef0e2ab8f2e582289761153549043fc`. The report records this revision
as part of the prompt identifier. The pinned script SHA-256 is
`ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251`.
No upstream Python source is vendored.
LongMemEval's repository is MIT licensed at that revision. A release must still
cross-check the port against the upstream script because Memory Bench uses the
current OpenAI Responses API while the pinned source uses Chat Completions.

The license shown by a hosting platform is evidence, not a permanent guarantee.
Before implementing or releasing an importer:

1. pin the exact repository revision or dataset commit;
2. archive the license text/hash and source URL in release metadata;
3. confirm that the license covers the data files, not only accompanying code;
4. retain required copyright, attribution, and modification notices;
5. review privacy/publicity rights independently of copyright; and
6. do not redistribute the source files when terms are ambiguous.

Memory Bench-derived reports and mappings must not imply endorsement by the
upstream authors.
