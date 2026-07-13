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
switching devices means starting from zero. Mnema is a small self-hosted
server (MCP + REST) that gives all of them one common brain: structured
memory, hybrid document search (RAG), project maps, and role-based system
prompts. It runs on a Raspberry Pi 5 on your own network and follows you
across every machine and every agent.

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
that doesn't. No vector database cluster, no message queue, no Docker layer —
just enough infrastructure to make memory persistent and searchable across
tools and devices.

## Features

- **Shared memory** — facts, preferences, decisions (with rationale), and
  how-tos, saved by any agent and retrievable by any other. Hybrid search
  (BM25 via FTS5 + vector via `sqlite-vec`, merged with Reciprocal Rank
  Fusion) finds the right memory whether the match is lexical or semantic.
- **RAG document store** — ingest notes, READMEs, research write-ups, or
  learning summaries; markdown-aware chunking, automatic embedding, hybrid
  retrieval with source references.
- **Project maps** — one YAML-backed record per project: summary, stack,
  decisions, current focus, next steps. Any agent, any device, calls
  `project_get("name")` and has full context instantly.
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
  the primary (Pi) instance.
- **MCP + REST, same core** — every capability is exposed both as an MCP tool
  (for agents that speak MCP over Streamable HTTP) and as a REST endpoint
  (for scripts, custom agents, and the web UI) — one implementation, two doors.
- **Web UI** — a small React dashboard for browsing memory, RAG documents,
  projects, and prompts from a browser, including your phone.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Raspberry Pi 5 — "hub"  (Tailscale IP: 100.x.x.x)             │
│                                                                │
│  ┌────────────────────────────────────────────┐               │
│  │ hub-server (Node 22, systemd)                │              │
│  │  ├── MCP endpoint   /mcp   (Streamable HTTP)  │             │
│  │  ├── REST API       /api/* (scripts, agents)  │             │
│  │  └── Web UI         /      (dashboard, PWA)   │             │
│  └───────────────┬────────────────────────────┘               │
│                  │                                            │
│  ┌───────────────▼────────────────────────────┐               │
│  │ SQLite (single file: hub.db)                  │             │
│  │  ├── memories      (structured memory)        │             │
│  │  ├── documents     (RAG source docs)           │             │
│  │  ├── chunks + vec  (sqlite-vec embeddings)     │             │
│  │  ├── chunks_fts    (FTS5 BM25 index)           │             │
│  │  └── projects      (project maps)              │             │
│  └────────────────────────────────────────────┘               │
│                                                                │
│  Nightly backup: sqlite backup + markdown export → git push   │
└──────────────────────────────────────────────────────────────┘
         ▲ Tailscale (private network; Funnel optional for public access)
         │
   ┌─────┴──────────────────────────────────────┐
   │ Devices (desktop, laptop, phone)             │
   │  ├── Claude Code  → MCP (Streamable HTTP)    │
   │  ├── Cursor / Windsurf → MCP (mcp.json)      │
   │  ├── opencode     → MCP (opencode.json)      │
   │  ├── Codex CLI    → MCP (config.toml)        │
   │  ├── claude.ai / ChatGPT / Gemini → MCP (Funnel + ?token=) │
   │  └── custom scripts → REST API               │
   └────────────────────────────────────────────┘
```

Embedding calls (Gemini API) are made from the Pi only — clients send raw
text, so the API key lives in exactly one place.

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

### Raspberry Pi deploy

```bash
curl -fsSL https://raw.githubusercontent.com/fthsrbst/mnema/main/deploy/setup-pi.sh | bash
```

This installs Node 22, clones the repo, builds server + web UI, generates a
`.env` with a random `HUB_TOKEN`, installs a systemd unit (`hub@<user>`), and
schedules a nightly backup cron job. See [`deploy/setup-pi.sh`](deploy/setup-pi.sh)
and [`deploy/clients.md`](deploy/clients.md) for details.

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

Mnema's auth model is intentionally simple — read this before exposing it
beyond your own machine:

- **Single bearer token.** `HUB_TOKEN` in `.env` gates every request except
  `/health`. If it's empty, auth is off entirely (fine for local dev, not for
  anything else). There's no per-agent scoping or rotation tooling — rotating
  means changing `.env`, restarting the service, and updating every connected
  client by hand.
- **Two ways to send the token.** Most clients send
  `Authorization: Bearer <token>`; platforms that can't attach custom headers
  (claude.ai, ChatGPT, Gemini) fall back to `?token=<HUB_TOKEN>` in the URL.
  Token-in-URL has real trade-offs (browser history, proxy/access logs) — see
  [`docs/connectors.md`](docs/connectors.md) for the full write-up.
- **Tailscale is the default network boundary.** The hub listens on a private
  tailnet address; nothing is reachable from the open internet unless you
  explicitly run `tailscale funnel`. Funnel makes the endpoint **fully
  public** — the bearer token becomes the only thing standing between the
  internet and your memory store, so treat turning it on as a deliberate,
  temporary action, not a default.
- **`/outputs` is served without auth, on purpose.** Generated media
  (`data/outputs`, via `image_generate`/`media_generate`) and the web UI's
  static shell are served unauthenticated (`express.static`, mounted before
  the token middleware in `src/server/index.ts`) so `<img>`/`<video>` tags in
  the dashboard work without token-laced URLs. All *data* endpoints
  (`/api/*`, `/mcp`) stay behind the bearer check. Don't put anything
  sensitive in `data/outputs`.

This is a personal-scale tool, not a hardened multi-tenant service — see the
maturity table below for what's actually battle-tested versus rough.

## Roadmap

Not built yet, tracked in [`PLAN.md`](PLAN.md) (Faz 5/6):

- **`hub ask "<question>"`** — RAG + Gemini Flash, direct terminal Q&A without
  opening an agent.
- **Quick capture** — a mobile-friendly single-input web UI for dropping a
  note or link straight into RAG (with auto-fetch + summarize for links).
- **Watch mode** — re-index a notes/docs folder automatically on change.
- **`hub timeline <project>`** — chronological dump of a project's decisions
  and sessions.
- **Weekly memory-maintenance digest** — a cron job that reports
  stale/conflicting memory entries instead of just letting them accumulate.
- **Qdrant migration path** — `sqlite-vec` is fine to roughly 1M vectors;
  moving to a dedicated vector store if that ceiling is ever hit is planned,
  not implemented.

## Maturity / honesty table

No inflation — this is what's actually solid versus still rough.

| Area | Status | Notes |
|---|---|---|
| Memory CRUD + hybrid search | Stable | Used daily; FTS-only fallback tested |
| RAG ingest + search | Stable | Chunking is markdown-aware but simple; no re-ranking model |
| Project maps | Stable | YAML + DB sync works; no conflict UI beyond LWW |
| MCP server (tools) | Stable | All tools listed in `src/server/mcp.ts` are in daily use |
| REST API | Stable | Mirrors MCP tools; used by CLI and web UI |
| Cross-device sync (LWW) | Functional, lightly tested | Works for the author's two-to-three-device setup; not stress-tested for heavy concurrent writes |
| Web UI | Functional | Covers memory/RAG/projects/prompts browsing; not a polished product UI |
| Local LLM orchestration (LM Studio) | Functional | Works when LM Studio is reachable; no retry/queueing beyond basic error handling |
| Media generation (ComfyUI) | Experimental | Works for the author's own workflows; expect to write your own `workflows/*.json` |
| Public connector exposure (Funnel + `?token=`) | Functional, use with care | Token-in-URL is a real trade-off — see [`docs/connectors.md`](docs/connectors.md) |
| Auth model | Basic | Single bearer token, no per-agent scoping or rotation automation |
| Backup/restore | Functional | Nightly cron + markdown export exist; restore path is manual |
| Qdrant / larger-scale vector store | Not built | `sqlite-vec` is fine to roughly 1M vectors; migration path is planned, not implemented |

This is a personal-scale tool built for one user running a handful of
devices — it is not hardened for multi-tenant or public deployment beyond the
token + Funnel model described above.

## License

MIT — see [`LICENSE`](LICENSE).
