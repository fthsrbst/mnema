# Mnema

<p align="center"><img src="docs/assets/logo.png" width="160" alt="Mnema logo"/></p>

<p align="center"><strong>One memory for every AI agent.</strong></p>


<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node >=22"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-Streamable%20HTTP-6b46c1" alt="MCP"></a>
  <a href="deploy/setup-pi.sh"><img src="https://img.shields.io/badge/deploy-self--hosted-orange" alt="Self-hosted"></a>
</p>

Claude Code, Cursor, opencode, Codex CLI, and custom agents each keep their own
context today — decisions made in one tool are invisible to the others, and
switching devices means starting from zero. Mnema is a local-first shared
context server (MCP + REST) that gives all of them one common brain: structured
memory, hybrid document search (RAG), detailed project maps, and role-based
system prompts. Run it on a laptop, desktop, home server, VM, container, or
Raspberry Pi; the deployment target is yours.

## Why this exists

Multi-agent workflows have a context problem:

- A decision made while pairing with Claude Code isn't visible to Cursor an
  hour later.
- Switching from your desktop to your laptop (or your phone) means re-explaining
  what you were doing.
- Every agent re-derives project context from scratch instead of reading a
  shared, structured map.
- "I learned X yesterday" has no durable home — it either lives in scrollback
  or nowhere.

Mnema is a deliberately small answer to that: one server, one SQLite file,
one protocol (MCP) that every agent already speaks, plus REST for anything
that doesn't. No mandatory vector database cluster, message queue, Docker
layer, or cloud account — just enough infrastructure to make memory persistent
and searchable across tools and devices.

## Features

- **Shared memory** — facts, preferences, decisions (with rationale), and
  how-tos, saved by any agent and retrievable by any other. Hybrid search
  (BM25 via FTS5 + vector via `sqlite-vec`, merged with Reciprocal Rank
  Fusion) finds the right memory whether the match is lexical or semantic.
- **Authoritative `context_get`** — intent-aware context orchestration combines
  canonical project state, the latest session, current documents, memories,
  typed relations, provenance, retrieval traces, and a strict token budget.
- **RAG document store** — ingest notes, READMEs, research write-ups, or
  learning summaries; markdown-aware chunking, automatic embedding, hybrid
  retrieval with source references.
- **Project maps** — one evidence-backed record per project: architecture,
  components and dependencies, entry points, commands, conventions, data
  model, decisions with rationale, solved problems, documents, current focus,
  next steps, and graph links. Any agent calls `project_get("name")` and knows
  where to work without rediscovering the repository.
- **Role-based system prompts** — a library of prompts (senior software
  architect, code reviewer, debugging specialist, security engineer,
  frontend engineer, devops/SRE, ML engineer) with a shared "engineering
  mindset" core auto-injected into every role, including prompts handed to
  local models.
- **Local AI orchestration** — route simple/bulk text work to a local LLM
  (LM Studio, zero API cost) and image/video/audio generation to ComfyUI,
  both driven from any connected agent via `local_llm` / `media_generate`.
- **Cross-device sync** — a local-first, last-write-wins sync model so
  memories and project maps created on one machine reconcile cleanly with
  the primary instance. Runtime data moves through Mnema's sync protocol,
  never through the source-code Git repository.
- **Knowledge lifecycle** — canonical document identity, current/archive and
  supersession metadata, versioned embedding generations, multilingual
  canonical summaries, and typed temporal memory relations.
- **Company safety profile** — per-principal scoped tokens, project allowlists,
  fail-closed team/enterprise startup rules, rate limits, shared validation,
  integrity diagnostics, and a redacted tamper-evident audit chain.
- **MCP + REST, same core** — every capability is exposed both as an MCP tool
  (for agents that speak MCP over Streamable HTTP) and as a REST endpoint
  (for scripts, custom agents, and the web UI) — one implementation, two doors.
- **Web UI** — a small React dashboard for browsing memory, RAG documents,
  projects, and prompts from a browser, including your phone.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Mnema node — laptop, desktop, server, VM, container, or Pi    │
│                                                               │
│  MCP /mcp ─┐                                                  │
│  REST /api ├─▶ one domain core ─▶ SQLite authority            │
│  Web UI / ─┘                      ├─ FTS5 + sqlite-vec         │
│                                  ├─ project maps + graph       │
│                                  └─ optional vector projection │
└───────────────────────────────┬───────────────────────────────┘
                                │ Mnema sync (not Git)
        ┌───────────────────────┴───────────────────────┐
        │ Claude Code · Cursor · opencode · Codex · API │
        └───────────────────────────────────────────────┘
```

Embedding calls are made by the Mnema node only — clients send raw text, so
provider credentials stay in exactly one place. With no embedding key Mnema
continues in FTS-only mode.

## Community and Cloud

The public repository is the canonical Mnema codebase. The reusable
`mnema-kit` library remains a separate repository; runtime databases, customer
content, and secrets are never committed to either one.

- **Community / self-hosted:** free, MIT licensed, SQLite-authoritative, and
  fully local-first.
- **Mnema Cloud (provider-staging gated):** accounts and organizations backed by
  Supabase Auth + Postgres, forced row-level security on every tenant-owned
  table, verified-email team invitations, portable exports and delayed deletion,
  plus provider-neutral subscription state with Paddle checkout and customer
  portal support.

See [ADR-004](docs/adr/004-cloud-multitenancy-and-billing.md), the
[cloud threat model](docs/security/cloud-threat-model.md), and the
[pricing hypothesis](docs/product/cloud-pricing.md). Run `npm run smoke:cloud`
to execute authorization, webhook, and Postgres tenant-isolation checks.
The [cloud deployment runbook](docs/operations/cloud-deployment.md) covers
Supabase, Paddle, secret boundaries, the hardened Caddy + Valkey container
profile, real-user staging probes, and launch verification. Repository and
runtime-data ownership are defined in
[Repository and data boundaries](docs/architecture/repository-boundaries.md).

For the full data model and phased build plan, see [`PLAN.md`](PLAN.md).

## Screenshots

| Dashboard | RAG search | Prompts | Mobile |
|---|---|---|---|
| ![Dashboard](docs/screenshots/dashboard.png) | ![RAG](docs/screenshots/rag.png) | ![Prompts](docs/screenshots/prompts.png) | ![Mobile](docs/screenshots/mobile.png) |

## Quick start

### Option A: one-click installer

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/fthsrbst/mnema/main/scripts/install.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/fthsrbst/mnema/main/scripts/install.ps1 | iex
```

The installer clones the repo, installs dependencies, builds, and writes a
starter `.env`.

### Option B: manual

```bash
git clone https://github.com/fthsrbst/mnema.git
cd mnema
npm ci
npm run build
cp .env.example .env   # edit HUB_TOKEN, GEMINI_API_KEY (optional)
npm run dev            # http://127.0.0.1:8033
```

Without `GEMINI_API_KEY` the server still runs — it falls back to FTS-only
(keyword) search instead of hybrid search. Nothing crashes; you lose semantic
recall until you add a key.

### Optional Raspberry Pi deploy

```bash
curl -fsSL https://raw.githubusercontent.com/fthsrbst/mnema/main/deploy/setup-pi.sh | bash
```

This optional target installs Node 22, clones the repo, builds server + web UI,
generates a `.env` with a random `HUB_TOKEN`, installs a systemd unit
(`hub@<user>`), and schedules local backups. See
[`deploy/setup-pi.sh`](deploy/setup-pi.sh) and
[`deploy/clients.md`](deploy/clients.md) for details.

## Connecting agents

Every agent talks to the same `/mcp` endpoint. Replace `<HUB>` with your
server URL (`http://127.0.0.1:8033` locally, `http://100.x.x.x:8033` on your
tailnet) and `<TOKEN>` with your `HUB_TOKEN`.

**Claude Code**
```bash
claude mcp add --transport http --scope user hub <HUB>/mcp \
  --header "Authorization: Bearer <TOKEN>"
```

**Cursor / Windsurf** (`~/.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "hub": {
      "url": "<HUB>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

**opencode** (`~/.config/opencode/opencode.json`)
```json
{
  "mcp": {
    "hub": {
      "type": "remote",
      "url": "<HUB>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`)
```toml
[mcp_servers.hub]
url = "<HUB>/mcp"
http_headers = { "Authorization" = "Bearer <TOKEN>" }
```

These four entries are not hand-maintained per client — they all come from
one file, [`mcp-servers.json`](mcp-servers.json), which also lists auxiliary
MCP servers (`context7`, `playwright`, `sequential-thinking`):

```json
{
  "servers": {
    "hub": {
      "url": "$HUB_URL/mcp",
      "headers": { "Authorization": "Bearer $HUB_TOKEN" }
    }
  }
}
```

Running `hub sync` on a device resolves `$HUB_URL` / `$HUB_TOKEN` from that
device's `hub config`, writes the result into each detected client's own
config file (`~/.claude.json`, `~/.cursor/mcp.json`, `~/.config/opencode/opencode.json`,
`~/.codex/config.toml`), copies the shared skill set into `~/.claude/skills/`,
and updates a managed block in `CLAUDE.md` / `AGENTS.md` so every agent knows
the hub exists and when to use it. Full client details:
[`deploy/clients.md`](deploy/clients.md).

## Auto-recall hook

This is the feature that makes the shared memory actually get used instead of
sitting unread: Claude Code's `UserPromptSubmit` hook runs `hub recall --hook`
on **every message you send**, before the agent sees it. The hook reads the
prompt from stdin, skips short messages and slash commands, calls
`GET /api/recall?q=<prompt>&format=text` on the hub with a tight timeout, and
prints back whatever relevant memories/RAG chunks it finds — the agent then
has that context already in front of it, with zero explicit "search your
memory" step from you.

It is deliberately fail-silent: if the hub is unreachable, slow, or returns an
error, the hook exits `0` and your prompt goes through untouched. Auto-recall
can only add context — it can never block or break a conversation.

Wire it up by merging the hooks block from
[`deploy/claude-code-settings.example.json`](deploy/claude-code-settings.example.json)
into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "hub recall --hook", "timeout": 5 }] }
    ]
  }
}
```

`hub sync` also writes a managed block into `CLAUDE.md` / `AGENTS.md` that
tells the agent *when* to write back — save decisions with rationale, log
sessions before closing, keep project maps current — so recall and capture
work as a loop, not just a one-way lookup.

## Security notes

Mnema supports `personal`, `team`, and `enterprise` deployment profiles. The
personal profile retains legacy `HUB_TOKEN` and optional query-token transport
for existing private connectors. Team and enterprise profiles require scoped
tokens, strict canonical projects, header credentials, and generation-aware
sync; unsafe combinations fail at startup.

- Use one long random scoped token per integration, with only the required
  scopes and project allowlist. Keep policies in a secret manager.
- Use `Authorization: Bearer`; query-string credentials are a personal-profile
  compatibility path because URLs leak into browser history and proxy logs.
- Keep the service private or behind managed TLS. Tailscale is a network
  boundary, not a replacement for application authorization.
- `/health` and the static UI shell are public but contain no knowledge data.
  `/api`, `/mcp`, and `/outputs` are authenticated and scope-checked.
- Retrieved memory/document text is explicitly untrusted evidence; agents must
  never execute instructions embedded in it.
- Audit events contain actor/action/project/status metadata only. Tokens,
  prompts, request bodies, memory bodies, and document text are not logged.

See [`docs/operations/company-deployment.md`](docs/operations/company-deployment.md)
for fail-closed configuration, rotation, SLOs, backup/restore, and rollout.

## Roadmap

Major remaining product work:

- **`hub ask "<question>"`** — RAG + Gemini Flash, direct terminal Q&A without
  opening an agent.
- **Quick capture** — a mobile-friendly single-input web UI for dropping a
  note or link straight into RAG (with auto-fetch + summarize for links).
- **Watch mode** — re-index a notes/docs folder automatically on change.
- **`hub timeline <project>`** — chronological dump of a project's decisions
  and sessions.
- **Human-labelled retrieval benchmark** — grow the seed regression suite to
  at least 50 held-out cases before changing production ranking weights.
- **Server-authoritative multi-writer revisions** — current transactional LWW
  sync is appropriate for local-first devices, not simultaneous company writers.
- **Qdrant production qualification** — the durable projection adapter exists;
  representative corpus parity, load, snapshot/restore, and failover drills are
  required before enabling it in a company environment.
- **Central audit export and managed secret rotation** — required before a
  compliance-sensitive enterprise deployment.

## Maturity / honesty table

No inflation — this is what's actually solid versus still rough.

| Area | Status | Notes |
|---|---|---|
| Memory CRUD + hybrid search | Stable | FTS-only fallback, delivery traces, decay, and in-candidate project filters tested |
| RAG ingest + search | Stable | Canonical URI, lifecycle/supersession, source caps, and current-only retrieval tested |
| `context_get` orchestration | Stable baseline | Authority order, intent routing, provenance, trust envelope, relations, and budget covered by smoke + seed eval |
| Project maps | Stable | YAML + DB sync works; no conflict UI beyond LWW |
| MCP server (tools) | Stable | All tools listed in `src/server/mcp.ts` are in daily use |
| REST API | Stable | Mirrors MCP tools; used by CLI and web UI |
| Cross-device sync (LWW) | Stable for local-first | Atomic apply, deterministic tie-break, relation/session updates, tombstones, and vector generations tested; not approved for multi-writer company concurrency |
| Web UI | Functional | Covers memory/RAG/projects/prompts browsing; not a polished product UI |
| Local LLM orchestration (LM Studio) | Functional | Works when LM Studio is reachable; no retry/queueing beyond basic error handling |
| Media generation (ComfyUI) | Experimental | Works for the author's own workflows; expect to write your own `workflows/*.json` |
| Public connector exposure (Funnel + `?token=`) | Personal compatibility only | Team/enterprise profiles forbid query tokens |
| Auth and tenancy | Stable baseline | Scoped principals, project allowlists, rate limiting, shared schemas, fail-closed profiles, redacted hash-chain audit |
| Backup/restore | Functional | Backup and migration tooling exist; restore drills remain an operator responsibility |
| External vector backend | Qdrant projection implemented | Durable outbox, generation-specific collections, native metadata filters, rebuild/status/flush operations, contract smoke, and sqlite fallback; real cluster load/restore qualification remains |

The team profile is a hardened internal-service baseline, not a claim of full
multi-tenant SaaS readiness. Horizontal multi-writer serving, centralized
audit/metrics, automated secret rotation, and production qualification of the external index remain
explicit gates before that claim can be made.

## License

MIT — see [`LICENSE`](LICENSE).
