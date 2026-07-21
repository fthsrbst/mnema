# ADR-005: Change-log delivery watermark for device sync

- Status: Accepted
- Date: 2026-07-21

## Context

Mnema replicates between three devices (fatih-pc, fatihpi as primary, fatih-mac)
in a star topology: each device pulls from the primary and then pushes its own
changes. Conflict resolution is last-writer-wins on `updated_at`, with a content
fingerprint as the deterministic tie-break.

The pull watermark is wrong in a way that loses data permanently.
`collectChanges(since)` filters rows by their **own** `updated_at`
(`WHERE updated_at >= ?`), while the watermark advances to the primary's **wall
clock** (`setSyncState({ last_pull: remote.now })`). A row that reaches the
primary *after* its own `updated_at` — which happens whenever a third device
syncs late — is invisible to every peer whose watermark has already passed that
timestamp. Such a row is never delivered again.

This is not hypothetical: on 2026-07-21 an audit found 8 memories and 14 session
logs that had never reached fatih-pc, with no tombstone. They were recovered by
hand with a full `since=1970-01-01` sweep.

The defect is not limited to memories. Every table in `collectChanges` uses the
same event-time filter — memories, documents (with chunks embedded), relations,
projects, sessions, machines, assets, agent_presence, tasks, agent_capabilities,
agent_messages, and deletions: twelve tables. `agent_messages` filters on
`created_at` instead, but belongs to the same failure class. Because `assets`
carries skills and prompts, the same bug can silently withhold a skill from a
device.

Two implementation shapes were considered:

1. **A `sync_seq` column on every syncable table.** Each local write and each
   remote apply assigns a fresh value from a monotonic counter. Simple to query,
   but it requires touching every write path in twelve tables. This project has
   already shipped that class of bug twice — a schema field was added while a
   handler silently dropped it (`origin_machine` in the session-log write path),
   and embeddings were missed on some rows.
2. **A central `change_log` table fed by triggers.** One table, one trigger pair
   per source table. A trigger cannot be bypassed by a forgotten handler.

## Decision

Sync delivery is driven by a monotonic sequence produced by a central
`change_log` table, written by SQLite triggers.

```sql
CREATE TABLE change_log(
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl        TEXT NOT NULL,
  row_key    TEXT NOT NULL,   -- uid; name for projects and machines
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
```

`AUTOINCREMENT` is required rather than a plain `INTEGER PRIMARY KEY`: the plain
form reuses the highest deleted rowid, which would break monotonicity after
pruning.

Triggers are installed through a single helper,
`installChangeTrigger(db, tbl, rowKeyExpr, { update })`, so that insert-only
tables (`agent_messages`) get no `AFTER UPDATE` trigger, and so that Phase 2 can
attach an append-only promotion table to sync in one line.

The mechanism that fixes the bug: `applyChanges` writes remote rows with ordinary
`INSERT`/`UPDATE`, so the trigger stamps them with a **fresh local seq**. A
late-arriving row therefore receives a new sequence number on the primary and
becomes visible to peers whose watermark has already advanced.

Supporting decisions:

- **Deletions keep their own table.** `deletions` is a tombstone — a fact used by
  LWW in nine separate checks (`tomb.deleted_at >= row.updated_at`). `change_log`
  is a delivery notification. Merging them would mean rewriting every one of
  those checks. Deletion events reach `change_log` only through a trigger on
  `deletions`; consequently, deleting a row directly from a data table without
  writing a tombstone does not replicate. That is now a stated invariant, not an
  accident.
- **Pruning keeps only the highest seq per row**
  (`DELETE FROM change_log WHERE seq NOT IN (SELECT MAX(seq) ... GROUP BY tbl, row_key)`).
  This is safe for every peer regardless of its watermark, because a peer only
  ever needs the latest state of a row. Pruning runs on a row-count threshold
  after a sync cycle, not unconditionally.
- **Echo is avoided by ordering, not by a new column.** Applying remote rows
  stamps them with local seqs, which would push them straight back to their
  origin. Collecting the local push set *before* applying the remote payload
  removes the echo without an `origin_peer` column and its trigger-visible
  session state.
- **Triggers are installed as the last step of the migration chain.** Existing
  data migrations (notably `INSERT OR REPLACE INTO deletions` in
  `migrateDeletionPrimaryKey`) would otherwise flood `change_log` and rebroadcast
  every historical tombstone.
- **Backward compatibility.** The server accepts both `?since_seq=` and the
  legacy `?since=`; payloads carry `max_seq`. A client that sees no `max_seq`
  falls back to timestamp mode. A client with no `last_pull_seq` performs one
  full `since=1970-01-01` sweep and then switches to seq mode, which automates
  the manual repair described above. `last_pull` continues to be updated
  alongside `last_pull_seq` so the fallback path never resumes from a frozen
  timestamp. The primary must be deployed first; otherwise clients stay on the
  fallback and the fix never activates.
- **A consistency check is part of the feature, not a follow-up.**
  `GET /api/sync/digest` returns per-table `{count, uid_hash, max_seq}`.
  Comparing `last_pull` freshness was never evidence that sync worked; comparing
  counts and uid sets is. A full content hash is available on demand rather than
  every cycle, because hashing every row on a Raspberry Pi 5 is not free.

The watermark continues to be written *after* a successful apply. That ordering
is already crash-safe: a crash leaves the old watermark, the rows are re-fetched,
and re-apply is idempotent under LWW.

## Consequences

- Late-arriving rows are delivered. The failure that silently dropped 22 records
  cannot recur through this path.
- Divergence becomes observable instead of invisible. The digest endpoint turns a
  silent class of bug into a reported one.
- `change_log` is new operational surface: it grows on every write, including
  writes that arrive from sync, and it requires pruning. This is accepted as the
  cost of not being able to forget a write path.
- A trigger is harder to notice than a handler when reading code. The helper and
  this ADR are the mitigation.
- Twelve tables gain triggers, so bulk data migrations must consider whether they
  want to emit change events, and must run before trigger installation if they do
  not.
- **Not addressed here:** `projects` stores a project map as one JSON blob under
  `name PRIMARY KEY`, so two agents editing different fields of the same map on
  different devices still lose one side's edit to whole-document LWW. The change
  log makes the write visible; it does not make the merge field-aware. That is a
  separate work item.
- **Not addressed here:** `agent_messages` is insert-only by design, so `read_at`
  never replicates; read state is device-local. Documented, not changed.
