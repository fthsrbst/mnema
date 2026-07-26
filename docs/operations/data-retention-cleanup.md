# Data retention and safe cleanup

Mnema knowledge is not a cache. A stale or duplicate-looking row may still be
provenance, rollback evidence, or an offline peer's only deletion signal. Cleanup
therefore uses a staged workflow, never ad-hoc SQL deletion.

## 1. Inventory without writes

Run the read-only audit against the actual database:

```bash
npm run cleanup:audit -- --db=/absolute/path/hub.db
```

Narrow it when reviewing a project:

```bash
npm run cleanup:audit -- --db=/absolute/path/hub.db --project=ai-hub --stale-days=90 --invalidated-days=30
```

The report separates:

- current low-value memories that should be archived first;
- invalidated memories whose observation window has elapsed;
- exact-title duplicate groups requiring a canonical choice;
- disabled, superseded, or expired RAG documents;
- old compacted sessions;
- operational rows eligible for normal retention pruning;
- tombstone and audit counts, which are protected by default.

Candidate status is not deletion approval.

## 2. Back up and verify

Use SQLite's online backup API so the copy is transactionally consistent:

```bash
npm run backup:copy -- /absolute/path/hub.db /absolute/path/backups/hub-before-cleanup.db
```

The command refuses to reuse the source path and runs `PRAGMA integrity_check`
on the copy. Keep this backup until every peer has synced and the observation
window has passed.

## 3. Archive, observe, then purge

For current but stale memories:

1. Review the title, body, project, relations, and source.
2. Add the `archived` tag/reduce importance using `archiveStale`; do not delete.
3. Observe for at least 14 days and check retrieval feedback.
4. If the fact is wrong, invalidate it with evidence instead of merely archiving.
5. Only after review, prepare an explicit manifest of IDs/UIDs approved for purge.

For duplicates, select one canonical record, rewire useful relations, and
invalidate the superseded copy first. Automated "delete every duplicate" is
forbidden because duplicate detection is a candidate generator, not a proof.

## 4. Delete through domain APIs

Approved deletions must use Mnema APIs, not `DELETE FROM ...`:

- memory: MCP `memory_delete` or REST `DELETE /api/memory/:id`;
- document: REST `DELETE /api/rag/documents/:id`;
- session: REST `DELETE /api/sessions/:id`;
- operational retention: the existing `pruneOld*` functions/maintenance loop.

These paths maintain vectors, relations, change logs, and sync tombstones.
Record the reviewed manifest, backup path, operator, timestamp, and reason in
the change ticket or session log.

## 5. Protect tombstones and audit history

Do not routinely remove `deletions`. Offline peers need tombstones to learn that
a row was deleted; removing them early can resurrect old knowledge. Tombstone
compaction is allowed only after a future peer-watermark mechanism proves every
registered peer has observed each deletion.

Do not trim `audit_events` as ordinary cleanup. If legal retention eventually
requires it, export and verify the chain first and treat the operation as a
separate audited migration.

## 6. Verify after purge

After the approved manifest is applied:

1. Run `PRAGMA integrity_check` through another `cleanup:audit`.
2. Run the full smoke and context evaluation suites.
3. Sync every peer and compare digests/consistency reports.
4. Verify removed IDs do not appear in normal retrieval or vectors.
5. Keep the backup through the observation window.

Database file size may not shrink immediately after row deletion. That is normal
SQLite freelist behavior. Schedule `VACUUM` only during a maintenance window,
after backup and with sufficient free disk space; it is not part of routine
knowledge cleanup.
