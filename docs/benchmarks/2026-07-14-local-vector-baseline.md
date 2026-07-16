# Local Vector Baseline — 2026-07-14

This is a reproducible development-workstation baseline, not a production capacity claim.

## Command

```powershell
npm run benchmark:vector -- --rows=10000 --queries=100 --projects=20 --dim=768 --gate
```

Environment: Windows, Node.js 24.15.0, sqlite-vec 0.1.6. Synthetic normalized vectors use a deterministic PRNG; every query uses an exact stored vector and an exact project filter.

## Result

| Metric | Result |
|---|---:|
| Rows | 10,000 |
| Projects | 20 |
| Dimensions | 768 |
| Insert throughput | 12,378 rows/s |
| Filtered vector recall@10 | 1.0 |
| Vector p50 / p95 / max | 1.844 / 2.410 / 2.704 ms |
| FTS recall@10 | 1.0 |
| FTS p50 / p95 / max | 0.093 / 0.134 / 0.616 ms |
| SQLite size | 63.17 MiB |
| Process RSS at completion | 158.23 MiB |

## Interpretation

- The current local filtered index has substantial headroom over the 10k-vector development corpus.
- Exact-vector recall is a structural sanity check, not a semantic retrieval-quality benchmark.
- The result does not prove 100k/million-vector performance, concurrent-agent tail latency, Pi performance, or Qdrant cluster performance.
- Run the same harness on the target host at increasing row counts. Activate Qdrant only when representative p95, recovery time, concurrency, isolation, or recall gates justify it.
- Company acceptance still requires production-shaped text/embedding distributions, concurrent queries, context-level eval, backup/restore timing, and failure injection.
