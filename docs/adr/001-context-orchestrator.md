# ADR-001: Server-owned context orchestration

Status: accepted
Date: 2026-07-14

## Context

MCP clients currently receive separate `project_get`, `session_recent`, `memory_search`, `rag_search`, `bridge`, and `recall` tools. Tool availability does not guarantee that an agent calls them, uses the right project, respects freshness, or stays within a token budget. Semantic recall also cannot be the authority for questions such as “what is current?” because an older but highly similar document may rank first.

## Decision

Add `context_get` as the preferred context entry point. The server resolves intent, project, authority order, evidence mix, provenance, trust labels, and token budget. Existing low-level tools remain available for explicit exploration and backward compatibility.

`current_status` returns project-map and latest-session authority first and does not include arbitrary RAG chunks until document lifecycle metadata can prove that they are current.

All returned project/session/memory/document content is labelled as data rather than executable instructions.

## Consequences

- Context behavior becomes consistent across MCP clients.
- Status answers stop depending on semantic similarity alone.
- Token usage becomes centrally bounded and observable.
- The orchestrator becomes a correctness-critical module and requires a held-out eval suite.
- Existing hooks can migrate gradually; no client is broken immediately.
