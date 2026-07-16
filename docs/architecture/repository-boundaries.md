# Repository and data boundaries

## Canonical repositories

- `fthsrbst/mnema` is the single public product repository. The former private
  development history and public release history are joined by a merge commit,
  so neither line of authorship is discarded.
- `fthsrbst/mnema-kit` remains a separate reusable library. It may expose shared
  contracts or clients, but it is not a second Mnema application repository.

There is no supported workflow that develops product features independently in
a private application repository and later copies selected files into public.
Product changes branch from and return to `fthsrbst/mnema`.

## Runtime data is not source code

The following never travel through Git or GitHub:

- SQLite/Postgres databases, WAL/journal files, vector indexes
- memory or RAG content
- customer exports and backups
- `.env` files, provider keys, tokens, or webhook secrets

Self-hosted replicas transport authoritative records through Mnema's sync
protocol. Cloud records stay inside the tenant-scoped Postgres data plane.
Backups use encrypted object/file storage with a tested restore path.

The root `.gitignore` blocks `data/`, `backups/`, `.env`, and SQLite artifacts.
CI secret scanning and a staged-file check should remain release gates.
