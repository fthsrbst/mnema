# Context evaluation

`context-golden.json` is the checked-in seed regression set. It is useful for catching authority-order, stale-status, negative-query, bilingual routing, and known retrieval regressions, but it is not large enough to approve ranking changes.

Run:

```bash
npm run eval:context
```

The release gate requires at least 50 human-reviewed cases and a 100% pass rate:

```bash
npm run eval:context:release
```

Do not satisfy the gate by duplicating or mechanically paraphrasing cases. Each case must be labelled from a real information need, carry non-empty `reviewed_by` and `reviewed_at` fields after a person verifies it, and include at least one of: expected authority, expected memory/document, forbidden stale source, explicit empty evidence, or isolation warning. Keep a balanced set across current status, decisions, technical history, documentation, preferences, multilingual queries, negative queries, and project isolation.

When ranking changes, record both the before and after report. A gain in average recall does not permit a stale current-status hit or cross-project leak.
